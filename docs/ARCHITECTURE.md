# Architecture

This describes the layers, their contracts, the flows and trust boundaries, and
the extension points. It is meant to stay stable while concrete APIs change; the
phase-1 API lives in [DESIGN.md](DESIGN.md).

## The core abstraction

Porthole renders **agent-drawn HTML plus a declared set of host functions.**

- The HTML is untrusted. It may draw anything, but on its own it can only draw.
- A **host function (capability)** is any power beyond drawing: send a prompt to
  the agent, open a link, read or write state, call a tool, read data, report an
  error. Each is named in the config and carries three facts: its **gate** (needs
  a user gesture, needs a person's confirmation, is rate-limited), its **egress
  needs** (origins it must reach), and its **guide entry** (how the manual
  describes it).

A page published as an artifact may be an app: under the **capability runtime** it reaches its
host through one global, `porthole.use(name)`, for the capabilities it declared and its viewer's
level allows. The runtime is how content reaches host functions, not new ones: each of its
methods is served by a host function the config declares, and the bridge alone decides each call
(the page's declaration, the viewer's level, the gates). The services behind them (a document
store, an asset library, versions, comments) are the host's.

One capability list therefore drives three artifacts: the **bridge** (which
functions the shell wires and the host handles), the **CSP** (what the sandbox
may reach), and the **manual** (what the agent is told). This is why the config
is the single source (PRINCIPLE 3) and why "talk to the agent" is not special —
it is one host function (PRINCIPLE 4).

## Layers

```
            ┌──────────────────────────────────────────────────────────┐
            │  Host app  (owns product policy, theme, callbacks)         │
            └───────────────┬──────────────────────────────────────────┘
                            │ picks a preset, passes theme + callbacks
  ┌─────────────────────────▼─────────────────────────────────────────┐
  │  PRESET POLICY LAYER                                                │
  │  inline-widget · artifact · mcp-app · url                           │
  │  each = a config: CSP+origins, capabilities+gates, theme, guide     │
  └─────────────────────────┬─────────────────────────────────────────┘
                            │ one config
  ┌─────────────────────────▼─────────────────────────────────────────┐
  │  FRAMEWORK LAYER  (mechanisms only, no policy)                      │
  │                                                                     │
  │  config compiler ── CSP + sandbox/allow attrs                       │
  │                 └── shell runtime (what to wire)                    │
  │                 └── guide + tool description                        │
  │                                                                     │
  │  isolation core · egress hardening · streaming render · auto-size   │
  │  theming · host-function bridge · guide gen · serving (/server)     │
  └───────┬───────────────────────────────────────┬────────────────────┘
          │ host side                              │ in-frame side (shell)
  ┌───────▼─────────┐                      ┌───────▼──────────────────┐
  │ PROTOCOL ADAPTER│  ◄── transport ──►   │  SHELL  (runs first in    │
  │ (MCP Apps; …)   │   (postMessage/      │  the isolated frame;      │
  │                 │    native bridge)    │  renders HTML, wires caps)│
  └───────┬─────────┘                      └───────────────────────────┘
          │
  ┌───────▼───────────────────────────────────────────────────────────┐
  │ PLATFORM HOST   web (iframe) now · WKWebView / Android later        │
  └─────────────────────────────────────────────────────────────────── ┘

  CONFORMANCE / LEAK SUITE drives a platform host through the adapter and
  probes every egress and escape channel (runnable by any host).
```

### Framework layer (mechanisms)

Pure mechanism, no product policy, no host or vendor types.

- **Config compiler.** Turns one config into the CSP string, the iframe sandbox
  and `allow` attributes, the shell's wiring, and the guide + tool description.
  Deterministic and pure, so a test can assert the three outputs agree.
- **Isolation core.** Places the content on an origin that is never the host's,
  with nothing of the host's reachable: an opaque-origin frame, or a served
  origin of its own (domain mode: a subdomain per storage scope on a separate
  registrable domain; url mode: the app's own origin). The mode is chosen by
  config; the rest of the framework does not depend on which.
- **Egress hardening.** The closed-by-default network and navigation walls, plus
  the in-shell defenses for channels a CSP does not cover (see Trust boundaries).
- **Shell runtime.** The code that runs first inside the frame: applies theme,
  inserts the HTML (streaming-aware), reports size and errors, and exposes the
  declared host functions to the content.
- **Host-function bridge.** Carries capability calls from the shell to the host
  and results back, over a transport, with validation and gating at the boundary.
- **Streaming render, auto-size, theming, guide generator.** The remaining
  mechanisms, each usable on its own. Content is plain HTML and SVG; its look
  comes from the theme variables, never from a component vocabulary (P015).
- **Serving.** For served modes, a request handler a host's backend mounts: it
  serves documents on their own origins with their CSP in headers, and turns a
  one-time ticket the host minted into a cookie of that origin only. A stored
  version may be one page or a set of files: each file is looked up in the
  version's manifest only, typed by Porthole's own table, and served under that
  version's own address, so a page's relative addresses are its version's.

### Preset policy layer

A preset is a named config with safe defaults. It fixes the CSP and allowed
origins, the capabilities and their gates, the theme vocabulary, and the manual.
A host adopts a preset and overrides only theme and callbacks.

- **inline-widget** — host injects agent code into a strict, opaque-origin frame
  with a shell; smallest capability set; for cards inside a conversation.
- **artifact** — a standalone page: written into an opaque frame where the host
  has it, or served at a URL on a separate registrable domain, CSP in headers,
  versioned.
- **mcp-app** — renders a standard MCP Apps view (a `ui://` template plus tool
  input/result), using the MCP Apps adapter.
- **url** — frames a running app by URL (a dev server's preview): isolation and
  access auth only; no shell, no capabilities, no egress control.

### Protocol adapters

A thin adapter maps the framework's capability and lifecycle events onto a wire
protocol. **MCP Apps** is the first and default. The adapter is the only layer
that knows protocol method names and shapes; the core speaks capabilities.

### Platform hosts

The platform host owns the actual isolation primitive and the transport: an
`iframe` + `postMessage` on the web now; a `WKWebView` + message handler on iOS
later. The framework layer is written against a small platform interface so a new
platform is an implementation of that interface, not a fork.

### Conformance / leak suite

A standalone test runner that drives a platform host through an adapter and
attempts every known egress and escape channel, asserting none succeeds. Any host
can run it against its own integration. It is both our regression gate and the
artifact we offer upstream (PRINCIPLE 5, 6).

## Contracts between layers

- **Host → preset:** a preset name, theme tokens (resolved per color scheme), and
  callbacks for each enabled host function. Nothing else is required.
- **Preset → framework:** one config (capabilities with gates and egress needs,
  allowed origins, theme variable map, limits, layout, mode and isolation).
- **Config → {CSP, shell, guide}:** derived, never hand-written; a test asserts
  agreement.
- **Framework ↔ shell:** lifecycle and capability messages over a transport.
  Validated both directions; unknown or malformed messages are dropped.
- **Framework ↔ adapter:** the adapter translates between capability/lifecycle
  events and protocol messages; it may add protocol-only messages (handshake,
  teardown) that the framework does not model.
- **Framework ↔ platform host:** create an isolated surface, set its policy
  (CSP/sandbox/allow or the native equivalent), send and receive messages,
  report size, tear down.

## Flows per mode

### Inline widget

```
Host app                 Framework/Adapter            Shell (opaque frame)
   │  mount(config, cbs)       │                             │
   │──────────────────────────►│  compile config → CSP,      │
   │                           │  sandbox attrs, shell doc    │
   │                           │  create opaque frame ───────►│ (shell runs first)
   │                           │◄──── initialize ─────────────│
   │                           │──── host context (theme,     │
   │                           │     capabilities, size) ────►│
   │  content (may stream) ───►│──── content (partial*) ─────►│ draw inert
   │                           │──── content (complete) ─────►│ run
   │                           │◄──── size / error ───────────│
   │◄── onError / onResize ────│                             │
   │                           │◄──── capability call ────────│ (e.g. sendPrompt)
   │◄── gate (confirm?) ───────│   validate + gate            │
   │── result ────────────────►│──── result ─────────────────►│
```

`*` partial content is drawn inert (no scripts, handlers or navigation) until
complete; see Streaming in DESIGN.md.

### MCP Apps view

Same shape, with the adapter speaking MCP Apps: the view is an MCP Apps `App`;
`initialize`/`initialized` is the handshake; content arrives as tool input
(streamed as tool-input-partial, then tool-input) and tool result; capability
calls are `ui/message`, `ui/open-link`, etc., which map to host functions. On the
web a second-origin sandbox proxy relays messages so arbitrary MCP App HTML
(which expects `allow-same-origin`) is isolated from the host; the proxy is
transparent to the view and the host.

### Artifact page

The content is served as a real document at a URL on a separate registrable
domain with its CSP in HTTP headers; the host embeds that URL in a frame whose
`frame-ancestors` names the host. No code injection, and the shell is optional.
A page may come with files of its own (stylesheets, scripts, data, images, other
pages): they are served beside it, under its version's own address, and its CSP
opens that path and nothing else of its origin; every page of the set gets the
shell.
Access is gated by a one-time ticket exchanged for a scoped cookie. Where the host
holds the page and needs no stable origin, the shell writes it into an opaque
frame instead.

### URL frame

```
Host app            Host backend (+ /server)          App origin (served)
   │  mount(url preset) │                                  │
   │── locate ─────────►│ decide the viewer may see it,    │
   │◄── ticketed URL ───│ mint a one-time ticket           │
   │  frame src = URL ──────────────────────────────────────►│ ticket → cookie
   │                                                       │ (that origin only)
```

No shell and no protocol: the app is someone else's. The embedding page frames
only the declared content origins.

## Trust boundaries

1. **Host ↔ content.** The hard boundary. The content runs on an origin that is
   never the host's, so same-origin policy denies it the host's DOM, storage,
   cookies and credentials. Everything it wants beyond drawing crosses the bridge
   as a validated, gated capability call. *What each side may know:* the content
   never holds a host secret; whatever it says, the host treats as the content's
   own word and confirms with a person before acting where the capability's gate
   says so.

2. **Content ↔ the outside network.** Closed by default and opened only to the
   origins the config's capabilities declare (and, for a served page with files,
   its own version's path on its own origin, and its artifact's asset library at `/_blob/`: the
   host's own server, P082, P089). Two
   kinds of attacker matter:
   - *Attacking the host* (steal credentials, read other data, escape the
     sandbox): stopped by origin isolation — the content is a stranger to the
     host origin.
   - *Leaking or deceiving* (exfiltrate what the content was already given, or
     draw a convincing fake to fool the viewer): origin isolation does not help
     here; egress hardening and gating do. Some channels (a peer connection's
     ICE gathering, a self-navigation of the frame, a nested frame in a fresh
     realm) reach the network outside a frame's own `connect-src`. These are
     closed by in-shell defenses and by the embedding page's own policy, each
     proven by a leak-suite probe (DESIGN.md lists them).
   - *An opaque frame is as closed as its page.* A `srcdoc` frame inherits the
     embedding page's whole policy as well as its own, so on a page with
     `default-src 'none'` and a tight `connect-src`/`img-src` its content is more
     closed than its config says: an origin the config opens stays shut. On such
     a page prefer domain mode, whose frames inherit nothing (P058).

3. **Host's decision ↔ what a page may do.** Under the capability runtime a page reaches only the
   built-ins and what it declared at publish (stored by the host, given to the mount), and each
   method only for viewers at its level (`view < interact < admin < owner`), which the host's
   access says. The bridge refuses before any handler; the host's own API checks again, since it
   is its data's wall. A person's per-user data is reached by the host's id for them, never the
   content's word.

4. **Message boundary.** Every message crossing the frame is validated against a
   schema and checked for sender identity before use; the shell accepts messages
   only from its host, and the host only from its frame. What the frame says about
   itself (its size, its errors, an annotation's anchor and where it is) is the
   content's word even when the shell says it, since they share a realm: the host
   bounds it and uses it as a UI hint, never as a permission (P053).

5. **Host's decision ↔ content domain.** Authentication and authorization
   *policy* are the host's; carrying the host's decision safely onto the content
   domain is Porthole's *mechanism*. The host decides who may open an instance
   before it calls `issue` (a viewer it knows, or a public link), and may decide
   again on every request (`ServerOptions.authorize`). Porthole carries the decision
   as a one-time ticket, then a signed cookie of that origin and instance only,
   with the host's opaque `subject` inside, and never interprets identity. A deny
   ends access from the next request on and tells the display why.

## Extension points

- **Capabilities.** New host functions are added to the capability vocabulary
  with a gate, egress need, and guide entry. Adding one extends the bridge, the
  CSP, and the manual together.
- **Protocol extension points.** MCP Apps gaps go through the spec's own
  mechanisms (experimental capabilities, own-prefixed methods), so the external
  contract stays standard (PRINCIPLE 2).
- **Theme variables.** The theme map is config; the standard MCP Apps variable
  names are the default vocabulary.
- **The person's clipboard** is the host's alone: content asks for a copy
  (`copyText`), the host performs it and shows what it copied (P051, P052).
- **The capability runtime** (`config.runtime`): a contract version's capabilities, each a
  namespace of methods over host functions, with a versioned `.d.ts`; a host offers them through
  its config and serves them through its handlers; an artifact's asset library is served by
  `/server` from the host's store at `/_blob/<id>` on the artifact's origin.
- **Annotations** (`annotate`): the host drives a select mode and marks anchors in
  the shell; anchors are W3C Web Annotation selectors a host stores with its own
  comments (P053).
- **Served content.** A host plugs its own policy and infrastructure into `/server`:
  who may see what (`authorize`), where tickets live (`TicketStore`: memory, D1),
  how origins are named (`content.name`, other servers' `reserved` namespaces),
  and where apps and artifact versions come from (`upstream`, `artifacts`: a page, or a
  manifest of files and their bytes), and which address means which version (`entry.at`). It runs
  on any runtime with web-standard `Request`/`Response` (Node, Workers).

## How a new protocol or platform plugs in

- **A new protocol** is a new adapter implementing the capability/lifecycle
  translation. It does not touch the core, the shell mechanisms, or the presets
  beyond adding a preset that selects it. The capability abstraction is the seam.
- **A new platform** is a new implementation of the platform-host interface
  (create isolated surface, set policy, transport, size, teardown). The framework
  layer, adapters and presets are unchanged; the shell runtime is plain,
  dependency-free script so it runs as-is in a new engine.

This is what keeps the three answers independent: *which protocol* (adapter),
*which platform* (platform host), and *what policy* (preset/config) each vary
without the others changing.
