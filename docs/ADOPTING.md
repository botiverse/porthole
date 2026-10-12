# Adopting Porthole

How to put Porthole in an app, from the npm package alone. The package's `examples/` is a whole
app that does everything below: `examples/app.mjs` is the app, runtime-agnostic;
`examples/node/server.mjs` and `examples/workers/` run it; `examples/mcp/server.mjs` gives the
agent its tools. DESIGN.md says how it works and DECISIONS.md why (the P-numbers the code cites).

## 1. Choose how content is shown

| | Opaque | Served |
| --- | --- | --- |
| Where it runs | A sandboxed frame in your page, origin `null` | A frame on an origin of its own (`a-<id>.example-usercontent.com`) |
| Server side | None | The host kit (`createContentHost`) |
| Storage, clean address, open in a tab | No | Yes |
| Typical | Widgets in a conversation | Stored pages, artifacts, a viewer |

Start opaque if you can; add served pages when content needs storage or an address. A served app
keeps the opaque config as its fallback for when the content domain is down.

## 2. Say your display kinds once

```js
// displays.mjs: imported by the server, the page and the agent's tools
import { defineDisplays } from "@botiverse/porthole";

export const displays = defineDisplays({
  widget: { preset: "inlineWidget", options: { capabilities: { sendPrompt: {}, copyText: {} } } },
  artifact: { preset: "artifact", options: { layout: { kind: "fill" } } }, // a whole-page viewer
  preview: { preset: "url" },                                            // a running app: served only
});
```

