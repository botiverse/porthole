# Adopting Porthole

How to put Porthole in an app, from the npm package alone. The package's `examples/` is a whole
app that does everything below: `examples/app.mjs` is the app, runtime-agnostic;
`examples/node/server.mjs` and `examples/workers/` run it. DESIGN.md says how it works and
DECISIONS.md why (the P-numbers the code cites).

## 1. Choose how content is shown

| | Opaque | Served |
| --- | --- | --- |
| Where it runs | A sandboxed frame in your page, origin `null` | A frame on an origin of its own (`a-<id>.example-usercontent.com`) |
| Server side | None | The host kit (`createContentHost`) |
| Storage, clean address, open in a tab | No | Yes |
| Typical | Widgets in a conversation | Stored pages, artifacts, a viewer |

Start opaque if you can; add served pages when content needs storage or an address. A served app
keeps the opaque config as its fallback for when the content domain is down.

The config is the source of truth: `presets.inlineWidget()`, `presets.artifact()`,
`presets.mcpApp()`, `presets.url()` with your options. The same config object (or the same
options) must be used by the server (it puts the CSP in headers), the page (`createHost`) and the
agent's manual (`compile(config).guide()`): give it one home and import it everywhere.

## 2. Opaque displays: the page only

```js
import { createHost, presets } from "@botiverse/porthole";

const config = presets.inlineWidget({ capabilities: { openLink: {} } });
const host = createHost(config, {
  handlers: { openLink: ({ url }) => window.open(url, "_blank", "noopener") },
  // A gated call asks the person first, with the call's whole effect (here: the link).
  confirm: async (request) => window.confirm(`Open ${JSON.stringify(request.args)}?`),
});
const display = host.mount(container, { displayId: "w1", title: "A chart", scheme: "light" });
display.setContent(agentHtml, { partial: true }); // while it streams: drawn inert
display.setContent(agentHtml);                    // once whole: it runs, once
display.on("contentError", ({ message }) => tellTheAgent(message));
```

React: wrap the app in `<PortholeProvider>`, then
`<PortholeFrame config={config} displayId={id} title={title} scheme={scheme} content={html} partial={streaming} />`.

## 3. Served pages: the host kit

### Local development

Run the app and the content domain on one server: app `http://localhost:8790`, content domain
`content.localhost:8790` (pages at `http://a-<id>.content.localhost:8790`). Browsers resolve every
`*.localhost` name to loopback, and each is a site of its own, so the app and its content never
share cookies or storage. `http` is allowed only on loopback; everything else is `https`.

In production the content domain is a registrable domain your app uses for nothing else
(`example-usercontent.com`), with wildcard DNS and a wildcard certificate pointing at the same
app. Porthole refuses one that holds or may share a site with an app origin (`ContentDomainError`).
Put it on the Public Suffix List when you can, so its labels are sites of their own.

### The server

```js
import { presets } from "@botiverse/porthole";
import { createContentHost, prefixedName, memoryTicketStore } from "@botiverse/porthole/server";

const APP = "http://localhost:8790";
export const pageConfig = (source) =>
  presets.artifact({ layout: { kind: "fill" }, isolation: "domain", contentOrigins: [source] });

const content = createContentHost({
  domain: "content.localhost:8790",                // "" turns content off
  appOrigins: [APP],
  secret: process.env.PORTHOLE_SECRET,              // npx porthole secret
  tickets: memoryTicketStore(),                     // one process; d1TicketStore(env.DB) on Workers
  configs: (source) => ({ artifact: pageConfig(source) }),
  name: prefixedName("a-"),                         // page "abc" is served on a-abc.<domain>
  instance: (proposal) => myInstance(proposal),     // what a frame request asks for, as you mean it
  access: async (instance, viewer) => ((await mayView(viewer, instance)) ? { viewer: viewer.id } : null),
  source: (id, version) => myStore.page(id, version), // { html } | null
  entry: {                                          // clean addresses: a-abc.<domain>/ in a new tab
    authorizeUrl: `${APP}/porthole/authorize`,
    at: (scope, path) => instanceAt(scope, path),   // null: nothing there (404)
    signIn: (returnTo) => Response.redirect(`${APP}/login?next=${encodeURIComponent(returnTo)}`, 303),
  },
});
```

- **`configs`' keys** are the preset names a stored page names: an artifact page names
  `artifact` unless its `document.preset` says otherwise, so key it `artifact`.
- **`instance`** gets the client's proposal (`{ scope, document }`) and returns the instance as
  your app means it, or null. Derive the scope (the origin) from what it names: the client never
  chooses an origin.
- **`access`** returns a grant (`{ viewer }`, or `{ anonymous: true }` for a public page) or null.
  `authorize` (optional) checks again on every request after, for revocation.
