# Phase-1 design

The stable shape is in [ARCHITECTURE.md](ARCHITECTURE.md) and the reasons in
[DECISIONS.md](DECISIONS.md). This is the concrete phase-1 plan. Web first:
a framework-agnostic TypeScript core plus a thin React binding.

## Threat model

Two classes of attacker, handled by different layers (ARCHITECTURE § Trust
boundaries):

1. **Attacking the host** — steal the host's credentials or data, act as the
   person, or escape the sandbox. Countered by **origin isolation**: the content
   runs on an origin that is never the host's, so same-origin policy denies it
   the host's DOM, storage, cookies and credentials. This is the catastrophic
   class; a regression here is the one bug that matters most.
2. **Leaking or deceiving** — exfiltrate what the content was already handed
   (whatever the agent wrote into it, or data a capability returned), or draw a
   convincing fake (a login form, an "approve" button) to fool the viewer.
   Origin isolation does not help. Countered by **egress hardening** (close every
   outbound channel to all but declared origins), **gating** (powers that affect
   the person or the agent need a gesture or confirmation), and the host drawing
   its own chrome/approvals outside the frame, never inside it.

The agent is itself a trust boundary: the HTML is agent-authored, so loading a
library from an allowed CDN is no more trusted than the agent's own code. The
manual's supply-chain rule (pin exact, aged versions) is advice to the agent, not
a wall; the walls are isolation and egress.

## Package layout

A pnpm workspace; `@botiverse/porthole` is the umbrella.

```
packages/
  core        @botiverse/porthole         framework-agnostic TS: config compiler,
                                          CSP/sandbox builder, shell runtime (as a
                                          string), host-function bridge, streaming,
                                          sizing, theming, guide generator, presets.
                                          No DOM-framework, no host, no MCP SDK.
  react       @botiverse/porthole-react   thin React binding: <PortholeFrame>, hooks.
  mcp         @botiverse/porthole-mcp     the MCP Apps adapter (host side) + sandbox
                                          proxy; depends on core only.
  components  @botiverse/porthole-components  the in-sandbox preset web components.
  conformance @botiverse/porthole-conformance  the Playwright leak/conformance suite
                                          + a host test-interface a host implements.
  server      @botiverse/porthole-server  (phase 2) artifact/domain serving template.
```

Tooling (matching the wider workspace): Node ≥ 24 with TypeScript type stripping
(erasable syntax only), pnpm, oxlint + oxfmt, unit tests in vitest or node:test,
leak suite in Playwright. `"license": "Apache-2.0"`. Example root manifest:

```jsonc
{ "name": "@botiverse/porthole-root", "private": true, "type": "module",
  "license": "Apache-2.0", "engines": { "node": ">=24" },
  "packageManager": "pnpm@11", "scripts": {
    "check": "run-p typecheck lint format:check test",
    "test": "vitest run", "test:leak": "playwright test" } }
```

## Config schema

One config per display. The compiler derives the CSP, the sandbox/`allow`
attributes, the shell wiring, and the guide + tool description from it.

```ts
type Gate =
  | "none"                 // no gate (e.g. report-error, size)
  | "user-activation"      // must be called from a real user gesture
  | "confirm"              // host shows a person the full effect; they decide
  | { rateLimit: { perMinute: number } };

interface Capability {
  gate: Gate;
  connect?: string[];      // extra connect-src origins this capability needs
  resource?: string[];     // extra script/style/img/font origins it needs
  guide?: string;          // override the generated manual entry
}

interface PortholeConfig {
  mode: "inline" | "artifact" | "mcp-app";
  isolation: "opaque" | "domain";          // phase 1 ships "opaque"
  // Every power beyond drawing. Absent = not available, not wired, not in CSP,
  // not in the manual. Keys are the capability vocabulary.
  capabilities: Partial<Record<
    "sendPrompt" | "openLink" | "readState" | "writeState" |
    "callTool" | "readData" | "reportError" | "resize" | "setModelContext",
    Capability>>;
  egress: {                                 // base allowlists (capabilities add to these)
    connect?: string[]; script?: string[]; style?: string[];
    img?: string[]; font?: string[]; media?: string[]; frame?: string[];
  };
  theme: { variables: Record<string, string | { light: string; dark: string }> };
  limits: { maxHeightPx: number; maxBytes: number; maxLiveFrames?: number };
  components?: string[];                     // preset components to preload + document
  embedderFrameSrc?: string[];               // extra frame-src for the EMBEDDING page
}
```

