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

## P017 · 2026-10-11 · Leak-suite gate: Chromium and WebKit first, Firefox right after · Accepted

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
