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

## P005 · 2026-10-11 · Phase-1 isolation is an opaque origin; domain mode is designed, built later · Accepted

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

## P007 · 2026-10-11 · The MCP adapter reimplements the host-side subset; the widget uses the official SDK · Accepted

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

## P008 · 2026-10-11 · A conformance/leak suite is first-class, cross-engine, and host-runnable · Accepted

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

## P012 · 2026-10-11 · Three modes: inline widget, MCP Apps view, artifact page; URL mode out of scope · Accepted

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
