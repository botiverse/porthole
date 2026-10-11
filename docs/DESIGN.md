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

One package, `@botiverse/porthole`, with subpath exports (P013), in a pnpm
workspace (`packages/porthole`):

| Import | What | Source |
| --- | --- | --- |
| `@botiverse/porthole` | The core: config, presets, compiler, theme, guide, and the seams below. No DOM framework, no host, no MCP SDK. | `src/index.ts` |
| `@botiverse/porthole/react` | The React binding: `<PortholeProvider>`, `<PortholeFrame>`, the default `ConfirmDialog`. Peer: `react`. | `src/react/` |
| `@botiverse/porthole/mcp` | The MCP Apps adapter for full MCP Apps views. Depends on the core only. | `src/mcp/` |
| `@botiverse/porthole/conformance` | The leak/conformance suite and the host test interface. Peer: `@playwright/test`. | `src/conformance/` |
| `@botiverse/porthole/server` | Serving for domain, artifact and url modes, and the MCP Apps sandbox proxy: a request handler a host's backend mounts. | `src/server/` |

Inside `src/`:

```
config/      schema.ts (the config types), capabilities.ts (the vocabulary), validate.ts
compile/     compile.ts (config → CompiledConfig), policy.ts (CSP, sandbox, allow, embedder CSP)
shell/       runtime.ts (the in-frame script, a string), plan.ts (what it wires), document.ts
guide/       guide.ts (manual + tool description), examples.ts
theme/       variables.ts (the default vocabulary, resolveTheme)
presets/     presets.ts (inlineWidget, artifact, mcpApp, url; LIBRARY_CDNS)
protocol/    adapter.ts (the adapter seam), mcp-apps.ts (method names, HostContext), jsonrpc.ts
bridge/      types.ts (the host-function bridge)
transport/   types.ts          platform/  types.ts          isolation/  types.ts
host/        types.ts (host API), create-host.ts
react/ mcp/ conformance/ server/   the subpath entries
```

Tooling: Node ≥ 24 running TypeScript by type stripping (erasable syntax only;
relative imports carry `.ts`), pnpm 11, TypeScript 7 for typechecking, oxlint
(type-aware) and oxfmt, vitest for unit tests (`packages/porthole/test/`), and
Playwright for the leak suite (`packages/porthole/leak/`). In the workspace the
package exports its sources; `pnpm build` emits JS and declarations to `dist/`,
which a packed package exports instead (Node does not strip types under
`node_modules`).

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
type Gate = "user-activation" | "confirm" | { rateLimit: { perMinute: number } };
```

`mode` and `isolation` select the mechanism; everything else is policy. There is
no `components` field (P015).

### The capability vocabulary

| Capability | Default gates | Served by | Shell global | MCP Apps request (App SDK) |
| --- | --- | --- | --- | --- |
| `sendPrompt` | user-activation, confirm | handler | `sendPrompt(text)` | `ui/message` (`app.sendMessage`) |
| `openLink` | user-activation, confirm | handler | `openLink(url)` | `ui/open-link` (`app.openLink`) |
| `downloadFile` | user-activation, confirm | handler | — | `ui/download-file` (`app.downloadFile`) |
| `callTool` | confirm | handler | — | `tools/call` (`app.callServerTool`) |
| `readData` | 120/min | handler | — | `resources/read` (`app.readServerResource`) |
| `setModelContext` | 30/min | handler | — | `ui/update-model-context` (`app.updateModelContext`) |
| `reportError` | 10/min | event | (automatic) | `notifications/message`, level `error` |
| `resize` | none | event | (automatic) | `ui/notifications/size-changed` |

Every preset declares only `resize` and `reportError` (they report to the host and
carry nothing out); the host declares the rest. Gates are explained in P021: all
must pass; `confirm` calls the host's `confirm` function and fails closed without
one; `user-activation` is checked by the shell (advisory: it shares the content's
realm) and by the host where the engine passes the gesture up.

## What the compiler derives

`compile(config)` (`src/compile/compile.ts`) validates the config and returns:

- `csp` / `cspDirectives`: the frame's policy. `default-src 'none'`; scripts may be
  inline (agent content is inline) plus `blob:` and the script origins; each other
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
  given its plan. With `document`, the shell's head goes first and the document
  follows without its doctype, so nothing of the document's runs before the runtime.
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
them together. `leak/shell.spec.ts` checks the same wiring in real frames.

## Public interfaces

The seams other work builds against. Interfaces are typed in the files below;
functions not built yet throw `NotBuiltYet` naming their milestone.

| Seam | File | Built by | Used by |
| --- | --- | --- | --- |
| Config, presets, compiler, guide, theme | `src/config/`, `src/presets/`, `src/compile/`, `src/guide/`, `src/theme/` | core (M1, done) | everyone |
| Host API: `createHost`, `MountOptions`, `DisplayHandle`, `DisplayEvents` | `src/host/types.ts` | core (M2–M3) | React binding, hosts |
| Isolation: `InstanceRef`, `ServedDocument`, `InstanceLocator`, `FrameLocation`, `FrameSource` | `src/isolation/types.ts` | core | served modes, hosts |
| Platform host: `PlatformHost`, `Surface`, `SurfaceSpec` | `src/platform/types.ts` | core (web, M2) | native hosts later |
| Transport | `src/transport/types.ts` | core (M2) | adapters |
| Protocol adapter: `ProtocolAdapter`, `AdapterSession`, `AdapterConnection`, `ShellConnection` | `src/protocol/adapter.ts` | core (shell adapter, M2–M3) | MCP adapter |
| MCP Apps names: `MCP_APPS_METHODS`, `HostContext`; JSON-RPC parsing | `src/protocol/mcp-apps.ts`, `src/protocol/jsonrpc.ts` | core (M1, done) | shell, both adapters |
| Host-function bridge: `HostFunctionBridge`, `CapabilityHandlers`, `Confirm`, `ConfirmRequest`, `Refusal` | `src/bridge/types.ts` | core (M3) | adapters, hosts |
| React: `PortholeProvider`, `PortholeFrame`, `ConfirmDialog` props | `src/react/index.ts` | core (M4) | first host |
| Conformance: `ConformanceHost`, `LaunchSpec`, `LaunchedDisplay`, `defineLeakSuite` | `src/conformance/index.ts` | core (M2) | any host |
| Server: `createServer`, `PortholeServer`, `TicketStore`, `ArtifactStore`, `ContentDomain`, `Grant` | `src/server/index.ts` | served modes | host backends |

### Host API

```ts
import { createHost, presets, LIBRARY_CDNS } from "@botiverse/porthole";

