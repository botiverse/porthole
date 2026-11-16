# Design

How Porthole works: first its shape (the core abstraction, the layers and their contracts, the
flows, the trust boundaries and the extension points), then each mechanism, then every defense with
the test that proves it. What each use is protected from is in [THREAT_MODEL.md](THREAT_MODEL.md);
why things are the way they are, in [DECISIONS.md](DECISIONS.md). Web first: a framework-agnostic
TypeScript core plus a thin React binding.

Adopting Porthole? Start with [ADOPTING.md](ADOPTING.md) and the package's `examples/`. Paths
below like `leak/…` and `ops/…` are Porthole's own repository, not the package.

## Architecture

### The core abstraction

Porthole renders **agent-drawn HTML plus a declared set of host functions.**

- The HTML is untrusted. It may draw anything, but on its own it can only draw.
- A **host function (capability)** is any power beyond drawing: send a prompt to
  the agent, open a link, read or write state, call a tool, read data, report an
  error. Each is named in the config and carries three facts: its **gate** (needs
  a user gesture, needs a person's confirmation, is shown to the person first, is
  rate-limited), its **egress
  needs** (origins it must reach), and its **guide entry** (how the manual
  describes it).

A page published as an artifact may be an app: under the **capability runtime**, an optional
layer over the display (THREAT_MODEL.md says what each guarantees), it reaches its
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

### Layers

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

#### Framework layer (mechanisms)

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

#### Preset policy layer

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

#### Protocol adapters

A thin adapter maps the framework's capability and lifecycle events onto a wire
protocol. **MCP Apps** is the first and default. The adapter is the only layer
that knows protocol method names and shapes; the core speaks capabilities.

#### Platform hosts

The platform host owns the actual isolation primitive and the transport: an
`iframe` + `postMessage` on the web now; a `WKWebView` + message handler on iOS
later. The framework layer is written against a small platform interface so a new
platform is an implementation of that interface, not a fork.

#### Conformance / leak suite

A standalone test runner that drives a platform host through an adapter and
attempts every known egress and escape channel, asserting none succeeds. Any host
can run it against its own integration. It is both our regression gate and the
artifact we offer upstream (PRINCIPLE 5, 6).

### Contracts between layers

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

### Flows per mode

#### Inline widget

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
complete; see § Streaming below.

#### MCP Apps view

Same shape, with the adapter speaking MCP Apps: the view is an MCP Apps `App`;
`initialize`/`initialized` is the handshake; content arrives as tool input
(streamed as tool-input-partial, then tool-input) and tool result; capability
calls are `ui/message`, `ui/open-link`, etc., which map to host functions. On the
web a second-origin sandbox proxy relays messages so arbitrary MCP App HTML
(which expects `allow-same-origin`) is isolated from the host; the proxy is
transparent to the view and the host.

#### Artifact page

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

#### URL frame

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

### Trust boundaries

The attackers each boundary faces, what is out of scope, and the composition rule for
several displays on one page are in [THREAT_MODEL.md](THREAT_MODEL.md).

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
   host's own server, P082, P089). Two classes of attacker matter, handled by different layers:
   - *Attacking the host*: steal the host's credentials or data, act as the person, or escape
     the sandbox. Stopped by origin isolation: the content is a stranger to the host origin. This
     is the catastrophic class; a regression here is the one bug that matters most.
   - *Leaking or deceiving*: exfiltrate what the content was already handed (whatever the agent
     wrote into it, or data a capability returned), or draw a convincing fake (a login form, an
     "approve" button) to fool the viewer. Origin isolation does not help here. Egress hardening
     closes every outbound channel to all but declared origins; gating puts powers that affect
     the person or the agent behind a gesture or a confirmation; and the host draws its own
     chrome and approvals outside the frame, never inside it. Some channels (a peer connection's
     ICE gathering, a self-navigation of the frame, a nested frame in a fresh realm) reach the
     network outside a frame's own `connect-src`. These are closed by in-shell defenses and by
     the embedding page's own policy, each proven by a leak-suite probe (listed below).
   - *A served page outside its frame* (a public link, a new tab) has no frame's sandbox and no
     embedding page: its own CSP header carries the frame's sandbox tokens, and the shell closes
     `window.open` and stops it navigating away (P099).
   - *An opaque frame is as closed as its page.* A `srcdoc` frame inherits the
     embedding page's whole policy as well as its own, so on a page with
     `default-src 'none'` and a tight `connect-src`/`img-src` its content is more
     closed than its config says: an origin the config opens stays shut. On such
     a page prefer domain mode, whose frames inherit nothing (P058).
   - *The agent is itself a trust boundary.* The HTML is agent-authored, so a library loaded
     from an allowed CDN is no more trusted than the agent's own code. The manual's supply-chain
     rule (pin exact, aged versions) is advice to the agent, not a wall; the walls are isolation
     and egress.

3. **Host's decision ↔ what a page may do.** Under the capability runtime a page reaches only the
   built-ins and what it declared at publish (stored by the host, given to the mount), and each
   method only for viewers at its level (`view < interact < admin < owner`), which the host's
   access says. The bridge refuses before any handler; the host's own API checks again, since it
   is its data's wall. A person's per-user data is reached by the host's id for them, never the
   content's word.

4. **Message boundary.** Every message crossing the frame is validated against a
   schema and checked for sender identity before use; the shell accepts messages
   only from its host, and the host only from its frame. What the frame says about
   itself (its size, its errors, an annotation's anchor and where it is, how many
   matches find found) is the content's word even when the shell says it, since they
   share a realm: the host bounds it and uses it as a UI hint, never as a permission
   (P053, P131). What the host sends in (a mark, a find query) the content can read.

5. **Host's decision ↔ content domain.** Authentication and authorization
   *policy* are the host's; carrying the host's decision safely onto the content
   domain is Porthole's *mechanism*. The host decides who may open an instance
   before it calls `issue` (a viewer it knows, or a public link), and may decide
   again on every request (`ServerOptions.authorize`). Porthole carries the decision
   as a one-time ticket, then a signed cookie of that origin and instance only,
   with the host's opaque `subject` inside, and never interprets identity. A deny
   ends access from the next request on and tells the display why.

### Extension points

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
  its config and serves them through its handlers (§ The capability runtime).
- **Annotations** (`annotate`): the host drives a select mode and marks anchors in the shell;
  anchors are W3C Web Annotation selectors a host stores with its own comments (P053). A mark's
  marker is a button whose click the host answers with its own UI outside the frame (§ Annotations).
- **Find in page** (`find`): the host draws its own find bar and asks the shell for a query; the
  shell highlights the matches in a layer of its own (§ Find in page).
