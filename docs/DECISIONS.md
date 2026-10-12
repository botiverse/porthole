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
`confirm-gate`, `host-gesture`, `shell-gesture`, `link-scheme`, `draft-inert`, `document-theme`). Each names the exact text it
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

## P036 · 2026-10-11 · A host's origin may have any scheme, still exact · Accepted

**Decision.** The origins the shell takes messages from, and `/server`'s `hostOrigins`, are
exact origins of any scheme (`scheme://host[:port]`, lowercase, no path): a desktop app's own
registered scheme (`ferry://app`, `app://local`, `tauri://localhost`) works like `https://`.
`"null"` is refused with a message saying why (an opaque origin isn't one origin; `file:` pages
and unregistered custom schemes have one), as are wildcards, paths and uppercase. A custom-scheme
host is never the same site as web content, so the same-site check doesn't apply to it. Errors on
origins say what to do: http and ws are allowed on loopback names only ("use https"), and a
same-site content origin is refused with the host and the rule named. Item 0 (and 10) of 0.1.1.
**Why.** The first host's packaged desktop app serves its UI from `ferry://app`, and nothing
mounted there; the checks were written for the web. The check that matters (the sender is the
frame's parent, from exactly this origin) is unchanged.
**Rejected.** Accepting `"null"` (any opaque page would pass the origin check).
**Revisit when** a host must run from an opaque origin (then it needs another channel to prove
it is the parent).

## P037 · 2026-10-11 · A url-mode frame may opt into popups, modals and downloads · Accepted

**Decision.** `presets.url({ sandbox: [...] })` adds tokens from a documented set
(`URL_SANDBOX_EXTRAS`: `allow-popups`, `allow-popups-to-escape-sandbox`, `allow-modals`,
`allow-downloads`) to url mode's baseline (`allow-scripts allow-same-origin allow-forms`). Nothing
else, never `allow-top-navigation*` (refused by name), and only in url mode. The safe default
stays: no extras. Item 7 of 0.1.1.
**Threat it re-opens.** The framed app (the person's own running app, on its own origin) may
open windows (which, with `-to-escape-sandbox`, are unsandboxed top-level pages of its origin),
show modal dialogs over the host, and start downloads. Bounded by: its origin is a separate site
from the host's (`checkFrameLocation`, P020), so a window it opens can't reach the host; it still
can't navigate the host's page; it is the host's policy to opt in (PRINCIPLE 8), for an app the
person runs. The React url-mode test shows the default refuses a popup and top navigation, and
the opt-in allows the popup and still refuses top navigation, on all three engines.
**Rejected.** A free-form token list; extras for agent-made content (inline, artifact, views).
**Revisit when** a host needs another token (add it to the set, with its test).

## P038 · 2026-10-11 · The embedding page's CSP restricts frames only (no child-src) · Accepted

**Decision.** `embedderCsp` is `frame-src …` alone; it no longer repeats the sources in
`child-src`. Item 4 of 0.1.1.
**Why.** Measured on Chromium, WebKit and Firefox: under 0.1.0's `child-src 'none'` the host's
own workers (blob and file) were blocked, since `worker-src` falls back to `child-src`. All three
engines read frames from `frame-src` (the item-5 probes pass without `child-src`), so the repeat
protected nothing and broke hosts. With no `child-src` (and no `default-src`), Porthole's policy
says nothing about workers at all, whatever the host's own policy says.
**Rejected.** Emitting `worker-src 'self' blob:` (it would restrict hosts that load workers from
elsewhere).
**Revisit when** an engine Porthole supports reads frames only from `child-src`.

## P039 · 2026-10-11 · A whole document takes the person's scheme only when it declares it · Accepted

**Decision.** An artifact page (or any whole document the shell renders) shows as its author
styled it, in light, unless it declares it supports both schemes
(`<meta name="color-scheme" content="light dark">`); then it takes the person's scheme
(`color-scheme`, `data-theme`) like a widget does. The theme variables are set either way (they
change nothing a page doesn't use). A host may set `theme.documents: "always"`. The manual says
so for artifact pages. Fragments (widgets) are unchanged. Item 12 of 0.1.1.
**Why.** A shown HTML file is the author's own page: forcing a dark `color-scheme` on a page
written for light turns its default text and canvas dark under its own light colors, and the
first host had to force light. The `11.document-theme` probe and its `document-theme` control
show both cases on every engine.
**Rejected.** Theming every document; never theming documents (pages that support dark should
follow the person).
**Revisit when** a host needs per-page control beyond the meta tag.

## P040 · 2026-10-11 · A display reports how its first document went · Accepted

**Decision.** Every display emits `outcome` once per run: `loaded`, `blocked` (with a reason:
`framing`, `cookies`, `session`, `upstream`, `not-found`, `error`, and the HTTP status where
there is one), or `timeout` (`limits.loadTimeoutMs`, 15 s by default). A shell or view is loaded
when its handshake completes. A url-mode frame, which has no handshake, is ready (`initialized`)
on its first load and fills its container (at least `minHeightPx`), since an app reports no size.
Pages of Porthole's `/server` tell their host how it went with an own-prefixed notification,
`porthole/notifications/frame-status`, posted to the host origins only: every status page says
`blocked` and why; a framed url-mode app is entered through a small page (not a redirect) that
says `entering`, checks the session cookie its own answer set was kept (`/__porthole/session`),
then goes on to the app, or says `blocked: cookies`. `issue` marks its locations `reports: true`,
so a load from which nothing spoke is a page that never ran (`blocked: framing`). A host's own
gateway may send the same notification. Items 1 and 13 of 0.1.1.
**Why.** A host needs to show its own fallback ("Open in a new tab") without pages of its own,
and a cross-origin frame can't be looked into: the only honest signals are the frame's loads,
its words, and time. Measured on all three engines (`leak/served/outcome.spec.ts`): a framed app
loads on Chromium and Firefox and is `blocked: cookies` on WebKit (P025); a host the server
doesn't allow gets `blocked: framing`; a used ticket `blocked: session`; a hanging load a
timeout; a served shell `loaded`, and `blocked: framing` from a foreign host.
**Limits.** Without `reports`, a frame the browser refused (its own policy, or the embedding
page's) still fires `load`, so it reads as loaded: only Porthole's pages (or a gateway that
speaks the notification) can say otherwise. An app's own `frame-ancestors` after entry likewise.
**Rejected.** Injecting a script into an app's pages (rewrites someone else's HTML, breaks under
its CSP); guessing from timing.
**Revisit when** browsers expose why a cross-origin frame failed, or MCP Apps defines a status
message (then speak it).

## P041 · 2026-10-11 · Porthole declares no test-only dependency; hosts register the conformance tests · Accepted

**Decision.** The package declares no dependencies, and React only as an optional peer.
`@playwright/test` and `@modelcontextprotocol/ext-apps` are no longer peers (optional or not):
`/conformance` runs on the host's own Playwright (and, for the App SDK probes, its own SDK,
skipped if absent). The tests are exported as entries (`leakTests`, `servedTests`) that a host
registers with its own `test()` in its own spec file, so they are located there and filtered by
that file or a probe id (`--grep "\[1\.connect\]"`); `defineLeakSuite`/`defineServedSuite`
remain for hosts that don't filter. Items 5 and 6 of 0.1.1.
**Why.** Some installs added the optional peers anyway (the first host's server image got
Playwright). A conformance runner is a host's test tool, not part of what it ships; and tests
registered inside the library were located in `node_modules`, so a host couldn't select them.
`test/package.test.ts` and `test/conformance-listing.test.ts` keep both true.
**Rejected.** A separate `@botiverse/porthole-conformance` package (a second package to publish
and version in lockstep, for one import); a CLI wrapper (the host's Playwright config already
runs its spec).
**Revisit when** a host's install layout can't resolve its own Playwright from the package (no
hoisting, Plug'n'Play): then split the package.

## P042 · 2026-10-11 · Confirm says accepted, declined or redirected, and may run the effect in its click · Accepted

**Decision.** A host's `confirm(request, proceed)` resolves `true`/`"accepted"`,
`false`/`"declined"`, or `"redirected"` (the person took it elsewhere, "Edit first": not sent,
refusal `redirected`, neither counted nor resetting). Only declines **in a row** mute a display;
an accepted call resets the count. `proceed()` runs the call's effect at once, inside the
caller's own gesture, and counts as accepted; the default dialog's yes calls it in its click, so a
handler that opens a window does so within the person's click. Items 8 and 11 of 0.1.1.
**Why.** The first host's "Edit first" counted as a decline and three of any declines muted a
widget, against its own original rule. An effect that needs a gesture (a window) can't wait for
a promise to settle on engines that end the gesture on the next task. Measured in Playwright on
all three engines: a yes given 1.5 s later, without `proceed`, still opened a window there, so
the tests show `proceed` works rather than that it is needed; real browsers' popup blockers are
stricter than headless ones.
**Rejected.** Running the effect in the dialog itself (the effect is the host's).
**Revisit when** a host needs more answers than these three.

## P043 · 2026-10-11 · Theme reads wait for the host's restyle; heights follow a renamed display; defaults can be dropped · Accepted

**Decision.** `setTheme` reads the host's values two animation frames after the flip (a host
that restyles its page on its next frame has by then); `refreshTheme()` (React: a new `themeKey`)
reads them again without a flip. A display renamed while it runs keeps its remembered height
under its new id, and `PortholeFrame`'s `aliases` find it under ids it had for a frame that
mounts anew. A host drops default theme variables with `null` in a preset's theme. Items 2, 3
and 9 of 0.1.1.
**Why.** The first host's design system swaps tokens a frame after its scheme flips, so a frame
read stale colors; its streamed widgets changed id and jumped when they mounted again; its
palette needs none of Porthole's chart colors. Each has a React test in a real browser (an async
restyle, a rename then a remount, an alias) and the agreement test covers a theme without the
chart colors and the accent.
**Rejected.** A fixed delay in milliseconds (frames are what a restyle waits on).
**Revisit when** a host restyles later than its next frame without being able to signal it.

## P044 · 2026-10-11 · `/server` runs on any web-standard runtime: its hashing is plain JavaScript · Accepted

**Decision.** `/server` loads no Node module. SHA-256 and HMAC-SHA-256 are plain JavaScript
(`src/server/crypto.ts`, FIPS 180-4 and RFC 2104), randomness comes from
`crypto.getRandomValues`, and base64url and the constant-time compare are its own. It runs on
Cloudflare Workers without `nodejs_compat`, and on Node, Deno and Bun. Its outputs are byte for
byte those of 0.1.1's `node:crypto`, so labels, tickets and cookies issued before still hold.
Item 1 of 0.1.2.
**Why.** Web Crypto's HMAC is asynchronous, and `originFor` is synchronous (a host computes an
origin while it renders): async hashing would have changed the API. The inputs are a few dozen
bytes (a scope, a ticket, a cookie), so speed doesn't matter. `nodejs_compat` is a flag a host
may not want, and it pulls in polyfills. Tested three ways:
- the standard vectors (NIST, RFC 4231) and agreement with `node:crypto` (`test/crypto.test.ts`);
- a static check that nothing `/server` loads imports a `node:` module or uses `Buffer`,
  `process` or `require`;