const host = createHost(
  presets.inlineWidget({
    capabilities: { sendPrompt: {}, openLink: {} },     // default gates
    egress: LIBRARY_CDNS,                                // opt in to library CDNs
    guide: { toolName: "show_widget", guideToolName: "display_guide" },
  }),
  {
    handlers: { sendPrompt: ({ text }, call) => send(text, call.displayId), openLink: ({ url }) => open(url) },
    confirm: (request) => askThePerson(request),         // or the React binding's default dialog
    theme: (scheme) => readMyTokens(scheme),             // live values for the config's names
  },
);

const display = host.mount(container, { displayId, title, scheme: "light" });
display.setContent(code, { partial: true });  // while the agent writes it
display.setContent(code);                      // once, whole: now it runs
display.setTheme("dark");
display.on("resize", ({ height }) => {});
display.on("error", ({ message }) => {});
display.destroy();

host.compiled.guide(["widget", "chart"]);      // the manual, from the same config
host.compiled.toolDescription();
host.compiled.csp;                             // the exact CSP, for audit
embedderCsp([config]);                         // what the embedding page must send
```

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
- **Tickets** are minted by `issue` (one-time, short-lived, bound to an instance and
  a viewer), carried once in the frame's URL, taken by the content origin, and
  exchanged for a cookie of that origin only (`__Host-`, `Secure`, `HttpOnly`,
  `SameSite=None; Partitioned` in a frame); the response then redirects to the
  document without the ticket.
- **Separation is checked.** The content domain is a registrable domain the host
  uses for nothing else, and a mount refuses a located origin that doesn't match
  `contentOrigins` or is same-site with the host.

`/server`'s handler is fetch-style (`Request → Response | null`, null for requests
that aren't for the content domain), so a backend mounts it in front of its own
routes. Dev and tests use `*.localhost` subdomains, which browsers resolve to
loopback.

### Protocol adapters

The core ships the adapter for the MCP Apps subset its own shell speaks
(`ShellConnection`): `ui/initialize` answered with the host context,
`tool-input-partial` (0..n) then `tool-input` carrying `{ html }`,
`host-context-changed`, `size-changed` and `notifications/message` (errors) into
the bridge, `ui/message` and `ui/open-link` into the bridge, `ui/resource-teardown`.
Content may also use the official App SDK directly; the adapter answers a second
`ui/initialize` from the same frame.

The `/mcp` adapter (full MCP Apps views) implements `ProtocolAdapter` with its own
connection operations (tool input and result, cancellation), carries `tools/call`,
`resources/read`, `ui/download-file`, `ui/update-model-context` and
`ui/request-display-mode` through the bridge, maps a view's `_meta.ui.csp` into the
config's egress, and performs the sandbox-proxy handshake when the frame is the
proxy. An adapter validates every message and never calls a host handler itself:
`bridge.call` decides.

### The host-function bridge

`bridge.call(capability, args)` checks, in order: declared → arguments valid
(`openLink` http(s) only; a prompt 1..`maxPromptChars` characters) → muted? →
rate limit → user activation → `confirm` → the host's handler. Each refusal is a
`Refusal` and a `refused` display event; the frame gets an error result. After
`declinesBeforeMute` declines a display stops asking (`muted`) until it runs again.

### React binding

`<PortholeProvider confirm? hostInfo? locator?>` near the root owns the default
confirmation dialog and the live-frame cap; `<PortholeFrame config displayId title
content partial scheme theme handlers confirm? instance? document? generation?
onResize onError …>` mounts a display lazily as it nears the screen, keeps at most
`limits.maxLiveFrames` running (those off screen longest stop first, and run again
when they come back), and remembers each display's height. Written with
`createElement`, so it needs no JSX transform.

## Widget side (what the agent writes against)

The content speaks **MCP Apps**. An author can use the official
`@modelcontextprotocol/ext-apps` `App` SDK, or the raw JSON-RPC over `postMessage`
the spec documents — the host side answers it. For convenience the shell defines
`sendPrompt(text)` and `openLink(url)` when those capabilities are declared (sugar
over `ui/message` and `ui/open-link`), turns link clicks into `openLink`, stands in
for `localStorage` in an opaque frame, applies the theme variables, and fires the
config's theme event after a change. A capability that is not declared is simply
absent.

## The modes

- **Inline widget** (`presets.inlineWidget`). The host has the HTML (the agent
  wrote it) and the shell draws it in an opaque frame, streamed as it is written.
  The phase-1 workhorse.
- **Artifact page** (`presets.artifact`). A whole document: written into an opaque
  frame by the shell where the host has it (the first host's "show an HTML file"),
  or served on its own origin (domain isolation), CSP in headers, versioned. It
  scrolls inside past a shorter height cap.
- **MCP Apps view** (`presets.mcpApp`). A standard `ui://` template plus tool
  input/result, through the `/mcp` adapter: hardened in an opaque frame (the shell's
  runtime first in the view's document), or behind the sandbox proxy on a second
  origin.
- **Domain mode** (any of the above with `isolation: "domain"`). A stable origin per
  storage scope, so `localStorage` persists (P016).
- **URL mode** (`presets.url`). A running app by URL (the first host's dev-server
  preview): frame, isolation and access auth; no shell, no egress control (P020).

## Egress hardening, each with its test

Closed by default; opened only to origins the config declares. The leak suite
attempts each channel and asserts nothing leaves, on Chromium and WebKit, then
Firefox (P017); harden for the weakest (PRINCIPLE 6). The probes land in M2; until
an item's probe passes, the item does not exist (PRINCIPLE 5).

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
| 10 | loading from the embedding page's own origin (an opaque frame's `'self'` may resolve to it) | no `'self'` in any directive (P022) | a script, style, image and fetch to the host origin all fail |