- **Served content.** A host plugs its own policy and infrastructure into `/server`:
  who may see what (`authorize`), where tickets live (`TicketStore`: memory, D1),
  how origins are named (`content.name`, other servers' `reserved` namespaces),
  and where apps and artifact versions come from (`upstream`, `artifacts`: a page, or a
  manifest of files and their bytes), and which address means which version (`entry.at`). It runs
  on any runtime with web-standard `Request`/`Response` (Node, Workers).

### How a new protocol or platform plugs in

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

## Package layout

One package, `@botiverse/porthole` (`packages/porthole`), with subpath exports (P013). The
subpaths and what each exports are in the package README's Subpaths; the source tree is in
AGENTS.md § Layout. The core (`src/index.ts`) has no DOM framework, no host and no MCP SDK.
`/react` has the peer `react`, `/conformance` the peer `@playwright/test`, and `/mcp` depends
on the core only.

Node ≥ 24 runs the TypeScript by type stripping. In the workspace the package exports its
sources; `pnpm build` emits JS and declarations to `dist/`, which a packed package exports
instead (Node does not strip types under `node_modules`).

## Config schema

One config per kind of display (`src/config/schema.ts`); `validateConfig` refuses
a bad one whole (unknown fields, capabilities or gates; any origin that isn't
exactly `scheme://host[:port]`, so nothing can inject a CSP directive; theme values
that could break out of CSS). Presets return validated configs.

```ts
interface PortholeConfig {
  mode: "inline" | "artifact" | "mcp-app" | "url";
  isolation: "opaque" | "domain" | "external";   // external ⇔ url mode
  capabilities: { [name in CapabilityName]?: {
    gates?: Gate[];                // all must pass; omitted = the vocabulary's defaults
    withoutShow?: true;            // gates leave the default show out on purpose (P100)
    connect?: string[]; resource?: string[];   // extra origins it needs
    guide?: string;                // replaces the generated manual entry
  } };
  egress: { connect?, script?, style?, img?, font?, media?: string[] };  // base allowlists, closed by default
  theme: { variables: Record<string, string | { light; dark }>; event: string };
  limits: { maxHeightPx; minHeightPx; maxBytes; maxLiveFrames;
            declinesBeforeMute; maxPromptChars; maxErrorReports };
  layout: { minWidthPx; narrowWidthPx; wideWidthPx };   // for the manual's size rules
  guide: { toolName?; guideToolName?; topics?: Record<string, string> };
  contentOrigins: string[];        // domain/external: where content is served from
  embedder: { frameSrc?: string[] };  // extra frames the embedding page shows
}
type Gate = "user-activation" | "confirm" | "consent" | "show" | { rateLimit: { perMinute: number } };
```

`mode` and `isolation` select the mechanism; everything else is policy. There is
no `components` field (P015).

### The capability vocabulary

| Capability | Default gates | Served by | Shell global | MCP Apps request (App SDK) |
| --- | --- | --- | --- | --- |
| `sendPrompt` | confirm, 30/min (P149) | handler | `sendPrompt(text)` | `ui/message` (`app.sendMessage`) |
| `openLink` | confirm, 30/min (P149) | handler | `openLink(url)` | `ui/open-link` (`app.openLink`) |
| `downloadFile` | confirm, 30/min (P149) | handler | — | `ui/download-file` (`app.downloadFile`) |
| `callTool` | confirm, 30/min (P103) | handler | — | `tools/call` (`app.callServerTool`) |
| `readData` | 120/min | handler | `readData(uri)` | `resources/read` (`app.readServerResource`) |
| `subscribeData` | 60/min (needs `readData`) | handler (`changed`, `signal`) | `subscribeData(uri, onData, onError)` | `resources/subscribe`, `resources/unsubscribe`; the host's `notifications/resources/updated` (MCP's own; none in MCP Apps, P079) |
| `setModelContext` | 30/min, show (P100) | handler (text blocks and plain-JSON structured content, at most `MAX_CONTEXT_CHARS` together; both adapters offer `{ text, structuredContent }`) | — | `ui/update-model-context` (`app.updateModelContext`) |
| `reportError` | 10/min | event | (automatic) | `notifications/message`, level `error`; `porthole/navigation-blocked` `{ url }`, a navigation the shell stopped (P080) |
| `resize` | none | event | (automatic) | `ui/notifications/size-changed` |
| `copyText` | user-activation, 30/min | handler | `copyText(text)` | `porthole/copy-text` (none in the standard) |
| `annotate` | 120/min (the frame's reports) | event | — | `porthole/annotate.*` (the host drives it, P053) |
| `user` (runtime) | 60/min | viewer (the host's `ViewerInfo`) | `porthole.use("user")` | `porthole/call` (P087) |
| `comments` (runtime) | 30/min (P149) | handler (answers a boolean) | `porthole.use("comments")` | `porthole/call` (P090) |
| `artifact` (runtime, artifact mode) | 10/min | handler (`op: get \| publish`) | `porthole.use("artifact")` | `porthole/call` (P088) |
| `assets` (runtime, served artifacts) | 30/min | handler (`op: list \| upload \| delete`) | `porthole.use("assets")` | `porthole/call`; `/server` serves `/_blob/<id>` (P089) |
| `db` (runtime) | 600/min | handler (`op: get \| query \| watch \| set \| update \| delete \| batch`) | `porthole.use("db")` | `porthole/call`, `porthole/event`, `porthole/unwatch` (P088) |

Every preset declares only `resize` and `reportError` (they report to the host and
carry nothing out); the host declares the rest. Gates (P021) all must pass:
- `confirm` calls the host's `confirm` function and fails closed without one.
- `user-activation` (by default `copyText`'s alone, P149; a host may name it for any other) is
  checked by the shell (advisory: it shares the content's realm) and by the host where the
  engine passes the gesture up.
- `consent` asks the host's `consent` function once per display, before its first
  consent-gated call, and fails closed without one (P079). A `Refused` given as `consent`
  refuses them all, asking nothing, and their capabilities need no handler (P080).
- `show` calls the host's `show` function with the call's whole effect before the handler runs,
  asking nothing, and fails closed without one, or when it throws (P100). By default every model
  context update is shown, so the person sees it outside the frame before the agent's next turn;
  the React binding's `ContextNotice` is the default surface.

A refused request's error carries why, `data: { code, message }` (`consent_required`, `denied`,
`rate_limited`, `not_allowed`, `failed`; the host's `Refused` words its own, P080).
`presets.liveWidget` declares `readData` and `subscribeData` with `consent` and its rate, and
keeps egress closed: no option opens it, and it refuses `egress` and a capability's own
`connect` or `resource` (P103). Served, it loads Porthole's libraries from its origin
(`egress.libraries`).

## What the compiler derives

`compile(config)` (`src/compile/compile.ts`) validates the config and returns:

- `csp` / `cspDirectives`: the frame's policy. `default-src 'none'`; scripts may be
  inline (agent content is inline), `'unsafe-eval'` (content is the agent's own script already,
  so eval adds no capability, and libraries content uses compile with it, WebAssembly too: P071),
  plus `blob:` and the script origins (and, with `egress.libraries`, Porthole's library path on
  the content origins, `<origin>/__porthole/lib/`, P079); each other
  kind opens only to its origins; `connect-src 'none'` unless something is
  declared; `frame-src`, `object-src`, `base-uri`, `form-action` all `'none'`;
  `webrtc 'block'`. Never `'self'` (P022). Empty in url mode.
- `sandbox`: `allow-scripts` (opaque); `allow-scripts allow-same-origin` (domain,
  P016); `allow-scripts allow-same-origin allow-forms` (url, P020).
- `allow`: empty (no powerful feature delegated).
- `embedderFrameSources` (and `embedderCsp(configs)` for a page that shows several
  kinds): `frame-src 'self'` plus content origins plus the host's own frames, and
  `child-src` the same; no `default-src`.
- `shell` (the plan) and `shellDocument({ origins, title?, document?, cspMeta? })`:
  the frame's document with the CSP `<meta>` first, the base styles, and the runtime
  given its plan. A given `document` (an MCP Apps view, a served page) travels in the
  plan as data; the runtime renders it as it renders any document (§ The shell
  runtime), never handing its markup to the page's parser.
- `guide(topics?)` and `toolDescription()`: the manual and the show tool's
  description.

**The agreement test** (`test/agreement.test.ts`) compiles every preset and
variations of it, and asserts: the shell injects exactly the config's theme
variables and the manual teaches exactly them; the manual names exactly the
globals the shell defines, and the runtime defines each; the shell wires exactly
the declared capabilities, and each capability's manual entry states its gates
(confirm, click, rate); the manual names exactly the origins the CSP allows; each
CSP directive equals the egress plus the declared capabilities' needs; the manual
states the limits, layout and theme event; and changing the config (opening an
origin, dropping a capability or a variable, overriding an entry) changes all of
them together. The leak suite's `0.*` probes check the same wiring in real frames.

## Public interfaces

The seams other work builds against, typed in the files below.

| Seam | File | Used by |
| --- | --- | --- |
| Config, presets, compiler, guide, theme | `src/config/`, `src/presets/`, `src/compile/`, `src/guide/`, `src/theme/` | everyone |
| Host API: `createHost`, `MountOptions`, `DisplayHandle`, `DisplayEvents` | `src/host/types.ts`, `src/host/create-host.ts` | React binding, hosts |
| Isolation: `InstanceRef`, `ServedDocument`, `InstanceLocator`, `FrameLocation`, `FrameSource`; `checkFrameLocation` | `src/isolation/types.ts`, `src/isolation/served.ts` | served modes, hosts |
| Platform host: `PlatformHost`, `Surface`, `SurfaceSpec`; `webPlatform` | `src/platform/` | native hosts later |
| Transport; `postMessageTransport` | `src/transport/` | adapters |
| Protocol adapter: `ProtocolAdapter`, `AdapterSession`, `AdapterConnection`, `ShellConnection`; `shellAdapter` | `src/protocol/adapter.ts`, `src/protocol/shell-adapter.ts` | MCP adapter |
| MCP Apps names: `MCP_APPS_METHODS`, `MCP_APPS_STYLE_VARIABLES`, `PORTHOLE_STYLES`, `HostContext`; JSON-RPC parsing | `src/protocol/mcp-apps.ts`, `src/protocol/jsonrpc.ts` | shell, both adapters |
| MCP Apps adapter: `mcpAppsAdapter`, `McpAppConnection`, `viewEgress`, `readViewResource`, `MCP_APPS_STYLE_VARIABLES`, `sandboxProxyDocument` | `src/mcp/` | hosts showing MCP Apps views |
| Host-function bridge: `HostFunctionBridge`, `CapabilityHandlers`, `Confirm`, `ConfirmRequest`, `Refusal`; `createBridge` | `src/bridge/` | adapters, hosts |
| React: `PortholeProvider`, `PortholeFrame`, `ConfirmDialog`, `admitFrame` | `src/react/` | hosts |
| Conformance: `ConformanceHost`, `LaunchSpec`, `LaunchedDisplay`, `defineLeakSuite`, `PROBES`, the oracles; `defineServedSuite`, `ServedConformanceHost` | `src/conformance/` | any host |
| Server: `createServer`, `PortholeServer`, `TicketStore`, `ArtifactStore`, `ContentDomain`, `Grant`, `Access`, `Upstream`, `proxyTo`, `memoryTicketStore` | `src/server/` | host backends |
| Files (P081): `checkFileSet`, `filePathProblem`, `fileLimits`, `requestFilePath`, `lookupFile`, `fileTypeOf`, `servesFiles`; `StoredFiles`, `FileAddress`, `versionedAddress`; `lintFiles`, `admitFiles` | `src/files/`, `src/server/files.ts`, `src/check/files.ts` | host backends, publish tools |

### Host API

`createHost(config, options)` takes one config and the host's handlers, `confirm` and theme;
`host.mount(container, …)` gives a `DisplayHandle` (`setContent`, partial then whole; `setTheme`;
`refreshTheme`; events `resize`, `error`, `outcome` (loaded, blocked and why, or timeout: P040);
`destroy`). `host.compiled` holds the manual, the tool description and the exact CSP, and
`embedderCsp([config])` is what the embedding page must send. The wiring, with code, is
[ADOPTING.md](ADOPTING.md) § "3. Opaque displays".

`mount` throws if a declared capability served by a handler has none, so a manual
never teaches a function nobody serves. A `DisplayHandle` is the framework's
controls plus the adapter's own operations (`setContent` for the shell adapter;
the MCP adapter adds its own, such as a tool result).

### Isolation modes and served content

Opaque frames need nothing from outside: the host builds the shell document and
the frame is `srcdoc`. Served frames (domain, external) load a URL: the host's
`InstanceLocator` turns an `InstanceRef` into a `FrameLocation`, usually by asking
the host's own backend, which authenticates the viewer, decides they may see it,
and calls `PortholeServer.issue`.

- **Storage is keyed by origin.** An `InstanceRef` names its `scope` (the host's
  choice: a display id, an app id); `/server` maps each scope to
  `<label>.<content domain>`, the label keyed from the scope with the server's
  secret. Same scope, same origin, shared storage; different scope, nothing shared.
  Browsers partition a framed origin's storage by the top-level site, so it is
  stable within one host app.
- **What a served frame loads** is a `ServedDocument`: the shell (content then
  arrives over the transport, as for opaque frames), a stored artifact version, the
  MCP Apps sandbox proxy, or an external app (url mode).
- **A served page carries its frame's sandbox** (P099). Every page `/server` serves (a shell, an
  artifact page, a set's page, the sandbox proxy; not a url-mode app's own documents) sends
  `sandbox allow-scripts allow-same-origin` in its CSP header (`servedSandboxDirective`: the
  frame's own tokens). In a frame it repeats the attribute; on a tab of its own (a public link, a
  new tab, a frame's address opened outside it) it is the only sandbox: no popups, forms,
  downloads, modals or navigation of another window. Its `Permissions-Policy` header denies what
  the frame's `allow` doesn't grant (`servedPermissionsPolicy`: camera, microphone, location, full
  screen and the rest of `FRAME_DENIED_FEATURES`), changing nothing in a frame. On a tab the shell
  also answers `window.open` with null (but `_self`), refuses picture-in-picture windows, devices,
  location and full screen (for engines that don't read the header), and its navigation guard
  stops the page navigating itself away (an engine without the Navigation API has no wall for
  that on a tab: P099's accepted limit).
- **A version made of files** (P081–P084). The store answers a manifest (`files`: path →
  `{ size, sha256, type? }`, an `entry`, `spa`) and `read(path)`; `{ html }` stays one page. Every
  file is looked up in the manifest only, by the path below the version's base, decoded once
  (`requestFilePath`, `lookupFile`: `dir/` is its `index.html`, `name` is `name.html`, the nearest
  `404.html`, the entry for a single-page app's navigations). Its answer is typed by Porthole's
  table (`fileTypeOf`; unknown: a download), `nosniff`, with its CSP (a page's and a script's: the
  frame's plus the version's own path, P082; anything else `default-src 'none'; sandbox`), a
  strong ETag and 304, ranges, `Cross-Origin-Resource-Policy: same-origin` (files), and the cache
  rule of its address (files immutable, pages revalidated); a service worker's script is refused.
  Every page is in the shell. Its address: in a frame, `/__porthole/f/<sealed access>/<path>` (the
  ticket's answer is the entry, whose shell moves to that address first, P083); on a tab, the
  version's own clean address, `entry.at`'s `base` (`/v/3/`), where an address that means the
  latest (`/`, `/style.css`) is redeemed (P081). So a page never mixes versions: its relative
  addresses are its version's. A set's pages open each other in the frame (P084).
- **Tickets** are minted by `issue` (one-time, short-lived, bound to an instance and
  a viewer, stored as their hash), carried once in the frame's URL, and taken by the
  content origin. A served document (at `/__porthole/d/<instance key>`) comes back in
  that same answer, with a cookie of that origin and instance only (`__Host-`,
  `Secure`, `HttpOnly`, `SameSite=None; Partitioned` in a frame, `Lax` on a tab) for
  what follows, a reload; a url-mode app's ticket buys the cookie and redirects to
  the app's own landing path, every request of the app riding on the cookie. WebKit
  keeps no cookie in a cross-site frame (measured), so a framed url-mode app runs
  only where the engine keeps partitioned cookies; elsewhere the host opens it on a
  tab (P025).
- **Separation is checked.** The content domain is a registrable domain the host
  uses for nothing else, and a mount refuses a located origin that doesn't match
  `contentOrigins` or is same-site with the host.
- **Names** (P047). By default a scope's label is keyed (24 base32 characters). A
  host may name its own (`content.name`; `prefixedName("a-")` gives `a-<scope>`,
  one-to-one): one lowercase DNS label, never an IDNA form or a `reserved` one.
  `reserved` labels are other servers' namespaces under the same domain (`f` for
  `<label>.f.<domain>`) or the host's own (`p-*`: every label starting `p-`; or a
  function of the label, P056): requests for them and anything under them return
  null, to the host's routes; any other deeper name gets this server's 404.
- **Requests** (P056). The label is the request URL's; a request whose Host header
  names another host, where either is under the content domain, gets a 400 (a Node
  adapter builds the URL from an absolute-form target, and a host or a cache routes
  by Host). A Host that is a local address (an IP literal, `localhost`), as a test
  runner sends, isn't compared. A server without an `upstream` serves only Porthole's
  own paths: any other is a plain 404. Every answer says `x-robots-tag: noindex`.
- **Who** (P046, P050). A grant names a `viewer`, or is `anonymous` (a public link:
  documents only, never a url-mode app), and may carry the host's opaque `subject`
  (a share or session id), signed into the ticket and the cookie. The host's
  `authorize.check` runs after a ticket or cookie verifies and before anything is
  served: document loads, url-mode entry, every app request, `/__porthole/session`
  and `access()`. A deny is a 403 status page (`denied`, the host's code); answers
  are not reused unless the host sets `ttlSeconds` (at most 300).
- **Runtimes** (P044, P045). `/server` uses no Node module (hashing in plain
  JavaScript, randomness from `crypto.getRandomValues`), so it runs on Cloudflare
  Workers without `nodejs_compat`; tickets there live in D1 (`d1TicketStore`, taken
  by one `DELETE … RETURNING`), never KV (eventually consistent). Sessions are
  signed cookies: no store.

`/server`'s handler is fetch-style (`Request → Response | null`, null for requests
that aren't for the content domain or are in a reserved namespace), so a backend
mounts it in front of its own routes. Dev and tests use `*.localhost` subdomains, which browsers resolve to
loopback. In url mode an app's requests go, once its cookie checks out, to the
host's `upstream` (`proxyTo` relays them by HTTP, telling the app it is on its own
origin and nothing of the proxy); WebSockets take the host's own upgrade path, let
in by `PortholeServer.access`. The MCP Apps sandbox proxy is served the same way,
its CSP from the config plus the view's declared egress, signed into the ticket; it
becomes the view rather than nesting it (P026).

A page whose `script-src` is nonce-based (no `'unsafe-inline'`) blocks an opaque
frame's shell: a `srcdoc` frame inherits the embedding page's whole policy (P054).
The host passes its nonce (`HostOptions.nonce`, `PortholeProvider`'s `nonce`); the
shell's script and style carry it, and the shell gives it to every script it runs
for the content. Inline event handlers in content (`onclick="…"`) stay blocked by
such a page's policy, as on the page itself; scripts and `addEventListener` work.
The whole leak suite runs again on a reference page with a nonce-only `script-src`
(`leak/strict-csp.spec.ts`), and passes on all three engines; its negative control
`nonce` (the shell without the nonce) fails it.

The served modes have their own conformance cases (`defineServedSuite`, run against
`leak/served/`'s reference serving, which starts its own servers per worker): content
runs on its own origin and can't reach the host's DOM, storage, cookies or URL,
navigate the host's page or open a window (domain and url mode, each also after a
click); storage persists within a scope and is never shared across scopes; a ticket
opens its content once; only the host origins may frame content; the CSP in headers
closes egress; each version of an artifact page shows as stored, hardened before it runs; an app shows nothing without its cookie, runs on a tab, and runs
framed where the engine keeps partitioned cookies; the sandbox proxy becomes a
hardened view, takes it only from its host, and opens only what the view declares.
`served.domain.egress` reads the policy that applied to the document (from the
violations its attempts raise) and holds the host to its config: scripts, styles,
fetches and frames never reach the canary, and no directive for them opens a scheme;
images and media are closed unless the config opened them to any https site
(`anyHttps`, P059), where an image then must reach an https canary, reported as
expected rather than as a leak (P062; `leak/served/any-https.spec.ts`).
A served shell draws nothing, and reports no height, until its host sends content,
so the suite gives `show` a line of content for each shell (`options.content`) and a
host that speaks to the shell sends it (P057). The shell cases also run against a
host on `createHost` whose frames take their content's height
(`leak/served/core-host.spec.ts`), as a React host's do.

#### Wiring on Cloudflare Workers

The steps are [ADOPTING.md](ADOPTING.md) § "5. Cloudflare Workers"; `test/workers/` runs such a
Worker in workerd, with real D1. The content domain's routes need wildcard DNS and a certificate
for every level served (`*.f.<domain>` included). Scopes named by `prefixedName` must already be
label-safe (lowercase letters, digits, inner hyphens); other ids keep the keyed default.

### The host kit

The host kit is the machinery around `/server` that each app would otherwise write itself (P066,
P068, P072), so an app writes only its policy and its settings. The policy is four callbacks
(five with redirect entry):
- `instance`: the instance an issue request proposes, as the app means it;
- `access`: may this viewer see it, and with what grant;
- `authorize`: may this cookie still see it, on each request (P050);
- `source`: a stored version by id and version: one page (`{ html }`), or a set of files (P081);
- `entry.at`: the instance a clean address's path names (redirect entry), or, for a set of files,
  the instance with its version's own address (`{ instance, base, file }`, P081).

How an adopter wires it is [ADOPTING.md](ADOPTING.md) § "The server" and the package's
`examples/app.mjs` (Node and Workers).

**Displays: `defineDisplays(kinds)`** (core). Each kind's preset and options, once: opaque and
served configs (memoized per content source), the kind an instance names, frame sources and the
`frame-src` directive without a server, and a served kind's config for the manual without a real
origin. `createContentHost({ displays })` and the conformance runner take it.

**Server: `createContentHost(options)` (`@botiverse/porthole/server`, runtime-agnostic: Node,
Workers, Deno, Bun).** It gives:
- **`fetch(request)`, the routing middleware.** Every host under the content domain is
  Porthole's, so the app never answers there. Reserved labels and the app's own hosts return
  null, for the app's routes. `reserved` is only for labels the app itself serves on the content
  domain (Ferry's `p-*` previews); a label nothing serves needs no entry. A label the naming
  never makes, the bare domain, and a clean address `entry.at` says names nothing all get
  Porthole's 404 there, never a trip to the app (P070). Settings that can't be served answer a
  plain 503, never the app's. `owns(request)` says the same for a WebSocket upgrade.
- **`issue(viewerOf)`, the issue endpoint** (a fetch handler). The body is always `{ instance }`
  (an `InstanceRef`, the wire shape). The app's `instance` callback treats it as a proposal: it
  validates it, derives the scope from what it names (a session, a page), and refuses anything
  else (404). App ids travel in the document's fields. **The client never chooses an origin**:
  the scope the server maps to does. Then `access` (401 without a viewer, 403 refused), a ticket,
  and `201 FrameLocation`. `503 not-served` while content isn't served; `409` when `/server`
  refuses the instance; an optional per-viewer rate limit (429), an anonymous viewer keyed by an
  address the host trusts (the socket's peer, `CF-Connecting-IP` on Workers, or behind
  `trustedProxies` the `X-Forwarded-For` entry they appended; never what a client says, P092).
  The body is read to at most `ISSUE_BODY_BYTES` (64 KiB), counted as it arrives: past it the
  read stops and the answer is `413 too-large`; a Content-Length over it is refused before the
  viewer is asked (P092).
- **`routes(viewerOf)`**: one mount under `/porthole` (`prefix`): `POST frames` (`issue`,
  answering `link`, the clean address, where `entry.pathOf` names the path, which it may look up:
  a promise, P074), `GET authorize` (its URL the default `entry.authorizeUrl`), `GET meta`
  (`ContentClientMeta`: served, content source, frame sources, health) and `POST`/`DELETE
  handoff`. `contentHostFor(build)` gives one host per Workers `env`, failing closed with a
  plain 503. A missing or short secret throws, naming `PORTHOLE_SECRET`.
- **`authorize(viewerOf)` and `urlOf(scope, path)`: redirect entry** (below).
- **`meta()`** `{ served, contentSource, health }` for the app's page; **`frameSources`** for
  its CSP (`frame-src`), the authorize route's path included.
- **Domain helpers.** `contentDomain(input, { appOrigins })` parses (the scheme from loopback or
  `*.localhost`, the port) and gives `originOf(label)`, `source`, `isContentHost(host)`,
  `labelOf(host)`; `ContentDomainError` names the rule (`invalid`, `clash`, `same-site`).
- **Clashes.** Porthole never serves a content domain that holds an app origin or may share its
  site. With the health gate (the opaque fallback) on, such settings are a lasting "unhealthy:
  misconfigured, <reason>": logged once (`porthole.content.misconfigured`, with its `code`),
  `meta().served` false, frames run opaque. Without it, `createContentHost` throws the typed
  error at startup. Fail closed either way; there is no separate switch.
- **The health gate (optional).** Porthole answers a who-am-I on its health label
  (`/__porthole/health`, a keyed id, so another deployment's answer doesn't count). The kit
  probes it over the real network (DNS, the edge, TLS): every 60 s while unhealthy, every 10 min
  while healthy, 10 s timeout. While unhealthy, `issue` answers `503 not-served` and the page's
  `servedOrOpaque` picks opaque configs. `health.onChange(view)` is told each change of state
  (P070), and `health.onServedChange(served)` once per flip. On Workers the probe is optional (a
  host that doesn't enable it serves from startup). `log` takes a `{ info, warn, error }` logger.
- **The viewer handoff**, for a page that holds a token: `POST /porthole/handoff` with the app's
  own credential, from the app's own page, sets a 10-minute `HttpOnly` cookie scoped to the
  prefix holding a Porthole-signed key (the viewer's id and expiry), which the authorize route
  reads when `viewerOf` knows no one. `entry.spa` signs a person in through the app's own route.
- **The url-mode relay kit:** `upstreamHeaders` (the header rewrite `proxyTo` makes, for any
  transport, WebSockets too), `statusPage` (the frame-status page with its script under its
  hash), `nodeHost`'s `appSocket` without Porthole's cookies, `content.forget()` for cached
  `authorize` answers.

**Redirect entry (P068).** Every instance has a clean, stable address
(`https://a-<id>.content.example.com/v/3`) that opens directly: a new tab, a reload, a bookmark,
a link sent to someone with access.
1. A request on a clean address that names nothing gets Porthole's 404 on the content origin:
   the naming never made its label, or `entry.at(scope, path)`, asked with no viewer, says
   nothing (null or undefined) is there (P070).
   A request on a clean address without a cookie for it gets a 302 to the app's authorize route
   with a signed state (label, path, nonce, five minutes), and a cookie holding the nonce on the
   content origin (partitioned in a frame, `Lax` on a tab, like the session cookie).
2. `authorize` asks `entry.at(scope, path)` and `access`. No viewer: the app's own sign-in
   (`signIn(returnTo, request, entry)`), which comes back to the same route. No access: the app's
   refusal (`refusal(status, request, entry)`; nothing returned: Porthole's page); never content.
   **Redirect entry is for a tab alone (P125):** a clean address asked from a frame
   (`Sec-Fetch-Dest: iframe`/`frame`), and the authorize route asked from one, answer Porthole's
   "open this in a new tab" page (the status pages' policy, no script), never a trip to the app.
   Both hooks get the address decoded (`EntryContext`: label, scope, path, clean URL, the
   instance, framed). `returnTo` (and `entry.spa`'s `next`) is `authorizeUrl` with the request's
   query: the app as it is reached, never the request's own URL, whose scheme and host behind a
   TLS edge or a dev proxy are another's (P074).
3. Granted, a 302 back to `/__porthole/entry?code=…`: a one-time code (60 s), bound to the
   label, the path and the nonce. The content origin redeems it only on that label and only with
   the nonce's cookie, sets the session (bound to the path) and 303s to the clean address. The
   code is in an address for that one hop (gone from history), every redirect sends
   `no-referrer`, and Porthole never logs it.
4. A path whose session didn't come back is caught on the second bounce (`blocked: cookies`, the
   loop guard): on a tab only, since a frame never enters (P125).

Frames use tickets (`issue` → `FrameLocation`, with its door): no extra round trip, and no
dependence on the app's own cookie reaching its authorize route inside a frame. Firefox and
WebKit don't send a `Lax` app cookie on a frame navigation that came through a cross-site
redirect; Chromium does (measured, P125). To frame what a clean address names, the host resolves
it through `issue` first (`{ address }`, `client.resolve`, `<PortholeView address>`, P125); a
refusal there is the outcome, with no frame. Clean addresses are for tabs, links, bookmarks and
reloads: a host's "open in a new tab" and "copy link" use `urlOf`, never a ticket. The first open
of an instance per browser costs one extra round trip through the app.

**Node: `@botiverse/porthole/node`.** `nodeServer({ content, app })` is the whole Node server
(`content` may be a function giving the host once made, P074; asked right after the `listen`
callbacks and at each request until it gives one, and `start` is idempotent, P076).
`nodeHost(content, { request, upgrade, appSocket })` returns a request listener and an upgrade
listener for `http.createServer`: content hosts to `content.fetch`, WebSockets on reserved labels
to the app's upgrade, a url-mode app's socket to `appSocket(access, …)` once its cookie checks
out, any other socket on the content domain a 404. `toRequest`/`sendResponse` convert (P070): the
request carries a signal aborted when the client goes away (`proxyTo` passes it on, so a proxied
event stream ends with its page); the body is written as the socket drains and cancelled when
the client leaves; an error mid-body destroys the response rather than end it looking whole.
Nothing a request does throws out of the listeners or ends the process (P092): a request fetch
can't take is 405 (`CONNECT`, `TRACE`, `TRACK`) or 400 (a Host or a target that is no URL); a
handler or an app listener that throws or rejects, or an answer Node can't write, is 500, and
`onError` hears it (by default a process warning); an upgrade's socket closes on its own errors.
A HEAD gets the head, its body cancelled; a client gone before the answer cancels it too. The
request body is read only as it is pulled (a reserved label's request reaches the app whole);
once the answer is out, what no one read is dropped (at most 1 MiB and 5 s) before the connection
closes, so a client still sending reads its answer. `nodeListener(app, { scheme, onError })` is a
fetch-style app's listener with the same guarantees (it is `nodeServer`'s `app`). `nodeProbe()`
is the health probe (`*.localhost` resolved to loopback, no redirects, 4 KB read). `/server`
stays free of Node.

**Client** (core). `httpLocator(url, { headers, credentials, onNotServed })` POSTs
`{ instance }`, passes the abort signal, refuses redirects, and throws a `LocateError` with the
endpoint's status and code. `servedOrOpaque(meta, servedConfigs, opaqueConfigs)` gives
`{ served, configs }`, or null until meta is known, so a frame never starts opaque and then
restarts served. A redirect entry's pages on the app origin report the frame's status too
(`blocked: sign-in`), and the frame transport hears that from the host's own origin only for
frame status. `portholeClient({ displays, base, headers, credentials, handoff })` is the
locator and knows each kind's config from the meta (null until known), links, `openInTab` (a tab
opened in the click, then sent to the address), the handoff, and `entryTarget` (the authorize
route only; with `{ app: true }` also a path or address on the app's origin, P074).
`frameFallback(outcome)` words what to offer when a frame shows nothing (`needs-tab`, `denied`,
`expired`, `failed`, `timeout`).

**React** (the kit's part): `PortholeView` (a display by kind, served or opaque, with its
fallback), `usePortholeLink`, and what the provider shares with every frame (ADOPTING.md § 3:
`scheme`, `theme`, `nonce: "auto"`, `handlers`, `openLink`, `notify`, `renderConfirm`, whose
`redirect` doesn't count toward muting, P074). The confirm request's `display` carries the
instance the host gave the frame, and an opaque frame never gets it (P076, P077). A flip of the
provider's scheme or a new themeKey re-themes running frames in place: no effect that makes a
display depends on the context value those renew (#9, P074).

**Conformance runner (`@botiverse/porthole/conformance`).** `defineHostConformance(test,
{ name, open, issue, config, instances, entry?, nonce?, skip? })` registers the leak suite, the
served cases and the redirect entry cases against the app's real page:
- `open(page)` opens it as a person sees it (signed in, its real CSP);
- the harness is framework-free, on the core's `createHost` (no React: an app's own frame
  components are its own e2e's; Porthole's React binding is Porthole's own tests'). It loads as a
  script from the page's own origin (routed by the test), with the page's nonce, so a strict CSP
  needs nothing added;
- served frames are located by the app's issue endpoint from the page, with its cookies;
- the canaries and a foreign origin are routed; cases for instances the app doesn't give
  (versions, url mode, the MCP Apps proxy) are skipped with the reason.

The tests are located in the app's own spec file, at the `defineHostConformance` call, so
`playwright test <spec>` and `<spec>:<line>` select them (P070). `entry.unknown` lists addresses
that name nothing, each of which must be a 404 on the content domain. `hostConformance(options)`
gives the hosts for an app that registers the cases itself. The options, the reporter and
`conformanceProjects` are [ADOPTING.md](ADOPTING.md) § "7. Conformance".

**Prod shape** (`ops/prod-shape/`, `ops/prod-shape/run.sh`). Docker compose: Caddy's internal
CA serving `app.test`, `*.content.test` (same-site siblings, as in production without a Public
Suffix List entry), `clash.test` and `evil.test`; wildcard DNS (CoreDNS); the kit reference app
behind the edge, its health probe over the real TLS; a misconfigured twin that must run opaque,
and a strict one that must not start; a Playwright image trusting the CA (Chromium's NSS store,
the system store for WebKit; Playwright's Firefox reads neither, so its project overrides
certificate errors). The suite (`packages/porthole/prod-shape`) runs the whole runner over https,
then the sibling cases: Porthole's cookies host-only and `__Host-`; a sibling label (an app's
preview) can't plant a cookie that opens content, or frame it; another site can't frame it; the
clash. CI (`.github/workflows/ci.yml`) runs the checks, the examples and the loopback suites on
Chromium on every push, and the loopback suites on each engine, the negative controls and the
prod-shape profile when started by hand, which a release requires on its commit (P146).

**Types and compatibility.** The kit wraps `createServer`, which remains public. The npm
package carries these docs (`docs/`), and `/server` exports the types an app's callbacks take
(`InstanceRef`, `FrameLocation`, `ServedDocument`, `PortholeConfig`, `EntryContext`).
`FrameBlock` includes `sign-in`; `ContentDomain.name` takes a `Naming` (any function fits).

### The agent's side: lint, check, tools

How an adopter wires the tools is [ADOPTING.md](ADOPTING.md) § "6. The agent's side".

- **`lintContent(config, content)`** (core, pure): what can be told without running it, each
  finding worded for the agent with its line. Errors only for what certainly fails or is cut:
  over the size, a document where a fragment goes that has no body, nested frames and plugins,
  `document.write`. Warnings for the rest: a document sent as a widget (taken as its body,
  `fragmentOf`), the clipboard, dialogs, forms, hosts outside egress, unpinned CDN libraries,
  `position: fixed` in a flow layout, new windows without `openLink`, the page's own styles
  holding it to one screen (P106, P110: `src/check/scroll.ts`, a cascade of html, body and the
  root's overflow, height and position; `lintFiles` reads the version's linked stylesheets too,
  only those within its caps; advisory, so a throw in it says the page wasn't checked).
- **`admitContent(config, content, { refuseOn })`**: the show tool's gate. It refuses errors by
  default with a text that says what to change; otherwise it shows the content (a widget's
  document taken as its body) and returns the warnings as a note.
- **A page with files** (P081): `lintFiles(config, files)` lints each page as `lintContent` does
  (findings name their `path`), holds the set to `checkFileSet`'s rules and the config's limits,
  and looks each relative reference up in the set (markup, CSS, module imports, workers,
  fetches): a page's reference that starts with `/` is an error (it names the address's root, not
  the version: a Vite build without `base: "./"`), one that isn't in the set a warning.
  `admitFiles` is the publish tool's gate, as `admitContent` is the show tool's. `checkPage({
  config, files, driver })` serves the whole set and runs its entry (a served artifact config and
  a driver that serves).
- **`checkPage({ config, content, driver })`** (`/check`): the content in the real sandbox at each
  width and scheme (defaults: the manual's phone and desktop widths, light and dark unless
  unthemed). The check page (`src/check/page.ts`, bundled and shipped as `/check/page`, a module
  `checkPage` imports, so a bundle carries it, P075) is served by the driver at a fixed origin
  (`https://porthole-check.invalid`), mounts the content with a small instrument first in it, and
  hears errors, rejections, CSP blocks, failed loads, the console and the document's width by
  `postMessage`; heights come from the display's resize events. A served config runs served
  (P074): the driver also answers a reserved content domain (`*.porthole-check-content.invalid`)
  with an in-process `createServer` (a random secret, the check page as its only host origin), so
  the content gets its own origin, the served CSP in headers, the shell, storage and cookies, each
  run on a new origin; an opaque config, an MCP Apps view (as a page with the view's egress) and a
  driver without `serve` run opaque. Each inline script is named
  (`//# sourceURL=porthole-script-<n>`) and its first line recorded, so an error's line is the
  content's own line, as lint numbers it. Every host function the config declares is answered as
  a host that declines (`confirm` says no; each handler answers no; no call comes from a click,
  P078), and each call the host sees is reported (`run.calls`): refused by a gate whatever the
  person says (no click, bad arguments, too often) a problem, declined or answered a note. A global
  the shell refuses itself without a click (`sendPrompt`) rejects in the content, so it shows as an
  error. The report's `text` names each problem once, with where it happened, at most 8. Drivers:
  `playwrightDriver(browser)` (requests answered by `page.route`), and `cdpDriver(open)` over any
  CDP session (`Fetch` interception; Cloudflare Browser Rendering from a Worker).
- **Tools:** `showTool`, `guideTool`, `checkTool` give `{ name, description, inputSchema }` from
  the config; `answerGuide` answers the guide tool; `guideChanges(from, to)` is the notice when a
  kind flips between served and opaque. `examples/mcp/server.mjs` wires them over MCP.
- **The manual's examples pass the check:** `leak/check.spec.ts` runs every `GUIDE_EXAMPLES`
  entry under each preset at the manual's widths in light and dark, on three engines
  ([PRINCIPLES.md § Objectives](PRINCIPLES.md#objectives-and-success-criteria), criterion 5).

### Protocol adapters

The core ships the adapter for the MCP Apps subset its own shell speaks
(`ShellConnection`): `ui/initialize` answered with the host context,
`tool-input-partial` (0..n) then `tool-input` carrying `{ html }`,
`host-context-changed`, `size-changed` and `notifications/message` (errors) into
the bridge, `ui/message` and `ui/open-link` into the bridge, `ui/resource-teardown`.
Content may also use the official App SDK directly; the adapter answers a second
`ui/initialize` from the same frame, and the shell numbers its own requests with
strings (`porthole-shell-1`) so neither takes the other's answers.
The shell asks `ui/initialize` up to 40 times, 250 ms apart (the host may listen after it runs);
on a tab of its own it asks nothing, since no host can hear it, and its runtime has nothing to
offer from the start. The document's root says how the handshake ended (`data-porthole-host`:
`"answered"`, or `"none"`), for a tool that shoots a page to wait on (P139).

The host context carries in `styles.variables` only the names MCP Apps defines
(`MCP_APPS_STYLE_VARIABLES`): the official SDK refuses any other name there and fails
the whole handshake. Porthole's own variables (the accent, the chart palette) go in
the host context's own-prefixed field `porthole/styles: { variables }`, which the
shell applies beside the standard ones and a view ignores (P028). The `0.app-sdk-*`
probes connect the official SDK from content under the inline, artifact and MCP Apps
presets.

The `/mcp` adapter (full MCP Apps views) implements `ProtocolAdapter` with its own
connection operations (`sendToolInputPartial`, `sendToolInput`, `sendToolResult`,
`sendToolCancelled`), carries `ui/message`, `ui/open-link`, `tools/call`,
`resources/read`, `ui/download-file` and `ui/update-model-context` through the
bridge, answers `ui/request-display-mode` with the current mode, sends a view only
the standard style variables (the official SDK refuses others), and performs the
sandbox-proxy handshake when the frame is the proxy (P027). A host maps a view's
`_meta.ui.csp` into its config's egress with `viewEgress` (or `readViewResource`,
which reads the view and its egress from a `resources/read` result). An adapter
validates every message and never calls a host handler itself: `bridge.call`
decides. The leak suite runs the official ext-apps examples, as published, through
it (`leak/mcp/`), in an opaque frame and behind the sandbox proxy.

### The host-function bridge

`bridge.call(capability, args)` checks, in order: the display's run not stopped (a restart or
its end closes its bridge, P095) → declared by the config → declared by the page, where it has
a declaration (P086) → before the arguments are read: for the runtime's own host functions, a
method by its `op` and the viewer's level for it, then for every capability its host function's
own rate (P091, P095: a malformed call costs its rate) → arguments valid and within their
limits (`openLink` http(s) only and without credentials in the URL; a prompt
1..`maxPromptChars` characters; a tool's arguments, model context and a download's contents
plain, bounded JSON, P095) → who may (P087: the level of each method the call runs for the
viewer, the data a page named with or without a viewer (P094), db's rules) → muted, if
confirm-gated → the own rate of each method it runs (`methodGates`; P094: a batch's writes count
each) → user activation → the viewer's `consent` → `confirm` (at most 10 waiting a display, P095)
→ the host's handler (or, for a read, a result the host already gave for it (P094), or for a read
allowed stale, the host's cache). Each refusal is a
`Refusal` and a `refused` display event; the frame gets an error result. After
`declinesBeforeMute` declines a display stops asking (`muted`) until it runs again.

### React binding

`@botiverse/porthole/react` (`src/react/`, TSX that a host's bundler or `pnpm build`
compiles; peer `react` 19.2+ for `useEffectEvent`). All isolation is the core's; the
binding is mounting and lifecycle (P034).

```ts
<PortholeProvider confirm? hostInfo? locator? nonce? dialogClassName? toastClassName?>   // once per page
  <PortholeFrame
    config={widgetConfig}            // a preset's config, stable (module scope or memoized)
    displayId={id} title={title}     // height memory and confirmations key on these
    scheme={scheme}                  // "light" | "dark": flips in place
    content={code} partial={streaming}   // drafts inert while partial; whole runs once
    handlers={{ sendPrompt, openLink }}  // one per declared capability; latest are called
    theme={(scheme) => tokens}       // live values for the config's variable names
    generation={n}                   // bump to run again from the start
    onContentError onHostError onResize onNavigated onNavigationBlocked onRefused onMuted
    onInitialized onOutcome
    fill?                            // fill the box and scroll inside, not grow with the content
    annotating? annotations? focusedAnnotation? trackedAnnotation? trackedSelection? onAnnotation?   // where annotate is declared
    ref?                             // a PortholeFrameHandle: clearSelection() (P118)
    aliases? themeKey? renderPlaceholder? eager? confirm? document? instance?
    className? style? />
</PortholeProvider>
```

- **Provider** (per page): which frames run (a live-frame cap: the config's
  `limits.maxLiveFrames`; frames off screen longest stop first, show a placeholder at
  their last height with "Run again", and run again when they come back), the
  heights displays reported (by `displayId`, so a frame mounting again starts at its
  last height), and the default confirmation dialog (`ConfirmDialog`, P019): the
  call's whole effect and the display's title, Cancel focused, the accept button
  ignoring presses for `ARM_DELAY_MS` after it opens, Escape cancels; a modal in the
  host page, outside every frame. `confirm` replaces it. Without a provider frames
  still run (one page-wide registry) and calls that need a person are refused. It
  also serves `copyText` for frames whose handlers don't (P052): the host's page
  writes the clipboard and the copy toast (`CopyToast`) shows the person what went on
  it, clipped to four lines and `TOAST_CHARS`; if the write failed it says so and
  offers a Copy button, a click on the host's own page.
- **Frame**: mounts when it nears the screen (800 px) unless `eager`; until its
  content reports a size it holds its remembered height (at least
  `PLACEHOLDER_HEIGHT_PX`) and is hidden behind its placeholder (`data-porthole-state`:
  `waiting`, `running`, `stopped`; `data-porthole-ready` while it loads); then it is
  as tall as its content, within the config's limits. Only a new `config`,
  `document`, `instance` or `generation` makes a new display; `content`, `partial`,
  `scheme`, handlers, and even `displayId` and `title` are fed to the running one (a
  streamed display keeps its frame when its id settles, and its confirmations name
  it as the host now does).
  Navigation recovery is the core's: started again up to three times, `onNavigated`
  each time, then stopped with an error.
- The shell reports no size before it has drawn something, so an empty shell never
  overwrites a remembered height.
- **Annotations** follow props: `annotating` (what the person may point at now, or
  null), `annotations` (the marks), `focusedAnnotation` (each new id is brought into
  view; `{ id, key }` with a new key focuses the same one again), `trackedAnnotation`
  (the mark followed, or null, P118), `trackedSelection` (true: the selection followed in
  its place, and highlighted, P138); `onAnnotation` gets what the frame reported, `tracked`
  and `selectionTracked` boxes too. A frame that mounts again gets them all. A `ref` holds `clearSelection()`, `find`,
  `clearFind` and `focusMark(id)` (`PortholeFrameHandle`), each a no-op while no display runs.
- **Errors** (P055): `onContentError` gets what the content did wrong (what it
  threw, what the sandbox blocked, a navigation the shell stopped, that it kept
  navigating away): the agent's to hear. `onNavigationBlocked` gets a stopped
  navigation's address whole (P080). `onHostError` gets what failed on the host's side (`locate`, `mount`,
  `annotations`): never the agent's. `onError(message, source)` gets both.
- **Identity** (P057): `config`, `instance`, `annotations` and the provider's
  `hostInfo` are compared by value, and the provider's `locator` and `confirm` are
  read when used, so a host may build them inline. A new `config`, `document`,
  `instance` or `generation` still makes a new display.
- **Fill** (P057): `fill` makes the frame fill its box (give the box, or its parent,
  a height) and the content scroll inside it, instead of growing with it; a url-mode
  app always fills. In the core, `MountOptions.fill`.
- **A strict page** (P054): `nonce` passes the page's CSP nonce to opaque frames, which
  inherit the page's policy (`HostOptions.nonce` in the core).

Its tests run in real browsers (`leak/react.spec.ts`, against `leak/react/app.tsx`,
which the leak server bundles with esbuild because React ships CommonJS only).

## Widget side (what the agent writes against)

The content speaks **MCP Apps**. An author can use the official
`@modelcontextprotocol/ext-apps` `App` SDK, or the raw JSON-RPC over `postMessage`
the spec documents — the host side answers it. For convenience the shell defines
`sendPrompt(text)` and `openLink(url)` when those capabilities are declared (sugar
over `ui/message` and `ui/open-link`), turns link clicks into `openLink`, stands in
for `localStorage` in an opaque frame, applies the theme variables, and fires the
config's theme event after a change. A capability that is not declared is simply
absent.

## The capability runtime

A config with `runtime: "1"` (inline widgets and artifact pages) gives its frames one global,
`porthole`, whose only member is `use(name)`: a frozen namespace, or null where the capability
isn't offered (the page draws without it). Errors carry a stable `code`. What a host does to offer
it is [ADOPTING.md](ADOPTING.md) § "The capability runtime";
what it guarantees is [THREAT_MODEL.md § 7](THREAT_MODEL.md#7-the-display-layer-and-the-app-runtime).

- **Contract** (`RUNTIME_CAPABILITIES`, version 1; `types/runtime/v1/*.d.ts`): `clipboard`,
  `links`, `downloads`, `comments` (built in), `user`, `chat`, `data`, `context`, `artifact`,
  `assets`, `db` (declared). Each method is served by one of the config's host functions, gated as
  the config says; the table in P085 maps them.
- **Declaration** (P086): `{ capabilities: { name: config }, runtime }`, stored by the host,
  resolved at publish by `declareCapabilities` (omitted carries forward, `{}` clears, an object
  replaces), checked against the config, given to `mount({ declaration })`. The bridge refuses an
  undeclared capability on every path (`undeclared` → `not_allowed`). A page stored before
  runtime declarations has none and takes the legacy path.
- **Levels** (P087): `view < interact < admin < owner`; each method's least level (config `levels`
  at or above its floor; a page's declaration raises). The host's access says the viewer's level
  (`Grant.level`, `Grant.user` → `FrameLocation.viewer`; or `mount({ viewer })`); below it is
  `forbidden`, before any handler. Without a viewer the config's other host functions run; the
  runtime's own are refused.
- **Order in the bridge** (§ The host-function bridge, for the runtime): declared in the config →
  declared by the page → for the runtime's own, the method's level and the host function's rate
  before the arguments are read → arguments (shape, bounded walks, limits: `too_large`) → the
  call's level (a batch's writes', a watch's read's), `data`'s names (with a viewer or without
  one, P094), `db`'s paths and rules → mute → rates → gesture → consent → confirm (the host
  function's gates and the own gates of each method the call runs: `artifact.publish` and
  `assets.delete` a yes, an upload whose code may run a yes; a db batch its writes', confirmed once
  whole, a rate counting each write; a watch its read's, P094) → the handler, or for a read a
  result the host already gave for it (P094) (context: `viewer`, `declared`, `instance`) → `db`
  answers with `data/users/me` (P091).
- **Mounts under a runtime** say what the page declared (`declaration`, or `null` for a page
  stored without one); an older version is mounted with `intersectDeclarations(version's,
  current)`, which allows exactly what both allow (each side's `db` rules read as `dbAccess` reads
  them, P093). A display without a viewer gets nothing above view; a viewer that doesn't parse is
  an error.
- **Wire**: the roster in `ui/initialize`'s `hostCapabilities.experimental["porthole/runtime"]`;
  `porthole/call { capability, method, args, watch? }` → `{ value }` or an error with
  `data: { code, message }`; `porthole/event { watch, data }`; `porthole/unwatch { watch }`.
  `data.read`/`data.subscribe` use MCP's `resources/*`.
- **Services are the host's**: `db` (paths, versions, `ifVersion`, batches, watches,
  `data/users/<id>` private, the page's rules: `dbAccess`, which the host applies again),
  `artifact` (current version; a base-checked patch), `assets` (an `AssetStore` `/server` serves
  at `/_blob/<id>`), `comments` (the host's composer; content hears a boolean).
  `defineRuntimeConformance` checks an app's real handlers, and with `api` its own API past the
  bridge with a forged context (never trust `context.viewer` or `context.declared`);
  `leak/runtime/memory.ts` is the reference, in memory. `pseudonymFor(secret, artifact, person)`
  gives a person an id per artifact.
- **Assets on the content origin** (P089, P091): for an access to the asset's artifact (a session
  cookie, a framed set's sealed address as `Referer`, or `assets.url(id)`'s
  `<sealed base>__porthole/blob/<id>`), then the host's check, then `AssetStore.get(id, access)`;
  revalidated (`no-cache`, ETag); code-typed only where trusted and the config lets uploaded code
  run, asked at each load (in bearer mode, every artifact config must, P103); by id alone only in
  bearer mode.
- **The manual**: under a runtime, topic `interactive` lists `porthole.use`'s methods with levels
  and gates, and topic `capabilities` teaches declaring, levels, errors, where state goes, and each
  offered capability's `.d.ts`. The legacy globals stay defined (`shell/legacy.ts`) and untaught.

## The modes

- **Inline widget** (`presets.inlineWidget`). The host has the HTML (the agent
  wrote it) and the shell draws it in an opaque frame, streamed as it is written.
  The workhorse.
- **Live widget** (`presets.liveWidget`, P079). An inline widget that shows the
  host's data, current, as the viewer may see it: `readData` and `subscribeData`
  behind the viewer's consent, no network of its own (no option opens it, a
  capability's own origins included, P103), and, served, Porthole's Chart.js and D3
  from its own origin.
- **Artifact page** (`presets.artifact`). A whole document: written into an opaque
  frame by the shell where the host has it (an app's "show an HTML file"),
  or served on its own origin (domain isolation), CSP in headers, versioned. It
  scrolls inside past a shorter height cap.
- **MCP Apps view** (`presets.mcpApp`). A standard `ui://` template plus tool
  input/result, through the `/mcp` adapter: hardened in an opaque frame (the shell's
  runtime first in the view's document), or behind the sandbox proxy on a second
  origin.
- **Domain mode** (any of the above with `isolation: "domain"`). A stable origin per
  storage scope, so `localStorage` persists (P016).
- **URL mode** (`presets.url`). A running app by URL (a dev server's
  preview): frame, isolation and access auth; no shell, no egress control (P020).
  It has no handshake: its first load makes it ready, and it fills its container (an
  app reports no size; give the frame a height), at least `minHeightPx`. A host may
  add popups, modals and downloads to its sandbox, never top navigation (P037), and
  delegate clipboard writes and full screen (`permissions`, P049; none by default).
  Through `/server`, a framed app is entered through a page that checks the browser
  kept its cookie, tells the host (P040), and goes on once it has loaded itself; the host's `outcome` says loaded,
  blocked (and why: `cookies` on WebKit, `framing`, `session`, `upstream`, `denied`
  with the host's code, `locate` when the host's own locator failed) or timeout, so
  it can offer its own "Open in a new tab". A `denied` may follow `loaded`: the host
  revoked access mid-session (P050).

## Egress hardening, each with its test

Closed by default; opened only to origins the config declares. For a host choosing a level
(closed, library CDNs, passive media from any https site), ADOPTING.md § "Choosing egress" is the
summary; this section is the long form. The leak suite
(`src/conformance/probes.ts`, run by `pnpm test:leak` against the reference host)
attempts each channel from inside the content, as an agent's code would, and asserts
with an out-of-band oracle that nothing left: an HTTP canary that also counts raw TCP
connections, a UDP listener for STUN, a witness origin a navigated document would
reach, and the page's responses. Each oracle has a positive control (an allowed
origin loads; an unsandboxed peer connection sends STUN; an unsandboxed hint
connects) or the probe says it has none. Each defense has a negative control
(`PORTHOLE_LEAK_WEAKEN`, P032) that takes it out, so its probes are seen to fail.
Engines: Chromium 153, WebKit 26.6 and Firefox 155 (Playwright 1.63) all gate (P017,
P035).

Origins are exact, or `https://*.` a domain of the host's own: a wildcard over a
public suffix (`*.com`, `*.co.uk`, `*.github.io`) is refused, as is any scheme
source, with one exception (P060). A host may let passive content load from any
https site (`egress.anyHttps: ["img", "media", "font"]`, P059): those directives
get `https:`, scripts, styles, data and frames never do, and the manual says so
(`leak/cdn.spec.ts`: a hotlinked image loads; a script, a stylesheet and a fetch
to the same site don't reach it).

An opaque frame inherits the embedding page's whole policy (P058): on a page that
closes images or fetches to its own origin, the positive controls of `1.connect`
and `2.resources` can't load, through no fault of the host's isolation. The suite
then reports the probe inapplicable on this host, with the reason, instead of
failing it: a probe sees the allowed origin blocked by a policy that isn't the
frame's own (the frame's allows it). `12.no-confirm` likewise, on a host that
always has a confirm function (a default dialog). Tested against a reference page
closed like a strict host's (`leak/inherited-policy.spec.ts`).

| # | Channel | Mechanism | Probes | Negative control → fails (Chromium / WebKit / Firefox) |
|---|---------|-----------|--------|------------------------------------------|
| 1 | fetch, XHR, WebSocket, EventSource, `sendBeacon`, `fetchLater`, a blob worker's fetch | CSP `connect-src` = the allowlist only (`'none'` by default) | `1.connect` (with an allowed origin as positive control) | `connect-src` → `1.connect`, `14.silent` (all three; `8.prefetch` no longer on Chromium: the shell's hint guard holds it, measured 0.7.0) |
| 2 | images, CSS images, SVG `<image>`/`<use>`, media and posters, `input type=image`, stylesheets, `@import`, fonts, scripts, `import()`, workers, manifests, icons | CSP `img/media/font/style/script-src` = the allowlist only; `worker-src blob:` | `2.resources` (an allowed image as positive control) | — (the same CSP as item 1) |
| 3 | WebRTC (ICE gathering reaches the network outside `connect-src`) | CSP `webrtc 'block'` **and** the shell removes every `RTC*`/`webkitRTC*` constructor, fixed in place, before content runs | `3.webrtc` (an unsandboxed peer connection as positive control: it sends STUN on both engines) | `webrtc` → `3.webrtc`, `14.workers` (all three; Firefox's positive control needs `media.peerconnection.ice.loopback`, set in the suite's Firefox project, P035) |
| 4 | a nested frame: a fresh realm where item 3's removal never happened | the shell drops frame-like elements (`iframe, frame, frameset, object, embed, portal, fencedframe`) synchronously wherever content connects a node (P030), and an observer removes any that arrive another way, in the document and every shadow root (`attachShadow` is wrapped so closed ones are reached too); documents are rendered inert and imported, never written; `document.open/write` throw; declarative shadow roots can't be built (P029); CSP `frame-src 'none'` | `4.light-dom`, `.sync-realm`, `.open-shadow`, `.closed-shadow`, `.shadow-nested`, `.declarative-shadow`, `.parse-html-unsafe`, `.domparser`, `.document-write`, `.plugins`, `.foreign-object`, `.template-clone`, `.static` (each: the child never runs, no STUN, no frame left) | `frame-guard,sync-guard` → light-dom, sync-realm, plugins, foreign-object, template-clone, `14.shell`; `attach-shadow,sync-guard` → closed-shadow, shadow-nested; `declarative-shadow` → declarative-shadow; `parser-entry-points` → document-write, `14.shell` (each on all three engines; with `sync-guard`, WebKit's `8.preconnect` too). Either guard alone is covered by the other: `frame-guard` and `attach-shadow` alone fail nothing. |
| 5 | self-navigation out, with data in the URL (`location`, `replace`, `open(…, "_self")`, meta refresh, a link clicked past the shell, an SVG link), to the host's own origin, or to a `blob:`/`data:` document of its own (a fresh realm) | the **embedding page's** `frame-src` (`embedderCsp`: `'none'` for opaque content, P033; frames only, so the host's own workers are untouched, P038): a frame's own CSP cannot stop its own navigation; the shell sends link clicks out through `openLink` and drops refreshes (P030); a display whose frame navigates is started again, at most three times (P031). A served frame's page must let it reach the content origins, so there the shell cancels every navigation the frame starts to another document (the Navigation API's `navigate` event; reloads and same-document ones go on, P079), and tells the host (`navigationBlocked`, P080); an opaque frame gets no navigate events | `5.location`, `.replace`, `.open-self`, `.refresh`, `.anchor`, `.svg-link`, `.host-origin`, `.blob`, `.data` (no request reaches the canary or the host; a navigated document never runs: a witness origin hears nothing); served: `leak/served/live.spec.ts` (`location`, `replace`, `open(…, "_self")`, `navigation.navigate` to another content origin and to an outside site: no request reaches either, the document stays, the host is told the sibling's address), and the served conformance case `served.domain.self-navigation` (a click sends the frame to another content origin, then an outside site: the document stays, no request reaches the canary; on a tab of its own, `served.domain.tab-navigation`, P099) | `embedder-csp` → location, replace, open-self, anchor, svg-link, host-origin, blob, data, `6.remote-download` (all three; `.refresh` holds: the synchronous guard drops the refresh; Firefox no longer holds `.data` by itself (Firefox 155; P035 measured it did); `.blob` and `.data` see the document run by its first act, a beacon, which outlasts the display's restart (P096); the navigation guard has no events in these opaque frames); `embedder-self` → `5.host-origin`; `navigate-guard` → the four served navigation cases (each reaches another content origin), `served.domain.self-navigation` and `served.domain.tab-navigation` (all three) |
| 6 | forms, popups, downloads, top and parent navigation | `sandbox="allow-scripts"` only; CSP `form-action 'none'` | `6.submit`, `.request-submit`, `.blank-form`, `.open`, `.blank-link`, `.download`, `.remote-download`, `.top`, `.top-link`, `.parent` | `sandbox` → open, blank-link, top, top-link, parent, `14.dialogs`, `14.windows` (all three), `14.print` (Chromium, Firefox: WebKit prints nothing from a frame either way), download (Chromium; WebKit and Firefox started no download either way). Form submits still fail: `form-action` is a second wall |
| 7 | `<base>` hijack, plugins | CSP `base-uri 'none'`, `object-src 'none'`; plugins removed as frames | `7.base-plugins` | `base-uri` → `7.base-plugins` (all three); `frame-guard,sync-guard` too (plugins left in place) |
| 8 | resource hints and speculation rules | CSP for those an engine governs (`prefetch`, `preload`, `modulepreload`); for the rest the shell drops `dns-prefetch`, `preconnect`, `prefetch`, `prerender` links, speculation rules, refreshes and `x-dns-prefetch-control` metas synchronously, and refuses changes that would make a connected link one (P030); `x-dns-prefetch-control: off` | `8.preconnect`, `.dns-prefetch`, `.prefetch`, `.prerender`, `.preload`, `.modulepreload`, `.speculation-rules` (each in markup, inserted, and switched on by attribute change; no request, no connection) | `sync-guard` → `8.preconnect` (WebKit: it preconnects synchronously, outside CSP). Measured: Chromium and Firefox opened no preconnect even unsandboxed. `dns-prefetch` has no out-of-band oracle here (DNS isn't observed); the element is refused before it connects |
| 9 | the host's DOM, storage, cookies, credentials; another display | opaque origin (no `allow-same-origin`); nothing secret is sent into the frame; the shell takes messages only from its parent | `9.host`, `9.siblings` (a display can't navigate or drive another) | — (the sandbox is the platform's; measured: a new frame's realm is cross-origin even in the task that made it, both engines) |
| 10 | the embedding page's own origin | no `'self'` in any directive (P022) | `10.self` | `self` → none: measured, an opaque frame's `'self'` reaches nothing of the host on either engine. Kept out anyway (nothing legitimate needs it) |

Interop (`0.*`): the content runs in an opaque origin; the shell defines a global only
per declared capability, fixed in place; it applies exactly the declared theme
variables; streamed content is drawn inert and runs once; and content using the
official App SDK connects under the inline, artifact and MCP Apps presets
(`style-split` → all three, P028).

### Behavior and gates, each with its test

| # | What | Mechanism | Probes | Negative control → fails (all three engines) |
|---|------|-----------|--------|------------------------------------------|
| 11 | streaming | `setContent(html, { partial: true })` any number of times, then whole once; the shell draws a draft from a template with everything that runs or navigates removed (scripts, frames, `on*`, `javascript:`), changing only what changed | `11.streaming`: each draft shows; a drawn node is kept across drafts (an image doesn't reload); nothing runs (no script, handler or `javascript:` href) until the whole, which runs once; a repeat or a late draft changes nothing | `draft-inert` → `11.streaming` |
| 11 | auto-size | the shell reports its height (`size-changed`) as it changes; the host clamps it to `minHeightPx`..`maxHeightPx` and sizes the frame; past the cap the content scrolls inside | `11.size` (grows, shrinks, stops at the cap and scrolls, floors at the minimum; events carry the clamped height), `11.size-document` (a whole page's height; its own `load` fires; its title kept) | — |
| 11 | theming | `setTheme(scheme)`: the host sends the resolved variables (the host's live values over the defaults, P028), the shell sets them in place, with `data-theme` and `color-scheme`, then fires the config's theme event once, only when the scheme or a value changed (never at mount, never for a host re-sending what the content has, P061); the frame element's `color-scheme` follows | `11.theme-flip` (no event at mount or for the same scheme; in place: content state kept, the event fired once per flip, back and forth), `11.theme-host-values` (live values for standard and own names; undeclared names dropped) | — |
| 11 | base styles | plain CSS at zero specificity (`:where`): native buttons, inputs, selects and text areas take the theme's borders, radius, colors and focus ring, 44 px tall (the manual's touch size); the manual says so for inline widgets | `11.base-styles` (themed; content's own CSS overrides them) | — |
| 12 | `sendPrompt` | the host asks `confirm` with the whole text, whether a click came with the call or not (no proof of a gesture is asked since 0.16.0, P149); declines count toward a mute; at most 30 a minute | `12.prompt-confirm` (a call on load asks, and a no sends nothing; a click asks; a no sends nothing; a yes reaches the handler), `12.raw-message` (a raw `ui/message` around the shell, no click: asked too, and a no sends nothing), `12.mute`, `12.no-confirm` | `confirm-gate` → prompt-confirm, raw-message, link, mute, no-confirm, `14.windows` |
| 12 | live data (`readData`, `subscribeData`, P079) | MCP `resources/read`, `resources/subscribe`/`unsubscribe`, `notifications/resources/updated`; the `consent` gate asks the host once per display before the first data call (a no refuses them all; none refuses, fail closed), then the rate; a subscribed read may be answered from the host's cache, marked stale, the fresh one following as an update; a refusal tells content why (`data: { code, message }`, P080) | `test/live-data.test.ts`, `test/refusals.test.ts`; `leak/served/live.spec.ts` (read and followed, consent asked once; cached then fresh; a viewer's no refuses both, no handler runs, `denied` with its sentence; a host refusing all without handlers; a handler's `Refused`) | — |
| 12 | `openLink` | link clicks go out through `openLink`; the bridge takes http(s) only, without credentials in the URL; confirmed | `12.link` (a web link asks and opens; `javascript:` links and `openLink("javascript:…")` do nothing and are refused) | `link-scheme` → `12.link` |
| 14 | error reports (`reportError`, S05, P095) | the adapters hand the bridge what content logged as it came; the bridge counts reportError's rate before reading it, then makes bounded text of it (`boundedText`: each object once, `[Circular]`/`[Repeated]`; 1,000 values, 16 levels, 8,000 characters; a BigInt as `"5n"`), scrubs sealed addresses and cuts to 2,000; nothing a log holds throws out of an adapter | `14.error-shapes` (a cycle, a BigInt and a 20-level shared graph from an inline widget and from an MCP Apps view, each reported as bounded text); `test/log-bounds.test.ts` (undeclared or past its rate: nothing of it read) | `report-unbounded` → `14.error-shapes`, `14.silent` (its blocked-load report read as the text it was), on both host pages (P096) |
| 12 | model context (`setModelContext`, S5, P100) | the `show` gate by default: the bridge hands the host's `show` the whole update (text blocks rebuilt, structured content P095's JSON data, at most `MAX_CONTEXT_CHARS`, no character the person can't see: format characters, variation selectors, private use, lone surrogates, controls but `\n` and `\t`, save the selectors and joiners of real emoji and the joiners that shape Arabic, Indic and Myanmar letters) after every other gate and before the handler; no `show`, or one that throws, refuses it (`no-show`, `not_allowed`), and `close` ends its wait; the manual calls it the content's unconfirmed text, never instructions, and says what is refused; the React provider's default `show` draws `ContextNotice`, whole, and lets a call go once its own update is on the page (one replaced before it was drawn is refused); named gates without `show` and without `withoutShow: true` earn a `ConfigWarning` | `12.model-context` (a raw `ui/update-model-context`: shown whole, then handled; a host without `show`: refused, no handler); `test/model-context.test.ts` (both adapters, the order, the shapes, the size, each invisible character in text, values and keys, the warning); `leak/react.spec.ts` (the default notice is drawn before the handler runs, with its size; two updates in one task: only the drawn one goes; stacked displays all reachable; no provider: refused) | `model-context-show` → `12.model-context` (all three, `scripts/controls.ts`; the kit's harness is built unweakened), and both React cases (measured on Chromium) |

Measured: a click in the frame gives the host page user activation (it propagates to
ancestors) on Chromium, WebKit and Firefox, so the host-side gesture check (`copyText`'s, and
any a host names) holds for real clicks; it is still advisory, since a person may have clicked
the host a moment before. Playwright's own page evaluations count as gestures, so the gate
probes (`12.copy-text`, `12.raw-copy`; `shell-gesture` → copy-text, `host-gesture` → raw-copy)
wait for that to lapse and click with raw input.

### Served content, each with its test

| What | Mechanism | Tests (all three engines unless noted) | Negative control → fails |
|------|-----------|-------|------------------|
| The host's check (P050) | `authorize.check` after a ticket or cookie verifies, before anything is served; a deny is a 403 page saying `denied` and the host's code, and the display's `outcome` says so (after `loaded` too in url mode; a served display that isn't nested is told by its next run's door, which takes a fresh ticket, P125) | `leak/served/authorize.spec.ts`: a revoked subject's ticket (a page, an app); a framed app's next request and reload mid-session (Chromium, Firefox: WebKit keeps no framed cookie, P025); a framed page's next load (every engine: its next run's door); an app and a page in a tab | `authorize` → every case but WebKit's framed app (no framed cookie) |
| Who may say how loading went (P124, P125) | a frame status (`porthole/notifications/frame-status`) draws the host's fallback, so it is taken only where content can't have said it. **A served display** (a served shell, a page, a view through the sandbox proxy) is framed on its scope's origin, where the scope's others run content: **no frame status from its frame is ever taken** (one `frame-status` host error a run), and its silence is a `timeout`, never `framing`. Its **door** said how loading went first, from a frame of the host's that no content can reach (`open`, or `blocked` and why, P125). An **opaque frame**'s every status is the content's. A **url-mode app**'s is taken, as before (S6). A served location **without a door** (an older server) raises a `hostError` of kind `door` once a mount and is strict (no status taken) | `test/outcome.test.ts` ("who may say how loading went (P124)", "a served display takes no frame status from its frame (P125)", and through `createHost`: the door hand-off, a door block with its code, door silence, a restart's new door); `leak/served/siblings-status.spec.ts`: a same-scope sibling that injects, reloads, stops, wipes a display, attacks the proxy, or reaches for the door, each on all three; `leak/served/outcome.spec.ts`: a served shell's content, a served page, an opaque widget and a nested page each say `blocked` and are shown nothing (the opaque and served-non-nested cases are the ordering rule / the door rule; the opaque rule 1 is proven by `test/outcome.test.ts` only, P124-3; the door's opacity, its namelessness and the sibling's navigation flag by the static sandbox test and `[door-reach]`) | `content-status` → the two served-content cases, `[sibling-inject]`, `[sibling-reload]`, `[proxy]`; `door-status` → `[sibling-inject]`, `[sibling-reload]`, `[proxy]`; `door-silence` → `[sibling-wipe]`; `door-opaque` → `[door-reach]`; `frame-status-order` → the nested case |
| Url-mode delegation (P049) | `allow` from `permissions`, `""` by default | `leak/served/permissions.spec.ts`: full screen follows it on all three; clipboard writes on Chromium only (WebKit and Firefox let any frame write in a click) | `url-permissions` → the default case (all three) |
| Siblings on the content domain (P101) | over https only `__Host-porthole-` names are read (a sibling sets any other name for the whole domain, never a `__Host-` one), names trimmed of spaces and tabs only; the entered mark is its label's and path's, read from a nonce cookie only; a url-mode app's request rides its cookie only from its own origin (`Origin`; `Sec-Fetch-Site` `same-origin` or `none`) or as a GET/HEAD navigation, else a 403 before the upstream and the host's check; a socket (`access`, `nodeHost`'s `appSocket`, a Worker's upgrade path) from its own origin only | `test/siblings.test.ts` (planted names, the mark on another label, every kind of request and socket, `nodeHost` over a real socket); `test/workers.test.ts` (workerd: a sibling's POST and socket refused, the app's own open); `served.url.siblings`: another app's frame (Chromium, Firefox: WebKit keeps no framed cookie, P025) or tab loading the app's script is refused, its own loads; `leak/kit.spec.ts`: the app's own WebSocket opens through `nodeHost`, a same-site sibling's doesn't; prod shape: a session copied under an unprefixed name and planted with `Domain=` opens nothing, and the socket case over wss | `url-origin` → `served.url.siblings` on the reference serving (Chromium, Firefox; its labels are cross-site on `*.localhost`, so only the framed half rides a cookie) |
| Porthole's libraries (P079) | `egress.libraries` (domain isolation; on in `presets.liveWidget`): `script-src <content origin>/__porthole/lib/`; `/server` serves Chart.js 4.5.1 and D3 7.9.0, npm's bytes, on every content origin, without a ticket, immutable | `test/libraries.test.ts` (npm's bytes, pinned, licenses; headers; nothing else under the path); `leak/served/live.spec.ts` (both load and draw in a live widget whose every other load and fetch reaches no oracle) | — (rows 1–2) |
| Library CDNs for artifacts (P048, P078) | `egress: LIBRARY_CDNS` in the host's artifact config; closed by default (P022); Tailwind's, jQuery's and Plotly's own CDNs for scripts only | `leak/cdn.spec.ts`: opaque and served, a CDN library loads only when opened; another origin never; a stylesheet, an image and a fetch never reach the libraries' own CDNs | — (the CSP of rows 1–2) |
| Files: serving (P081) | `StoredFiles`; the manifest only, decoded once; Porthole's type table, `nosniff`, a CSP on every answer, ETag/304, ranges, CORP `same-origin`, service workers refused; every page in the shell | `test/files.test.ts`; `leak/served/files.spec.ts`: many files by relative path (framed, on a tab), the Vite + React build, a newer version never reaches a running page, traversal 404s, `.html` as `.txt` is text, another origin reads nothing, no service worker | `service-worker` → "no service worker ever registers" (all three); `file-corp` → "another origin reads none of the files" (a page elsewhere runs the script, all three) |
| Files: the version's own path in the CSP (P082) | `fileSetCspDirectives`: `<origin><base>` (tab) or `<origin>/__porthole/f/` (frame) in the seven loading directives; never `'self'` | `leak/served/files.spec.ts`: a page loads no other version's files; a way out past the base is blocked | `file-self` → those two cases (another version's data and module load; `%2e%2e` past the base reaches the server; all three) |
| Files in a frame: access in the path (P083) | the ticket's answer is the entry; `/__porthole/f/<AES-GCM sealed session>/`; `history.replaceState` before anything loads; the host's check per file; an address opens on its own for an hour (then only the running page's own same-origin loads, till the session ends), renewed by the shell; reported as `./`, never whole | `test/files.test.ts` (sealed: no viewer or subject in it; another origin, a tampered or ended one: 401; revoked: 403; its hour, the page's own loads after it, renewal; redaction); `test/workers.test.ts` (workerd); every framed case of `leak/served/files.spec.ts` on WebKit (no cookie in frames), its reports never naming the address, its renewal under a moved clock | — |
| Files: pages navigate within the set (P084, P098) | the guard lets a navigation to a page under `files.base` go, after `porthole/navigating`, and the page it opened says so as it arrives, each naming its version; the host takes the next load as that page, or the load the notice came after: a load no notice for the mounted version explained waits `LATE_NOTICE_MS` holding the frame (nothing it says reaches the display), then starts it again | `leak/served/files.spec.ts`: a link opens another page in the frame, the display goes on, also with the leaving page's notice dropped or every notice late; a non-page file, `/`, `/__porthole/d/…` never open; `test/pages-of-set.test.ts`: another version's notice or a hello first restarts at once, nothing is answered during the wait | `navigate-guard` → the three link cases, "opens nothing else" and the sealed-address reports case (all three; the last measured failing before P098 too) |
| A page's own nested frames, opt-in (P128) | `nestedFrames: "own"` (off by default): the shell keeps an iframe with `srcdoc` or whose `src` is under `files.base` (`OWN_FRAME`, through the platform's getters) and removes every other frame and plugin as before; a kept frame leaves before a change would point it elsewhere (P030's guard; the observer watches `src`/`srcdoc`); a set's page has `frame-src` its version's path, its files `frame-ancestors` its own origin and the app's; refused for url mode, nested pages, live widgets. Inside a child frame none of the shell's defenses run (accepted) | `4.own-external`, `.own-turned`, `.own-default` (opaque: a srcdoc child's scripts don't run there, measured); `leak/served/files.spec.ts` "a page's own frames": its file (with its shell), a srcdoc and a made frame run; another site, `/`, `/__porthole/d/…`, `../../`, plugins stay out; by default none runs; `test/shell.test.ts`, `test/files.test.ts`, `test/check.test.ts` | `own-frame-rule` → `4.own-external`, `4.own-turned`, the served "stays out of the tree"; `own-frame-rule,own-frame-src` → that and "loads nothing" (the page's `frame-src`, the second wall); `frame-guard,sync-guard` → `4.own-external`, `4.own-turned`, `4.own-default` |
| A page on a tab of its own (P099) | every served page's CSP header carries the frame's sandbox (`sandbox allow-scripts allow-same-origin`, `servedSandboxDirective`) and its `Permissions-Policy` denies what the frame's `allow` doesn't grant (`servedPermissionsPolicy`); on a tab the shell answers `window.open` with null (but `_self`), refuses picture-in-picture windows, devices, location, full screen, passkeys, the share sheet, payments (Apple Pay too) and a video's full screen; its navigation guard (P079) stops the page navigating itself, and `navigation.navigate()` and a tab's `open(…, "_self")` ask its rule before they start (the address read once, through the platform's own functions); a tab's links are followed by the shell as clicked (cancelled in its first listener, found through the composed path, closed shadow roots made open to it), never by the browser; a lock that can't take says so (`data-porthole-unfixed`, a report to the host) | `test/server.test.ts`, `test/files.test.ts`, `test/policy.test.ts`, `test/agreement.test.ts` (every served page, in a frame, on a tab, without fetch metadata; never a script, a url-mode app or Porthole's own pages; the header held to the frame's `allow`); served conformance `served.domain.tab-window-open`, `.tab-escapes` (a target=_blank link clicked past the shell, forms, a blob download, `prompt`), `.tab-opener` (its opener sent elsewhere), `.tab-navigation` (a `blob:` document of its own and an outside site, each from a fresh tab by `location`, `assign`, `replace`, a link past the shell, `navigation.navigate()` and `open(…, "_self")`, the last two given a two-faced address too, a link and `navigate()` with the built-ins lying), `.tab-links` (a link's `href`, `target` or `download` changed after the shell read it, a link in an open or closed shadow root; a fragment link still jumps, a cancelled one goes nowhere), `.tab-devices` (location, camera and microphone granted by the browser, full screen after a click), `.tab-prompts` (a passkey, a payment to a canary method, a share, a video's full screen: each refused at once); `test/permissions-policy.test.ts` (the denied list against Chromium's, checked in); `leak/served/tab.spec.ts`: those five, a file set's page on a tab (its module, fetch and links to its own pages work; nothing else opens), a frame's sealed address opened on a tab | `tab-sandbox` → tab-escapes, tab-opener, the file set's and the sealed address's cases (all three); `tab-sandbox,window-open` → those and tab-window-open (all three; picture-in-picture opens on Chromium and Firefox, absent on WebKit); `permissions-policy,device-locks` → tab-devices (all three), tab-prompts (Chromium, Firefox; WebKit refused each at once here either way); `device-locks` alone → tab-devices on WebKit and Firefox (they don't apply the header; Chromium holds), tab-prompts on Firefox; `window-open` or `permissions-policy` alone → none; `navigate-guard` → tab-navigation, tab-links (all three; P096 measured the second); `navigate-ask` (the rule asked first, alone) → tab-navigation and tab-links on WebKit (Chromium and Firefox hold by the event); `link-rule` (the browser follows links again) → tab-links and tab-navigation on WebKit; `scripts/controls.ts` |
| The runtime: a page's declaration (P086) | the bridge refuses a capability the page didn't declare (`undeclared`), on `porthole/call` and 0.6's requests alike, before any handler | `test/runtime.test.ts`; `leak/served/runtime.spec.ts`: "an undeclared capability: null from use, refused when sent anyway, its handler never asked" | `runtime-declaration` → that case (all three) |
| The runtime: levels (P087) | each method's least level against the host's viewer, before any handler | `test/runtime.test.ts`, `test/assets.test.ts` (the grant's level to the bridge); `leak/served/runtime.spec.ts`: "a method above the viewer's level: forbidden, its handler never asked" | `runtime-level` → that case, and P094's "a read above the viewer's level: a result the host pushed is refused as a cold read is", whose reads stand on it (all three) |
| The runtime: a page's data names (P086, P094) | the bridge refuses a resource or tool the page's `data` doesn't name (`undeclared`), with a viewer and without one, before any handler | `test/audit-gates.test.ts`, `test/runtime.test.ts`; `leak/served/runtime.spec.ts`: "a resource outside the page's data names: refused with a viewer and without one, its handler never asked" | `runtime-data-names` → that case (all three) |
| Live data: a kept result is a read (P094) | a result the host pushed (`changed(result)`), or read after a stale answer, answers the frame's next read only past every gate a read has (level, names, rate, gesture, consent, confirm), with no new upstream call | `test/audit-gates.test.ts`; `leak/served/runtime.spec.ts`: "a read above the viewer's level: a result the host pushed is refused as a cold read is" | `live-held-read` → that case (all three) |
| The runtime: per-user data (P088) | `dbAccess`: `me` is the host's id; another's `data/users/<id>`, or anything else under `data`, refused at every level, in the bridge and the host | `test/runtime.test.ts`; `leak/served/runtime.spec.ts`: "a person's own data is theirs" | `db-private` → that case (all three) |
| The runtime: comments write-only (P090) | the bridge answers `comments` with `true` only for a handler's `true`; no read method | `test/runtime.test.ts`; `leak/served/runtime.spec.ts`: "comments are write-only" | `comments-result` → that case (all three) |
| The runtime: a comment's draft is visible text (P108) | the bridge refuses a draft that isn't a string, is blank, past 2,000 characters, or holds what a person can't see (`unseen`), before any handler | `test/runtime.test.ts`: "a draft (P108)"; `leak/served/runtime.spec.ts`: "a comment's draft is the host's to check" | `comment-draft` → that case (all three) |
| The runtime: a draft is visible text, strictly; the anchor beside it cleaned (P109) | a draft with a joiner (U+200C, U+200D) anywhere but between two letters or marks (first, last, doubled, beside a space or punctuation, in an emoji sequence), a line or paragraph separator, blank-looking text, more than 32 blanks or two blank lines in a row is refused; the label and quote lose what a person can't see, refused if nothing visible is left | `test/runtime.test.ts`: "a draft is visible text, strictly (P109)" | — (unit-tested: the bridge's own check, behind `comment-draft`'s) |
| The asset library (P089, P091) | `/_blob/<id>` (or the frame's `<sealed base>__porthole/blob/<id>`) for an access to its artifact (a cookie, a sealed `Referer`, the sealed path), then the host's check, the store asked with it; typed by name, never a page, code only where trusted and uploaded code may run (asked at each load; by id alone, every artifact config must, P103), inert CSP, CORP, revalidated; the page's CSP opens `<origin>/_blob/` for images, media, fonts and data, for scripts and styles only where uploads are the admins' | `test/assets.test.ts` (a forged same-origin claim: 401; another artifact's session: 404; revoked: 403; bearer mode; a stricter config turns trusted code into a download, bearer mode too); `leak/served/runtime.spec.ts`: an upload loads in its frame; a set's page loads it; static `/_blob/` in a frame by `Referer` (Chromium, Firefox; WebKit sends only the origin: measured); "a script asset runs as code only if an admin uploaded it"; "scripts load from /_blob/ only where uploads are the admins'"; "an asset reaches only its own artifact's pages"; "an asset opened on its own runs nothing" | `blob-trusted` → the trusted-code case; `blob-script,blob-trusted` (two walls) → that case and the tab's CSP case; `blob-inert` → the opened-on-its-own case (all three; `scripts/controls.ts`) |
| Workers (P044, P045) | no Node module in `/server`; D1 tickets taken by one `DELETE … RETURNING` | `test/workers.test.ts` (workerd, no `nodejs_compat`, real D1: once per ticket, a race, anonymous, a revocation, flat names, reserved namespaces) | — |
| An embedded document (P143) | grant `embed` (only with the server's `embeds: true`, anonymous, no level or user, an artifact's page; signed into the session as `m` and into the sealed address) → `frame-ancestors *` for that session's answers alone (its document, a file set's pages and files and own frames, assets, renewals, its status and ended-access pages); an embed session's cookie has a name of its own (`e-<key>`) and never stands in for another session; the plan names no host (`origins: []`): the shell asks no host, ends its handshake at once (`"none"`), says nothing to any parent (no `*` notices, no annotation or find report) and hears no one; no door; `statusPage` and `doorStatusResponse` take `embed` (`*`, `data-porthole-hosts="[]"`); the host kit refuses an `access` answer with `embed` (P145: minted through `host.server.issue` alone) | `test/embed.test.ts` (refused without `embeds`, with a viewer, a level or a user, for url mode, a nested display, a served shell or the proxy, at a clean address and at the door; the host kit refuses it from `access` at its issue endpoint, a clean address's resolve and its tab, with `embeds` or without; the flag can't be added or stripped, nor a session moved to the other name; **the bound**: 23 kinds of answer under an embed session say `*` and name no host, and the same under a public and a viewer's session are byte for byte what a server without `embeds` answers, on the same server while an embed session of the same artifact exists, and with both cookies sent; the host's check is told `embed`; cookies host-only, never `Domain=`); `test/shell.test.ts` (P143's handshake); `leak/served/embed.spec.ts`: `[embed.loads]`, `[embed.unheard]` (the words before the document loads too, P145), `[embed.untold]`, `[embed.no-escape]`, `[embed.reader-unframeable]` | `embed-ancestors` → `[embed.reader-unframeable]`; `embed-handshake` → `[embed.untold]`; `embed-origins` → `[embed.unheard]` (all three) |

### The clipboard, and copy buttons

Content never writes the clipboard (P051). The frame's `allow` denies
`clipboard-read` and `clipboard-write` by name; the shell makes the async Clipboard
API refuse (`write`, `writeText`, `read`, `readText`), makes `execCommand` refuse
`copy`, `cut` and `paste`, and stops copy and cut events at the window before any
listener of the content's, so a copy the person makes copies their selection as the
browser makes it. Copy buttons call `copyText(text)` (P052): the host's page
writes the clipboard, inside the person's click (a click in a frame activates its
ancestors), and shows them what went on it.

| # | Channel | Mechanism | Probes | Negative control → fails |
|---|---------|-----------|--------|--------------------------|
| 13 | the async Clipboard API in a click (`writeText`, `write`, `readText`) | the shell's lock; Chromium also by the `allow` denial | `13.clipboard-api` | `clipboard` → WebKit, Firefox, with `14.shell`'s clipboard (Chromium holds by the `allow` denial) |
| 13 | `execCommand("copy")`/`("cut")` of the content's own selected text | the shell refuses the commands | `13.clipboard-command` | `clipboard` → all three |
| 13 | a copy listener swapping what the person copies (`clipboardData.setData`) | copy and cut events stopped at the window, first | `13.clipboard-event` (the person's own copy works: positive control) | `clipboard` → all three |
| 12 | `copyText` | a click (shell and host), 30 a minute, the host's handler | `12.copy-text` (refused on load; the whole text reaches the handler from a click) | — |

Measured before the walls: a click in an opaque widget wrote the clipboard
on all three engines (the async API on WebKit and Firefox, the copy command and copy
listeners everywhere). The oracle is the person's clipboard: text copied on the
host's page, then pasted back there. What the shell can't stop: text hidden by CSS
inside what the person selects goes with their copy (the browser's own copy); hosts
that care point people at copy buttons, whose toast shows exactly what was copied.

### Annotations

A person points at part of a display to comment on it (P053). The host drives the shell with
Porthole's own messages and the shell reports back. The config declares `annotate` (inline
widgets and artifact pages; MCP Apps views where the host chooses), and only then is the
annotation runtime in the shell. How a host wires it, and what it must do, is
[ADOPTING.md § Annotations](ADOPTING.md#annotations-comments-on-a-display); what a page can learn
or fake is [THREAT_MODEL.md § 7](THREAT_MODEL.md#7-the-display-layer-and-the-app-runtime).

| Direction | Message | Params |
|-----------|---------|--------|
| host → frame | `porthole/annotate.start` | `{ elements, text, keepSelection? }`: picking elements (the one under the pointer or finger outlined with its name; a click or tap picks it, never reaching the content; Escape cancels; one pick), selecting text (each settled selection), or both (a click picks, a drag selects); `keepSelection: true`: the host will follow what is selected, so the frame keeps it, and a pick's outline (P140) |
| host → frame | `porthole/annotate.stop` | — |
| host → frame | `porthole/annotate.show` | `{ marks: [{ id, anchor, count?, kind? }], active? }`: drawn in the shell's own layer, found again whenever the content changes; a `count` (0 to 999; the host clamps a larger one, P116) gives a marker (P104); `kind: "draft"` (absent: posted) is drawn apart, with a marker and never a count (P107) |
| host → frame | `porthole/annotate.focus` | `{ id }`: scrolled into view inside the frame, made the active mark, flashed |
| host → frame | `porthole/annotate.clear` | — |
| host → frame | `porthole/annotate.clearSelection` | —: the page's text selection is taken away (the DOM's own `removeAllRanges`, taken before content runs) with what the shell held of it; nothing is reported back; marks, drafts and the mode stay (P115) |
| host → frame | `porthole/annotate.focusMark` | `{ id, at }`, `at` the host's `Date.now()` as it sent it: the DOM focus goes to that mark's marker once the marks of a `show` are found. Dropped if it had to wait and the focus isn't in the frame's document as it lands (the DOM's own `hasFocus`, P135), if the frame takes it 100 ms or more after `at` by its own clock (the DOM's own `Date.now`), or with no `at` (P137); the built-ins are taken before content runs. Nothing is reported back; with no such marker, or while elements are picked, nothing happens. For after the keyboard closed the host's view: Escape, or a Tab past its ends (P134) |
| host → frame | `porthole/annotate.track` | `{ id }` or `{ id: null }`: follow one shown mark, or none (P112); `{ id: null, selection: true }`: follow the selection last reported as `selected`, highlighted while followed (P138; an older shell reads it as none) |
| frame → host | `porthole/annotate.selected` | `{ anchor, rect, lastLineDocumentRect?, scroll? }` (the last two only as a pair, P133, P137); after a scroll, sent again only if its box moved more than 0.5 px, on the follow-ups' clock (P105), and not while the host follows the selection (P138) |
| frame → host | `porthole/annotate.unselected` | — (the text selection went away) |
| frame → host | `porthole/annotate.cancelled` | — (Escape) |
| frame → host | `porthole/annotate.anchored` | `{ results: [{ id, state: "attached" \| "orphaned", rect?, documentRect?, lastLineDocumentRect?, order? }], scroll? }`: every mark after `show`, the one after `focus`, every mark when the content changed a state; while any mark has a marker, once a scroll, a resize or a run of content changes has settled (150 ms quiet), only the marks that moved more than 0.5 px since the host was last told, at most one a second together with the selection's (P104, P105) |
| frame → host | `porthole/annotate.tracked` | `{ id, rect, documentRect?, lastLineDocumentRect?, scroll? }`: the followed mark's box at an animation frame where it moved, at most one every 16 ms; the host takes 60 a second, for that mark only (P112, P132, P133) |
| frame → host | `porthole/annotate.selectionTracked` | `{ state: "attached", rect, documentRect, lastLineDocumentRect?, scroll, inView }` or `{ state: "orphaned" }`: the followed selection's boxes, as `tracked`'s, also when the viewport changed size, the first at the frame after the host asks; `orphaned` once while it isn't in the page, found again by its anchor at most twice a second. The host takes it only while it follows the selection (otherwise dropped unread, no refusal, P140), 60 a second with `tracked`, its `rect` clamped, `inView` false unless its box reaches the viewport (P138) |
| frame → host | `porthole/annotate.activated` | `{ id, rect }`: the person clicked a mark's marker, or pressed Enter or Space on it (P133); `rect` is the marker's (P104); no gesture is asked of it (P149) |

- **Anchors** are W3C Web Annotation selectors, at most one of each: `CssSelector` (unique: the
  nearest id, else a path of `nth-of-type` steps), `TextQuoteSelector` (the words, with 32
  characters of context each side), and `TextPositionSelector` (offsets into the body's text,
  without scripts, styles and templates). An element anchor has its selector and its first 300
  characters of text; a text anchor its words (at most 4,000), position and nearest element.
- **Found again**, best-effort: a text anchor where it was, else its words anywhere (the
  occurrence whose context matches best), else its words with any spacing; an element anchor by
  its selector if its text still starts with its words (or the selector is an id, or it has no
  words), else the element holding its words. What can't be found is `orphaned`; a host keeps
  the comment and shows it apart.
- **Boxes.** `rect` is in the frame's viewport, CSS px (the host adds the frame element's
  position and maps it through the frame's transform). `createHost` clamps each `rect` to the
  frame's viewport (P104): a box wholly outside becomes one of no size on the nearest edge; a
  platform whose `viewport()` answers no size or throws gets nothing at the corner (P105).
  `documentRect` (P132) is the box plus the document's scroll as it was read (the report's
  `scroll`, `{ x, y }`, read with the DOM's own `getBoundingClientRect`), so it says where a mark
  outside the frame is; `rect` is `documentRect` less `scroll`, before the clamp.
  `lastLineDocumentRect` (P133) is the last box with a width of the words' client rects (an
  element's whole box), in the same coordinates, for a host's UI after a selection or a mark.
  `createHost` checks these as boxes (finite, within the coordinate limit, sizes not negative; a
  malformed one drops the report) and clamps neither: the host clips what it draws. A page that
  scrolls a box of its own rather than its document moves its marks' places with it, as `rect`.
- **The selection followed** (P138, P140). For a host that follows the selection, or said at
  `start` that it will (`keepSelection`), the shell keeps what each `selected` reported: the
  element picked, or a copy of the selection's range (the DOM's own `cloneRange`), kept up to date
  through the page's changes and kept when the page's own selection goes. While followed (one
  followed thing at a time: a mark's id, `null` or `clear` ends it; `show`, `stop` and a pick's end
  leave it), it is drawn in the layer (an element outlined, lighter and without its name; words
  with a light fill and an underline) and its boxes are told as a followed mark's, with `inView`.
  It reads boxes only: no focus moves, no selection changes, no listener is added, and nothing
  about the words goes with it. Under `keepSelection`, before a follow, the element just picked
  keeps the same outline, so nothing changes on screen when the follow takes over; it ends as a
  selection does (the next pick or selection, `clearSelection`, `start`, `stop`, `clear`, Escape,
  the element leaving the page), on no timer. The end of a following lets the kept selection go
  unless `keepSelection` holds; for any other host nothing is kept and a pick's outline goes with
  the pick. The React binding sends the following before a mode change made in the same render,
  and starts the mode with `keepSelection` while `trackedSelection` is given (read at each start,
  never a reason for one).
- **Markers** (P104, P133). A mark with a `count` gets a bubble glyph and its number ("99+" above
  99; 0 the bubble alone), a real `<button>`, on an element's top right corner, or at the end of a
  text anchor's paragraph, just past the last word of its last line, or where that doesn't fit, at the places a draft's takes. A draft's goes beside its
  own last line: in the line's gutter past the block's right edge, at the frame's right edge where
  the frame is too narrow, or just past the line's last word where something else is beside the
  block (P105, #36). Each place must be clear of that line's words and of anything of the
  content's but a box holding the anchor (the shell hit-tests it). Markers on one line go
  together in the order their words end; where the bubble doesn't fit, its number alone does
  (compact); where neither does, they go over the line's end. The pointer on a marker lights its
  words; an element's mark with a marker is a thin line. Placing costs a bounded number of hit
  tests per marker in view, none out of view, and reads a line's end only as far as the line goes
  (P105: 300 marks with counts in view, about 20 ms a change).
- **The layer** is a closed shadow root, the document's last child, and takes no pointer but on
  markers. A press on a marker, and the pointer's moves over it, are stopped in the shell's first
  window listener, read through built-ins kept before content runs (P105); a trusted click or a
  tap is reported `activated`. On touch (P119), while the last pointer down or moved was a finger
  or a pen (before any, where `(any-pointer: coarse)` matches), each marker also takes the pointer
  in a box of at least 44 by 44 px centred on its bubble (an invisible `::before` in the layer),
  the nearest bubble's where two overlap; a mouse's move takes the boxes away, so a mouse is
  hit-tested on bubbles alone. Content that patches no built-in hears none of a press; content
  that patches others can reach the layer's nodes (P105); either way it can tell a press happened
  (`:active`, `relatedTarget`, user activation). A pointer's press moves no focus. Markers step
  aside while elements are picked, from Tab as well.
- **The keyboard** (P133, P134). Each marker has a tab stop after the page's own, and a name
  (`aria-label`: `3 comments on "…"`, `Draft comment on "…"`, an element's tag left out, P134, in
  English); only markers are exposed to assistive technology. Enter and Space make the button's own trusted click, the focused
  marker's (the shadow root's `activeElement`, kept before content runs); those keys are stopped
  at the window, a held key clicks once, and every other key stays the page's. A real key gives
  the host's page transient activation as a click does. Focus on a marker lights its words and,
  out of view, scrolls the document to it (the layer clips rather than hides, so it never scrolls
  itself). While one has the focus, a draw moves none and takes
  the markers out of hit tests by `pointer-events`, not `display`. The host's own list of marks
  stays the keyboard path it can rely on.
- **Drafts** (P107). A mark with `kind: "draft"` has a marker with or without a count, placed by
  its own words, and drawn apart: a dashed underline (a dashed outline on an element), a lighter
  fill, a hollow marker with no number. `checkMarks` sends a draft without its count and throws on
  an unknown kind; the shell draws no number for a draft and drops a mark of a kind it doesn't
  know. Its click, place and following are a posted marker's.
- **Following and budgets** (P104, P105). Only while a mark has a marker (a count or a draft),
  each mark keeps what the host was last told; a settled scroll or resize (any scroller), or a
  quiet run of content changes, reports only what moved. A selection already told is told again
  after a settled scroll only if its box moved. Both share one clock, at most one report a second,
  so honest scrolling takes at most half of the bridge's 120 a minute.
- **Settled** (P057). Nothing is reported before the content is in place (marks shown before it
  arrives are anchored once it has), nor while a run of changes settles; a `focus` asked for
  meanwhile waits for anchoring, so a focus right after `show` is never `orphaned` first.
- **What the host takes.** A selection only while it asked for that kind, a cancel only while
  picking, results only for its own marks, a marker's click only for a mark it shows with a
  marker, with or without a gesture (P149). It rebuilds each from known fields within
  `ANNOTATION_LIMITS` (a label without what the person can't see, P105), drops the rest, and
  passes it through the bridge's rate limit. A report decides where a comment is drawn, never who
  may see or do anything.
- **Host API.** `display.annotations.start(mode?)`, `stop()`, `show(marks)`, `focus(id)`,
  `track(id)`, `clear()`, `clearSelection()`, `focusMark(id)`, and the `annotation` event
  (`AnnotationReport`); the state is given to every frame the display runs (not `clearSelection`
  or `focusMark`). `parseAnchor` checks an anchor a host stores.

Tests (`leak/annotate.spec.ts`, and `leak/late-word.spec.ts` for a word a busy page takes late,
which full Chromium runs too; all three engines): picking and selecting unseen by the content;
marks shown, focused, orphaned and found again on a revised page; follow-ups only for what moved,
within their budget; markers placed clear of words, reported by click, tap and key and heard by
none of the content, also against patched built-ins; `focusMark` landing only when it should;
drafts drawn apart; the selection followed; `clearSelection` against a patched `removeAllRanges`;
a hostile page faking every report; and ADOPTING.md's `guardPresses`, as written there, taking no
press within 500 ms of its view opening and the person's own press or key after. Each case's
negative control is in § The negative controls.

### Find in page

A host's own find bar over a display (P131), where the config declares `find`. How a host wires
it is [ADOPTING.md § Find in page](ADOPTING.md#find-in-page-the-hosts-find-bar); what the page
learns is [THREAT_MODEL.md § 7](THREAT_MODEL.md#7-the-display-layer-and-the-app-runtime).

- **Shell.** `FIND_RUNTIME` (`src/shell/find.ts`), spliced in as the annotation runtime is, before
  content runs. It finds a query (`porthole/find.query`, a request) in annotations' text index
  (`TEXT_INDEX`, `src/shell/text.ts`, shared), case-insensitive and loose about spacing
  (`FIND_MATCH`), only matches that are drawn, at most 1,000; draws them in a layer of its own (a
  closed shadow root, annotations' layer style; never the CSS Custom Highlight API, which is the
  content's to read and rewrite), the current one apart, redrawn on scroll and
  resize and found again as the content changes (`porthole/find.updated`, at most once a second);
  brings the current one into view through its scrolling ancestors and the window; and, while the
  host says it draws its own bar (`porthole/find.handled`), cancels the browser's find on Cmd+F or
  Ctrl+F a page didn't take (`FIND_SHORTCUT`) and says `porthole/find.requested`. Like the guards
  (P129), it and the text index call only built-ins captured before content runs, through
  `callOf`; its layer goes in through the guarded insertion methods (P130,
  [insertion-entry-points.md](insertion-entry-points.md) § The shell's own layers).
- **Host API.** `display.find.query(query, { direction, caseSensitive })` → `{ total, active,
  capped?, rect? }` or `"unsupported"` (no `find`, an older shell's `-32601`, a malformed answer, no
  answer in `FIND_LIMITS.timeoutMs`, a query superseded by a later one: the shell searches only the
  latest of a burst, `FIND_LATEST`), `clear()`, `takeShortcut(take)`; the query holds only for the
  content it was asked of (a new run or other content forgets it); events `findRequested`
  (only while taken, with the page's focus in the frame) and `findUpdated` (only while a query is
  shown), checked and rate-limited through the bridge. React: `onFindRequested`, `onFindUpdated`,
  and the handle's `find` and `clearFind`.
- **Trust.** The page reads every query; what it says back is a find bar's numbers. Tests:
  `test/find.test.ts` (the matching and its limits, the shortcut rule, the checks, the shell's
  splice and built-ins, only the latest query, `createHost`'s requests, answers, forgetting and
  gates, the React handle's scope); `leak/find.spec.ts`
  on three engines (highlights, next and previous into view, a scrolling box, a change found again,
  the shortcut the host's only while taken and the page's own find keeping it, and a hostile page's
  `requested` while the person types in the host's composer dropped: `find-requested-focus`).

## The shell runtime

The runtime (`src/shell/runtime.ts`, plain ES2020, no build) runs first in every
frame it serves. Before any content: an in-memory `localStorage` (opaque frames), the
WebRTC removal (item 3), the frame and hint guards (items 4, 8: the observer, the
wrapped `attachShadow`, the synchronous insertion and attribute guards), and the
closed parser entry points (P029). Then, when it speaks for the content: the
handshake, the theme (P028), content drawn inert while partial and run once when
whole (a fragment parsed in a template, its scripts recreated in order; a document
parsed with `DOMParser` and imported, its scripts recreated in order, then
`DOMContentLoaded` and `load`), size and error reports, and link clicks sent out
through `openLink`. A view that speaks for itself (`protocol: "none"`, MCP Apps) is
rendered the same way from the plan, once the shell's document has loaded.

## Streaming

Agents write a widget's code over seconds, so the shell renders it as it grows
(PRINCIPLE 10 — the manual tells the agent to order it styles → markup →
scripts). While the code is incomplete the shell draws the **markup inert**: it
parses in a `<template>`, removes anything that runs or navigates (`script`,
frames, `on*` handlers, `javascript:` URLs) and changes only what changed, so an
image does not reload and an animation does not restart. When the code is
complete the shell drops the draft and renders once, running scripts in order
(external ones awaited). Partial input never runs code. The adapter carries this
as MCP Apps `tool-input-partial` (0..n) then `tool-input` (once). A leak-suite
test asserts: markup appears as it streams, no script or handler runs until the
code is whole, then runs exactly once.

## Theme and base styles

The theme vocabulary is the MCP Apps style variables (`--color-background-*`,
`--color-text-*`, `--color-border-*`, `--color-ring-*`, `--font-*`,
`--border-radius-*`, `--border-width-regular`, `--shadow-*`) plus Porthole's own
`--color-accent(-soft)` and chart palette (`--color-chart-1…8`, `-seq-1…7`,
`-neg/-mid/-pos`), each with a neutral light and dark default
(`src/theme/variables.ts`). A host supplies live values for the same names from
its own tokens (`HostOptions.theme`); `resolveTheme` takes a host value for each
declared name, the default otherwise, and drops undeclared names. The shell
applies them in place on a flip and fires the theme event; the host's values are
read two frames after the flip, so a host that restyles on its next frame is read
after it has (`refreshTheme()` reads them again, P043). A host drops a default it
doesn't want with `null` in a preset's theme. Its base styles set the body's type
and color from the variables; base styles for native form elements (buttons,
inputs) are the only further look Porthole adds, as plain CSS (P015). A whole
document (an artifact page) takes the person's scheme only when it declares it
supports both, `<meta name="color-scheme" content="light dark">`, or the host sets
`theme.documents: "always"`; otherwise it shows as its author styled it (P039).

## Guide generation

The manual and the tool description are generated from the same config, lazily,
so they cannot teach a variable the shell does not inject or a capability the CSP
blocks (PRINCIPLE 3, 10). Topics: `widget` (what to pass, where it runs, sizes that
read on a phone, what is not allowed, the network in prose from the CSP's origins,
the size limit, libraries when scripts may load, the color variables by group,
diagrams), `chart` (form, look, size, libraries or hand-drawn SVG, the chart
palette, marks, reading values), and `interactive` (one entry per declared
capability, with its gates in words, and how state behaves under the isolation
mode); a host adds its own topics (`guide.topics`) for its own tools. A sentence
that needs a variable the config doesn't declare, and an example that uses one, is
left out. The examples (`GUIDE_EXAMPLES`) use only the default theme and no
network; the leak suite renders each through the real sandbox at phone and desktop
widths in light and dark and asserts it reads (no overflow, text above a floor
size) — the guide's examples are themselves conformance cases.

The `widget` topic's "The sandbox:" list states every limit that silently changes
how content behaves, each one line derived from the config (`manualLimits`, P064):

| Limit | Says | Stated when | Checks (all three engines) |
|-------|------|-------------|----------------------------|
| `silent` | what's blocked shows nothing on the page (nothing loads, a fetch rejects); where it is reported follows `errors` (P067): back to the agent, to the app only, to the app, or (no `reportError`) nowhere | always | `14.silent` |
| `network` | what loads from where, from the CSP's sources | always | `1.connect`, `2.resources` |
| `inline-assets` | images, fonts and sound inline as data: URLs or SVG; CSS in a `<style>` | something is open (else Network: none says it) | `14.inline-assets` |
| `dialogs` | alert/confirm/prompt show nothing: confirm false, prompt null | no `allow-modals` | `14.dialogs` |
| `print` | `window.print()` does nothing | no `allow-modals` | `14.print` |
| `downloads` | no `<a download>`, data:/blob: links or script saves; `downloadFile` if declared | no `allow-downloads` | `14.downloads`, `6.download` |
| `forms` | forms never submit and some browsers fire no submit event: `type="button"` and a click handler | no `allow-forms` | `14.forms` |
| `link-schemes` | mailto:, tel:, sms: open nothing: show the text | always | `14.link-schemes` |
| `windows` | window.open and target=_blank open no window (null or a throw); through `openLink` if declared | no `allow-popups` | `14.windows`, `6.open` |
| `devices` | camera, microphone, location, sharing denied without asking; file inputs and FileReader work | always | `14.devices` |
| `workers` | blob: Web Workers work; no service workers; no WebRTC | always | `14.workers`, `3.webrtc` |
| `sound` | sound plays only from a click | always | `14.sound` |
| `address` | about:srcdoc (opaque) or its own address with Porthole's ticket (domain) | always | `14.address`, `served.domain.address` |
| `shell` | document.write/open throw; nested frames removed (with `nestedFrames: "own"`, P128: but `srcdoc` ones and frames of the page's own files); full screen and clipboard closed | always | `14.shell`, `4.document-write`, `4.light-dom`, `4.own-external` |
| `storage` (interactive topic) | per isolation; in domain mode reads and writes can throw: try/catch | always | `14.storage`, `served.domain.storage-scope` |

Three more limits sit outside the list:
- `layout` (where it runs): a card whose height follows its content, or `layout.kind:
  "fill"`, a frame as tall as its box with the page scrolling itself. Checks: `11.size`, `14.fill`.
- `theme` (where it runs): the person's theme, a page that declares it, or
  `theme.documents: "never"`, always light. Checks: `11.theme-flip`, `11.document-theme`,
  `14.theme-never`.
- `errors` (interactive): `errors: "agent" | "host" | "none"`. Checks: `14.errors`, `14.error-shapes`.

They are config facts a whole-page viewer needed (P065):
- `layout.kind: "fill"` makes every mount fill its container (`MountOptions.fill`, React
  `fill`). The manual says the page fills the app's viewer (as tall as that, often smaller than
  the window), that `position: fixed` and `sticky` work, and to read the frame's own width,
  designing for the phone's width first; it drops the card's height cap and the "no
  `position: fixed`" line.
- `theme.documents: "never"` (pages only) gives the frame light values and a light
  `color-scheme`. A host flip doesn't reach it, so it hears no theme event. The manual says
  style it yourself, and not to rely on `prefers-color-scheme`. Measured with the person on
  dark: inside, that query says light on WebKit and Firefox (they follow the frame element's
  `color-scheme`) and dark on Chromium.
- `limits.maxBytes` is stated in KB or MB (`Keep it under 10 MB.`).
- `storage.scope` names what one display's storage is kept for ("this artifact, across its
  versions"), without `storage.shared`'s prefix advice.
- `errors` says where the content's errors go: back to the agent, to the app only, or nowhere
  (no `reportError`). Absent, the manual says "reported to the app".

`test/limits.test.ts` fails if a limit names no check, names one no suite defines,
or the list holds a line that isn't a limit. Measured differences, each stated as
the behavior safe everywhere:
- submit events fire on WebKit only;
- `window.open` returns null on Chromium and WebKit and throws on Firefox;
- reading `navigator.serviceWorker` in an opaque frame throws on Chromium and
  WebKit, and `register` rejects on Firefox;
- `play()` without a click is refused on Chromium and WebKit, and allowed by
  Playwright's Firefox;
- Web Share is absent on all three desktop engines.

On a page whose own policy closes blob: workers, `14.workers` reports itself
inapplicable (P058).

## MCP Apps adapter vs AppBridge

The official SDK ships `AppBridge` (host side), which extends the MCP SDK's
`Protocol` class and pulls in the MCP client/core packages. **Decision: Porthole's
MCP adapter reimplements the thin host-side subset of MCP Apps that maps to
capabilities; it does not embed AppBridge** (P007), and no AppBridge-backed adapter
is offered for now (P014). On the **widget side** we reimplement nothing — authors
use the official `App` SDK, which is exactly the point of speaking the standard.
Upstream, once the code and tests exist (P018), we contribute what is general: the
conformance/leak runner, the container-agnostic framing note (a single hardened
frame instead of the mandated double-iframe, where equally secure), and the
shadow-root / document-rewrite frame-escape findings.


## The leak / conformance suite

A Playwright suite (`@botiverse/porthole/conformance`) that:

- drives a **platform host** (the web iframe host, and later others) through an
  **adapter**, via a small host **test interface** (`ConformanceHost`: launch a
  display in a fresh page; answer confirmations; read the calls that reached the
  handlers and the errors; flip the theme) so the suite is not coupled to any one
  host's DOM — aligned with the upstream conformance-interface effort so results
  can feed it;
- is registered by the host in a spec file of its own (`leakTests(host)`,
  `servedTests(host)`: one entry per probe, `test(each.title, ({ page, browserName },
  info) => each.run({ page, browserName }, info))`), so its tests are located there
  and selected by that file or a probe id; it runs on the host's own Playwright, which
  Porthole doesn't declare (P041);
- runs every egress and escape probe in the table above, each attempting its
  channel and asserting nothing leaves, using out-of-band oracles (`httpOracle`: a
  local HTTP server that also counts TCP connections; `udpOracle`: a UDP listener
  for STUN), each with its positive control;
- runs the MCP Apps examples unmodified and checks the lifecycle and interaction;
- renders the generated guide's examples and checks they read at the target
  widths and themes.

Porthole runs it against its own reference host (`leak/host/reference.ts`, the real
`createHost` in a page; `leak/reference-host.ts`, its `ConformanceHost`; served by
`leak/server.ts`, which serves the core's TypeScript stripped as Node does, with the
embedding CSP `embedderCsp` derives): `pnpm test:leak` runs Chromium, WebKit and
Firefox;
`PORTHOLE_LEAK_ENGINES=chromium` runs a subset where an engine's system libraries
are missing; `PORTHOLE_LEAK_WEAKEN=<control>[,<control>]` serves the core with
defenses taken out (P032; § The negative controls lists what each must fail).
`ConformanceHost.launch` called twice on one page shows two displays side by side
(`9.siblings`).

### The negative controls

Every control the suite has is in one registry (`leak/controls.ts`, P096): the specs it
is run with and the tests it must fail on each engine, each named exactly (a probe's
`[id]`, a served case's id, or a test's whole title). `pnpm --filter @botiverse/porthole
test:controls` (`scripts/controls.ts`; in CI, a job per engine) runs each of them and
requires its tests to fail by their verdicts, on every engine asked, and every other test
of its specs to pass. A probe's verdict is its deciding `expect`, whose message starts
`probe: ` (in the shipped probes and in the spec tests the registry names); a failure of
its setup or of a positive control is no failure of the wall. A run that didn't happen, an
engine missing from the report, a probe skipped, never run, timed out or failed by anything
but its verdict, or a test declared to fail (`test.fail`) that passes, fails the check. A
control that fails nothing on an engine says why: another wall holds, shown by a combined
control that takes both out and fails something there, or no probe can see the wall; one
that fails "every other test" takes out what all of them stand on (`nonce`: the shell),
and none of them may pass. No control runs `kit.spec.ts`: the kit's reference app runs
Porthole in Node, where no weakening reaches (`UNWEAKENED`). In CI a whole engine's controls
outlast a job, so each job runs one of four shards of the registry (`--shard k/4`, split by
measured weight, stable for a registry), and the `controls` job checks every shard's verdicts
(`--summary`): every control ran and held on every engine. The table is the registry's
(`node scripts/controls.ts --table` prints it; `test/controls.test.ts` holds them equal,
every weakening to a control, every control that fails nothing to its reason, and every
control the tables above name to the registry):

| Control | Run with | Fails on every engine | Fails only on | Where it fails nothing, or may skip, why |
|---------|----------|-----------------------|---------------|-----------------------------|
| `connect-src` | `leak.spec.ts` | `[1.connect]`, `[14.silent]` | — | — |
| `webrtc` | `leak.spec.ts` | `[3.webrtc]`, `[14.workers]` | — | — |
| `frame-guard` | `leak.spec.ts` | nothing | — | the synchronous guard drops what the observer would, or refuses it at creation (P130) (`frame-guard,sync-guard`) |
| `attach-shadow` | `leak.spec.ts` | nothing | — | the synchronous guard refuses the frame at creation (P130), and reaches a closed shadow root's frames as they connect (`attach-shadow,sync-guard`) |
| `sync-guard` | `leak.spec.ts` | nothing | WebKit: `[8.preconnect]` | on Chromium and Firefox the observer removes what the synchronous guard would, and no preconnect opens even unsandboxed (measured) (`frame-guard,sync-guard`) |
| `frame-guard,sync-guard` | `leak.spec.ts` | `[4.light-dom]`, `[4.sync-realm]`, `[4.plugins]`, `[4.foreign-object]`, `[4.template-clone]`, `[7.base-plugins]`, `[14.shell]`, `[4.own-external]`, `[4.own-turned]`, `[4.own-default]` | WebKit: `[8.preconnect]` | — |
| `own-frame-rule` | `leak.spec.ts`, `served/files.spec.ts` | `[4.own-external]`, `[4.own-turned]`, `a page's own frames, opted in (P128): a frame of another site, of another path of its origin, or a plugin stays out of the tree` | — | — |
| `own-frame-rule,own-frame-src` | `served/files.spec.ts` | `a page's own frames, opted in (P128): a frame of another site, of another path of its origin, or a plugin stays out of the tree`, `a page's own frames, opted in (P128): a frame of another site or of another path of its origin loads nothing` | — | — |
| `attach-shadow,sync-guard` | `leak.spec.ts` | `[4.closed-shadow]`, `[4.shadow-nested]` | WebKit: `[8.preconnect]` | — |
| `declarative-shadow` | `leak.spec.ts` | `[4.declarative-shadow]` | — | — |
| `parser-entry-points` | `leak.spec.ts` | `[4.document-write]`, `[14.shell]` | — | — |
| `embedder-csp` | `leak.spec.ts` | `[5.location]`, `[5.replace]`, `[5.open-self]`, `[5.anchor]`, `[5.svg-link]`, `[5.host-origin]`, `[5.blob]`, `[5.data]`, `[6.remote-download]` | — | — |
| `embedder-self` | `leak.spec.ts` | `[5.host-origin]` | — | — |
| `sandbox` | `leak.spec.ts` | `[6.open]`, `[6.blank-link]`, `[6.top]`, `[6.top-link]`, `[6.parent]`, `[14.dialogs]`, `[14.windows]` | Chromium: `[6.download]`, `[14.print]`; Firefox: `[14.print]` | — |
| `base-uri` | `leak.spec.ts` | `[7.base-plugins]` | — | — |
| `self` | `leak.spec.ts` | nothing | — | no probe can see it: an opaque frame's 'self' matches no origin, so 'self' in its CSP reaches nothing of the host on any engine (measured, P022); kept out because nothing needs it, and its run checks that it still opens nothing |
| `style-split` | `leak.spec.ts` | `[0.app-sdk-inline]`, `[0.app-sdk-artifact]`, `[0.app-sdk-mcp-app]` | — | — |
| `draft-inert` | `leak.spec.ts` | `[11.streaming]` | — | — |
| `document-theme` | `leak.spec.ts` | `[11.document-theme]`, `[14.theme-never]` | — | — |
| `confirm-gate` | `leak.spec.ts` | `[12.prompt-confirm]`, `[12.raw-message]`, `[12.link]`, `[12.mute]`, `[12.no-confirm]`, `[14.windows]` | — | — |
| `shell-gesture` | `leak.spec.ts` | `[12.copy-text]` | — | — |
| `host-gesture` | `leak.spec.ts` | `[12.raw-copy]` | — | — |
| `model-context-show` | `leak.spec.ts` | `[12.model-context]` | — | — |
| `link-scheme` | `leak.spec.ts` | `[12.link]` | — | — |
| `clipboard` | `leak.spec.ts` | `[13.clipboard-command]`, `[13.clipboard-event]` | WebKit, Firefox: `[13.clipboard-api]`, `[14.shell]` | — |
| `report-unbounded` | `leak.spec.ts`, `strict-csp.spec.ts` | `[14.error-shapes]`, `[14.silent]` | — | — |
| `nonce` | `strict-csp.spec.ts` | `the shell runs on a host page whose script-src is its nonce alone (P054)`, and every other test | — | — |
| `annotation-checks` | `annotate.spec.ts` | `a hostile page fakes reports: the host takes none it didn't ask for, nothing malformed, and not a flood` | — | — |
| `annotation-activated` | `annotate.spec.ts` | `a hostile page fakes a marker's click: the host takes it only for a mark it shows with a marker` | — | — |
| `annotation-activated-count` | `annotate.spec.ts` | `a hostile page fakes a marker's click: the host takes it only for a mark it shows with a marker` | — | — |
| `marker-trusted` | `annotate.spec.ts` | `a hostile page fakes a marker's click: the host takes it only for a mark it shows with a marker` | — | — |
| `marker-click` | `annotate.spec.ts` | `markers: a mark with a count gets a numbered bubble; its click is reported and never reaches the content`, `a marker's press, of any kind, moves nothing of the content's: no handler, no focus, no selection`, `a page that patches the event's built-ins neither hears a marker's press nor stops its report (P105)`, `a tap on a marker is reported on every engine, and the content hears none of it (P105)`, `a marker is a button the keyboard reaches: Tab in reading order, Enter and Space report it once, the content hears neither, and it steps aside while elements are picked (P133)`, `drafts (P107): a dashed line and a hollow marker with no number, apart from posted marks; their clicks are reported the same`, `on touch, a marker takes a tap a few px off its bubble (44 by 44), after the page scrolled itself; a tap past that is the page's (P119)`, `on touch, where two markers' 44 px boxes overlap, a tap is the nearest bubble's (P119)`, `a paragraph's marker pinned at the frame's top once its start scrolled away takes a mouse click and a tap where it is drawn (P119, porthole#42)` | — | — |
| `marker-prevent` | `annotate.spec.ts` | `a marker's press, of any kind, moves nothing of the content's: no handler, no focus, no selection` | — | — |
| `marker-place` | `annotate.spec.ts` | `text markers cover no word: on a column page, and on a phone's lines with one marker each (P105, #36)` | — | — |
| `marker-key` | `annotate.spec.ts` | `a marker is a button the keyboard reaches: Tab in reading order, Enter and Space report it once, the content hears neither, and it steps aside while elements are picked (P133)` | — | — |
| `marker-focus` | `annotate.spec.ts` | `a page that patched focus isn't handed the marker the host's focusMark moves to (P134)` | — | — |
| `marker-late` | `annotate.spec.ts` | `a parked focusMark doesn't land once the person has moved on to the host's button (P135)`, `a focusMark parked with the focus in the frame doesn't land once the person moves on while it waits (P135)`, `a parked focusMark with the focus on the host's body is dropped; after the host's own move into the frame a second one, parked too, lands on the marker (P135)`, `a page that patched hasFocus to say yes gets no landing the platform's own answer refuses (P135)` | — | — |
| `marker-busy` | `late-word.spec.ts` | `a focusMark a busy page takes late doesn't land once the host's page has moved on (P137)`, `a page that stopped Date.now gets no landing for a word it took late (P137)`, `a page that patched hasFocus to say yes gets no landing for a word it took late (P137)` | — | — |
| `marker-clock` | `late-word.spec.ts` | `a page that stopped Date.now gets no landing for a word it took late (P137)` | — | — |
| `marker-has-focus` | `annotate.spec.ts`, `late-word.spec.ts` | `a page that patched hasFocus to say yes gets no landing the platform's own answer refuses (P135)`, `a page that patched hasFocus to say yes gets no landing for a word it took late (P137)` | — | — |
| `marker-originals` | `annotate.spec.ts` | `a page that patches the event's built-ins neither hears a marker's press nor stops its report (P105)` | — | — |
| `follow-throttle` | `annotate.spec.ts` | `an honest scroll session, long, in comment mode, leaves room for a marker's click: follow-ups, the selection's too, at most one a second` | — | — |
| `selection-follow` | `annotate.spec.ts` | `an honest scroll session, long, in comment mode, leaves room for a marker's click: follow-ups, the selection's too, at most one a second` | — | — |
| `follow-count` | `annotate.spec.ts` | `following: a host that gives no counts hears no follow-up after a scroll, as before markers` | — | — |
| `draft-count` | `annotate.spec.ts` | `what the page reads of a draft (P107): that it is one, never its count; a posted mark as before` | — | — |
| `draft-shell-checks` | `annotate.spec.ts` | `the shell's own checks on a raw show (P107): a draft draws no number, a kind it doesn't know is no mark` | — | — |
| `annotation-rect-clamp` | `annotate.spec.ts` | `a hostile page reports a box outside its frame: the host gets it clamped to the frame's viewport`, `marks: drawn over their anchors, one brought into view, an unfound one orphaned, all cleared`, `following: once a scroll settles, one report with only the marks that moved`, `every attached mark's place in the document comes with the scroll it was read at, offscreen ones too, and the followed mark's as the document scrolls (P132)`, `a selection's and a mark's last line come in the document's coordinates with the scroll, offscreen ones too; rect stays clamped (P133)` | — | — |
| `authorize` | `served/authorize.spec.ts` | `a revoked subject's ticket opens nothing: a page and an app are denied, and the host is told`, `in a tab of its own, a revoked app and page are denied from the next request on`, `a framed page mid-session: its next load after revocation is denied where the engine keeps its cookie` | Chromium, Firefox: `a framed app mid-session: its next request after revocation is denied, and its next load tells the host` | — |
| `url-permissions` | `served/permissions.spec.ts` | `a url-mode frame gets no clipboard writes or full screen unless the host delegates them` | — | — |
| `navigate-guard` | `served/live.spec.ts`, `served/files.spec.ts`, `served/served.spec.ts`, `served/tab.spec.ts` | `served.domain.self-navigation`, `served.domain.tab-navigation`, `served.domain.tab-links`, `can't navigate itself away (location): to a site, or to another content origin`, `can't navigate itself away (replace): to a site, or to another content origin`, `can't navigate itself away (open-self): to a site, or to another content origin`, `can't navigate itself away (navigation-api): to a site, or to another content origin`, `a link to another page of the set opens it in the frame; the display goes on`, `a link to another page of the set opens it in the frame when the leaving page's notice is dropped (P098)`, `a link to another page of the set opens it in the frame when the leaving page's notice is late (P098)`, `without the Navigation API, a link to another page of the set opens it in the frame; the display goes on`, `a link down the page scrolls it; the document stays, and so does the display`, `without the Navigation API, a link down the page scrolls it; the document stays, and so does the display`, `a page opens nothing else: not a file that isn't a page, not another path of its origin`, `no report, content error or blocked navigation names the frame's sealed address (P083)` | — | — |
| `same-document-notice` | `served/files.spec.ts` | `a link down the page scrolls it; the document stays, and so does the display`, `without the Navigation API, a link down the page scrolls it; the document stays, and so does the display` | — | — |
| `tab-sandbox` | `served/tab.spec.ts` | `served.domain.tab-escapes`, `served.domain.tab-opener`, `a file set's page on a tab of its own opens its own pages, and no window, link in a new window or download`, `a frame's sealed address opened on a tab of its own is sandboxed as its frame is` | — | — |
| `window-open` | `served/tab.spec.ts` | nothing | — | the CSP's sandbox stops a window first (`tab-sandbox,window-open`) |
| `tab-sandbox,window-open` | `served/tab.spec.ts` | `served.domain.tab-escapes`, `served.domain.tab-opener`, `a file set's page on a tab of its own opens its own pages, and no window, link in a new window or download`, `a frame's sealed address opened on a tab of its own is sandboxed as its frame is`, `served.domain.tab-window-open` | — | — |
| `navigate-ask` | `served/tab.spec.ts` | nothing | WebKit: `served.domain.tab-navigation`, `served.domain.tab-links` | on Chromium and Firefox the navigate event cancels what the rule would have (`navigate-guard`) |
| `link-rule` | `served/tab.spec.ts` | nothing | WebKit: `served.domain.tab-links`, `served.domain.tab-navigation` | on Chromium and Firefox the navigate event cancels a link the browser follows (`link-rule,navigate-guard`) |
| `link-rule,navigate-guard` | `served/tab.spec.ts` | `served.domain.tab-navigation`, `served.domain.tab-links` | — | — |
| `permissions-policy` | `served/tab.spec.ts` | nothing | — | the shell's locks deny what the header would (`permissions-policy,device-locks`) |
| `device-locks` | `served/tab.spec.ts` | nothing | WebKit: `served.domain.tab-devices`; Firefox: `served.domain.tab-devices`, `served.domain.tab-prompts` | Chromium applies the Permissions-Policy header, which denies them first (`permissions-policy,device-locks`) |
| `permissions-policy,device-locks` | `served/tab.spec.ts` | `served.domain.tab-devices` | Chromium, Firefox: `served.domain.tab-prompts` | — |
| `url-origin` | `served/served.spec.ts` | nothing | Chromium, Firefox: `served.url.siblings` | no probe can see it on WebKit here: it keeps no cookie in a cross-site frame (P025), and the reference serving's labels are cross-site, so no request of another origin rides the app's cookie |
| `service-worker` | `served/files.spec.ts` | `no service worker ever registers` | — | — |
| `file-corp` | `served/files.spec.ts` | `another origin reads none of the files: not another artifact's page, not a page elsewhere` | — | — |
| `file-self` | `served/files.spec.ts` | `a page loads no other version's files, though the browser may open both (P082)`, `a file outside the set is a 404, and so is every spelling of a way out` | — | — |
| `runtime-declaration` | `served/runtime.spec.ts` | `an undeclared capability: null from use, refused when sent anyway, its handler never asked` | — | — |
| `runtime-level` | `served/runtime.spec.ts` | `a method above the viewer's level: forbidden, its handler never asked`, `a read above the viewer's level: a result the host pushed is refused as a cold read is` | — | — |
| `runtime-data-names` | `served/runtime.spec.ts` | `a resource outside the page's data names: refused with a viewer and without one, its handler never asked` | — | — |
| `live-held-read` | `served/runtime.spec.ts` | `a read above the viewer's level: a result the host pushed is refused as a cold read is` | — | — |
| `db-private` | `served/runtime.spec.ts` | `a person's own data is theirs: another person's is refused, never reaching the service` | — | — |
| `comments-result` | `served/runtime.spec.ts` | `comments are write-only: the composer opens when the page asks, with a click or without one, and content hears only that` | — | — |
| `cancel-any-mode` | `annotate.spec.ts` | `Escape while selecting text is cancelled, and stays the page's key; with no mode on, a page's own cancel isn't heard (P112)`, `a hostile page fakes reports: the host takes none it didn't ask for, nothing malformed, and not a flood` | — | — |
| `track-checks` | `annotate.spec.ts` | `a followed mark's box comes as it moves, for that mark only, at most 60 a second, clamped to the frame, until the host stops (P112)` | — | — |
| `track-selection-checks` | `annotate.spec.ts` | `a followed selection's place comes as it moves, highlighted, out of view and back, gone and found again, only while the host follows it, at most 60 a second (P138)`, `without keepSelection or a follow, a pick's outline goes with the pick and nothing is kept: a follow asked after it has nothing, one asked before it follows it; a page's malformed word is no refusal (P140)` | — | — |
| `order-check` | `annotate.spec.ts` | `every found mark's place in the document comes with its box, offscreen ones too; a place that isn't one is no report (P112)` | — | — |
| `hold-click` | `annotate.spec.ts` | `holding a block 500 ms selects it and its release's click never reaches the page; a tap, a moving finger and a mouse are the page's (P112)` | — | — |
| `clear-selection` | `annotate.spec.ts` | `clearSelection takes the page's selection away and tells nothing back; marks and drafts stay, the next selection is told (P115)` | — | — |
| `content-status` | `served/outcome.spec.ts`, `served/siblings-status.spec.ts` | `a served shell's content that says it is blocked is told nothing and shown nothing (P124)`, `a served artifact page that says it is blocked as it loads is told nothing and shown nothing (P124)`, `[sibling-inject]`, `[sibling-reload]`, `[proxy]` | — | WebKit: `[sibling-inject]`, `[sibling-reload]`, `[sibling-wipe]`, `[proxy]` may skip instead, measured (their attack lands only sometimes there) |
| `door-status` | `served/siblings-status.spec.ts` | `[sibling-inject]`, `[sibling-reload]`, `[proxy]` | — | WebKit: `[sibling-inject]`, `[sibling-reload]`, `[sibling-wipe]`, `[proxy]` may skip instead, measured (their attack lands only sometimes there) |
| `door-silence` | `served/siblings-status.spec.ts` | `[sibling-wipe]` | — | WebKit: `[sibling-inject]`, `[sibling-reload]`, `[sibling-wipe]`, `[proxy]` may skip instead, measured (their attack lands only sometimes there) |
| `door-opaque` | `served/siblings-status.spec.ts` | `[door-reach]` | — | — |
| `embed-ancestors` | `served/embed.spec.ts` | `[embed.reader-unframeable]` | — | — |
| `embed-handshake` | `served/embed.spec.ts` | `[embed.untold]` | — | — |
| `embed-origins` | `served/embed.spec.ts` | `[embed.unheard]` | — | — |
| `comment-draft` | `served/runtime.spec.ts` | `a comment's draft is the host's to check: past the limit, holding what a person can't see, or not text, it opens no composer (P108)` | — | — |
| `blob-script` | `served/runtime.spec.ts` | nothing | — | an untrusted script asset is served as a download (`blob-script,blob-trusted`) |
| `blob-trusted` | `served/runtime.spec.ts` | `a script asset runs as code only if an admin uploaded it where uploads are the admins'` | — | — |
| `blob-script,blob-trusted` | `served/runtime.spec.ts` | `a script asset runs as code only if an admin uploaded it where uploads are the admins'`, `scripts load from /_blob/ only where uploads are the admins' (a tab, its session)` | — | — |
| `blob-inert` | `served/runtime.spec.ts` | `an asset opened on its own runs nothing, on a tab with the artifact's session` | — | — |
| `find-requested-focus` | `find.spec.ts` | `a hostile page says the find shortcut was pressed while the person types in the host's composer: the host's find bar stays shut (P131)` | — | — |
