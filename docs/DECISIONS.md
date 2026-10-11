# Decision log

Append-only. Each entry records the decision, why, what we rejected, and **when to
revisit**. To change a decision, add a new entry that supersedes the old one and
mark the old one `Superseded by Pxxx`. The "revisit when" line is the most
important part.

Format: `Pxxx · YYYY-MM-DD · Title · Status`

---

## P001 · 2026-10-11 · Two layers: a framework of mechanisms, and a preset policy layer · Accepted

**Decision.** Split the library into a framework layer (isolation, egress
hardening, shell runtime, streaming, sizing, theming, the host-function bridge,
the guide generator — mechanisms only, no policy) and a preset policy layer
(inline-widget, artifact, mcp-app — named configs with safe defaults). A host
adopts a preset, passes theme tokens and callbacks, and gets a safe display plus
the agent manual.
**Why.** Policy (which origins, which confirmations, what theme) is
product-specific and changes faster than mechanism. Separating them lets the
mechanisms be audited once and reused, while hosts get "out of the box" from the
presets without touching internals.
**Rejected.** One monolithic widget component (couples mechanism to one policy);
mechanisms with no presets (every host re-derives a safe config and most get it
wrong).
**Revisit when** a host needs a mode no preset covers, or the preset set grows
enough to need its own structure.

## P002 · 2026-10-11 · The core abstraction is agent-drawn HTML plus declared host functions · Accepted

**Decision.** The content may draw freely; every power beyond drawing is a host
function (capability) named in the config, each declaring its gate, its egress
needs, and its guide entry. Sending a prompt to the agent is one such capability,
not a privileged built-in.
**Why.** One capability list then drives the bridge, the CSP and the manual
together (P003), and "what can this content do?" is answered by reading the
config. Treating agent-interaction as ordinary keeps the model uniform and makes
hosts that don't want it simply omit it.
**Rejected.** A fixed built-in set of powers (inextensible, and couples the core
to one product's needs); ambient powers granted implicitly (unauditable).
**Revisit when** a capability needs structure the flat list can't express (e.g.
capabilities that compose).

## P003 · 2026-10-11 · One config is the single source for the CSP, the shell, and the manual · Accepted

**Decision.** The CSP, the iframe sandbox/`allow` attributes, the in-frame shell
wiring, and the agent guide + tool description are all generated from one config
by a pure compiler. A test asserts the three outputs agree (the guide names only
injected variables and allowed capabilities; the CSP allows only what the manual
teaches).
**Why.** These artifacts must agree to be safe and usable; drift between them is
the most common defect in hand-built sandboxes, and a manual that promises what
the sandbox blocks wastes the agent's turns.
**Rejected.** A hand-maintained guide; a literal CSP string no test ties to the
capabilities.
**Revisit when** a host needs to hand-tune one artifact — then the override must
flow back through the config, never edited in place.

## P004 · 2026-10-11 · The external contract is MCP Apps; the host side is protocol-pluggable · Accepted

**Decision.** Agent-written HTML speaks MCP Apps (`io.modelcontextprotocol/ui`,
2026-01-26). We do not define a widget-side protocol; gaps go through the spec's
extension points (experimental capabilities, own-prefixed methods) and, when
general, upstream. Internally the host side is protocol-pluggable: a thin adapter
maps capabilities/lifecycle onto a wire protocol, with MCP Apps the first and
default adapter.
**Why.** Standard agent-UI is only valuable if one widget runs in many hosts and
one host renders many widgets; a bespoke protocol forfeits that. A pluggable
inside keeps the core host-agnostic and lets a second protocol be an adapter, not
a fork.
**Rejected.** A new wire format; coupling the core to one protocol SDK's object
model.
**Revisit when** the spec changes incompatibly, or a second protocol is needed.

## P005 · 2026-10-11 · Phase-1 isolation is an opaque origin; domain mode is designed, built later · Superseded in part by P016 (domain mode is phase 1)

**Decision.** Phase 1 isolates content in an opaque-origin frame (sandboxed
without `allow-same-origin`): a different origin from the host with no persistent
storage. The domain mode (a per-instance subdomain on a separate registrable
domain, giving a real, stable origin with storage) is designed in phase 1 and
built in phase 2.
**Why.** An opaque origin is the cheapest isolation that fully solves the
host-attack class and needs no server, domain or certificate — so phase 1 ships
without infrastructure. Stable storage and a real origin require serving
infrastructure that is phase-2 work.
**Rejected.** Shipping domain mode in phase 1 (pulls server/DNS/cert work into
the first release); same-origin isolation with a strict CSP (a CSP mistake then
becomes host takeover — isolation must be the floor, not the CSP).
**Revisit when** a host needs persistent per-instance state or a stable origin
(then build domain mode).

## P006 · 2026-10-11 · Egress is closed by default, including channels a frame CSP doesn't cover · Accepted