- **`Response.redirect` needs an absolute URL** outside a browser (Node throws on `/login`).
- **`reserved`** is only for labels your app itself serves on the content domain (previews of a
  dev server, `p-*`). Labels nothing serves need nothing: they are a 404 there.

Routes: the content domain first, then your app.

```js
// Node (node:http)
import { nodeHost, nodeProbe, toRequest, sendResponse } from "@botiverse/porthole/node";
const porthole = nodeHost(content, { request: (req, res) => app(toRequest(req, "http")).then((r) => sendResponse(res, r)) });
http.createServer(porthole.request).on("upgrade", porthole.upgrade).listen(8790, () => content.start());

// Any fetch-style runtime (Workers, Hono, Bun, Deno)
const answer = (await content.fetch(request)) ?? (await app(request));

// Your app's routes
"/api/frames"          → content.issue(viewerOf)(request)     // POST { instance } → 201 { url, origin }
"/porthole/authorize"  → content.authorize(viewerOf)(request) // GET, for clean addresses
"/api/meta"            → content.meta()                        // { served, contentSource, health }
```

`viewerOf(request)` is your app's own: who is signed in, from its cookie, or null.

### The page

```html
<script type="module" nonce="…">
  // A client module that fails to load shows nothing at all: say so.
  import("@botiverse/porthole").then(async ({ createHost, httpLocator }) => {
    const meta = await (await fetch("/api/meta")).json();
    const host = createHost(meta.served ? servedConfig(meta.contentSource) : opaqueConfig, {
      locator: httpLocator("/api/frames"),
    });
    const display = host.mount(box, {
      displayId: id, title, scheme: "light",
      instance: { scope: id, document: { kind: "artifact", id, version } },
    });
    display.on("outcome", (outcome) => { if (outcome.state !== "loaded") offerNewTab(); });
  }, (error) => showProblem(`Porthole didn't load: ${error.message}`));
</script>
```

- `servedOrOpaque(meta, servedConfigs, opaqueConfigs)` picks the configs and says nothing until
  meta is known, so a frame never starts opaque and then restarts served.
- "Open in a new tab" and "Copy link" use `content.urlOf(scope, path)`, the clean address, never a
  ticket URL. Pass it to the page from the server.
- `outcome` says how the frame loaded: `blocked` with a `reason` (`cookies`: the browser keeps no
  cookie in a frame, as Safari; `sign-in`; `denied`; `session`) is your cue to offer a new tab.

### The page's CSP

- `frame-src`: `content.frameSources` (the content origins, and the authorize route).
  `embedderCsp(configs)` gives the same as a directive, from configs alone.
- **An opaque display inherits your page's CSP.** Its own policy then narrows it, never widens it.
  If your page sets `default-src`, also allow what agent content uses inline:
  `img-src data: blob:`, `media-src data: blob:`, `font-src data:`, `style-src 'unsafe-inline'`,
  `worker-src blob:`. A nonce-based `script-src` works: give `createHost` the nonce
  (`HostOptions.nonce`) and the shell runs content's scripts under it.
- **`form-action` holds every redirect of a submission.** If your sign-in page posts a form and
  then redirect entry continues to the content origin, a `form-action 'self'` blocks the last
  hop: leave it out there, or add the content source.

## 4. Cloudflare Workers

```js
import { d1TicketStore } from "@botiverse/porthole/server";
let app = null;
export default {
  async fetch(request, env) {
    app ??= makeApp({ ...settingsFrom(env), tickets: d1TicketStore(env.DB) }); // once per isolate
    return (await app.content.fetch(request)) ?? app.handle(request);
  },
};
```

- **Tickets in D1** (never KV, which is eventually consistent):
  `npx porthole d1-schema > migrations/0001_porthole_tickets.sql`, then
  `wrangler d1 migrations apply <db>`.
- **One secret, `PORTHOLE_SECRET`:** `npx porthole secret`, then `wrangler secret put
  PORTHOLE_SECRET` (`.dev.vars` locally). At least 32 bytes; it signs tickets, cookies and
  entry codes.
- **Static assets:** set `"assets": { "run_worker_first": true }`. Otherwise Workers serves your
  static files before the Worker runs, on every host, content origins included.
- No `nodejs_compat` needed. `wrangler dev` passes the Host through, so
  `*.content.localhost:<port>` works locally.

## 5. The agent's side

- `compile(config).toolDescription()` is your show tool's description; `compile(config).guide()`
  the manual (topics: `widget`, `interactive`, `chart`, and yours). Set `guide.toolName` and
  `guide.guideToolName` so they name your tools.
- A tool definition, as an MCP server lists it:

  ```js
  { name: "show_page", description: compiled.toolDescription(),
    inputSchema: { type: "object", required: ["title", "html"],
      properties: { title: { type: "string" }, html: { type: "string", description: "The whole HTML document" } } } }
  ```

- **Fill:** a whole-page viewer says `layout: { kind: "fill" }` in its config. The frame then fills
  its box, and the manual tells the agent so (the page scrolls itself; `position: fixed` works).
  `MountOptions.fill` and `<PortholeFrame fill>` are deprecated: they size the frame but leave the
  manual saying the height follows the content.
- `errors: "agent"` sends what content throws (and what the sandbox blocks) back to the agent:
  listen for `contentError` and pass it on.

## 6. Conformance: prove your integration

`@botiverse/porthole/conformance` runs Porthole's suite (egress and escape probes, the served
cases, redirect entry) against your app's real page, its CSP and session, in Playwright:

```js
// playwright.config.mjs
import { defineConfig, devices } from "@playwright/test";
import { conformanceProjects } from "@botiverse/porthole/conformance";
export default defineConfig({ projects: conformanceProjects(devices), webServer: { … } });