`mode` and `isolation` select the platform and isolation mechanism; everything
else is policy. A preset is a `PortholeConfig` with defaults filled in.

## API sketch

### Host side (core, framework-agnostic)

```ts
import { createHost, presets } from "@botiverse/porthole";

const host = createHost(presets.inlineWidget({
  theme: { variables: myTokens },            // per-scheme tokens
  capabilities: {
    sendPrompt: { gate: "confirm" },
    openLink:   { gate: "confirm" },
    reportError:{ gate: "none" },
  },
}), {
  onCapability: {
    sendPrompt: async (text, ctx) => confirmAndSend(text),  // return {ok} | {error}
    openLink:   async (url) => confirmAndOpen(url),
    reportError: (message) => log(message),
  },
  resolveTheme: (scheme) => myTokens[scheme],
});

const handle = host.mount(container, { displayId });
handle.setContent(html, { partial: true });  // may be called repeatedly while streaming
handle.setContent(html);                      // final
handle.setTheme("dark");
handle.on("resize", (px) => {});
handle.destroy();

// The generated agent-facing artifacts come from the same config:
host.guide(["widget", "chart"]);              // manual text for the agent
host.toolDescription();                        // the tool description string
host.csp();                                    // the exact CSP, for audit/tests
```

### React binding

```tsx
<PortholeFrame
  preset="inline-widget" theme={tokens} capabilities={caps}
  content={code} partial={streaming}
  onSendPrompt={confirmAndSend} onOpenLink={confirmAndOpen} onError={log} />
```

### Widget side (what the agent writes against)

The content speaks **MCP Apps**. An author can use the official `@modelcontextprotocol/ext-apps`
`App` SDK, or the raw JSON-RPC over `postMessage` the spec documents — the shell
is a conformant host. For convenience the shell also exposes thin globals that map
onto the enabled capabilities (`sendPrompt(text)`, `openLink(url)`, a `localStorage`
shim, a `theme` event); these are sugar over the same messages, not a new protocol.
A capability that is not in the config is simply absent.

## The modes

- **Inline widget.** The host has the HTML (the agent wrote it) and injects it
  into an opaque-origin frame carrying the shell, with a strict CSP in a `<meta>`
  and the embedding page restricting its frames. Smallest capability set. This is
  the phase-1 workhorse.
- **MCP Apps view.** A standard `ui://` template plus tool input/result, via the
  MCP adapter and (on the web) a second-origin sandbox proxy. Must run the
  official examples unmodified.
- **Artifact page.** The content is a real document served at a URL on a separate
  registrable domain, CSP in HTTP headers, versioned, access gated by a one-time
  ticket exchanged for a scoped cookie. Designed in phase 1; the serving template
  is built in phase 2. The shell is optional here (the page is a full document).
- **Domain mode for widgets** (a per-instance subdomain so a widget gets stable
  storage and a real origin) is designed now, may land in phase 2.

## Egress hardening, each with its test

Closed by default; opened only to origins a capability declares. The leak suite
attempts each channel and asserts nothing leaves. Measured on Chromium, WebKit,
Firefox; harden for the weakest (PRINCIPLE 6).

| # | Channel | Mechanism | Test |
|---|---------|-----------|------|
| 1 | fetch / XHR / WebSocket / `sendBeacon` to a non-allowed origin | CSP `connect-src` = allowlist only | a canary to a non-allowed origin fails; one to an allowed origin succeeds |
| 2 | images / media / fonts / styles / scripts from non-allowed origins | CSP `img/media/font/style/script-src` = allowlist only | a tracking-pixel canary and an off-list script both fail |
| 3 | WebRTC (reaches the network outside `connect-src` via ICE gathering) | CSP `webrtc 'block'` **and** the shell deletes the `RTC*` constructors before content runs | a canary that tries to open a peer connection produces no packet at a local UDP listener |
| 4 | a nested frame runs in a fresh realm where RTC was never removed | the shell removes frame-like elements (`iframe, frame, object, embed, …`) the content adds, **including inside shadow roots**, and re-arms after any content-initiated document rewrite | a child-frame RTC canary — in the light DOM, in an open and a closed shadow root, and after the content calls `document.open()` — produces no packet *(the shadow-root and document-rewrite cases are gaps a naive top-level observer misses; measured here, so they are explicit cases)* |
| 5 | self-navigation of the frame to an external URL carrying data in the query | the **embedding page's** `frame-src` (a frame's own CSP cannot stop its own navigation) | navigating the frame to an external URL produces no request; the frame keeps its content |
| 6 | forms that submit, pop-ups, downloads, top-navigation | iframe `sandbox` grants only `allow-scripts` (no `allow-forms`, `allow-popups`, `allow-downloads`, `allow-top-navigation*`); `form-action 'none'` | each is attempted and blocked |
| 7 | `<base>` hijack, plugins | `base-uri 'none'`, `object-src 'none'` | a `<base>` and an `<object>` canary have no effect |
| 8 | resource hints / speculation rules (`dns-prefetch`, `preconnect`, `prefetch`, speculation rules) | `default-src 'none'` governs them (no `prefetch-src` allowance) | none produces a DNS lookup or connection in the engine's network log |
| 9 | reaching the host origin, storage, cookies, DOM | opaque origin, no `allow-same-origin` with a host-origin document; nothing secret ever sent into the frame | the frame cannot read `parent`, its origin is not the host's, and no host token is present |