**Decision.** All outbound network and navigation is closed by default and opened
only to origins a capability declares. Beyond `connect-src`/resource directives,
the shell closes channels a frame's own CSP cannot: it removes the WebRTC
constructors (a peer connection reaches the network via ICE outside
`connect-src`), removes nested frames the content adds — including inside shadow
roots and after a content-initiated document rewrite (a nested frame runs in a
fresh realm where the removals never happened) — and the embedding page sets
`frame-src` to stop the frame navigating itself out with data in the URL. Each
item has a leak-suite probe (P008).
**Why.** Origin isolation stops the host-attack class but not exfiltration of
what the content already holds; egress hardening does. These three channels sit
outside a frame's own CSP, so they need in-shell defenses and the embedder's
policy, verified by measurement because engines differ.
**Rejected.** Trusting `connect-src` alone (misses WebRTC, nested-frame realms,
self-navigation); trusting one CSP directive honored unevenly across engines.
**Revisit when** an engine changes how it honors `webrtc`/`frame-src`, or a new
egress channel is found (add the probe first).

## P007 · 2026-10-11 · The MCP adapter reimplements the host-side subset; the widget uses the official SDK · Accepted; amended by P014 (no AppBridge adapter) and P018 (upstream timing)

**Decision.** The MCP Apps adapter reimplements the thin host-side subset of the
protocol that maps to capabilities, rather than embedding the official
`AppBridge`. On the widget side we reimplement nothing — authors use the official
`App` SDK. An AppBridge-backed adapter is offered as an optional, separate entry.
We contribute upstream what is general: the conformance/leak runner, the
container-agnostic framing note, and the frame-escape findings.
**Why.** `AppBridge` extends the MCP SDK's `Protocol` class and pulls in its
client/core packages; embedding it would tie the host-agnostic core to that
dependency tree and class hierarchy (against P004/P007-core-agnostic) for a
subset we can state and test directly against the reference examples. The widget
side is where speaking the standard matters, so there we use the real SDK.
**Rejected.** Embedding AppBridge in the core (heavy coupling); reimplementing the
widget side (defeats the point of the standard).
**Revisit when** the host-side subset grows large or the SDK sheds its coupling
(then prefer wrapping), or a host standardized on the MCP SDK needs the
AppBridge adapter sooner.

## P008 · 2026-10-11 · A conformance/leak suite is first-class, cross-engine, and host-runnable · Accepted; engine order amended by P017

**Decision.** A standalone Playwright suite drives a platform host through an
adapter via a small host test interface, attempts every egress and escape
channel, and asserts nothing leaks — on Chromium, WebKit and Firefox. It also
runs the MCP Apps examples and renders the generated guide's examples. Any host
can run it against its own integration. A hardening item exists only if a test
proves it (PRINCIPLE 5), and isolation facts are decided by measurement, not
assumption (PRINCIPLE 6).
**Why.** Browser isolation behavior changes across versions and engines; only an
executed probe shows the wall is there and keeps it there. Making the suite
host-runnable turns it into the proof hosts can trust and the artifact we offer
upstream.
**Rejected.** Unit-testing CSP strings only (doesn't prove the browser enforces
them); a single-engine suite (misses engine-specific gaps).
**Revisit when** a target engine is dropped or added, or an upstream conformance
interface stabilizes (align to it).

## P009 · 2026-10-11 · Web first: a framework-agnostic core plus a thin React binding · Accepted

**Decision.** Ship a framework-agnostic TypeScript core and a separate thin React
binding first. Native hosts (WKWebView, maybe Android) come later behind the same
platform-host interface. Tooling: Node ≥ 24 with type stripping (erasable syntax
only), pnpm workspace, oxlint + oxfmt, vitest or node:test, Playwright.
**Why.** The web is where the first host lives, and a framework-agnostic core
keeps the library usable by non-React hosts and portable to native engines (the
shell is plain dependency-free script). The toolchain matches the wider workspace
so agents and contributors share one setup.
**Rejected.** React-only (excludes other hosts and native); a bundler-heavy build
(type stripping needs none).
**Revisit when** a native host is built, or a second UI framework needs a binding.

## P010 · 2026-10-11 · Apache-2.0, private for now · Accepted

**Decision.** License Apache-2.0, copyright Botiverse. The repository stays
private during phase 1.
**Why.** Apache-2.0 is permissive with an explicit patent grant, standard for a
library meant for broad embedding. Staying private during design keeps the shape
settling before it is public.
**Rejected.** MIT (no patent grant); public from day one (premature while the API
is unsettled).
**Revisit when** phase 1 is done and the owner decides to open it.

## P011 · 2026-10-11 · The first host is a normal user of the public API · Accepted

**Decision.** The first adopter migrates onto Porthole through the public API
with no privileged path; anything it needs goes into the config or a documented
extension point any host could use. The first host's existing shell, theme map,
embedding-page CSP, frame component and guide seed the framework layer, then are
consumed from the packages.
**Why.** A library shaped around one caller's internals is not reusable and leaks
that caller's assumptions into the core. Dogfooding by a real host is the test
that the API is general (OBJECTIVE 4).
**Rejected.** Private hooks for the first host; keeping the extraction in the
host's own repo (then it is not a library).
**Revisit when** a second host adopts it (confirm nothing was first-host-specific).

## P012 · 2026-10-11 · Three modes: inline widget, MCP Apps view, artifact page; URL mode out of scope · Superseded in part by P020 (URL mode is phase 1)

