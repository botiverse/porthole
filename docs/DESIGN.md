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
| `copyText` | user-activation, 30/min | handler | `copyText(text)` | `porthole/copy-text` (none in the standard) |
| `annotate` | 120/min (the frame's reports) | event | — | `porthole/annotate.*` (the host drives it, P053) |

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

The seams other work builds against. Interfaces are typed in the files below;
functions not built yet throw `NotBuiltYet` naming their milestone.

| Seam | File | Built by | Used by |
| --- | --- | --- | --- |
| Config, presets, compiler, guide, theme | `src/config/`, `src/presets/`, `src/compile/`, `src/guide/`, `src/theme/` | core (M1, done) | everyone |
| Host API: `createHost`, `MountOptions`, `DisplayHandle`, `DisplayEvents` | `src/host/types.ts`, `src/host/create-host.ts` | core (M2, built: opaque, domain and url frames) | React binding, hosts |
| Isolation: `InstanceRef`, `ServedDocument`, `InstanceLocator`, `FrameLocation`, `FrameSource`; `checkFrameLocation` | `src/isolation/types.ts`, `src/isolation/served.ts` | core; served modes (the checks) | served modes, hosts |
| Platform host: `PlatformHost`, `Surface`, `SurfaceSpec`; `webPlatform` | `src/platform/` | core (web, M2, built) | native hosts later |
| Transport; `postMessageTransport` | `src/transport/` | core (M2, built) | adapters |
| Protocol adapter: `ProtocolAdapter`, `AdapterSession`, `AdapterConnection`, `ShellConnection`; `shellAdapter` | `src/protocol/adapter.ts`, `src/protocol/shell-adapter.ts` | core (shell adapter, M2, built) | MCP adapter |
| MCP Apps names: `MCP_APPS_METHODS`, `MCP_APPS_STYLE_VARIABLES`, `PORTHOLE_STYLES`, `HostContext`; JSON-RPC parsing | `src/protocol/mcp-apps.ts`, `src/protocol/jsonrpc.ts` | core | shell, both adapters |
| MCP Apps adapter: `mcpAppsAdapter`, `McpAppConnection`, `viewEgress`, `readViewResource`, `MCP_APPS_STYLE_VARIABLES`, `sandboxProxyDocument` | `src/mcp/` | MCP adapter (done) | hosts showing MCP Apps views |
| Host-function bridge: `HostFunctionBridge`, `CapabilityHandlers`, `Confirm`, `ConfirmRequest`, `Refusal`; `createBridge` | `src/bridge/` | core (M2–M3, built and proven) | adapters, hosts |
| React: `PortholeProvider`, `PortholeFrame`, `ConfirmDialog`, `admitFrame` | `src/react/` | core (M4, built) | first host |
| Conformance: `ConformanceHost`, `LaunchSpec`, `LaunchedDisplay`, `defineLeakSuite`, `PROBES`, the oracles; `defineServedSuite`, `ServedConformanceHost` | `src/conformance/` | core (M2, built); served modes (done) | any host |
| Server: `createServer`, `PortholeServer`, `TicketStore`, `ArtifactStore`, `ContentDomain`, `Grant`, `Access`, `Upstream`, `proxyTo`, `memoryTicketStore` | `src/server/` | served modes (done) | host backends |

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
display.on("outcome", (outcome) => {});        // loaded | blocked (why) | timeout (P040)
display.refreshTheme();                        // the host's values changed without a flip
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

#### Wiring on Cloudflare Workers

A Worker with Hono, D1 and R2 serving artifact pages on `a-<id>.<content domain>`
(`test/workers/` runs one like it in workerd, with real D1):

- **Bindings.** A D1 database (`DB`) with `d1TicketSchema()` applied once as a
  migration; a secret of at least 32 random bytes (`wrangler secret put
  PORTHOLE_SECRET`); the host's own artifact source (R2, D1) behind `artifacts.get`.
  No `nodejs_compat`.
- **Routes.** The content domain's wildcard (`*.<content domain>/*`, with wildcard
  DNS and a certificate for every level served, `*.f.<domain>` included) and the
  host's own domain, to the same Worker, or the content domain to a Worker of its own.