`displays.opaque(kind)`, `displays.served(contentSource)`, `displays.configFor(instance, source)`,
`displays.frameSources(source, { authorizeUrl })` (a CSP built without a server: a dev server, a
desktop shell) and `displays.guideConfig(kind, "served" | "opaque")` (the agent's manual) all come
from it. A kind's name is the preset name its documents carry: a stored page names `artifact`
unless its `document.preset` says otherwise.

**Fill:** a whole-page viewer says `layout: { kind: "fill" }`. The frame fills its box, and the
manual tells the agent so (the page scrolls itself; `position: fixed` works). `MountOptions.fill`
and `<PortholeFrame fill>` are deprecated: they size the frame but leave the manual saying the
height follows the content.

## 3. Opaque displays: the page only

```js
import { createHost } from "@botiverse/porthole";

const host = createHost(displays.opaque("widget"), {
  handlers: { sendPrompt: ({ text }) => send(text) },
  // A gated call asks the person first, with the call's whole effect.
  confirm: async (request) => window.confirm(`${request.capability}: ${JSON.stringify(request.args)}?`),
});
const display = host.mount(box, { displayId: "w1", title: "A chart", scheme: "light" });
display.setContent(agentHtml, { partial: true }); // while it streams: drawn inert
display.setContent(agentHtml);                    // once whole: it runs, once
display.on("contentError", ({ message }) => tellTheAgent(message));
```

React: `<PortholeProvider>` near the root; `<PortholeFrame config displayId title content partial />`
per display. The provider takes what every frame shares: `scheme`, `theme` (and `themeKey`;
`cssVariableTheme(tokens)` reads the values from your page's CSS variables), `nonce` (`"auto"`
reads the page's), `handlers`, `openLink` (default: a new tab), `notify` (your own toast for what
a copy button copied), and `renderConfirm` (your own dialog: Porthole keeps the queue, runs your
yes inside its click, and counts declines). `useRunAgain()` gives a "run again" button.

## 4. Served pages: the host kit

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
import { createContentHost, prefixedName, memoryTicketStore } from "@botiverse/porthole/server";
import { displays } from "./displays.mjs";

const APP = "http://localhost:8790";
const content = createContentHost({
  domain: "content.localhost:8790",                 // "" turns content off
  appOrigins: [APP],
  secret: process.env.PORTHOLE_SECRET,              // npx porthole secret
  tickets: memoryTicketStore(),                     // one process; d1TicketStore(env.DB) on Workers
  displays,
  name: prefixedName("a-"),                         // page "abc" is served on a-abc.<domain>
  instance: (proposal) => myInstance(proposal),     // what a frame request asks for, as you mean it
  access: async (instance, viewer) => ((await mayView(viewer, instance)) ? { viewer: viewer.id } : null),
  source: (id, version) => myStore.page(id, version), // { html } | null
  entry: {                                          // clean addresses: a-abc.<domain>/ in a new tab
    at: (scope, path) => instanceAt(scope, path),   // null: nothing there (a 404 on the content domain)
    pathOf: (instance) => pathOf(instance),         // the reverse: frames come with their link
    signIn: (returnTo) => Response.redirect(`${APP}/login?next=${encodeURIComponent(returnTo)}`, 303),
  },
});

// One mount, under /porthole: POST frames, GET authorize, GET meta, POST/DELETE handoff.
const routes = content.routes(viewerOf);
// Every request: the content domain first, then Porthole's routes, then your app.
const answer = (await content.fetch(request)) ?? (await routes(request)) ?? (await app(request));
```

- **`instance`** gets the client's proposal (`{ scope, document }`) and returns the instance as
  your app means it, or null. Derive the scope (the origin) from what it names: the client never
  chooses an origin. **`access`** returns a grant (`{ viewer }`, or `{ anonymous: true }` for a
  public page) or null; `authorize` (optional) checks again on every request after, and
  `content.forget({ scope, subject })` drops its cached answers when you revoke.
- **`viewerOf(request)`** is your app's own: who is signed in, from its cookie or token, or null.
- **`Response.redirect` needs an absolute URL** outside a browser (Node throws on `/login`).
- **`reserved`** is only for labels your app itself serves on the content domain (previews of a
  dev server, `p-*`). Labels nothing serves need nothing: they are a 404 there.
- **Node:** `nodeServer({ content, app: (request) => answer(request) }).listen(8790)` is the whole
  server, WebSockets included, the health gate started on listen. **Workers:**
  `contentHostFor((env) => options)` makes one host per `env`, and answers a plain 503 naming the
  problem when the settings can't be served.
- **Health:** `health: { probe: nodeProbe(), onServedChange: (served) => … }` checks the content
  domain over the real network and falls back to opaque frames while it doesn't answer.

### The page

```js
import { createHost, frameFallback, portholeClient } from "@botiverse/porthole";
import { displays } from "./displays.mjs";

const porthole = portholeClient({ displays });       // the server's /porthole routes
const meta = await porthole.refresh();               // { served, contentSource, frameSources }
const display = createHost(porthole.config("artifact"), { locator: porthole })
  .mount(box, { displayId: id, title, scheme: "light", ...(meta?.served ? { instance } : {}) });
if (!meta?.served) display.setContent(opaqueCopy);   // frames not served now: the page, opaque
display.on("outcome", (outcome) => {
  const fallback = frameFallback(outcome);           // null when it loaded
  if (fallback !== null) offer(fallback.title, fallback.message);  // "Open this in a new tab", …
});
openButton.onclick = () => porthole.openInTab(instance);           // the clean address
```

`porthole.config(kind)` is the served config while frames are served, the opaque one while they
aren't, and null until the meta is known, so a frame never starts opaque and then restarts
served. A client module that fails to load shows nothing at all: catch its import and say so
(`examples/app.mjs` does).

React: give the provider the client, and show a kind:

```jsx
<PortholeProvider client={porthole} scheme={mode} theme={cssVariableTheme(TOKENS)} nonce="auto">
  <PortholeView display="artifact" instance={instance} content={opaqueCopy}
    fallback={({ title, message, link, retry }) => <Fallback {...{ title, message, link, retry }} />} />
</PortholeProvider>
// const { link, open, copy } = usePortholeLink(instance);   "Open in a new tab", "Copy link"
```

### The page's CSP

- `frame-src`: `content.frameSources` (the content origins, and the authorize route), also in
  `GET /porthole/meta`; `displays.frameSources(source, { authorizeUrl })` without a server.
- **An opaque display inherits your page's CSP.** Its own policy then narrows it, never widens it.
  If your page sets `default-src`, also allow what agent content uses inline:
  `img-src data: blob:`, `media-src data: blob:`, `font-src data:`, `style-src 'unsafe-inline'`,
  `worker-src blob:`. A nonce-based `script-src` works: give `createHost` the nonce
  (`HostOptions.nonce`) and the shell runs content's scripts under it.

### Sign-in

- Your sign-in page gets the authorize URL as `next`, and goes back to it when signed in. Check
  it with `entryTarget(next, authorizeUrl)` (or `porthole.entryTarget(next)`): only your own
  authorize route, never another site.
- **Warning: no `form-action 'self'` on a sign-in page that posts a form.** `form-action` holds
  every redirect of a submission, and redirect entry continues from your sign-in through the
  content origin, so the browser blocks the last hop and the person stays on your sign-in. Leave
  `form-action` out of that page's CSP, or add the content source.
- **A page that authenticates with a token** (a single-page app holding a bearer token, a desktop
  app) has no cookie for the authorize route to know the viewer by. Use the viewer handoff:
  `entry.handoff: { id: (viewer) => viewer.id, viewer: (id) => lookUp(id) }` on the server, and
  `portholeClient({ displays, headers: () => ({ authorization: `Bearer ${token()}` }), handoff: true })`
  on the page. It posts to `/porthole/handoff` with your own credential, on load and when the
  page regains focus; Porthole answers with a cookie that holds a key it signs (the viewer's id
  and ten minutes), `HttpOnly`, scoped to `/porthole`. That beats storing the app's token in a
  cookie: the key isn't a credential for your API, goes nowhere but Porthole's routes, can't be
  set from another site (the POST needs your credential, and is refused from another origin), and
  expires in ten minutes (an expired one costs only a quiet trip through your sign-in route).
  `entry.spa: { route: "/sign-in" }` sends a signed-out person to your app's route with `next`.

### Url mode: a relay of your own

`proxyTo` relays a url-mode app by HTTP. A relay of your own (over your own transport) uses the
same parts: `upstreamHeaders.request(headers, { origin, target, websocket })` and
`.response(...)` (the header rewrite, Porthole's cookies kept out), `statusPage({ status, title,
detail, reason, hostOrigins })` (a page that tells the frame's host why it shows nothing, desktop
schemes included), and `nodeHost`'s `appSocket` (a WebSocket, Porthole's cookies already removed).

## 5. Cloudflare Workers

```js
import { contentHostFor, d1TicketStore } from "@botiverse/porthole/server";

const porthole = contentHostFor((env) => ({ domain: env.CONTENT_DOMAIN, appOrigins: [env.APP_ORIGIN],
  secret: env.PORTHOLE_SECRET, tickets: d1TicketStore(env.DB), displays, /* your policy */ }));
export default {
  async fetch(request, env) {
    return (await porthole.fetch(request, env)) ??
      (await porthole.routes(request, env, viewerOf)) ?? app.fetch(request, env);
  },
};
```

- **Tickets in D1** (never KV, which is eventually consistent):
  `npx porthole d1-schema > migrations/0001_porthole_tickets.sql`, then
  `wrangler d1 migrations apply <db>`.
- **One secret, `PORTHOLE_SECRET`:** `npx porthole secret`, then `wrangler secret put
  PORTHOLE_SECRET` (`.dev.vars` locally). At least 32 bytes; it signs tickets, cookies, entry
  codes and handoffs.
- **Static assets:** set `"assets": { "run_worker_first": true }`. Otherwise Workers serves your
  static files before the Worker runs, on every host, content origins included.
- No `nodejs_compat` needed. `wrangler dev` passes the Host through, so
  `*.content.localhost:<port>` works locally.

## 6. The agent's side

### Its tools

```js
import { admitContent, answerGuide, checkTool, guideTool, showTool } from "@botiverse/porthole";

const config = displays.guideConfig("artifact", "served");
const tools = [showTool(config), guideTool(config), checkTool(config)]; // { name, description, inputSchema }
// show:  const admitted = admitContent(config, args.html);   // refuses only what certainly fails
//        admitted.ok ? show(admitted.content) + admitted.note : refuse(admitted.refusal)
// guide: answerGuide(config, args)                           // { text } or { error }
```

Names come from the config (`guide.toolName`, `guide.guideToolName`); the descriptions are the
manual's own words. `examples/mcp/server.mjs` wires all three as an MCP server.

- **`admitContent`** runs `lintContent` and refuses (by default, `refuseOn: "error"`) only what
  would certainly fail or be cut: over the size limit, a document with no body where a fragment
  goes, nested frames, `document.write`. Its refusal says exactly what to change. Everything else
  (hosts outside egress, unpinned libraries, `alert`, forms, the clipboard…) comes back as
  warnings with the result. `refuseOn: "never"` only warns.
- **`guideChanges(from, to)`** is the notice for the agent when a kind flips between served and
  opaque (null when its manual reads the same).
- **`errors: "agent"`** sends what content throws (and what the sandbox blocks) back to the agent
  once people see it: listen for `contentError` and pass it on.

### Checking a page before people see it

`checkPage` (`@botiverse/porthole/check`) runs the content in the real sandbox at the manual's
phone and desktop widths, in light and dark, and answers a report whose `text` is a few lines for
the agent: what it threw, what the sandbox blocked, what failed to load, `console.error`, overflow
and a cut height, each problem once with where it happened (at most 8; the rest counted).

```js
import { checkPage, playwrightDriver } from "@botiverse/porthole/check";
const report = await checkPage({ config, content: html, driver: playwrightDriver(browser) });
report.ok; report.text;
```

It needs a browser somewhere: Chromium is best (WebKit mutes a thrown error's message in an
opaque frame, so the agent reads only "Script error."). Where:

- **A server with Chromium** (Node): `playwrightDriver(await chromium.launch())`.
- **An agent on a person's machine, maybe without Chromium** (Ferry's daemon): run
  `lintContent` there (no browser needed), and send `check_page` to your server, which runs
  `checkPage`; or use Playwright where it is installed (`examples/mcp/server.mjs` falls back to
  the lint, saying so).
- **Cloudflare Workers:** Browser Rendering, through a CDP session:

  ```js
  import puppeteer from "@cloudflare/puppeteer";
  import { cdpDriver, checkPage } from "@botiverse/porthole/check";
  import page from "@botiverse/porthole/check/page";   // the check page's script, bundled
  const browser = await puppeteer.launch(env.BROWSER);
  const tab = await browser.newPage();
  const report = await checkPage({ config, content, page, driver: cdpDriver(() => tab.createCDPSession()) });
  await browser.close();
  ```

## 7. Conformance: prove your integration

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
  issue: { url: "/porthole/frames" },
  displays, contentSource: "http://*.content.localhost:8790",
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
on demand); `instances` and `entry.url` may be async. The tests are located at your
`defineHostConformance` call, so `playwright test porthole.spec.mjs` selects them.

The leak probes run opaque displays on your page: where its own CSP closes what a probe needs,
the probe reports itself inapplicable, saying which directive. Those are facts about your page's
opaque fallback, not failures.

## 8. Expected, and how to tell

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

## 9. Reference

| Import | What |
| --- | --- |
| `@botiverse/porthole` | `createHost`, `presets`, `defineDisplays`, `portholeClient`, `frameFallback`, `entryTarget`, `lintContent`, `admitContent`, `showTool`, `guideTool`, `checkTool`, `answerGuide`, `guideChanges`, `compile` |
| `@botiverse/porthole/react` | `PortholeProvider`, `PortholeFrame`, `PortholeView`, `usePortholeLink`, `cssVariableTheme`, `useRunAgain` |
| `@botiverse/porthole/server` | `createContentHost` (`routes`, `forget`), `contentHostFor`, `prefixedName`, `memoryTicketStore`, `d1TicketStore`, `upstreamHeaders`, `statusPage`, `conformancePage`, the callbacks' types |
| `@botiverse/porthole/node` | `nodeServer`, `nodeHost`, `nodeProbe`, `toRequest`, `sendResponse` |
| `@botiverse/porthole/check` | `checkPage`, `playwrightDriver`, `cdpDriver`; `/check/page`, the check page's script |
| `@botiverse/porthole/mcp` | the MCP Apps adapter (views, the sandbox proxy) |
| `@botiverse/porthole/conformance` | `defineHostConformance`, `conformanceProjects`, `onDemand`, `conformancePage` |

The types' doc comments are the precise reference; DESIGN.md § "The host kit" is the long form.