**Decision.** Support inline widget, MCP Apps view, and artifact page (a
host-control spectrum from host-injected code to a host-served document). URL mode
(embedding a running app by URL, with only origin isolation and access auth, no
shell, no egress control) is out of scope for now.
**Why.** The three modes cover showing agent-made HTML the host or an MCP server
produced, which is the stated subject. URL mode is a different problem (isolating
a third party's live site) with little shared mechanism beyond origin isolation,
and no host needs it yet.
**Rejected.** Adding URL mode in phase 1 (scope creep for a mode nobody needs);
dropping the artifact page (it is the standalone-page half of the stated goal).
**Revisit when** a host needs to embed a live external app, or the artifact and
URL modes turn out to share enough to justify both.

## P013 · 2026-10-11 · One package, `@botiverse/porthole`, with subpath exports · Accepted

**Decision.** Porthole ships as one package: the core at `@botiverse/porthole`, and
`/react`, `/mcp`, `/conformance` and `/server` as subpath exports of it. Optional
peers (`react`, `@playwright/test`) are needed only by the subpaths that use them.
The workspace exports the TypeScript sources directly; `pnpm build` emits JS and
declarations to `dist/`, which a packed or published package exports instead
(`publishConfig.exports`), because Node does not strip types under `node_modules`.
**Why.** The shell runtime, the compiler and the adapters must move in lockstep (a
shell from one version and a host from another is an untested pair); one version
makes that impossible to get wrong. The seams are module boundaries, which keep the
core free of React, Playwright and server code without separate packages.
**Rejected.** Six packages (`-react`, `-mcp`, `-components`, `-conformance`,
`-server`): version skew between core and shell, more release work, no isolation
gain.
**Revisit when** a subpath's dependencies or release cadence burden hosts that don't
use it.

## P014 · 2026-10-11 · No AppBridge-backed adapter for now · Accepted

**Decision.** Porthole ships only its own MCP Apps adapter (P007); the optional
AppBridge-backed adapter P007 offered is not built.
**Why.** No host has asked for it, and every adapter is surface the leak suite must
cover.
**Rejected.** Building it speculatively in phase 1.
**Revisit when** a host standardized on the MCP SDK asks for it.

## P015 · 2026-10-11 · Content is plain HTML/SVG plus the generated manual; no component vocabulary · Accepted

**Decision.** What an agent writes for Porthole is plain HTML and SVG, taught by the
generated manual. A consistent look comes from the injected theme variables and, at
most, plain CSS the shell ships (such as base styles for native form elements),
never from a component vocabulary. The "preset components" of the first design (a
stat tile, chart primitive, table and elicitation form as custom elements) are
dropped; the config has no `components` field.
**Why.** The owner: no DSL-like things for now, and a component vocabulary is one:
the agent must learn tag names and props, Porthole must version them, and content
stops being portable HTML. Theme variables already give content the host's look in
light and dark.
**Rejected.** Preset web components inside the sandbox; a host-extensible
component list.
**Revisit when** agents repeatedly hand-roll the same structure badly in a way base
styles and the manual can't fix.

## P016 · 2026-10-11 · Domain mode is phase 1 · Accepted

**Decision.** Supersedes P005's timing. Domain mode is built in phase 1: content is
served on a registrable domain the host uses for nothing else, one subdomain per
storage scope (the label keyed from the host's scope with a secret: stable, DNS-safe,
not guessable), so each scope has a real, stable origin and its storage persists.
Documents go out with their CSP, plus `frame-ancestors` naming the host origins, in
HTTP headers. Private content is reached with a one-time ticket the host's backend
mints (`/server`'s `issue`) and the content origin exchanges for a cookie of that
origin only. `/server` is a fetch-style request handler a host's backend mounts.
The served frame's sandbox adds `allow-same-origin`.
**Threat it re-opens.** `allow-scripts allow-same-origin` lets a frame act with its
own origin's full powers; if that origin were same-site with the host, it could
reach cookies and storage the host shares with its site. Bounded by: the content
domain is a separate registrable domain; a mount refuses a content origin that is
same-site with the host; and the leak suite's item 9 (no reach into the host) must
pass in domain mode, shipped with the domain-mode work.
**Why.** Hosts need stable storage and a real origin for some content (and the MCP
Apps sandbox proxy needs a second origin anyway); building it now keeps the served
modes from being designed in the abstract.
**Rejected.** Holding it to phase 2 (P005).
**Revisit when** browsers' storage partitioning or third-party cookie rules change
how a framed origin keeps state.

## P017 · 2026-10-11 · Leak-suite gate: Chromium and WebKit first, Firefox right after · Accepted; completed by P035

**Decision.** Amends P008's engine order. A hardening milestone is done when its
probes pass on Chromium and WebKit; Firefox joins the gate as the next milestone,
not later in the phase. The suite selects engines with `PORTHOLE_LEAK_ENGINES`;
where an engine's system libraries are missing (WebKit on the shared build machine),
it runs on a machine that has them.
**Why.** Chromium and WebKit cover the first host's web and iOS users and differ
most on the directives that matter (`webrtc`, `frame-src` for `srcdoc`); Firefox
follows quickly so no engine's gaps go unmeasured for long (PRINCIPLE 6).
**Rejected.** Waiting for all three before any milestone lands; dropping Firefox
from phase 1.
**Revisit when** an engine is added or dropped.

## P018 · 2026-10-11 · Upstream contributions once code and tests exist · Accepted

**Decision.** Issues and proposals to the MCP Apps spec and SDK (the conformance
runner, the framing note, the frame-escape findings) go upstream once Porthole has
the code and tests that back them, not before.
**Why.** Evidence makes a proposal actionable; a design without a runnable suite is
an opinion.
**Rejected.** Filing now from the design alone.
**Revisit when** the leak suite and the MCP Apps adapter pass on two engines.

## P019 · 2026-10-11 · The React binding ships a default, replaceable confirmation dialog · Accepted

**Decision.** `@botiverse/porthole/react` draws a default confirmation dialog
(outside every frame) for `confirm`-gated calls: the whole effect (the prompt's full
text, the link's full URL), the display's title, Cancel focused, and the accept
button ignoring presses for a moment after it opens. A host replaces it by passing
its own `confirm` function. The core never draws anything; `confirm` there is only a
function, and without one a gated call is refused.
**Why.** "Out of the box" needs a working confirmation; PRINCIPLE 8 rules out UI the
host can't control, and this one the host replaces with one prop.
**Rejected.** No default (every host must build a dialog before anything works);
a dialog in the core (couples the core to a UI framework).
**Revisit when** hosts routinely restyle rather than replace it (then expose its
parts).

## P020 · 2026-10-11 · URL mode is phase 1: frame, isolation and access auth only · Accepted

**Decision.** Supersedes P012's exclusion of URL mode: the first host's dev-server
preview pane must dogfood Porthole. URL mode frames a running app by URL with
isolation and access auth only: no shell, no capabilities, no manual, no egress
control (the app is someone else's, on its own origin). Its config is the `url`
preset (`mode: "url"`, `isolation: "external"`, its `contentOrigins`); the embedding
page's `frame-src` lists those origins; access goes through the same ticket → cookie
exchange as domain mode. The frame's baseline sandbox is `allow-scripts
allow-same-origin allow-forms`: no popups, downloads, modals or top navigation.
**Threat it re-opens.** The framed app runs with its own origin's powers and can
submit forms. Bounded by: its origin must be a separate site from the host's (as in
P016); it gets no host function and nothing of the host's; the embedding page frames
only the declared content origins. The served-modes work ships the probes for this
(no reach into the host; no top navigation; no popup) and refines the sandbox tokens
with a decision entry if a real app needs more.
**Why.** A preview pane is "show content the host didn't write" too, and building it
on Porthole keeps one audited framing path in the host.
**Rejected.** Leaving the preview on the host's own code (two framing paths to
audit); giving URL mode a shell or egress control (it is a live app, not content
Porthole draws).
**Revisit when** a host needs URL-mode frames to talk to it (then that is a
protocol, through an adapter).

## P021 · 2026-10-11 · Gates are a list that all must pass, safe by default, failing closed · Accepted

**Decision.** A capability's gates are a list (`user-activation`, `confirm`,
`{ rateLimit }`); every one must pass. A config that names no gates gets the
vocabulary's defaults (`sendPrompt` and `openLink`: a gesture and a confirmation;
`callTool`: a confirmation; reads and context updates: rate limits); `[]` is an
explicit "ungated". `confirm` is enforced by the framework calling the host's
`confirm` function; with none, the call is refused. `user-activation` is checked by
the shell and, where the engine passes a frame's gesture on to its ancestors
(measured by the leak suite), by the host too; the shell's check shares the
content's realm, so it stops calls made on load or on a timer, not a determined
author: the confirmation is the wall.
**Why.** The first design's single `gate` could not say "a gesture and a
confirmation", which the first host already requires for prompts. Defaults that are
safe and a refusal without a `confirm` function mean a host that forgets something
gets a call that doesn't run, not one that runs unasked (PRINCIPLE 1).
**Rejected.** One gate per capability; treating the shell's activation check as a
wall.
**Revisit when** a gate needs to depend on the call's arguments (then the host's
`confirm` decides, as it does for tool calls today).

## P022 · 2026-10-11 · Every preset starts with egress closed; library CDNs are a one-line opt-in · Accepted

**Decision.** Every preset's base egress is empty: nothing loads from outside and
every fetch fails. `LIBRARY_CDNS` (cdnjs, jsDelivr, unpkg, esm.sh for scripts,
styles, fonts, images and data; Google Fonts) is exported for a host to open with
one line, and the manual teaches libraries (and pinning them) only when scripts may
load. The frame's CSP never allows `'self'`: an opaque frame has nothing of its own
to load, and its `'self'` may be the embedding page's origin.
**Why.** P006 says egress opens only to what a config declares; a preset that opened
CDNs by default would be a default the host never chose. The CDNs are read-only
package caches (reviewed by the first host), so opening them is a reasonable host
choice, but it is the host's.
**Rejected.** CDNs on by default (the first host's previous posture); per-path CDN
allowlists (break ESM imports and data fetches for no egress gain).
**Revisit when** most hosts open the CDNs anyway (then consider a preset variant,
by a decision that names the residual supply-chain risk).

## P023 · 2026-10-11 · No `readState`/`writeState` capabilities · Accepted

**Decision.** The vocabulary drops `readState` and `writeState`. An opaque frame
keeps an in-memory `localStorage` for its life; content that needs storage that
persists runs in domain mode (P016), where `localStorage` is real and scoped by the
host's storage scope.
**Why.** Domain mode is now phase 1 and gives real storage without a protocol of our
own (MCP Apps has no state method, so these would have been Porthole-only methods).
**Rejected.** Own-prefixed state methods backed by the host.
**Revisit when** a host needs persisted state for opaque frames.

## P024 · 2026-10-11 · The shell reports errors with MCP's log notification; its theme event is named by the config · Accepted

**Decision.** The shell reports what content throws, and what the sandbox blocks, as
the standard `notifications/message` (level `error`, logger `porthole`), which the
host's adapter turns into the `reportError` capability. The window event the shell
fires after a theme change is `config.theme.event` (default `porthole:theme`), and the
manual teaches that same name. The shell's content arrives as `tool-input(-partial)`
with `{ html }`.
**Why.** MCP already has a logging notification, so errors need no private method
(PRINCIPLE 2). A host migrating onto Porthole may already have content listening for
its own event name; naming it in the config keeps that content working, and the
agreement test keeps the shell and the manual on the same name.
**Rejected.** An own-prefixed error method; a fixed event name.
**Revisit when** MCP Apps standardizes error reporting or theme-change events for
views.

## P025 · 2026-10-11 · A served document comes with its ticket's answer; the cookie serves what follows · Accepted

**Decision.** Refines P016's ticket flow. `/server` names each storage scope's origin
`<label>.<content domain>` (24 base32 characters of an HMAC of the scope, keyed from the
server's secret), and each instance a key (16 characters, an HMAC of the instance): a served
document (shell, artifact version, sandbox proxy) lives at `/__porthole/d/<key>`, and `issue`
returns that path with a one-time ticket (`?ticket=`, 60 s by default, stored as its hash). The
request that takes the ticket is answered **with the document itself**, CSP and `frame-ancestors`
in headers, plus a cookie of that origin and instance only: `__Host-porthole-<key>`, `Secure`,
`HttpOnly`, `Path=/`, `SameSite=None; Partitioned` in a frame (`Sec-Fetch-Dest` other than
`document`), `SameSite=Lax` on a tab of its own; signed, carrying the instance, the viewer and its
end (an hour by default, `Grant.sessionSeconds`). The cookie serves what follows: a reload, and
every request of a url-mode app, whose ticket is taken at `/__porthole/enter` and redirects to the
app's own landing path. Over http (loopback dev only) the cookie drops `__Host-`, and `Secure` on
a tab. Host origins on, or possibly same-site with, the content domain are refused when the server
is created; a mount checks a located frame the same way (`checkFrameLocation`). Without the
public-suffix list the same-site check errs toward "same site" (it refuses hosts sharing the last
two labels, so `a.github.io` and `b.github.io` are refused though browsers would allow them).
**Measured** (`.dev` probes, Playwright 1.63: Chromium 153, WebKit 26.6). WebKit keeps **no**
cookie in a cross-site frame: not `SameSite=None; Secure`, not `Partitioned`, not `__Host-`, over
http or https (`document.hasStorageAccess()` is false); on a tab of its own it keeps them over
https. Chromium keeps partitioned cookies in frames, including `Secure` ones over http on
`*.localhost`. Framed `localStorage` persists across reloads in both. So a redirect after the ticket
(the first design) shows WebKit nothing, while the document in the ticket's own answer shows it
everywhere; and a url-mode app, which needs its cookie for every subresource, cannot run framed in
WebKit: a host shows it on a tab there. The leak suite's `served.url.framed` asserts the WebKit
failure (`test.fail`), so a change in WebKit shows up as a failing case.
**Why.** The ticket must work on the weakest engine we support (PRINCIPLE 6), and a used ticket
left in the frame's URL is worthless (taken atomically, once), while the frame sends no referrer.
Per-instance cookies let several instances of one scope (one origin) reload side by side.
**Rejected.** Redirecting to a ticket-free URL (WebKit shows the 401 page); a token in the
document's path (a credential in every URL the content can read and log); a service worker that
adds the session to an app's requests (fragile beside an app's own worker, and no WebSockets).
**Revisit when** WebKit keeps partitioned cookies in frames (then `served.url.framed` fails as
"passed unexpectedly": framed url mode works there too), or a host needs revocation before a
cookie's end (then a check on every request).

## P026 · 2026-10-11 · The MCP Apps sandbox proxy becomes its view · Accepted

**Decision.** The sandbox proxy `/server` serves (`ServedDocument` `mcp-proxy`) speaks the
spec's host-facing protocol, `sandbox-proxy-ready` until the host answers
`sandbox-resource-ready { html }`, then writes the shell's hardening head and the view into
**its own** document rather than into a nested same-origin frame. Writing a document erases the
window's listeners, so nothing of the proxy remains and the view talks to its host directly; the
spec's relay is the identity. The view's CSP goes out in the proxy's headers before the HTML
arrives: `issue` takes the view's declared egress (`_meta.ui.csp`, mapped to Porthole's
vocabulary by `/mcp`) in the instance and signs it into the ticket and cookie, opened on top of
the config's (closed by default, so a view gets exactly what it declares). The proxy takes the HTML
only from its parent, from a host origin, once; it ignores the message's `csp`, `sandbox` and
`permissions` (the policy is the headers'; the frame's sandbox and `allow` are the host's). Leak
cases `served.proxy.view`, `.parent-only` and `.egress` prove it on Chromium and WebKit.
**Threat it re-opens.** None beyond P016's: the view runs with `allow-same-origin` on a scope's
origin, as any domain-mode content.
**Why.** A view nested in a same-origin frame can script its proxy: a second realm where WebRTC
and frame creation are intact (outside the shell's hardening) and whose fetches run under the
proxy's own policy, so the proxy would need the view's hardening a second time. Writing in place
leaves one realm, hardened once, under one policy. The host and the view see the protocol the
spec describes.
**Rejected.** The reference host's nested inner frame (`document.write` into a same-origin child,
CSP from a `?csp=` query); a `<meta>` CSP written with the view (the header is in force before any
HTML arrives and can't be edited by it).
**Revisit when** the spec makes the relay observable to a view, or a host needs to send a proxy a
second resource; the framing note goes upstream with the leak runner (P018).

## P027 · 2026-10-11 · The MCP Apps adapter: what a view is sent, and what it may ask · Accepted

**Decision.** `@botiverse/porthole/mcp`'s `mcpAppsAdapter` (P007) answers `ui/initialize` with
the spec's protocol version, the host's name, the capabilities the config declares (`openLinks`
for `openLink`, `serverTools` for `callTool`, `message` for `sendPrompt`, …, plus the egress it
opens as `sandbox.csp`) and the host context; it sends a view nothing else before the view says
`initialized` (queued tool input, result and cancellation go then, in order, the drafts collapsed
to the latest). It carries `ui/message`, `ui/open-link`, `ui/download-file`, `tools/call`,
`resources/read` and `ui/update-model-context` into the bridge with the host page's user
activation; a refusal answers with JSON-RPC error `-32000` (`-32601` when not declared), a host
function that ran but couldn't with `{ isError: true }`. Sizes go to `resize`, `notifications/message`
at error levels and above to `reportError`. Further:
- **Style variables are cut to the standard's 76 names.** Measured: the official App SDK (2.0.3,
  zod 4) refuses a host context naming any other, so a view never initializes; Porthole's own
  names (`--color-accent`, the chart palette) stay with its shell. `MCP_APPS_STYLE_VARIABLES` is
  exported (a test checks it against the SDK's list).
- **`ui/request-display-mode` keeps the current mode**, answering with it (the spec's answer
  when a request isn't granted): how a display is laid out is the host's, and the vocabulary has
  no capability that could gate it.
- **A view's `frameDomains` and `baseUriDomains` open nothing** (`viewEgress`): the shell removes
  nested frames (P006) and `base-uri` stays `'none'`; `connectDomains` and `resourceDomains` that
  are exact origins (or `https://*.`) become egress, anything else is dropped.
- **Tool visibility is the host's policy:** its `callTool` handler refuses tools the view may not
  call (`_meta.ui.visibility`).
The leak suite runs the official examples as published (`server-basic-vanillajs`,
`server-basic-react`, `server-threejs`, pinned dev dependencies, unmodified) through the adapter, in
an opaque frame and behind the sandbox proxy: tool input (streamed) and result, `tools/call`,
`ui/message`, `ui/open-link`, theme change, size, teardown and model context; all pass on Chromium
and WebKit. **Measured:** a click in a view, opaque or served, activates the host page on both
engines (each clicked call reached the bridge with `userActivated: true`).
**Why.** Interop is decided by the real SDK and examples, not by reading the spec (PRINCIPLE 6);
everything a view can do beyond drawing stays a declared, gated host function (PRINCIPLE 4).
**Rejected.** Sending all theme variables (breaks every SDK view); a host callback for display
modes outside the bridge (an ungated power); honoring `frameDomains` (re-opens P006's nested-realm
channel).
**Revisit when** the SDK accepts unknown style keys or the spec adds names (then widen the list),
or a host needs fullscreen views (then a `displayMode` capability with a gate).

## P028 · 2026-10-11 · The host context carries only the spec's style names; Porthole's own go in `porthole/styles` · Accepted

**Decision.** In `ui/initialize` and `host-context-changed`, `styles.variables` holds
exactly the names MCP Apps defines (`MCP_APPS_STYLE_VARIABLES`, in the core, re-exported
by `/mcp`). The theme's other variables (`--color-accent`, the chart palette, a host's
own) travel in the host context's own-prefixed field `porthole/styles: { variables }`;
the shell applies both, filtered by the config's names. The shell numbers its own
requests with strings (`porthole-shell-<n>`) so content using the App SDK in the same
window never takes the shell's answers, nor the shell the SDK's.
**Why.** Measured: the official App SDK (ext-apps 2.0.3) validates the host context
strictly and fails the whole handshake on an unknown style name ("Invalid result for
ui/initialize: hostContext.styles.variables: Unrecognized keys"), while it keeps
unknown top-level fields. The `0.app-sdk-*` probes connect the official SDK from content
under the inline, artifact and MCP Apps presets; the `style-split` negative control
(every variable in `styles`) makes all three fail with that error.
**Rejected.** Dropping the extra variables (the manual teaches them); defaults baked
into the shell's CSS only (a host's live values for them would never arrive).
**Revisit when** the spec's style list grows (move names across) or it gains an
extension point for host-specific variables (use it, and take ours upstream).

## P029 · 2026-10-11 · Documents are rendered inert and imported; content can't rewrite its document or build declarative shadow roots · Accepted

**Decision.** A whole document (an artifact page, an MCP Apps view in an opaque frame,
a served page, the sandbox proxy's view) is never handed to the page's parser: it
travels as data (the shell's plan, or the protocol's tool input), is parsed with
`DOMParser` (no scripts run, no declarative shadow roots built), guarded, imported in
place of the shell's, and its scripts run in order, as a fragment's are, followed by
`DOMContentLoaded` and `load`. Content can't rewrite its document
(`document.open`/`write`/`writeln` throw), and the entry points that would build a
declarative shadow root (`setHTMLUnsafe`, `Document.parseHTMLUnsafe`) get fragment
parsing's behavior. The sandbox proxy (P026) writes the shell's own document with the
view in its plan, not the view's markup.
**Why.** The frame guard (P006) reaches every shadow root `attachShadow` makes, but not
a closed declarative one: the parser builds it without any script seeing it, and a frame
inside it runs in a fresh realm. Measured on Chromium: with the `setHTMLUnsafe` block
taken out (`declarative-shadow` control) a child frame in a closed declarative root
runs; with `document.write` allowed (`parser-entry-points`) a rewritten document's child
runs. Rendering by import has no such path, and the re-serialization alternative
(parse, strip, serialize, write) reopens it through markup that parses differently the
second time.
**Rejected.** Writing documents with `document.write` (the first host's way); a string
sanitizer; letting content rewrite its document.
**Cost.** Content that calls `document.write` fails (reported as an error); declarative
shadow DOM in content is inert; a page's scripts see `document.readyState` "complete"
(their load events still fire, once).
**Revisit when** engines let a script observe or refuse declarative shadow roots (then
allow them), or a host needs `document.write` content.

## P030 · 2026-10-11 · Guarded elements are refused synchronously, where they are connected or changed · Accepted

**Decision.** Besides the mutation observer (which runs at the next microtask), the shell
wraps every DOM insertion API (`appendChild`, `insertBefore`, `replaceChild`,
`append`/`prepend`/`replaceChildren`, `before`/`after`/`replaceWith`,
`insertAdjacentElement`, `Range.insertNode`/`surroundContents`) to drop frame-like
elements and resource hints before they are connected; parses markup set through
`innerHTML`, `outerHTML`, `insertAdjacentHTML` and `setHTML` in a detached element of the
same kind, guards it, then moves it in; refuses `execCommand("insertHTML")`; and removes a
connected `<link>` or `<meta>` from the document before any change (attributes, IDL
setters, `relList`, attribute nodes and maps) that would make it a guarded one. Each
wrapper is fixed in place (non-configurable).
**Why.** Measured on WebKit: a `rel=preconnect` link that script inserts, or turns into a
preconnect while connected, opens a TCP connection at once, outside the CSP, before any
observer runs (`8.preconnect` failed with 3 connections; it passes with these guards).
Chromium measured no preconnect from a frame here, but harden for the weakest engine
(PRINCIPLE 6). The `sync-guard` negative control makes `8.preconnect` fail on WebKit.
**Rejected.** Accepting the leak on WebKit; relying on the observer alone.
**Revisit when** WebKit applies the CSP to preconnect (then the observer suffices), or a
DOM insertion API is added (wrap it, and add its probe).

## P031 · 2026-10-11 · A display whose content navigates its frame is started again, at most three times · Accepted

**Decision.** The web platform counts its frame's loads; any after the first means the
content navigated the frame. The display is started again from its content (an event
`navigated`), at most three times per run, then stopped with an error. The wall against
navigating out is the embedding page's `frame-src` (P006); a document the frame
navigates to must never run, and the leak suite asserts that, not the restart.
**Why.** Measured on Chromium and WebKit: a self-navigation the embedding page's
`frame-src` blocks still replaces the frame's document (an error page fires `load`), so
the content is gone either way; starting again keeps the display showing. Measured on
Chromium with the embedding CSP taken out (`embedder-csp` control): a `blob:` or `data:`
document the frame navigates to runs, and only the restart's timing kept it from
reaching the STUN oracle, which is a race, not a wall; so `5.blob`/`5.data` assert, with
a witness origin, that such a document never runs.
**Rejected.** Ignoring navigations (a blank display); restarting forever (content that
navigates on load would loop).
**Revisit when** an engine keeps the frame's document on a blocked navigation.

## P032 · 2026-10-11 · Every hardening item has a negative control · Accepted

**Decision.** The leak suite's server can serve the core with one defense taken out
(`PORTHOLE_LEAK_WEAKEN=<name>`: `frame-guard`, `webrtc`, `attach-shadow`,
`parser-entry-points`, `declarative-shadow`, `sync-guard`, `connect-src`, `self`,
`sandbox`, `base-uri`, `style-split`, `embedder-csp`; later also `embedder-self`,
`confirm-gate`, `host-gesture`, `shell-gesture`, `link-scheme`, `draft-inert`). Each names the exact text it
removes, and the server refuses to start if that text is gone, so a control can't
silently weaken nothing. DESIGN.md records, per engine, which probes each control makes
fail. Every probe that asserts "nothing left" also has a positive control (an allowed
origin, an unsandboxed peer connection, an unsandboxed hint) or says it has none.
**Why.** PRINCIPLE 6: a wall never seen to fail proves nothing. Running the controls found
what the passing suite could not: that `5.blob` passed by a race (P031), that two walls
stand behind form submission (`sandbox` alone doesn't fail `6.submit`: `form-action`
holds), and that an opaque frame's `'self'` doesn't reach the host on Chromium.
**Rejected.** Trusting a green suite.
**Revisit when** a defense is added (add its control) or a control stops failing its
probes (the probe has gone blind: fix it first).

## P033 · 2026-10-11 · The embedding page frames nothing by default: `frame-src 'none'` for opaque content · Accepted

**Decision.** `embedderCsp` no longer includes `'self'`: for opaque displays it is
`frame-src 'none'; child-src 'none'`; served and external displays add their content
origins, and a host its own frames through `embedder.frameSrc`, where `'self'` is
accepted only by name. Resolves DESIGN's open question on `'self'`.
**Why.** Measured on Chromium and WebKit: a `srcdoc` frame loads and runs under its
embedding page's `frame-src 'none'`, so `'self'` bought opaque content nothing but a way
to navigate its frame to the host's own origin, a request carrying whatever the content
puts in its URL, with any of the host's `SameSite=None` cookies. Probe `5.host-origin`
asserts no such request; the `embedder-self` control makes it fail. This tightens a
default (PRINCIPLE 1 allows that freely); a host that frames its own pages names `'self'`
and accepts that navigation.
**Rejected.** Keeping `'self'` (the first host's policy) for compatibility.
**Revisit when** an engine stops letting `srcdoc` frames load under `frame-src 'none'`
(the opaque-origin probes would fail at once).

## P034 · 2026-10-11 · The React binding owns lifecycle and page state; the core owns everything else · Accepted

**Decision.** `@botiverse/porthole/react` is mounting and lifecycle only: a
`PortholeProvider` per page holds the live-frame registry (`admitFrame`, the first host's
policy: frames off screen longest stop first, a stopped one keeps its height and offers
"Run again"), the heights displays reported (by display id), and the default dialog
queue; a `PortholeFrame` per display mounts the core's `createHost` when it nears the
screen, feeds it `content`/`partial`/`scheme` (and its id and title), and makes a new
display only for a new `config`, `document` or `instance` (or `generation`). It is
written in TSX (the React lint rules only understand JSX; a host's bundler or the
package's build compiles it). Handlers are read
from the latest props. The cap is each config's `limits.maxLiveFrames`. Without a
provider, frames run against a page-wide registry and no one confirms (gated calls are
refused). The shell reports no size before it has drawn something.
**Why.** These are the first host's widget-frame behaviors (OBJECTIVE 4: its code
reduced to config plus callbacks), and they are page state a framework binding owns,
not isolation. Measured while testing: the first host's shell reported an empty
shell's height at its handshake, which overwrote a display's remembered height and
made a re-mounted frame jump; `11.size` now asserts the first size is the content's.
**Rejected.** A binding with its own frame or protocol code; a default with no
provider that silently auto-confirms.
**Revisit when** a second framework needs a binding (then move the registry and
heights into a framework-free module both use: `live.ts` already is).

## P035 · 2026-10-11 · Firefox joins the gate; its differences are measured and need no new wall · Accepted

**Decision.** Completes P017: every Playwright suite (leak, served, MCP examples, React)
runs on Chromium, WebKit and Firefox, and every negative control was run on Firefox.
All leak probes passed on Firefox as they stood; no defense was added for it. Its
differences, each measured (Firefox 155, Playwright 1.63):
- A navigation the embedding page's `frame-src` blocks **keeps** the frame's document
  (Chromium and WebKit replace it with an error page, so their displays restart, P031).
  The React binding's recovery test therefore navigates to `about:blank`, which every
  engine follows.
- A frame without `allow-popups` gets an exception from `window.open` (the others get
  `null`): no window either way. The served `no-popups` cases accept both.
- Firefox sends no STUN to a loopback server by default, which left `3.webrtc` without
  its positive control; the suite's Firefox project sets
  `media.peerconnection.ice.loopback` (test environment only), and an unsandboxed peer
  connection then reaches the oracle while the sandboxed one, without constructors, can't.
- Without the embedding CSP, Firefox still refuses a frame's own navigation to `data:`
  (`5.data` holds under the `embedder-csp` control); the other navigations out fail, as
  on the other engines.
- Like Chromium, Firefox opened no preconnect even unsandboxed (`sync-guard` alone fails
  nothing on it); WebKit stays the weakest engine there (P030).
- A click in the frame reaches the host page's user activation; a new child frame's
  realm is unreachable in the task that made it (a `TypeError`, not a `SecurityError`).
- Headless Firefox has no WebGL on a machine without a GPU (Mesa installed or not): the
  threejs example cases skip there with that reason; they are about the machine, not
  Porthole. A Playwright worker crashed once (SIGSEGV) and never again on rerun.
- Waiting on script in a frame that `frame-ancestors` refused never settles on Firefox;
  the served `frame-ancestors` case bounds that wait.
**Why.** PRINCIPLE 6: engines differ, so each is measured and the weakest decides. Firefox
is weaker nowhere the suite can see.
**Revisit when** an engine version changes any of these (the probes and controls will say
which), or Firefox gains a synchronous hint path like WebKit's.