- **Handler.** One server per isolate, made on first use from `env`:

  ```ts
  const porthole = createServer({
    content: { domain: "example-usercontent.com", scheme: "https", name: prefixedName("a-"), reserved: ["f", "www"] },
    secret: new TextEncoder().encode(env.PORTHOLE_SECRET),
    hostOrigins: ["https://app.example.com"],
    configs: { artifact: presets.artifact({ isolation: "domain", contentOrigins: ["https://*.example-usercontent.com"] }) },
    artifacts: { get: (id, version) => env.ARTIFACTS.get(`${id}/${version}`).then((o) => o && o.text()).then((html) => html && { html }) },
    tickets: d1TicketStore(env.DB),
    authorize: { check: ({ subject }) => stillShared(env, subject) },   // the host's policy
  });
  app.all("*", async (c, next) => (await porthole.handle(c.req.raw)) ?? next());
  ```

  and from the host's own authenticated API, once it has decided the person may see
  it, `porthole.issue({ scope: id, document: { kind: "artifact", id, version } },
  { viewer: userId, subject: shareId })` (a public share route: `{ anonymous: true,
  subject: shareId }`) returns the `FrameLocation` the host page frames. Scopes named
  by `prefixedName` must already be label-safe (lowercase letters, digits, inner
  hyphens); other ids keep the keyed default.

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

### Protocol adapters

The core ships the adapter for the MCP Apps subset its own shell speaks
(`ShellConnection`): `ui/initialize` answered with the host context,
`tool-input-partial` (0..n) then `tool-input` carrying `{ html }`,
`host-context-changed`, `size-changed` and `notifications/message` (errors) into
the bridge, `ui/message` and `ui/open-link` into the bridge, `ui/resource-teardown`.
Content may also use the official App SDK directly; the adapter answers a second
`ui/initialize` from the same frame, and the shell numbers its own requests with
strings (`porthole-shell-1`) so neither takes the other's answers.

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