// porthole.spec.mjs
import { test } from "@playwright/test";
import { defineHostConformance } from "@botiverse/porthole/conformance";
defineHostConformance(test, {
  name: "my-app",
  open: async (page) => { /* sign in, open the page that shows content */ },
  issue: { url: "/api/frames" },
  config: () => pageConfig("http://*.content.localhost:8790"),
  instances: { artifact: (scope, version) => ({ scope, document: { kind: "artifact", id: "conformance", version } }) },
  entry: { url: (scope) => `http://a-t-${scope}.content.localhost:8790/v/1`, unknown: "derive" },
});
```

What the runner asks of your app, and what it skips without:

| Option | It needs | Without it |
| --- | --- | --- |
| `instances.artifact(scope, version)` | versions `"1"` and `"2"` of one stored page on `scope`'s origin, each exactly `conformancePage(version)` | the stored-page case |
| `instances.shell(scope)` | a served shell | the domain cases run on `artifact(scope, "1")` |
| `instances.app`, `.proxy` | a url-mode app, the MCP Apps proxy | their cases |
| `entry.url(scope)` | the clean address of `artifact(scope, "1")` | the redirect entry cases |
| `entry.denied`, `atSignIn`, `completeSignIn` | a page the viewer may not see; your sign-in page | that case; the sign-in is judged by leaving the content origin, and not completed |
| `entry.unknown` | addresses that name nothing, or `"derive"` | that case |

The suite names its own scopes, so an app serves them through a **test mode**
(`examples/app.mjs`: `PORTHOLE_CONFORMANCE=1`): the test page under `t-<scope>`, and a private
page. **Never ship test mode**: with it, anyone signed in can make content origins of their
choosing. `onDemand(make)` memoizes fixtures made the first time a case asks (a page published
on demand); `instances` and `entry.url` may be async.

The leak probes run opaque displays on your page: where its own CSP closes what a probe needs,
the probe reports itself inapplicable, saying which directive. Those are facts about your page's
opaque fallback, not failures.

## 7. Expected, and how to tell

- Chromium logs `Unrecognized Content-Security-Policy directive 'webrtc'` for every frame: the
  directive closes WebRTC where an engine knows it, and is ignored where it doesn't.
- Content's CSP allows `'unsafe-eval'`. Content is the agent's own script already
  (`'unsafe-inline'`), so eval adds no capability, and libraries content uses compile with it
  (Vue's in-browser build, Alpine.js, Vega's expressions, WebAssembly). Egress, the sandbox and the
  origin are what isolate it (P071).
- On `http` loopback the session cookies are `porthole-<key>`; on `https`, `__Host-porthole-<key>`.
- A clean address that names nothing (a label the naming never makes, the bare domain, a path
  `entry.at` says has nothing) is a 404 on the content domain: it never reaches your sign-in.
- Host errors name the content origin and leave out ticket URLs.

## 8. Reference

| Import | What |
| --- | --- |
| `@botiverse/porthole` | `createHost`, `presets`, `compile`, `embedderCsp`, `httpLocator`, `servedOrOpaque` |
| `@botiverse/porthole/react` | `PortholeProvider`, `PortholeFrame` |
| `@botiverse/porthole/server` | `createContentHost`, `prefixedName`, `memoryTicketStore`, `d1TicketStore`, `contentDomain`, `conformancePage`, the callbacks' types |
| `@botiverse/porthole/node` | `nodeHost`, `nodeProbe`, `toRequest`, `sendResponse` |
| `@botiverse/porthole/mcp` | the MCP Apps adapter (views, the sandbox proxy) |
| `@botiverse/porthole/conformance` | `defineHostConformance`, `conformanceProjects`, `onDemand`, `conformancePage` |

The types' doc comments are the precise reference; DESIGN.md § "The host kit" is the long form.