- a Worker bundled from `/server`, run in workerd (Miniflare) with no compatibility flags and a
  real D1 database (`test/workers.test.ts`).

The Worker test covers the flat names, a ticket once, the cookie on a reload, a race, an
anonymous link, a revocation, and the reserved namespaces.
**Rejected.** `nodejs_compat` (the host's flag to set, not ours to require); Web Crypto (async);
a hashing dependency (P041: none).
**Revisit when** Web Crypto has a synchronous HMAC, or a profile shows the hashing costs.

## P045 · 2026-10-11 · On Workers, tickets live in D1, taken by one `DELETE … RETURNING`; never in KV · Accepted

**Decision.** `d1TicketStore(db)` keeps tickets in a D1 table (`d1TicketSchema()`, applied once as
a migration). A ticket is taken by a single statement, `DELETE … WHERE id = ? RETURNING`, so two
requests racing for one ticket can't both get it. Expired tickets are swept as new ones go in.
The rows hold the ticket's hash only, as in memory. Sessions stay signed cookies with no store;
the host revokes them through its per-request check (P050). The in-memory store remains the
default. Item 2 of 0.1.2.
**Why.** A ticket must open its content once, across every isolate of a Worker. D1 runs writes
on its single primary, one statement at a time. Workers KV is eventually consistent (a write or a
delete may take up to a minute to be seen elsewhere) and has no atomic read-and-delete, so a
ticket read in two places could be used twice. Measured on real D1 in workerd: two requests
racing for a ticket get one 200 and one 401. Unit tests run the same SQL on SQLite (expiry, the
sweep, table names).
**Rejected.** KV (above). A Durable Object store would be just as strict, but each host would
need a class binding and its migrations; the host this was built for already has D1. A session
store (a cookie is enough; revocation is the host's check).
**Revisit when** a host uses D1 read replicas through the Sessions API. A `DELETE` is a write and
goes to the primary, but a store that read first would not be safe.

## P046 · 2026-10-11 · Anonymous grants for public links · Accepted

**Decision.** `issue(instance, { anonymous: true, subject? })` mints a ticket that names no
viewer, for public links. Only documents qualify (a shell, an artifact version, the MCP Apps
sandbox proxy), never a url-mode app. Every other rule is the same as for a named viewer:
- the ticket works once, for a short time, and is bound to one instance (for an artifact, one
  version);
- the cookie it buys is `__Host-`, `HttpOnly`, of that origin and that instance only;
- only the host origins may frame the content.

The host's check sees `anonymous: true` and an empty viewer. A grant naming both a viewer and
`anonymous` is refused. Item 3 of 0.1.2.
**Risk it re-opens.** Whoever reaches the host's public route gets the content. That route is
the only gate, because Porthole can't tell a link's holder from anyone else. A cookie bought
anonymously keeps opening that instance until its `sessionSeconds` end. Unsharing takes effect
at once only if the host's check looks at the share: give the grant the share id as its
`subject`, and deny it once unshared (P050). Anyone can make the public route mint tickets, so
the host rate-limits it (tickets expire and are swept).
**Bounded by** the server tests (once per ticket, never another instance, never an app, a viewer
and `anonymous` together refused) and the Worker test.
**Rejected.**
- A long-lived public URL without a ticket: a reusable bearer URL that shows up in logs and
  referrers and never expires.
- Public content without a cookie: a reload would show nothing.
- Anonymous url-mode apps: every request to someone's running app, with its data and sessions,
  would be open.

**Revisit when** a host needs anonymous access to an app (then a decision of its own).

## P047 · 2026-10-11 · A host may name content origins itself; other servers' namespaces are reserved · Accepted

**Decision.** `content.name(scope)` gives the label a scope is served on, and Porthole checks the
answer:
- it is one lowercase DNS label (`a-z0-9-`, at most 63, no hyphen at either end);
- it is not in an IDNA form (`xn--`, any `??--`);
- it is not `reserved`.

`prefixedName("a-")` is the one-to-one naming most hosts want (`a-<scope>`, scopes already
label-safe, anything else throws rather than fold into another scope's name). `content.reserved`
lists labels that belong to other servers under the same domain: `f`, for a server whose domain
is `f.<domain>` and whose origins are `<label>.f.<domain>`, or `www`. This server never names
them, and a request for one, or for anything under one, gets null and goes to the host's routes.
Any other deeper name still gets this server's 404. The keyed label (24 base32 characters) stays
the default. A keyed label never has a hyphen and a prefixed one always does, so the two
namespaces never meet. Item 4 of 0.1.2.
**Why.** A host with ids of its own wants stable, readable origins (`a-<id>.example-usercontent.com`)
next to another host's under the same content domain (`<instance>.f.example-usercontent.com`).
**Risks.**
- A host's names are guessable. Nothing opens without a ticket or a cookie, but the keyed
  default also hides which scopes exist.
- A naming that maps two scopes to one label merges their origins (storage, cookies). The helper
  is one-to-one; a host's own function must be too.
- Every label under one registrable domain is same-site with every other. `__Host-` cookies
  can't be set across labels, but SameSite doesn't separate them. Put the content domain on the
  Public Suffix List, and each nested namespace with it (`example-usercontent.com` and
  `f.example-usercontent.com`), so each origin is a site of its own.

**Rejected.** Free-form names (dots would nest namespaces, uppercase and IDNA forms would make
names that read as something else); a registry of names in Porthole (the host's ids are the
host's).
**Revisit when** the Public Suffix List entry lands: then the same-site note above can go.

## P048 · 2026-10-11 · Artifact pages reach library CDNs only by the host's config · Accepted

**Decision.** For artifact pages to load libraries, a host passes `egress: LIBRARY_CDNS` to
`presets.artifact`. For served pages it does so under a config name of its own that the
instance's `document.preset` selects (the harness's `artifactCdn`). Nothing else changes. The
default artifact preset stays closed (P022). Item 5 of 0.1.2.
**Why.** Agent-made pages often load a chart or diagram library. Opening the CDNs is a fair
choice for a host to make, but it is the host's (P022). Tested on all three engines, both opaque
and served in domain mode (`leak/cdn.spec.ts`):
- a page's `<script src>` from a listed CDN loads;
- one from any other origin doesn't reach the network;
- under the default preset, nothing does.

The CDN is routed inside the test, so nothing leaves the machine, and a request reaches the
route only if the frame's CSP let it out.
**Risk (the host's, as P022 says).** Code from the CDNs is code the host doesn't control (a
compromised or typo-squatted package runs in the frame). It still runs inside the sandbox and
egress, but a path requested from an open CDN is a narrow write channel whose reader is the CDN's
operator. The manual teaches pinning versions.
**Revisit when** hosts want subresource integrity required on CDN scripts (the manual could
demand it, and the shell could check it).

## P049 · 2026-10-11 · A url-mode frame may be delegated clipboard writes and full screen · Accepted

**Decision.** `presets.url({ permissions: ["clipboard-write", "fullscreen"] })` (config
`permissions`, url mode only, from `URL_PERMISSIONS`) sets the frame's `allow` attribute. By
default it delegates nothing (`allow=""`), and the other modes always delegate nothing. Item 6 of
0.1.2 (the first host's backlog).
**Risk it re-opens.**
- Clipboard writes: the app can put any text on the clipboard in a click (pastejacking: a
  command that looks like one thing and is another).
- Full screen: the app can cover the whole screen and draw a fake host or OS. The browser shows
  its own notice, and Esc leaves.

Both need the person's click. A url-mode app is a running app the host chose to show, on an
origin of its own.
**Measured** (`leak/served/permissions.spec.ts`, with the clipboard permission granted, so the
delegation alone stands in the way):
- Full screen follows the delegation on Chromium, WebKit and Firefox (`fullscreenEnabled`, and
  `requestFullscreen` in a click).
- Clipboard writes follow it only on Chromium. WebKit and Firefox let any frame write the
  clipboard in a click, delegated or not, so there default-off is no wall.

Negative control: `url-permissions` (delegate both by default) fails the default case on all
three engines.
**Rejected.** `clipboard-read` (reads what the person copied anywhere); camera, microphone,
location and the rest (a decision each, if ever); delegation in opaque or domain mode
(agent-written HTML).
**Revisit when** WebKit or Firefox enforce the clipboard-write policy feature (then the
measurement changes), or a host needs another feature.

## P050 · 2026-10-11 · The host's check runs on every request; Porthole carries the host's decision and never makes it · Accepted

**Decision.** `ServerOptions.authorize = { check(request), ttlSeconds? }`. Porthole calls it after
a ticket or cookie verifies and before anything of the content is served: a document's first
load and its reloads, a url-mode app's entry and its every request, `/__porthole/session`, and
`access()` (a host's WebSocket path).
- **Input.** The scope, the instance, the viewer (or `anonymous`), the request, and the host's
  own opaque `subject`. The host sets the subject at `issue` (512 characters at most); it is
  signed into the ticket and the cookie and never interpreted.
- **Answer.** `{ allow: true }` or `{ allow: false, code? }`. A deny, or a check that throws, is
  a 403 status page with reason `denied` and the host's code (`[a-z0-9-]{1,40}`, dropped
  otherwise). The page tells the display, whose `outcome` is `blocked: denied` with the code,
  even after `loaded`.
- **Caching.** None by default. `ttlSeconds` (at most 300) reuses an answer for the same
  instance, viewer, subject and session.

The scope line, now in PRINCIPLE 8 and ARCHITECTURE: authentication and authorization *policy*
are the host's; carrying the host's decision safely onto the content domain is Porthole's
*mechanism*. Item 7 of 0.1.2.
**Why.** A session cookie good for an hour outlived a revoked share or a member who left.
Sessions are stateless (P045), so revocation needed either a session store in Porthole (and with
it a notion of who someone is) or the host's own check. The check lets the host apply its own
policy (shares, membership, deletion) while Porthole knows nobody.
**Measured** on all three engines (`leak/served/authorize.spec.ts`):
- A framed url-mode app mid-session: its very next request is a 403, its reload shows the denied
  page, and the host gets `[loaded, blocked: denied (revoked)]`. This runs on Chromium and
  Firefox; WebKit keeps no cookie in a cross-site frame (P025), so a framed app never has a
  session there.
- A framed page's next load (WebKit: `session`, for the same reason).
- A revoked subject's ticket, framed: denied on all three.
- In a tab of its own, an app's next request and a page's reload: denied on all three.

Negative control: `authorize` (the harness's server without the check) fails every case except
WebKit's framed page, which expects `session` either way.
**Limits.**
- What is already loaded keeps running until its next request. An app's own fetches get a 403
  the app must handle; the host hears of it at the next load.
- A `ttlSeconds` delays revocation by up to that long.
- The check's latency is on every request (a host caches its own lookups, or sets a short TTL).

Found on the way: the url-mode entry page could leave for the app before its own load, and then
the host never counted that load and never decided `loaded`. It happened reliably in the full
suite on Chromium under load. The entry page now leaves only once it has loaded.

**Rejected.** Identity, sessions or revocation lists inside Porthole (PRINCIPLE 8); short
sessions as revocation (still a window, and more tickets).
**Revisit when** a host needs Porthole to push a revocation into a loaded frame (it can't today:
a cross-origin frame is the content's).

## P051 · 2026-10-11 · Content never writes the clipboard · Accepted

**Decision.** Content cannot write to the clipboard by itself, on any engine. The first host's
owner decided this.

The walls are:
- The frame's `allow` denies `clipboard-read` and `clipboard-write` by name.
- The shell makes the async Clipboard API refuse (`write`, `writeText`, `read`, `readText`).
- `execCommand` refuses `copy`, `cut` and `paste`.
- Copy and cut events are stopped at the window before any listener of the content's runs. A
  copy the person makes still copies their selection as the browser makes it.

Copy buttons go through the host instead (P052). Url mode is unchanged: an app is someone's own
running app, and only the host can delegate clipboard writes to it (P049). Item 1 of 0.1.3.

**Why.** Measured on 0.1.2: a click in an opaque widget wrote the clipboard on all three engines.
- WebKit and Firefox allowed the async API.
- All three allowed the copy command and copy listeners that swap what the person copied.

Pastejacking into a terminal is a real risk for coding-agent hosts. A "copy this command" button
that copies something else needs only a click.

**Measured** (`13.clipboard-api`, `13.clipboard-command`, `13.clipboard-event`; the oracle is the
person's own clipboard, written and pasted on the host's page): every wall holds on Chromium,
WebKit and Firefox. The negative control `clipboard` takes out the shell's walls:
- The async API then writes on WebKit and Firefox. Chromium still refuses it through the `allow`
  denial.
- The copy command and copy listeners then write on all three.

Moving the person's selection on their copy keystroke changed nothing on any engine, so no wall
is claimed for it.

**What stays open.** Text hidden by CSS inside what the person selects goes with their copy. That
copy is the browser's own, which the shell doesn't rewrite. Hosts point people at copy buttons,
whose toast shows exactly what was copied.

**Rejected.**
- A per-widget opt-in for direct writes: any widget would opt in.
- Rewriting the person's own copy to "visible text only": an arms race with CSS, and it breaks
  honest copies.

**Revisit when** browsers let a page veto a cross-origin frame's clipboard writes (then the shell
wall is a second one), or the person's copy can be shown before it lands.

## P052 · 2026-10-11 · Copy buttons call `copyText`: the host copies, and shows what · Accepted

**Decision.** A new capability, `copyText({ text })`:
- **Gates:** a click (`user-activation`, which the shell and the host check), and 30 a minute.
- **Limit:** at most `MAX_COPY_CHARS` (20,000) characters.
- **Served by the host:** its handler writes the clipboard on the host's own page (the core's
  `writeClipboard` helper tries the async API, then the copy command) and shows the person what
  was copied.
- **Reached by:** the shell global `copyText(text)` in inline widgets and artifact pages, or
  Porthole's own request `porthole/copy-text` (MCP Apps has no clipboard request).

The React binding serves it by default. The provider's handler writes the clipboard and shows a
small toast (`CopyToast`) with the text, clipped to four lines and 280 characters, plus its length
when clipped. If the write failed, the toast says so and offers a Copy button: a click on the
host's own page, which writes it. A host's own `copyText` handler replaces it.

The manual tells authors to use `copyText` for every copy button; the widget topic says the
clipboard is closed to them otherwise. Item 1 of 0.1.3.

**Why.**
- Copy buttons are common in agent-made content.
- The host's page can write the clipboard in the person's click, because a click in a frame gives
  its ancestors user activation (measured on all three engines in 0.1.2, and the copy itself in
  0.1.3).
- Showing the text lets the person see what they are about to paste.
- No confirmation dialog: a copy has no effect until the person pastes, and the toast shows it
  then.

**Measured:**
- `12.copy-text`: a call on load is refused, and the whole text reaches the handler from a click.
- `leak/react.spec.ts`: the toast shows the clipped text, the person's clipboard holds the whole
  text, and a failed write is recovered by the toast's own button. All on three engines.

**Rejected.** A confirm gate by default (too heavy for a copy; a host can add one, and its dialog
shows the text); writing from inside the frame (P051).
**Revisit when** MCP Apps defines a clipboard request (then the adapter maps it).

## P053 · 2026-10-11 · Annotations are mechanism: the host's comments, anchored in content it can't trust · Accepted

**Decision.** A new optional capability, `annotate`, declared by the host. It is for inline widgets
and artifact pages, and for MCP Apps views where the host chooses. With it, the host can:
- let a person pick an element or select text to comment on;
- mark existing anchors over the content;
- bring one into view;
- learn where each anchor is now, or that it is orphaned.

Policy (who may comment, where comments are stored, what they look like next to the frame) stays
the host's (PRINCIPLE 8). The runtime is spliced into the shell only where `annotate` is declared.

**Messages.** Porthole's own (P002):
- Host to frame: `porthole/annotate.start | stop | show | focus | clear`.
- Frame to host: `selected` (an anchor plus a rect in the frame's viewport), `unselected`,
  `cancelled` and `anchored`.

**Anchors.** W3C Web Annotation selectors, so an anchor can be found again after the content
changes: `CssSelector`, `TextQuoteSelector` (with prefix and suffix) and `TextPositionSelector`,
at most one of each. Finding one again is best-effort, with an explicit `orphaned`.

**Item.** 2 of 0.1.3. The host this matches (an artifact viewer with its own injected bridge) can
drop its bridge. Its features are covered:
- element grab with a hover outline and a name tag;
- selection to comment, with a host-drawn affordance at the reported rect;
- jump with a flash;
- live updates.

It also gains persistent marks and re-anchoring across versions, which it lacked.

**Trust.** The shell shares the content's realm, so content can interfere or fake any report. The
host therefore:
- takes a selection only while it asked for that kind, a cancel only while picking, and results
  only for its own marks;
- rebuilds every report from known fields within `ANNOTATION_LIMITS` and drops the rest;
- rate-limits reports at 120 a minute through the bridge.

What a frame reports is a UI hint, never a permission. It decides where a comment is drawn,
never who may see or do anything.

**Measured** (`leak/annotate.spec.ts`, on Chromium, WebKit and Firefox):
- picking, cancelling, selecting, and both together;
- marks, focus and clear;
- re-anchoring on a revised page (by id, by moved words, by respaced words, and a deleted one
  orphaned);
- live changes reported only when they change;
- an MCP Apps view;
- a hostile page faking every kind of report. The negative control `annotation-checks` fails it.

**Rejected.**
- Wrapping anchors in `<mark>` elements: it rewrites the content's DOM and breaks its scripts and
  styles.
- The CSS Custom Highlight API alone: it can't outline elements and isn't in every engine
  Porthole supports.
- XPath selectors: brittle to the edits agents make.

**Revisit when** content needs to cooperate (an author-declared anchor id API), or MCP Apps defines
annotations.

## P054 · 2026-10-11 · On a page with a nonce-based script-src, the shell carries the host's nonce · Accepted

**Decision.** A host whose page sends a nonce-based `script-src` (no `'unsafe-inline'`) passes its
nonce to Porthole: `HostOptions.nonce` (a string, or a function read each time a frame starts),
or `PortholeProvider`'s `nonce`. An opaque frame's shell document then carries it on its
`<script>` and `<style>`. The shell gives it to every script it runs for the content, and to the
annotation layer's style. Item 5 of 0.1.4 (the second host's friction).

**Why.** A `srcdoc` frame inherits the embedding page's whole policy, so a strict page blocked the
shell. The host this was built for had to run the conformance suite on a stripped page. Served
frames are navigations to an origin of their own, so they inherit nothing and need no nonce.

**Measured.** The whole leak suite runs again on a reference page whose policy is
`script-src 'nonce-…'; object-src 'none'; base-uri 'none'` (`leak/strict-csp.spec.ts`). It
passes on Chromium, WebKit and Firefox. Its negative control `nonce` (the shell without the
nonce) fails it.

**Risk.** The frame learns the page's nonce:
- its scripts carry it;
- the shell's own script element is in its document.

A nonce is per response. It helps an attacker only together with a markup injection into that
same response of the host's page, which the content can't make by itself. A host that also
renders content-supplied HTML in its own page has a bigger problem than the nonce.

**Limits.** Inline event handlers in content (`onclick="…"`) stay blocked by such a policy, as they
are on the page itself; scripts and `addEventListener` work. A nonce-based `style-src` would also
block the content's inline styles; the shell doesn't rewrite those.

**Rejected.**
- Hash-based sources Porthole publishes for its shell: the content's scripts would still be
  blocked.
- `data:` or `blob:` frames to escape inheritance: they inherit too, or need `frame-src` entries.
- Requiring `'strict-dynamic'`: it's the host's policy to choose.

**Revisit when** browsers let an embedding page give a `srcdoc` frame a policy of its own instead
of its own.

## P055 · 2026-10-11 · What the content did wrong and what failed on the host's side are separate · Accepted

**Decision.** A display reports `contentError` (what the content threw, what the sandbox blocked,
that it kept navigating its frame away: the agent's to hear and fix) apart from `hostError`
(`{ message, kind }`). `kind` is `locate` when the host's locator rejected; in the React binding
it can also be `mount` (a display that couldn't be made) or `annotations` (an annotation call
refused). A failed locate also ends the display's load as `outcome: blocked, reason: locate`.

`error` still fires for both, now with `source: "content" | "host"`, so hosts that listened there
keep working. The React binding adds `onContentError` and `onHostError`; `onError` now gets
`(message, source)`. Item 1 of 0.1.4 (both hosts' friction).

**Why.** Both hosts forward the content's errors to the agent. A failed locate (the server down,
access gone) is the host's own, and the agent would have tried to fix a widget for it. One host
tagged its own messages to tell them apart; the other caught inside its locator. A failed locate
also used to leave no outcome at all.

**Tested.** On all three engines:
- core (`leak/served/outcome.spec.ts`): a failing locator gives `blocked: locate` and one host
  error, no content error; a throwing widget gives a content error only;
- React (`leak/react.spec.ts`): a throwing widget goes to `onContentError`, a display with an
  unserved capability to `onHostError` (`mount`), each with its source on `onError`.

Found on the way: on WebKit and Firefox a content error was reported without its message, because
their `error.stack` doesn't start with it the way V8's does, so the agent heard only a stack. The
shell now puts the message first there. Measured: WebKit mutes an opaque (`srcdoc`) frame's script
errors to "Script error.", so there the host gets a content error without its message; served
frames carry it on all three engines.
**Rejected.** Dropping host failures from `error` (it would break hosts that relied on seeing a
failed locate there).
**Revisit when** `error` can be removed (a major version).

## P056 · 2026-10-11 · `/server` routing a host can rely on · Accepted

**Decision.** Items 3, 4 and 8 of 0.1.4, and the second host's headers:
- **Reserved labels.** `content.reserved` takes whole labels, prefixes ending in `*` (`p-*`), or a
  function of the label. A function that throws reserves the label, so the request goes to the
  host's routes rather than being served as content. Requests in a reserved namespace return
  null, so a host routes its own `p-`/`w-` labels without wrapping `handle`. A host's naming may
  never produce a reserved label.
- **Host header.** The label is read from the request URL. If the Host header names another host
  and either of the two is under the content domain, the answer is a 400 page. A Host that is a
  local address (an IP literal, `localhost`, as Miniflare's `dispatchFetch` or a dev proxy sends)
  is not a name and isn't compared.
- **No upstream.** A server without an `upstream` serves only Porthole's own paths
  (`/__porthole/…`). Any other path gets a plain 404, not url mode's 401 "Open this from the
  app".
- **Indexing.** Every answer of Porthole's own says `x-robots-tag: noindex, nofollow`. Content
  origins are behind tickets.
- **Frame sources.** `embedderFrameSourcesOf(configs)` returns the embedding page's `frame-src`
  sources as a list, for a host that writes its own policy around them.

**Why.**
- One host shares its content domain with its own preview gateway on `p-…` labels. It had to
  route by label before `handle`.
- A Node adapter (Hono's `getRequestListener`) builds the URL from an absolute-form target
  (`GET http://other/…`) while the host, and any cache in front of it, routes by Host. A crafted
  request could get content served under another host's name.
- The second host rewrote every non-Porthole path to `/__porthole/not-found` to avoid the
  misleading 401, and sliced `embedderCsp`'s string to merge it.

**Tested.** Server tests cover:
- prefixes, a predicate, and a throwing predicate;
- names that would be reserved;
- a crafted Host, an absolute-form target, an agreeing Host with a default port, and a local
  address;
- the 404 without an upstream;
- the noindex header.

The Workers test (where Miniflare sends a local Host) still passes.
**Rejected.** Reading the label from the Host header instead: on Workers the URL is the routed
truth, and test runners send a local Host. Refusing every mismatch: it would refuse those runners.
**Revisit when** a host needs Porthole behind a proxy that rewrites Host (then
`X-Forwarded-Host`, by a decision).

## P057 · 2026-10-11 · Hosts lay out, identify and annotate displays as they write them · Accepted

**Decision.** Items 2, 6, 7, 9 and 10 of 0.1.4:
- **Shared storage, in the manual.** A config may say what the displays sharing an origin share
  (`storage: { shared: "conversation" }`, domain isolation only). The manual then says storage is
  shared across that scope and that keys need a prefix of the display's own.
- **Fill.** `MountOptions.fill` (React: `fill`) makes the frame fill its container, with the content
  scrolling inside, instead of growing with the content. Sizes are still reported.
- **Identity in React.** `config`, `instance`, `annotations` and the provider's `hostInfo` are
  compared by value. The provider's `locator` (like `confirm`) is read when used. An inline object
  no longer starts a running frame again.
- **Annotations settle.** Nothing is reported before the content is in place, nor while a run of
  changes settles. A `focus` asked for meanwhile waits, then scrolls and reports, so a focus right
  after `show` says where the mark is, never `orphaned` first. React's `focusedAnnotation` takes
  `{ id, key }` to focus the same mark again.
- **Served shells in the conformance suite.** `ServedConformanceHost.show` gets `options.content`
  for each shell, and a host that speaks to the shell sends it. A shell draws nothing, and reports
  no height, until it has content.

**Why.**
- One host scopes storage per conversation, so its widgets overwrote each other's keys untold.
- The second host needed `!important` CSS on Porthole's internal attributes to make an artifact
  fill its viewer.
- Hosts memoized config, instance, hostInfo and marks by hand, and one compared marks as JSON
  itself.
- Both hosts worked around a focus that said `orphaned` first.
- The first host's conformance host had to give shells content by itself.

**Tested.** On all three engines:
- React: inline objects across re-renders keep one display; an artifact fills its 300 px box and
  scrolls inside, and without `fill` grows to its cap.
- Annotations: a focus right after `show` gives two reports, both attached, the focused mark in
  view; marks shown before the content are reported once it arrives.
- The served shell cases pass against a `createHost` host whose frames take their content's height.
  Without content they time out clicking (checked by hand).

Unit tests cover the storage note and its validation.

**Rejected.**
- A dev-only warning for unstable props: comparing by value removes the need.
- `fill` in the config: it is the host's layout, per mount.

**Revisit when** a host's config or instance carries something that isn't plain data (then
compare it otherwise).

## P058 · 2026-10-11 · An opaque frame is as closed as its page; the suite says when a case can't be observed · Accepted

**Decision.** This is now documented in ARCHITECTURE (the network boundary) and DESIGN: a `srcdoc`
frame inherits the embedding page's whole policy along with its own. On a page with
`default-src 'none'` and a tight `connect-src` or `img-src`, opaque-mode content is more closed
than its config says. On such a page, hosts should prefer domain mode, whose frames inherit nothing.

The conformance suite detects this. When a positive control (`1.connect`'s allowed fetch,
`2.resources`'s allowed image) fails, the probe loads from the allowed origin once more and
watches for a CSP violation. A violation there can't come from the frame's own policy, which
allows that origin, so it is the page's. The probe then reports itself **inapplicable on this
host** (skipped, with the reason) instead of failing.

`12.no-confirm` does the same on a host that always has a confirm function (a default dialog), so
a display without one can't be shown. When it is asked anyway, it answers no and reports
inapplicable.

Probes get `context.inapplicable(reason)`. Item 3 of 0.1.5 (the second host's adoption).

**Why.** The second host's real page sends `default-src 'none'` and `connect-src 'self'`. Its
suite failed two positive controls that prove nothing about its isolation, and failed one case
that its React host can't set up.

**Tested.** `leak/inherited-policy.spec.ts` runs the three cases against a reference page closed
like the second host's (with its nonce, P054) and against a host that always confirms. Each
reports inapplicable with its reason. Against the plain reference host they still run and pass.

**Rejected.** Skipping the positive controls by host configuration (a host would turn them off
everywhere); parsing the page's policy from its headers (frames see what applies, headers don't
show meta policies).
**Revisit when** a browser lets an embedding page give a `srcdoc` frame a policy of its own.

## P059 · 2026-10-11 · Passive content may load from any https site, by the host's explicit choice · Accepted

**Decision.** `egress.anyHttps` lists the passive kinds that may load from any https site:
`img`, `media` and `font`. Those CSP directives get `https:`. Scripts, styles, data (`connect`),
workers and frames never get it, and a config naming any other kind is refused. The manual and
the tool description say "images … from any https site". Nothing is opened by default. The MCP
sandbox proxy keeps the host config's choice; a view can't ask for it. Item 2 of 0.1.5.

**Risk it re-opens.**
- Any site the content names learns that someone viewed it, and from which address.
- The content can send data out in an image URL to a server of its choosing. Egress closes this
  channel by default (P006); this flag reopens it for these kinds.
- An attacker who controls an image can show anything in the frame. The frame is still the
  content's own; nothing reaches the host.

**Why.** A host showing existing reports needs their hotlinked images to work.

**Tested** (`leak/cdn.spec.ts`, all three engines): with `anyHttps: ["img", "media"]`, a hotlinked
image from a routed stranger's site loads. A script, a stylesheet and a fetch to the same site
never reach it. Without the flag, the image doesn't either. The agreement test checks that only
passive directives carry `https:` and that the manual says "from any https site" exactly when the
CSP does.

**Rejected.**
- `*` or `http:` (cleartext, and loopback/LAN reach).
- Allowing it for styles: CSS can probe and leak through selectors.
- Per-site lists: the host doesn't know the hotlinked sites.

**Revisit when** a host needs it for a kind that runs code: never by this flag.

## P060 · 2026-10-11 · A wildcard over a public suffix is refused · Accepted

**Decision.** An origin source `scheme://*.<base>` is refused when `<base>` is a single label
(`*.com`, `*.dev`; except `localhost`, for loopback development). It is also refused when
`<base>` is on a built-in list of common public suffixes:
- registries' second levels (`co.uk`, `com.au`, `co.jp`, …);
- hosting platforms where anyone gets a name (`github.io`, `pages.dev`, `workers.dev`,
  `vercel.app`, `netlify.app`, `amazonaws.com`, `cloudfront.net`, …).

The refusal says why and what to write instead. A wildcard over a domain under such a suffix
(`*.example.co.uk`, `*.me.github.io`) is fine. This applies to egress, content origins, and an
MCP view's declared domains (dropped there). Item 1 of 0.1.5 (a bug: `https://*.com` was
accepted).

**Why.** A wildcard over a public suffix opens every stranger's site, which is what egress control
exists to prevent.

**Tested** in unit tests: the refusals, the reason, wildcards accepted under such suffixes, and a
preset refusing a content origin.

**Rejected.** Shipping the whole Public Suffix List (about 200 KB, and a moving target). A wildcard
should name the host's own domain; the list covers the common ways it wouldn't.
**Revisit when** a host hits a suffix the list lacks (add it).

## P061 · 2026-10-11 · A theme event means the theme changed · Accepted

**Decision.** The shell fires the config's theme event only when the scheme or an applied value
changed since the content was last told:
- never for the theme a display starts with, at mount;
- never for a host context that repeats what the content has.

The React binding no longer calls `setTheme` or `refreshTheme` on mount: it does so only when
`scheme` or `themeKey` differ from what the display was made with. Item 4 of 0.1.5
(botiverse/porthole#3).

**Why.** Under the React binding, every mount called `setTheme` with the scheme the display
already had, two animation frames later. When the handshake and the content's scripts finished
within those frames, the content heard a "flip" to its own scheme. `[11.theme-flip]` failed about
1 run in 5 on the first host's React conformance host.

**Tested:**
- `11.theme-flip` now asserts no event at mount and none for a `setTheme` to the same scheme,
  before it flips (all three engines, repeated).
- A React test mounts a display listening for theme events, re-renders it unchanged, then flips
  it: exactly one event.

**Revisit when** content needs an event for values that change while the scheme doesn't (it gets
one now; the rule is "changed", not "flipped").

## P062 · 2026-10-11 · `served.domain.egress` holds a host to its own config's egress · Accepted

**Decision.** The served egress case no longer assumes images are closed. It tries a fetch, an
image, an audio element, a script, a stylesheet and a nested frame toward the host's canaries. It
reads the policy that applied to the document from the violations those attempts raise.
- **Always.** Scripts, styles, fetches and frames never reach the canary, and none of their
  directives (nor `default-src`) opens a scheme.
- **Images and media** must stay closed, unless the config opened them to any https site
  (`anyHttps`, P059). Then, with an https canary, the image must reach it. The case reports this
  as expected (an annotation naming P059), not as a failure, the way P058 reports a page's own
  policy. Media is measured, not asserted (engines differ on preloading).

Follow-up to 0.1.5 (the second host's adoption).
**Why.** A host that opts into `anyHttps` had to skip the built-in case and write its own
(`served.domain.egress-any-https`). Its logic is folded in here, so the host can drop it.
**Tested.**
- The case passes against the reference serving and a `createHost` host, both closed.
- It passes against a host whose shells open images and media (`leak/served/any-https.spec.ts`,
  with its canaries on a routed https site). The image and the audio reached the site; the fetch,
  script, stylesheet and frame didn't.

## P064 · 2026-10-11 · The manual states every sandbox limit content can trip over, and each claim has a browser check · Accepted

**Decision.** The `widget` topic's "The sandbox:" list replaces the old "Not allowed" line. Each
line comes from `manualLimits(config)`, which derives every limit from the config: the sandbox
tokens, declared capabilities and globals, egress, and isolation. Every limit has an id, and
`LIMIT_CHECKS` names the browser checks that prove it. These are new item-14 probes (`14.<id>`)
and served cases (`served.domain.address`, `served.domain.storage-scope`).

`test/limits.test.ts` fails in three cases:
- a limit names no check;
- a limit names a check no suite defines;
- the list holds a line that isn't a limit.

So a new line can't go untested.

The limits:
- **Failure:** what's blocked fails silently (worded by `errors` since 0.1.8: P067).
- **Loading:** the network; assets inline.
- **Shell-less behavior:** dialogs (confirm false, prompt null); print; downloads; forms;
  mailto:/tel:/sms: links; windows.
- **Platform:** devices denied without asking (file inputs work); blob: workers (no service
  workers, no WebRTC); sound only from a click.
- **Context:** the frame's address; the shell's own removals.
- **Storage** (in the interactive topic): it can throw in domain mode.

Item 1 of 0.1.7 (the owner's benchmark against another artifact host's page contract).

**Why.** The manual named only some limits ("Not allowed: …"), and several silently change
behavior. The advice to handle forms on submit would have failed: Chromium and Firefox fire no
submit event in a sandbox without `allow-forms`.

**Measured** on Chromium, WebKit and Firefox, in opaque frames and on the served origin. Each
difference is stated as the behavior safe on all three:
- submit events fire on WebKit only;
- `window.open` returns null on two engines and throws on Firefox;
- an opaque frame's `navigator.serviceWorker` throws on reading on Chromium and WebKit, and
  `register` rejects on Firefox;
- `play()` without a click is refused on Chromium and WebKit and allowed by Playwright's Firefox;
- getUserMedia rejects with `NotFoundError` on headless Chromium and `NotAllowedError` elsewhere;
- Web Share is absent on all three.

**Limits.** "Reads and writes can throw" (domain storage) and "sound only from a click" are
browser policy that the suite can't force everywhere. Their checks prove the half that is
observable (storage persists per scope; `play()` in a click plays). On a page whose own policy
closes blob: workers, `14.workers` reports itself inapplicable (P058).
**Rejected.** A hand-written list of limits (it drifts from the config); stating per-engine
behavior (the manual is read once, for every engine).
**Revisit when** a sandbox token or capability changes what content can do: add its limit and a
check, or the unit test fails.

## P065 · 2026-10-11 · A config says a whole-page viewer's shape, and the manual and behavior follow · Accepted

**Decision.** The first artifact-page host's served config made the manual say false things. New
config fields express its shape, and each drives the manual and the behavior it implies:
- **`layout.kind: "fill"`** (default `"flow"`):
  - Behavior: every mount fills its container (`MountOptions.fill`, React `fill`), and the
    content scrolls itself.
  - Manual: "about N px wide on a phone and as wide as the window on a desktop"; "as tall as the
    window: the page scrolls itself, and position: fixed and sticky work"; read the window's
    width. The card's height cap and the "No position: fixed" line go. The tool description
    says it fills the viewer.
- **`theme.documents: "never"`** (pages only; refused for fragments, which take the theme they
  are drawn in):
  - Behavior: the frame always gets the light values and a light `color-scheme`, and the shell
    never themes the page even if it declares light and dark. `setTheme` doesn't reach it, so it
    hears no theme event.
  - Manual: it always shows in light; style it yourself; `prefers-color-scheme` may report the
    reader's system setting, so don't rely on it. The theme-change and redraw sentences go.
- **`limits.maxBytes`** is stated in KB, or MB from a megabyte up ("Keep it under 10 MB.").
- **`storage.scope`** (domain only, exclusive with `storage.shared`) names what one display's
  storage is kept for ("this artifact, across its versions"). It adds no prefix advice, since
  only one display uses the origin at a time.
- **`errors: "agent" | "host" | "none"`** says where the content's errors go:
  - `agent`: "comes back to you, so you can fix it";
  - `host`: "goes to the app, not to you: test what you write";
  - `none`: no `reportError` (the preset drops it; validation keeps the two consistent), and
    "nothing reports what your code throws".

  Absent, the old "reported to the app" stays.

Item 2 of 0.1.7.

**Measured** with the person on dark: inside a page's frame whose element says light,
`prefers-color-scheme` reports light on WebKit and Firefox and dark on Chromium. Hence the
manual's "may report the reader's system setting".

**Tested.**
- Browser checks (all three engines, in `LIMIT_CHECKS` under `layout`, `theme` and `errors`):
  - `14.fill`: the frame keeps its box's 400 px, the page scrolls, a fixed bar stays at the top;
  - `14.theme-never`: light values, no `data-theme`, a light frame element, no theme event after
    a flip to dark;
  - `14.errors`: a throw reaches the host with `reportError`, and nothing reaches it with
    `errors: "none"`.
- Unit tests: the manual and tool description for the viewer's config, every field's
  validation, and an agreement case.

**Rejected.**
- Host-side patches to the manual's text: the config is the source.
- Making `"never"` the default for pages: hosts that theme pages would lose it.
**Revisit when** a host needs a theme of its own that isn't light (then a fixed scheme value).

## P066 · 2026-10-12 · The host kit: an app writes its policy, Porthole the machinery around `/server` · Accepted

**Decision.** Porthole 0.2.0 takes in the host-side machinery both hosts wrote around `/server`
(DESIGN § "The host kit"):
- `createContentHost`: the routing middleware (fetch/Workers; reserved labels handed back), the
  issue endpoint, `meta`, `frameSources`, the domain helpers and their guards, and an optional
  health gate with an opaque fallback;
- `@botiverse/porthole/node`: the Node adapter, WebSocket upgrades included, and the health
  probe;
- the client's `httpLocator` and `servedOrOpaque`;
- a framework-free conformance runner an app points at its real page (`defineHostConformance`);
- a prod-shaped docker profile (`ops/prod-shape`) and CI on every push.

The app keeps four callbacks (`instance`, `access`, `authorize`, `source`), plus `entry.at` with
redirect entry (P068), and its settings. Answers to the questions left open by the proposal:
1. **Clashes.** Porthole never serves a content domain that holds an app origin or may share
   its site. With the health gate (the opaque fallback) on, such settings are a lasting
   "unhealthy: misconfigured, <reason>": logged once with a stable event name
   (`porthole.content.misconfigured`, its `code`), `meta().served` false, frames opaque.
   Without it, `contentDomain`/`createContentHost` throw a `ContentDomainError` at startup.
   Fail closed either way; no separate switch.
2. **The issue body** is always `{ instance }`, the `InstanceRef` wire shape. The app's
   `instance` callback treats it as a proposal: it validates and normalizes it, derives the scope
   from what it names, and refuses anything else. App ids travel in the document's fields. The
   client never chooses an origin.
3. **The conformance harness has no React.** It is framework-free, on the core's `createHost`,
   loaded on the app's page as a script from the page's own origin under its nonce. An app's own
   frame components are covered by its own e2e; Porthole's React binding by Porthole's tests.

The Workers path uses no Node API (tested under workerd with D1); the health probe is optional
there.
**Why.**
- The first host wrote 1,738 lines (domain, displays, health, the content router, the client's
  served frames, its conformance host); the second 2,305 (content service, content mapping, the
  frame API, the client frame, its conformance tools). Most of it is the same code.
- Their copies already disagreed: the scheme from a public URL or from `*.localhost`; a clash
  logged and disabled, or failed closed. Neither was tested over TLS or on same-site siblings.

**Measured** in the prod shape (https, Caddy's internal CA, `*.content.test` siblings):
- the whole leak suite and the served cases pass on Chromium, WebKit and Firefox, as on
  loopback;
- a `Domain=content.test` cookie set by a sibling label reaches every content origin (same site
  without a Public Suffix List entry, P047); `__Host-` cookies can't be set that way, and nothing
  a sibling plants opens content;
- Playwright's Firefox reads neither the system's trust store nor an enterprise policy, so its
  prod-shape project overrides certificate errors (pages stay https, secure contexts); Chromium
  and WebKit check the chain.

**Rejected.** A separate switch for clash handling (two ways to fail, one of them open); the
app's own body fields on the wire (each app's client would choose what the server trusts);
bundling React in the harness (it would test Porthole's binding on the app's page, not the app).
**Revisit when** a third host needs something the four callbacks can't say.

## P067 · 2026-10-12 · The manual's silent line says where a block is reported, by `errors` · Accepted

**Decision.** The `silent` limit (P064) follows the config's `errors` (P065), as the Errors line
does:
- no `reportError` (`errors: "none"`, or none declared): "fails silently … and nothing shows an
  error", as before;
- `agent`: a block shows nothing on the page, and comes back to the agent as an error, so it
  checks them;
- `host`: the app is told of each block, the agent isn't;
- unset with `reportError` declared: each block is reported to the app.

`14.silent` now checks both halves: nothing is shown and nothing leaves, and the host hears of a
block where `reportError` is declared and nothing where it isn't (`errors: "none"`). Issue #4,
0.1.8.
**Why.** The shell reports every CSP violation through `reportError` ("Blocked by the sandbox:
…"). For a host with `errors: "agent"` (Ferry), "nothing shows an error" was false, and it
contradicted the manual's own Errors line. The check asserted only that no dialog opened, so it
passed while the line claimed more than it proved.
**Rejected.** Ending the line at "a blocked fetch rejects": the agent then isn't told that blocks
come back to it, which is what makes it check them.
**Revisit when** the shell reports blocks other than through `reportError`.

## P068 · 2026-10-12 · Redirect entry: every instance has a clean address that opens directly · Accepted

**Decision.** With `entry` set, every instance has a clean, stable address (`urlOf(scope,
path)`, `https://a-<id>.content.example.com/v/3`) that works when opened directly: a new tab, a
reload, a bookmark, a link sent to someone with access.
- A request on a clean address without a cookie for it is sent (302) to the app's authorize
  route (`ContentHost.authorize`, on an app origin) with a signed state: the label, the path, a
  nonce, five minutes. The content origin sets a cookie holding the nonce, in the session
  cookie's context (partitioned in a frame, `Lax` on a tab).
- The route asks the app: `entry.at(scope, path)` (the path names the instance; the query never
  does) and `access`. Not signed in: on a tab, the app's own sign-in (`signIn(returnTo)`), which
  comes back to the route; in a frame, never the sign-in, a plain page asking for a new tab
  (`blocked: sign-in`). No access: the app's refusal page on a tab (`entry.refusal`), a plain
  page in a frame; never content.
- Granted: a 302 to `/__porthole/entry?code=…` on the instance's own origin. The code is a
  one-time ticket (60 s) bound to the label, the path and the nonce. It is redeemed once, only on
  its label, only with the nonce's cookie; the session it buys is bound to the path; a 303 goes
  to the clean address.
- A browser that keeps no cookie in a frame (WebKit, P025) arrives at the redeem without the
  nonce: the "open in a new tab" outcome (`blocked: cookies`). A path whose session still didn't
  come back after a redeem is caught on the next bounce (the nonce cookie marks it entered for
  60 s): the same outcome, no loop.
- The redirect pages on the app origin are Porthole's (no app chrome), framable only by the app
  origins, their one script inline under its hash; the frame transport hears frame status, and
  nothing else, from the host's own origin.
- Tickets stay: frames should use them (no extra round trip; no dependence on the app's cookie
  inside a frame). Clean addresses are for tabs, links, bookmarks and reloads: a host's "open in a
  new tab" and "copy link" use `urlOf`. Redirect entry needs a naming that says a label's scope
  (`prefixedName` does; keyed labels are one-way).

**Security.**
- *Open redirects.* The authorize route redirects only to `/__porthole/entry` on the label in a
  state it verified; the redeem redirects only to its own origin plus the path from that state,
  as an absolute URL (`//evil.example/x` stays a path on the instance's origin). The app's
  `signIn` gets the authorize URL as `returnTo` and must come back only to its own paths.
- *CSRF and state binding.* The state is signed (HMAC under the server's key, typed apart from
  session cookies) and expires in five minutes. The code is bound to the state's nonce, whose
  cookie lives only in the browser that began: a code sent to someone else's browser (login
  CSRF, session fixation) opens nothing. A code is bound to its label: taken to another
  instance's origin, it is refused and spent.
- *The code.* It lives in an address for one hop (a redirect, so never in history), every
  redirect answer sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, and
  Porthole never logs it (an edge's access log may: keep codes out of logs there, or log paths
  without queries).
- *The new opening.* A request without a cookie used to be refused; it is now handed to the
  app, whose session decides. The app's sign-in and refusal never render in a frame. The host's
  own origin may now report a frame's status (only that: a protocol message from there is
  dropped, `test/transport.test.ts`).

**Measured** (the `served.entry.*` cases, on loopback and in the prod shape): a clean address
opens directly signed in, signed out through the app's sign-in, and gives the app's refusal
without access, on all three engines; a replayed code and a code taken to another instance's
origin open nothing. In a frame, the app's `SameSite=Lax` cookie reaches its authorize route
after the cross-site redirect from the content origin on Chromium (the frame shows the content),
and not on Firefox or WebKit (the frame asks for a tab to sign in). That is why frames should use
tickets.

**Rejected.**
- A `?ticket=` address for tabs and links: not stable, not shareable, and spent once.
- An entry page that checks the cookie with a script: the nonce cookie at the redeem tells the
  same thing on the server, before anything renders, with no script on either origin.
- Binding the session to the query too: two queries on one path would take two cookies for one
  document.

**Revisit when** a host needs clean addresses for keyed labels (a lookup from label to scope),
or a browser starts sending `Lax` cookies on framed redirects everywhere (then frames could use
clean addresses too).

## P069 · 2026-10-12 · The manual says what the page host means: call the guide tool, fill the viewer, no theme lines when unthemed; 14.sound reports an inherited block · Accepted

**Decision.** From the first artifact-page host reading its generated manual (0.2.1):
- With `guide.guideToolName`, the tool description says to *call* the guide tool ("Call
  read_page_guide once before your first page"): it is a tool, not a document.
- With `layout.kind: "fill"`, the frame fills the app's viewer, which is often smaller than the
  window (toolbars, side panels): the manual says "fills the app's viewer", "as tall as the
  viewer, not the window", and to read the frame's own width; it keeps "design for the phone's
  width first". This supersedes P065's "as tall as the window" wording.
- With `theme.documents: "never"`, the manual has no theme line but "always light: style it
  yourself" and the `prefers-color-scheme` caveat: the example's "cards that read in both
  themes" and "the app's light palette" go.
- `14.sound` detects that the page's own CSP (which an opaque frame inherits) blocks its `data:`
  media (`media-src`) and reports itself inapplicable, as `1.connect`, `2.resources`,
  `12.no-confirm` and `14.workers` do (P058); `leak/inherited-policy.spec.ts` proves it on a
  closed page on all three engines.

**Why.** Each line was false or misleading for that host (a document to read, the window's size,
both themes), and the host skipped `14.sound` by hand on a page whose `media-src 'self'` the
frame inherits.
**Revisit when** a host's viewer is the whole window (the wording is still true there).

## P070 · 2026-10-12 · The host kit, from its first two adopters: unknown addresses 404, pages that talk past a desktop scheme, streams that stop · Accepted

**Decision.** 0.2.2 fixes what Ferry and Raft Artifacts hit adopting the kit (#5, #6), so neither
needs a workaround. Additions only; the API is otherwise the same.
1. **An address that names nothing is a 404 on the content domain.** A label the naming never
   makes (`www`, `f`, garbage), the bare domain, and a clean address whose `entry.at` (asked on
   the content origin with no viewer) gives null or undefined get Porthole's 404 there. Only an
   instance that exists and lacks a cookie goes to the app's authorize route. `/server` takes it
   as `entry.named(label, path)`; a naming's `scopeOf` already refuses labels it never makes.
2. **`reserved` is for labels the app itself serves** on the content domain (Ferry's `p-*`
   previews); a label nothing serves needs no entry (item 1).
3. **The entry hooks get the address decoded** (`EntryContext`: label, scope, path, clean URL,
   instance, framed), and `refusal` may return nothing to use Porthole's page.
4. **`/server` exports the types an app's callbacks use**: `InstanceRef`, `FrameLocation`,
   `ServedDocument`, `PortholeConfig`, `EntryContext`.
5. **The runner:** `instances` and the entry addresses may be async (a page published on demand,
   its real instance then asked of the issue endpoint); `entry.unknown` adds
   `served.entry.unknown`; tests are located at the app's `defineHostConformance` call (compiled
   there with `vm`'s file name and line), so `playwright test <spec>` selects them.
6. **The pages' frame status survives a desktop scheme among the host origins (#5).** Each web
   host origin is told in its own `try`; where the host origins hold another scheme
   (`ferry://app`, which no browser takes as a target origin) and the parent isn't known to be a
   web host origin (`location.ancestorOrigins`), the word goes to the parent as `*`. Before, one
   throwing `postMessage` stopped the entry page before its cookie check, so every framed
   url-mode app stayed on "Opening the app…".
7. **`nodeHost` streams (#6):** the request carries a signal aborted when the client leaves
   (`proxyTo` passes it to the relay); the body is written as the socket drains and cancelled
   when the client leaves; an error mid-body destroys the response.
8. **`health.onChange(view)`** is told each change of the gate's state.
9. **The npm package carries the docs** (`docs/DESIGN.md`, `DECISIONS.md` and the rest).

**Risks.**
- Item 1 tells anyone whether an address names something (404, or a trip to the app). Labels
  under `prefixedName` were guessable already; an app that must not say so can answer `at` for
  every well-formed address and let `access` refuse.
- Item 6 sends the frame status to `*` in one case. The pages that send it are framable only by
  the host origins (`frame-ancestors`), so their parent is one, and what they say (entering,
  blocked and why) is no secret. Bounded by `test/pages.test.ts` and the kit's
  `served.url.framed`, which runs with a desktop scheme among the host origins on every engine.

**Why.** Before 0.2.0 these labels were 404s on the content domain, and production said so. The
other items are each a workaround an adopter wrote: the content-origin state re-parsed in its
hooks, labels left out of `reserved` (which looked like the way to keep them unanswered), http
origins only so the entry page wouldn't hang, its own streaming relay before `nodeHost`, its
own served flag in the `log` callback, a `-g` filter to find its tests.
**Revisit when** an app needs an address that exists but must not be told apart from one that
doesn't (then `at` grows a way to say "ask the app").

## P071 · 2026-10-12 · Adopting from the package alone: a README, examples, ADOPTING.md, and fixes a cold adopter hit · Accepted

**Decision.** A fresh agent adopted 0.2.2 from the npm package alone (Node and Workers, about 25
minutes, 130 lines); everything it hit was documentation, or small. 0.2.3:
- **Docs in the package:** a README with a quickstart; `docs/ADOPTING.md`, the adopter's path
  apart from DESIGN (the server, the page, its CSP, Workers, local development, the agent's
  tools, conformance, expected noise); DESIGN's snippet fixed (`Response.redirect` needs an
  absolute URL outside a browser; `configs` keyed `artifact`, the preset an artifact names by
  default; one secret name, `PORTHOLE_SECRET`).
- **Runnable examples in the package:** `examples/app.mjs` (one app, runtime-agnostic, with a
  conformance test mode), `examples/node/`, `examples/workers/` (D1 migration, `wrangler.jsonc`
  with `run_worker_first`), `examples/conformance/` (the suite against it, three engines). The
  page reports a client module that fails to load; the sign-in page has no `form-action`, which
  would hold the redirect back to the content origin.
- **`npx porthole`:** `secret` makes a `PORTHOLE_SECRET`; `d1-schema` prints the migration.
- **One way to fill:** the config's `layout.kind: "fill"`, which the manual follows.
  `MountOptions.fill` and `<PortholeFrame fill>` are deprecated (they size the frame only).
- **`'unsafe-eval'` in content's CSP is kept, and said:** content is the agent's own script
  (`'unsafe-inline'`), so eval adds no capability; libraries content uses (Vue's in-browser
  build, Alpine.js, Vega) and WebAssembly need it. Isolation comes from the origin, the sandbox and
  egress.
- **Conformance for an app that serves only stored pages:** `instances.shell` is optional (the
  domain cases run on `artifact(scope, "1")`); `conformancePage(version)` is the exact test page
  (also from `/server`, free of Playwright); `entry.denied`, `atSignIn` and `completeSignIn` are
  optional; `entry.unknown: "derive"`; `conformanceProjects(devices)`; `onDemand`;
  `defineHostConformance` takes any `TestType` without a cast. Test mode is documented with its
  warning: never ship it.
- **`14.inline-assets`** reports itself inapplicable where the page's own CSP (which an opaque
  frame inherits) blocks data: images or inline styles, as its siblings do (P058).
- **Host errors never quote a located URL** (it carries a ticket): they name its origin.

**Why.** The cold adopter's top ten were all here: no README, the runnable example unshipped,
adopter docs buried in DESIGN, no client snippet, a conformance runner that demanded what an
artifact-only app lacks, two snippet bugs, no word on the page's CSP, two ways to fill (one of
which left the manual wrong), Workers specifics, and local development.
**Revisit when** a second cold adoption (after 0.3) finds friction these don't cover.


## P072 · 2026-10-12 · Host kit 0.3: the client, the bootstrap and the relay, so adopters stop writing glue · Accepted

**Decision.** After 0.2.2 the server's content file is policy and little
else; the glue moved to the client, the bootstrap and url mode. Ferry still writes about 1,650
lines of glue and workarounds, Raft about 450 (notes/porthole-0.3-audit.md). 0.3 adds, all
additive:

1. **`defineDisplays(kinds)`** (core): one registry for every kind an app shows.

   ```ts
   const displays = defineDisplays({
     widget: { preset: "inlineWidget", options: { capabilities: { sendPrompt: {} } } },
     page:   { preset: "artifact", options: { layout: { kind: "fill" } } },
     preview:{ preset: "url", options: {} },               // url mode: served only
   });
   displays.opaque("widget");                              // PortholeConfig
   displays.served(contentSource);                         // Record<kind, PortholeConfig> | null, memoized
   displays.configFor(instance, contentSource | null);     // by the document's kind and preset
   displays.frameSources(contentSource, { authorizeUrl }); // for a CSP built without a ContentHost (Vite, Electron)
   displays.guideConfig("widget", "served" | "opaque");    // the agent's manual, without real origins
   ```

   `createContentHost({ displays })` and `defineHostConformance({ displays })` take it in place of
   `configs` and `config(instance)` (both stay).
2. **Conventional routes and bootstrap** (/server, /node):
   - `content.routes(viewerOf, { prefix = "/porthole" })`: `POST frames` (issue), `GET authorize`,
     `GET meta`, `POST handoff` (item 6), one mount. `entry.authorizeUrl` defaults to
     `${appOrigins[0]}${prefix}/authorize`.
   - `GET meta` answers `ContentClientMeta`: `{ served, contentSource, frameSources, health }`.
   - `issue` answers 201 `{ url, origin, link? }`: `link` is the clean address, where
     `entry.pathOf(instance)` names the instance's path.
   - `contentHostFor((env) => options)` on Workers: one host per `env`, a fail-closed 503 naming
     the problem (logged once), `fetch(request, env)` answering the content domain first.
   - `nodeServer({ content, app, upgrade?, appSocket? })`: the `http.Server`, the gate started on
     listen and stopped on close.
3. **The client served kit** (core, React):
   - `portholeClient({ base = "/porthole", headers?, credentials?, displays })`: `meta()`,
     `subscribe()`, `config(kind)` (served or opaque, null until meta is known), the locator,
     `link(instance)`, `openInTab(instance)` (a blank tab inside the click, then the link).
   - React: `<PortholeProvider client>` and `<PortholeView display="page" instance={…}
     content={…} fallback={({ kind, message, link, retry }) => …} />`, where `kind` is
     `needs-tab | denied | expired | failed | timeout`, worded as Porthole's pages word them.
     `usePortholeLink(instance)` gives `{ link, open, copy }`.
4. **React ergonomics:** provider `scheme`, `theme` with `themeKey`, `cssVariableTheme(tokens)`,
   `nonce: "auto"`, `openLink`, `notify` (skin the copy notice), `renderConfirm(request, answer)`
   (the app draws the dialog; Porthole keeps the gates, the one-at-a-time queue and decline
   counting); content errors deduplicated per run; `useRunAgain()` for a "run again" button.
5. **The url-mode relay kit** (/server, /node): `upstreamHeaders.request/response` (the header
   rewrite `proxyTo` uses, on `Headers` or raw pairs, WebSockets too); `statusPage(…)` (P070's
   fallback included); `nodeHost`'s `appSocket` gets the request with Porthole's cookies removed;
   `content.forget({ scope?, subject? })` drops cached `authorize` answers.
6. **Viewer handoff for token-authenticated apps:** `POST handoff`, called by the signed-in app
   with its own token (`client.handoff()`), sets an `HttpOnly` cookie scoped to the authorize
   path holding a short-lived viewer key Porthole signs (never the app's token);
   `entry.handoff: { id(viewer), viewer(id) }` says who a viewer is and turns it back. `entry.spa: { route }` gives the
   default `signIn` for a single-page app, with `entryTarget(next)` as the open-redirect guard.
7. **If cheap:** `health.onServedChange(served)`, deduplicated; `log` also takes a
   `{ info, warn, error }` logger; `prefixedNames({ w: …, f: … })` for several prefixes; a
   `location` on a mount, used once before the locator (pre-located frames).

**Why.** Each item deletes code both apps (or every adopter with that need) wrote the same way,
and three of them already drift: Ferry's desktop CSP lacks the authorize route, its copied status
page lacks P070's fallback, and clean addresses are computed two ways.
**Rejected.** A framework-specific server adapter (Hono, Express): `routes` is a fetch handler
any of them mounts in one line.
**Decided in review:**
- The default prefix is `/porthole`, overridable (`createContentHost({ prefix })`), and `issue`
  moves under it (`POST /porthole/frames`), so one mount serves frames, authorize, meta and
  handoff, and an embedding CSP, a dev proxy or a desktop CSP each need one path. Apps move their
  old routes themselves (`issue(viewerOf)` and `authorize(viewerOf)` still exist for that).
- The handoff cookie lasts 10 minutes, refreshed whenever the app's page loads or regains focus
  (`portholeClient({ handoff: true })`, at most every 30 s); an expired one costs only a quiet
  trip through the app's sign-in route. The POST needs the app's own credential (`viewerOf` must
  name a viewer) and is refused from another origin (`Origin`, or `Sec-Fetch-Site` where there is
  no `Origin`), so no other site can set or clear it. The key is Porthole-signed (HMAC under the
  secret, apart from session keys), names the viewer's id and its expiry, and the cookie is
  `HttpOnly`, `SameSite=Lax`, scoped to the prefix path (`__Secure-` on https). It is no
  credential for the app's API, unlike the app's token stored in a cookie (which Ferry did), which
  would ride on every request to the app origin, for as long as the token lives.
- Item 7: `health.onServedChange` and logger adapters only.

**Measured.** The example app on the new routes and client passes the whole suite on three
engines; `PortholeView`, its fallback and `renderConfirm` run in the React spec.

## P073 · 2026-10-12 · The agent's side: check a page before people see it; tools with names and schemas · Accepted

**Decision.** Today an agent learns its page broke only after a person
looked (Ferry, at its next turn, at most 5 errors) or never (Raft). Porthole already has the
parts: the shell's error capture, the conformance harness's `launch` at a width and a scheme, and
a browser check behind every line of the manual. 0.3 exposes them:

1. **`lintContent(config, content): Finding[]`** (core, pure, any runtime): what can be told
   without running it, worded as the manual words it, each rule tied to the manual's limit id:
   over `maxBytes`; a document where a fragment is shown (or the reverse); `document.write`;
   nested frames and plugins; `navigator.clipboard` and `execCommand("copy")` (use `copyText`);
   `alert`/`confirm`/`prompt`; a `<form>` that submits; hosts outside egress in `src`, `href`,
   `fetch` and imports; an unpinned library (`@latest`, a range); `position: fixed` in a flow
   layout; `target=_blank` without `openLink`. `{ rule, severity, message, line? }`.
2. **`checkPage(options): Promise<CheckReport>`** (`@botiverse/porthole/check`): runs the content
   in the real sandbox (the harness, the production CSP) at each width and scheme (defaults from
   the config: the manual's phone and desktop widths, light and dark unless the config is
   unthemed), and reports per run: errors (thrown, rejected, "Blocked by the sandbox"), CSP
   blocks, failed loads, `console.error`/`warn`, the height and whether the limit clips it,
   horizontal overflow, optional screenshots; plus `lint`, `ok` and one agent-readable `text`.
   Drivers: `playwrightDriver(browser)` (Node), and `cdpDriver(session)` over any CDP session
   (Puppeteer's, or `@cloudflare/puppeteer`'s on Cloudflare Browser Rendering), so a Worker can
   check too. The harness ships as a string module, so no file system is needed.
3. **Tool definitions** (core): `showTool(config)`, `guideTool(config)`, `checkTool(config)`, each
   `{ name, description, inputSchema }` (JSON Schema; names from `guide.toolName` and
   `guideToolName`, the topics an enum of the built-in and the config's own); `answerGuide(config,
   args)` validates and answers; `guideChanges(from, to)`, the notice for the agent when a display
   kind flips between served and opaque (null when the manual doesn't change). An MCP server
   example in `examples/mcp/` wires show, guide and check.
4. **The manual's own examples pass the check:** a test runs `checkPage` on every
   `GUIDE_EXAMPLES` entry under every preset, at the manual's widths, in light and dark
   (OBJECTIVES criterion 5).

**Why.** It is the one change that improves what agents make rather than what hosts write, and
both apps asked for errors to reach the agent before a person does.
**Rejected.** Running content on the host's server without a browser (jsdom and the like): it
doesn't apply CSP, layout or the sandbox, so it would pass pages that break.
**Decided in review:**
- The show tool refuses by default (`admitContent`, `refuseOn: "error"`), but only on a narrow
  set of deterministic errors that would certainly fail or be cut: over the size limit, a whole
  document where a fragment goes when it can't be taken as its body, nested frames and plugins,
  `document.write`. Everything heuristic is a warning returned with the result. A host sets the
  policy (`refuseOn: "never"`). A refusal says exactly what to change, and to call the tool again.
- Contrast: later.
- `checkPage` must work where the host has no browser: an agent on a person's machine lints
  locally and sends the check to its server (or uses Playwright where installed); a Worker uses
  Browser Rendering through `cdpDriver`, with the check page's script imported
  (`@botiverse/porthole/check/page`). The report's text is short enough for an agent's context:
  each problem once, with where it happened, at most 8 (`maxProblems`), the rest counted.

**How it runs.** The check page (bundled from `src/check/page.ts`) is served at a fixed origin
the driver answers itself (`https://porthole-check.invalid`: the shell needs a real host origin),
mounts the content with `createHost` under its own CSP, opaque (a served config's content with the
same CSP; an MCP Apps view as a page with its egress), and puts a small script first in the
content that reports errors, rejections, CSP blocks, failed loads, `console.error`/`warn` and the
document's width to the page by `postMessage`. Height comes from the display's own resize events.

**Measured.** Every `GUIDE_EXAMPLES` entry passes under the inline, artifact, whole-page viewer
and MCP Apps presets at the manual's widths in light and dark, on three engines
(`leak/check.spec.ts`); a broken widget is told each problem once; the CDP driver runs on
Chromium.