Gating tests (capabilities): `sendPrompt` without a user gesture is refused by
the shell and, when gated `confirm`, nothing is sent until the host confirms;
`openLink` is http(s) only and confirmed; a muted frame stops asking.

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

## Preset components

A small set of themed web components the shell can preload so an agent reaches
good building blocks without hand-rolling them each time: at least a stat tile, a
bar/line chart primitive, a table, and an **elicitation** form (fields the person
fills; the result returns via a capability). They read the theme variables, so
they match the host in light and dark. They are listed in the config's
`components` and therefore in the generated manual (the agent is told the tag
names and props). They are ordinary custom elements defined in the shell — no
host round-trip to render — so they stay inside the sandbox. A host can extend
the list; the generator documents whatever is enabled.

## Guide generation

The manual and the tool description are generated from the same config, lazily,
so they cannot teach a variable the shell does not inject or a capability the CSP
blocks (PRINCIPLE 3, 10). The generator composes: the theme variable names (from
the theme map), the enabled capabilities (each capability's guide entry, with its
gate), the enabled preset components (tag names and props), the egress rule (the
allowed origins, in prose), the size rules (one column from a phone width to a
desktop width; draw SVG for the narrow width or one unit per pixel; nothing fixed
wider than the narrow width), and the supply-chain rule (pin exact, aged library
versions). Topics are requested à la carte (`widget`, `chart`, `interactive`,
`file`). A test renders every example in the guide through the real sandbox at
phone and desktop widths in light and dark and asserts it reads (no overflow,
text above a floor size) — the guide's examples are themselves conformance cases.

## MCP Apps adapter vs AppBridge

The official SDK ships `AppBridge` (host side), which extends the MCP SDK's
`Protocol` class and pulls in the MCP client/core packages. **Decision: the
core's MCP adapter reimplements the thin host-side subset of MCP Apps that maps
to capabilities; it does not embed AppBridge.** The subset is small and
well-specified (`ui/initialize` → host context + capabilities; `tool-input(-partial)`;
`tool-result`; `size-changed`; `host-context-changed`; `ui/open-link`,
`ui/message` → host functions; the sandbox-proxy handshake; teardown). Embedding
AppBridge would tie the host-agnostic core to the MCP SDK's dependency tree and
class hierarchy, against PRINCIPLE 7, for a subset we can state in a few hundred
lines and test directly against the reference examples. On the **widget side** we
reimplement nothing — authors use the official `App` SDK, which is exactly the
point of speaking the standard. We will offer an **optional** AppBridge-backed
adapter as a separate entry for hosts already standardized on the MCP SDK.
Upstream, we contribute what is general: the conformance/leak runner (the spec
community wants a WPT-style host test), the container-agnostic framing note (a
single hardened frame instead of the mandated double-iframe, where equally
secure), and the shadow-root / document-rewrite frame-escape findings.

## Migration plan: the first host (Ferry)

Ferry already has a working widget sandbox; it becomes Porthole's first user and
proves the API is general (PRINCIPLE 9). This section names Ferry only as that
first adopter.

**Moves out of Ferry into Porthole** (becomes `@botiverse/porthole` + presets):
the in-frame shell (`packages/core/src/widget-shell.ts`: CSP builder, RTC
removal, frame guard, inert streaming draft, size/error reporting, the MCP Apps
subset), the theme-variable map and resolver (`widget-theme.ts`), the
embedding-page CSP builder (`webAppCsp`), the web frame component
(`apps/web/src/features/session/display/WidgetFrame.tsx`) as the basis of the
React binding, and the guide generator (`display-guide.ts`) as the guide-gen
mechanism seeded with Ferry's text.