`bridge.call(capability, args)` checks, in order: declared → arguments valid
(`openLink` http(s) only and without credentials in the URL; a prompt
1..`maxPromptChars` characters) → muted? → rate limit → user activation → `confirm`
→ the host's handler. Each refusal is a
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
    onContentError onHostError onResize onNavigated onRefused onMuted onInitialized onOutcome
    fill?                            // fill the box and scroll inside, not grow with the content
    annotating? annotations? focusedAnnotation? onAnnotation?   // where annotate is declared
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
  overwrites a remembered height (the first host's frame jumped there).
- **Annotations** follow props: `annotating` (what the person may point at now, or
  null), `annotations` (the marks), `focusedAnnotation` (each new id is brought into
  view; `{ id, key }` with a new key focuses the same one again); `onAnnotation` gets
  what the frame reported. A frame that mounts again gets them all.
- **Errors** (P055): `onContentError` gets what the content did wrong (what it
  threw, what the sandbox blocked, that it kept navigating away): the agent's to
  hear. `onHostError` gets what failed on the host's side (`locate`, `mount`,
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

Closed by default; opened only to origins the config declares. The leak suite
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
source, with one exception (P060). An egress source (not a content origin, not an
embedder frame) may carry a directory path prefix, one exact host only:
`https://cdn.jsdelivr.net/npm/` opens that CDN under `/npm/` and nothing else of it
(P063). The CSP lists it verbatim and matches by prefix. A browser ignores the path
after a redirect (CSP3), so a prefix narrows what content loads directly, not what a
redirect from inside it reaches: hygiene, not a wall (inline code and eval run
anyway). Where an origin is needed (the MCP Apps `sandbox.csp` domains,
`allEgressOrigins`), the path is dropped (`leak/cdn.spec.ts`,
`leak/served/any-https.spec.ts`: a URL under the prefix loads, one outside it,
`/allowedx/` included, doesn't). A host may let passive content load from any
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
| 1 | fetch, XHR, WebSocket, EventSource, `sendBeacon`, `fetchLater`, a blob worker's fetch | CSP `connect-src` = the allowlist only (`'none'` by default) | `1.connect` (with an allowed origin as positive control) | `connect-src` → `1.connect` (all three); `8.prefetch` too on Chromium |
| 2 | images, CSS images, SVG `<image>`/`<use>`, media and posters, `input type=image`, stylesheets, `@import`, fonts, scripts, `import()`, workers, manifests, icons | CSP `img/media/font/style/script-src` = the allowlist only; `worker-src blob:` | `2.resources` (an allowed image as positive control) | — (the same CSP as item 1) |
| 3 | WebRTC (ICE gathering reaches the network outside `connect-src`) | CSP `webrtc 'block'` **and** the shell removes every `RTC*`/`webkitRTC*` constructor, fixed in place, before content runs | `3.webrtc` (an unsandboxed peer connection as positive control: it sends STUN on both engines) | `webrtc` → `3.webrtc` (all three; Firefox's positive control needs `media.peerconnection.ice.loopback`, set in the suite's Firefox project, P035) |
| 4 | a nested frame: a fresh realm where item 3's removal never happened | the shell drops frame-like elements (`iframe, frame, frameset, object, embed, portal, fencedframe`) synchronously wherever content connects a node (P030), and an observer removes any that arrive another way, in the document and every shadow root (`attachShadow` is wrapped so closed ones are reached too); documents are rendered inert and imported, never written; `document.open/write` throw; declarative shadow roots can't be built (P029); CSP `frame-src 'none'` | `4.light-dom`, `.sync-realm`, `.open-shadow`, `.closed-shadow`, `.shadow-nested`, `.declarative-shadow`, `.parse-html-unsafe`, `.domparser`, `.document-write`, `.plugins`, `.foreign-object`, `.template-clone`, `.static` (each: the child never runs, no STUN, no frame left) | `frame-guard,sync-guard` → light-dom, sync-realm, plugins, foreign-object, template-clone; `attach-shadow,sync-guard` → closed-shadow, shadow-nested; `declarative-shadow` → declarative-shadow; `parser-entry-points` → document-write (each on all three engines). Either guard alone is covered by the other. |
| 5 | self-navigation out, with data in the URL (`location`, `replace`, `open(…, "_self")`, meta refresh, a link clicked past the shell, an SVG link), to the host's own origin, or to a `blob:`/`data:` document of its own (a fresh realm) | the **embedding page's** `frame-src` (`embedderCsp`: `'none'` for opaque content, P033; frames only, so the host's own workers are untouched, P038): a frame's own CSP cannot stop its own navigation; the shell sends link clicks out through `openLink` and drops refreshes (P030); a display whose frame navigates is started again, at most three times (P031) | `5.location`, `.replace`, `.open-self`, `.refresh`, `.anchor`, `.svg-link`, `.host-origin`, `.blob`, `.data` (no request reaches the canary or the host; a navigated document never runs: a witness origin hears nothing) | `embedder-csp` → location, replace, open-self, anchor, svg-link, blob, data, `6.remote-download` (all three; `.refresh` holds: the synchronous guard drops the refresh; Firefox also holds `.data` by itself, P035); `embedder-self` → `5.host-origin` |
| 6 | forms, popups, downloads, top and parent navigation | `sandbox="allow-scripts"` only; CSP `form-action 'none'` | `6.submit`, `.request-submit`, `.blank-form`, `.open`, `.blank-link`, `.download`, `.remote-download`, `.top`, `.top-link`, `.parent` | `sandbox` → open, blank-link, top, top-link, parent (all three), download (Chromium; WebKit and Firefox started no download either way). Form submits still fail: `form-action` is a second wall |
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
| 12 | `sendPrompt` | the shell refuses a call without a gesture; the host refuses one without its page's user activation, then asks `confirm` with the whole text; declines count toward a mute | `12.prompt-gesture-confirm` (a call on load is refused; a click asks; a no sends nothing; a yes reaches the handler), `12.raw-message` (a raw `ui/message` around the shell, no click: refused by the host), `12.mute`, `12.no-confirm` | `confirm-gate` → prompt-gesture-confirm, link, mute, no-confirm; `shell-gesture` → prompt-gesture-confirm, mute; `host-gesture` → raw-message |
| 12 | `openLink` | link clicks go out through `openLink`; the bridge takes http(s) only, without credentials in the URL; confirmed | `12.link` (a web link asks and opens; `javascript:` links and `openLink("javascript:…")` do nothing and are refused) | `link-scheme` → `12.link` |

Measured: a click in the frame gives the host page user activation (it propagates to
ancestors) on Chromium, WebKit and Firefox, so the host-side gesture check holds for real
clicks; it is still advisory, since a person may have clicked the host a moment
before. Playwright's own page evaluations count as gestures, so the gate probes wait
for that to lapse and click with raw input.

### Served content, each with its test

| What | Mechanism | Tests (all three engines unless noted) | Negative control → fails |
|------|-----------|-------|------------------|
| The host's check (P050) | `authorize.check` after a ticket or cookie verifies, before anything is served; a deny is a 403 page saying `denied` and the host's code, and the display's `outcome` says so even after `loaded` | `leak/served/authorize.spec.ts`: a revoked subject's ticket (a page, an app); a framed app's next request and reload mid-session (Chromium, Firefox: WebKit keeps no framed cookie, P025); a framed page's next load; an app and a page in a tab | `authorize` → every case but WebKit's framed page (`session` either way) |
| Url-mode delegation (P049) | `allow` from `permissions`, `""` by default | `leak/served/permissions.spec.ts`: full screen follows it on all three; clipboard writes on Chromium only (WebKit and Firefox let any frame write in a click) | `url-permissions` → the default case (all three) |
| Library CDNs for artifacts (P048) | `egress: LIBRARY_CDNS` in the host's artifact config; closed by default (P022) | `leak/cdn.spec.ts`: opaque and served, a CDN library loads only when opened; another origin never | — (the CSP of rows 1–2) |
| Workers (P044, P045) | no Node module in `/server`; D1 tickets taken by one `DELETE … RETURNING` | `test/workers.test.ts` (workerd, no `nodejs_compat`, real D1: once per ticket, a race, anonymous, a revocation, flat names, reserved namespaces) | — |

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
| 13 | the async Clipboard API in a click (`writeText`, `write`, `readText`) | the shell's lock; Chromium also by the `allow` denial | `13.clipboard-api` | `clipboard` → WebKit, Firefox (Chromium holds by the `allow` denial) |
| 13 | `execCommand("copy")`/`("cut")` of the content's own selected text | the shell refuses the commands | `13.clipboard-command` | `clipboard` → all three |
| 13 | a copy listener swapping what the person copies (`clipboardData.setData`) | copy and cut events stopped at the window, first | `13.clipboard-event` (the person's own copy works: positive control) | `clipboard` → all three |
| 12 | `copyText` | a click (shell and host), 30 a minute, the host's handler | `12.copy-text` (refused on load; the whole text reaches the handler from a click) | — |

Measured before the walls (0.1.2): a click in an opaque widget wrote the clipboard
on all three engines (the async API on WebKit and Firefox, the copy command and copy
listeners everywhere). The oracle is the person's clipboard: text copied on the
host's page, then pasted back there. What the shell can't stop: text hidden by CSS
inside what the person selects goes with their copy (the browser's own copy); hosts
that care point people at copy buttons, whose toast shows exactly what was copied.

### Annotations

A person points at part of a display to comment on it (P053). The host drives the
shell with Porthole's own messages and the shell reports back; the config declares
`annotate` (inline widgets and artifact pages; MCP Apps views where the host
chooses), and the annotation runtime is in the shell only then.

| Direction | Message | Params |
|-----------|---------|--------|
| host → frame | `porthole/annotate.start` | `{ elements, text }`: picking elements (the one under the pointer or finger outlined with its name; a click or tap picks it, never reaching the content; Escape cancels; one pick), selecting text (each settled selection), or both (a click picks, a drag selects) |
| host → frame | `porthole/annotate.stop` | — |
| host → frame | `porthole/annotate.show` | `{ marks: [{ id, anchor }], active? }`: drawn over the content in the shell's own layer (a closed shadow root), found again whenever the content changes |
| host → frame | `porthole/annotate.focus` | `{ id }`: scrolled into view inside the frame, made the active mark, flashed |
| host → frame | `porthole/annotate.clear` | — |
| frame → host | `porthole/annotate.selected` | `{ anchor, rect }` |
| frame → host | `porthole/annotate.unselected` | — (the text selection went away) |
| frame → host | `porthole/annotate.cancelled` | — (Escape) |
| frame → host | `porthole/annotate.anchored` | `{ results: [{ id, state: "attached" \| "orphaned", rect? }] }`: every mark after `show`, the one after `focus`, and when the content changed, only if a state did |

- **Anchors** are W3C Web Annotation selectors, at most one of each:
  `CssSelector` (unique: the nearest id, else a path of `nth-of-type` steps),
  `TextQuoteSelector` (the words, with 32 characters of context each side), and
  `TextPositionSelector` (offsets into the body's text, without scripts, styles and
  templates). An element anchor has its selector and its first 300 characters of
  text; a text anchor its words (at most 4,000), position and nearest element.
- **Found again**, best-effort: a text anchor where it was, else its words anywhere
  (the occurrence whose context matches best), else its words with any spacing; an
  element anchor by its selector if its text still starts with its words (or the
  selector is an id, or it has no words), else the element holding its words. What
  can't be found is `orphaned`, said so; a host keeps the comment and shows it apart.
- **Rects** are in the frame's viewport, CSS px: add the frame element's position.
- **Settled.** Nothing is reported before the content is in place (marks shown
  before it arrives are anchored once it has), nor while a run of changes settles; a
  `focus` asked for meanwhile waits for anchoring, then scrolls and reports, so a
  focus right after `show` says where the mark is, never `orphaned` first (P057).
- **Trust.** The shell shares its realm with the content, which can interfere with
  all of it or fake any report. The host takes a selection only while it asked for
  that kind, a cancel only while picking, results only for its own marks; it
  rebuilds each from known fields within `ANNOTATION_LIMITS` and drops the rest,
  through the bridge's rate limit. UI hints only, never permissions: what a
  report says decides where a comment is drawn, never who may see or do anything.
- **Host API.** `display.annotations.start(mode?)`, `stop()`, `show(marks)`,
  `focus(id)`, `clear()`, and the `annotation` event (`AnnotationReport`); the state
  is given to every frame the display runs. `parseAnchor` checks an anchor a host
  stores (its server, before saving a comment).

Tests (`leak/annotate.spec.ts`, all three engines): a pick outlines and picks
without the content seeing the click, by id or by path; Escape cancels; a text
selection and its clearing; both modes together; marks shown, one focused into
view, one orphaned, all cleared; re-anchoring on a revised page (by id, by words
moved, by words respaced, one deleted and orphaned); live changes reported only as
they change; an MCP Apps view; and a hostile page faking every report (not asked,
malformed, too large, the wrong kind, no such mark, a flood), whose negative
control is `annotation-checks`.

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
defenses taken out (P032; the table above lists what each must fail).
`ConformanceHost.launch` called twice on one page shows two displays side by side
(`9.siblings`).

## Milestones

The core (this repository's lead work), in order; each lands when its tests pass:

1. **M1 — scaffold, config, compiler, presets, interfaces** (done). The workspace
   and tooling; the config schema and validation; the compiler (CSP, sandbox and
   `allow`, embedder CSP, shell plan and document, guide and tool description) with
   the agreement test; the presets as configs; the public interfaces above as typed
   stubs; the shell's wiring checked in real frames on Chromium and WebKit.
2. **M2 — isolation core, shell runtime, egress hardening** (done). The web
   platform host and transport, `createHost` mounting opaque, domain and url frames
   (served frames checked by `checkFrameLocation`), the shell adapter and the bridge,
   the reference host and `defineLeakSuite`, items 1–10 above each with its probes,
   positive controls and negative controls, green on Chromium and WebKit; the
   official App SDK connecting under every preset.
3. **M3 — streaming, auto-size, theming, the gated bridge** (done). Streaming
   drafts through the host API, size reporting under the limits, theme apply and
   flip with the host's live values, base styles for native form elements, and the
   host-function bridge's gates, each proven in real frames (items 11, 12) with
   negative controls, and in unit tests (`test/bridge.test.ts`,
   `test/shell-adapter.test.ts`).
4. **M4 — the React binding and its default confirmation dialog** (done).
   `<PortholeProvider>`, `<PortholeFrame>`, `ConfirmDialog`: streaming through props,
   height memory per display, the live-frame cap with "Run again", theme flips,
   navigation recovery, generations, and the default, replaceable dialog, each
   proven in a real browser.
5. **M5 — Firefox** in the gate (done): every Playwright suite (leak, served, MCP
   examples, React) runs on Chromium, WebKit and Firefox, and every negative control
   was run on Firefox; its differences are recorded in P035.

In parallel, against the interfaces: the **MCP Apps adapter** (`/mcp`, running the
official ext-apps examples unmodified); the **served modes** (domain mode, `/server`,
the artifact page served, the MCP Apps sandbox proxy, URL mode); and the **Ferry
migration**.

## Open questions

1. ~~URL mode's sandbox tokens~~: popups, modals and downloads are a host's
   opt-in (P037); clipboard writes and full screen too (P049).
2. ~~`'self'` in the embedding page's `frame-src`~~: measured and dropped (P033).
3. ~~Clipboard writes from agent-written content~~: closed (P051); copy buttons go
   through the host (`copyText`, P052).