Gating tests (capabilities): `sendPrompt` without a user gesture is refused by
the shell and, when gated `confirm`, nothing is sent until the host confirms;
`openLink` is http(s) only and confirmed; a muted frame stops asking; a
`confirm`-gated call with no `confirm` function is refused.

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
applies them in place on a flip and fires the theme event. Its base styles set the
body's type and color from the variables; base styles for native form elements
(buttons, inputs) are the only further look Porthole adds, as plain CSS (P015).

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

## Migration plan: the first host (Ferry)

Ferry already has a working widget sandbox; it becomes Porthole's first user and
proves the API is general (PRINCIPLE 9). This section names Ferry only as that
first adopter. Every Ferry feature that shows agent-made or foreign HTML goes
through Porthole: widgets (inline widget), shown HTML files (artifact page), and
the dev-server preview pane (URL mode).

**Moved into Porthole** (seeded from Ferry, renamed, wired from the config): the
shell (`widget-shell.ts`) → `src/shell/`; its CSP builder → `src/compile/policy.ts`
(now without `'self'`, its CDNs an opt-in, `LIBRARY_CDNS`); the embedding-page CSP
(`webAppCsp`) → `embedderCsp`; the theme map (`widget-theme.ts`) → the default
vocabulary and `resolveTheme` (Ferry's rUI token names become its `theme` function;
its chart palette is the default); the guide (`display-guide.ts`) →
`src/guide/` (its `file` topic stays Ferry's, as `guide.topics.file`); the frame
component (`WidgetFrame.tsx`) → the React binding (live-frame cap, heights).

**Names that change** for content Ferry already shows: the theme event
`ferry:theme` → `config.theme.event` (Ferry may keep its name there, P024); the
error method `ferry/notifications/error` → `notifications/message` (level
`error`); the tool-input argument `widget_code` → `html` (Ferry maps its tool's
argument when it calls `setContent`); the root `#ferry-root` → `#porthole-root`.

**Stays in Ferry** (product policy and plumbing): the `show_file`/`show_widget`/
`display_guide` MCP tools and their receipts/log entries; the daemon upload and
attachment storage; the session-log fold that decides where a display draws; the
`sendPrompt` send-permission rules (its dialog may stay its own, through
`confirm`); lazy-mount/live-frame numbers as config; the preview gateway and its
daemon streams (URL mode frames it); anything tied to Ferry's session model.

**Ferry files that change:** `packages/core` drops the moved modules and depends
on `@botiverse/porthole`, re-exporting what its own tools need; `WidgetFrame.tsx`
becomes a thin wrapper over `@botiverse/porthole/react` supplying callbacks and
theme; `apps/server/src/http.ts`, `apps/web/vite.config.ts` and
`apps/desktop/src/main.ts` take the embedding-page CSP from `embedderCsp`;
`apps/daemon/src/crew/mcp.ts` builds its tool description and guide from the
Porthole config; the preview pane frames through the url preset; the native bridge
keeps carrying `@ferry/core`, which re-exports Porthole's shell. Ferry's display
decision entry gets a follow-up noting the extraction. The goal is Ferry's widget
code reduced to a config plus callbacks (OBJECTIVE 4, the dogfooding success
test).

## The leak / conformance suite

A Playwright suite (`@botiverse/porthole/conformance`) that:

- drives a **platform host** (the web iframe host, and later others) through an
  **adapter**, via a small host **test interface** (`ConformanceHost`: launch a
  display in a fresh page; answer confirmations; read the calls that reached the
  handlers and the errors; flip the theme) so the suite is not coupled to any one
  host's DOM — aligned with the upstream conformance-interface effort so results
  can feed it;
- runs every egress and escape probe in the table above, each attempting its
  channel and asserting nothing leaves, using out-of-band oracles (a local UDP
  listener for ICE, a local HTTP server for navigation/pixels, the engine's
  network log for hints);
- runs the MCP Apps examples unmodified and checks the lifecycle and interaction;
- renders the generated guide's examples and checks they read at the target
  widths and themes.

Porthole runs it against its own reference host (`leak/`, served by
`leak/server.ts`, which serves the core's TypeScript stripped as Node does):
`pnpm test:leak` runs Chromium and WebKit; `PORTHOLE_LEAK_ENGINES=chromium` runs a
subset where an engine's system libraries are missing.

## Milestones

The core (this repository's lead work), in order; each lands when its tests pass:

1. **M1 — scaffold, config, compiler, presets, interfaces** (done). The workspace
   and tooling; the config schema and validation; the compiler (CSP, sandbox and
   `allow`, embedder CSP, shell plan and document, guide and tool description) with
   the agreement test; the presets as configs; the public interfaces above as typed
   stubs; the shell's wiring checked in real frames on Chromium and WebKit.
2. **M2 — isolation core, shell runtime, egress hardening.** The web platform host
   and transport, opaque frames through `createHost`, the reference host and
   `defineLeakSuite`, items 1–10 above each with its probe, green on Chromium and
   WebKit.
3. **M3 — streaming, auto-size, theming, the gated bridge.** The shell adapter,
   inert streaming drafts, size reporting under the limits, theme apply and flip,
   base styles for native form elements, and the host-function bridge with its
   gating tests.
4. **M4 — the React binding and its default confirmation dialog.**
   `<PortholeProvider>`, `<PortholeFrame>`, `ConfirmDialog`.
5. **M5 — Firefox** in the leak suite gate.

In parallel, against the interfaces: the **MCP Apps adapter** (`/mcp`, running the
official ext-apps examples unmodified); the **served modes** (domain mode, `/server`,
the artifact page served, the MCP Apps sandbox proxy, URL mode); and the **Ferry
migration**.

## Open questions

1. **URL mode's sandbox tokens.** The baseline is `allow-scripts allow-same-origin
   allow-forms`; does a dev-server preview need more (popups for OAuth flows,
   downloads)? The served-modes work decides with a probe and a decision entry.
2. **`'self'` in the embedding page's `frame-src`.** It covers `srcdoc` frames and
   the host's own frames, but also lets a widget navigate its frame to a host page
   (no exfiltration: the host origin is not the attacker's). Measure whether
   `srcdoc` frames need it at all, and drop it if not.