**Stays in Ferry** (product policy and plumbing): the `show_file`/`show_widget`/
`display_guide` MCP tools and their receipts/log entries; the daemon upload and
attachment storage; the session-log fold that decides where a display draws; the
`sendPrompt` confirmation UI and send-permission rules; the chart palette as a
product theme input; lazy-mount/live-frame policy; anything tied to Ferry's
session model.

**Ferry files that change:** `packages/core` drops the moved modules and depends
on `@botiverse/porthole`, re-exporting what its own tools need; `WidgetFrame.tsx`
becomes a thin wrapper over `@botiverse/porthole-react` supplying callbacks and
theme; `apps/server/src/http.ts` and `apps/web/vite.config.ts` and
`apps/desktop/src/main.ts` take the embedding-page CSP from Porthole instead of
local copies; `apps/daemon/src/crew/mcp.ts` builds its tool description and guide
from the Porthole config; the native bridge keeps carrying `@ferry/core`, which
now re-exports Porthole's shell. Ferry's display decision entry gets a follow-up
noting the extraction. The goal is Ferry's widget code reduced to a config plus
callbacks (OBJECTIVE 4, the dogfooding success test).

## The leak / conformance suite

A standalone Playwright project (`@botiverse/porthole-conformance`) that:

- drives a **platform host** (the web iframe host, and later others) through an
  **adapter**, via a small host **test interface** (launch a display in a fresh
  instance, reset, read conversation/context, flip theme, confirm an action,
  send) so the suite is not coupled to any one host's DOM — aligned with the
  upstream conformance-interface effort so results can feed it;
- runs every egress and escape probe in the table above, each attempting its
  channel and asserting nothing leaves, on Chromium, WebKit and Firefox, using
  out-of-band oracles (a local UDP listener for ICE, a local HTTP server for
  navigation/pixels, the engine's network log for hints);
- runs the MCP Apps examples unmodified and checks the lifecycle and interaction;
- renders the generated guide's examples and checks they read at the target
  widths and themes.

Any host embedding Porthole can run it against its own integration; it is the
proof behind every hardening claim (PRINCIPLE 5) and is offered upstream.

## Phase-1 milestones (rough effort)

1. **Config compiler + presets + guide gen (S–M, ~1 wk).** The config schema, the
   CSP/sandbox builder, the three presets, and the guide/tool-description
   generator, with the agreement test (config → CSP/shell/guide match).
2. **Isolation core + shell runtime + egress hardening + leak suite (M, ~1.5 wk).**
   Opaque-origin frame, the shell, items 1–9, and the Playwright suite green on
   three engines. The highest-risk work; do it early.
3. **Streaming + auto-size + theming + host-function bridge (S–M, ~1 wk).** Inert
   streaming draft, size reporting, theme apply/flip, the gated capability bridge.
4. **React binding + preset components (S, ~0.5 wk).** `<PortholeFrame>`, hooks,
   and the themed component set (stat/chart/table/elicitation), documented by the
   generator.
5. **MCP Apps adapter + sandbox proxy (M, ~1 wk).** The host-side subset and the
   second-origin proxy; run the official ext-apps examples unmodified.
6. **Artifact page mode designed; domain mode designed (S for design, ~0.5 wk).**
   Headers, versioning and ticket→cookie written down; built in phase 2.
7. **Ferry migration (M, ~1 wk).** Extract, wire Ferry to the packages, reduce its
   widget code to config + callbacks, keep its tests green.

Rough total ~6–7 weeks of focused work, front-loaded on isolation and the suite.

## Open questions for the owner

See [DECISIONS.md](DECISIONS.md) for choices already made. Open:

1. **Package/scope names.** `@botiverse/porthole`, `-react`, `-mcp`,
   `-components`, `-conformance`, `-server` — acceptable, or one package with
   sub-paths?
2. **AppBridge-backed adapter.** Ship the optional AppBridge adapter in phase 1,
   or only the reimplemented subset until a host asks?
3. **Preset components scope.** Is the stat/chart/table/elicitation set right for
   phase 1, or keep it to the bare minimum (stat + elicitation) and let hosts add
   the rest?
4. **Domain mode timing.** Land per-instance-subdomain widget storage in phase 1
   if the serving template is ready, or hold all of it to phase 2?
5. **Firefox support bar.** Is "leak suite green on Chromium, WebKit, Firefox" the
   right phase-1 gate, given WebKit and Firefox differ on some directives, or is
   Chromium + WebKit enough to start?
6. **Upstream posture.** How forward to be with the spec community now — file the
   conformance-runner and framing issues under the project, or wait until the
   code exists?
