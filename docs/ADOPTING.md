# Adopting Porthole

How to put Porthole in an app, from the npm package alone. The package's `examples/` is a whole
app that does everything below: `examples/app.mjs` is the app, runtime-agnostic;
`examples/node/server.mjs` (`nodeServer`) and `examples/workers/` (`contentHostFor`) run it, as
§4 and §5 recommend; `examples/mcp/server.mjs` gives the
agent its tools. DESIGN.md says how it works and DECISIONS.md why (the P-numbers the code cites).
[THREAT_MODEL.md](THREAT_MODEL.md) says, for each use (chat widgets, live data, private and public
pages, MCP Apps, previews, several displays on one page), what Porthole guarantees, what you must
do, and what isn't covered: read your use's section before you show content that matters.

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

### Choosing egress

Egress is what content may load and send out: scripts, styles, fonts, images, audio and video, and
data (fetch, WebSocket). Every preset starts closed, and a kind opens more only through its
`options.egress`. There are three levels, and Porthole's own libraries for served content:

| Level | Config (`options`) | What it opens | The risk it re-opens | Typical host | The agent's manual says | Why | Tested by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Closed** (the default) | nothing to write | Nothing from outside the frame: content runs on what it carries (inline code, `data:` and `blob:` URLs). | None. | Widgets that draw their own SVG and CSS; any host that hasn't decided yet. | `Network: none. Nothing loads from outside` (and `write everything inline`) | [P006](DECISIONS.md#p006--2026-10-11--egress-is-closed-by-default-including-channels-a-frame-csp-doesnt-cover--accepted), [P022](DECISIONS.md#p022--2026-10-11--every-preset-starts-with-egress-closed-library-cdns-are-a-one-line-opt-in--accepted-amended-by-p082-p089) | probes `1.connect`, `2.resources`, `3.webrtc`, `4.*` (nested frames), `5.*` (navigating out), `8.*` (resource hints), `10.self`; served `served.domain.egress` |
| **Library CDNs** (`LIBRARY_CDNS`, plus script hosts of your own) | `egress: LIBRARY_CDNS`; more script hosts: `egress: { ...LIBRARY_CDNS, script: [...LIBRARY_CDNS.script, "https://cdn.example.com"] }` | Scripts, styles, fonts, images and data from cdnjs, jsDelivr, unpkg and esm.sh; Google Fonts; scripts only from three libraries' own CDNs (Tailwind's Play CDN, jQuery, Plotly). Nothing else. | Code you don't control runs in the frame (a compromised or look-alike package), still inside the sandbox and egress; and a path requested from a CDN is a narrow channel out, read by the CDN's operator. The manual tells agents to pin versions. | Ferry's widgets, Raft Artifacts' pages: agents load Chart.js, ECharts, d3, Mermaid, Tailwind, jQuery, Plotly. | `scripts, styles, fonts, images and data (fetch, WebSocket) from https://cdnjs.cloudflare.com` …, `scripts from https://cdn.tailwindcss.com, https://code.jquery.com, https://cdn.plot.ly` and `pin an exact version` | [P078](DECISIONS.md#p078--2026-10-13--library_cdns-adds-tailwinds-jquerys-and-plotlys-own-cdns-for-scripts-only--accepted), [P022](DECISIONS.md#p022--2026-10-11--every-preset-starts-with-egress-closed-library-cdns-are-a-one-line-opt-in--accepted-amended-by-p082-p089), [P048](DECISIONS.md#p048--2026-10-11--artifact-pages-reach-library-cdns-only-by-the-hosts-config--accepted) | `leak/cdn.spec.ts` (a CDN library loads only when the config opens it, opaque and served; another origin never; the libraries' own CDNs serve scripts and nothing else); probes `1.connect`, `2.resources` (an allowed origin loads, no other does) |
| **Passive from any https site** (`anyHttps`, on top of either) | `egress: { ...LIBRARY_CDNS, anyHttps: ["img"] }`; closed but for them: `egress: { anyHttps: ["img"] }` | The passive kinds you name (`img`, `media`, `font`) from any https site. Never scripts, styles, data, workers or frames, and never `http:`: a config naming another kind is refused. | Any site an image names learns that someone viewed the content, and from which address; content can send data out in an image URL to a server of its choosing (the channel P006 closes); whoever owns an image controls what it shows, inside the frame. | A host showing content that already exists, with hotlinked media: Raft's HTML attachment previews, reports whose `<img>` point at other sites (the case P059 was written for). | `images from any https site` (`fonts, images, audio and video from any https site` for all three) | [P059](DECISIONS.md#p059--2026-10-11--passive-content-may-load-from-any-https-site-by-the-hosts-explicit-choice--accepted), [P062](DECISIONS.md#p062--2026-10-11--serveddomainegress-holds-a-host-to-its-own-configs-egress--accepted) | `leak/cdn.spec.ts` (a hotlinked image loads; a script, a stylesheet and a fetch to the same site never reach it; without the flag, nothing does); served `served.domain.egress` (the image must reach an https canary; scripts, styles, fetches and frames never), `leak/served/any-https.spec.ts` |
| **Porthole's libraries** (`egress.libraries`, served kinds only; on in `presets.liveWidget`) | `egress: { libraries: true }` with `isolation: "domain"` | Chart.js 4.5.1 and D3 7.9.0 as scripts, from the frame's own origin (`/__porthole/lib/…`, served by `/server` on every content origin). Nothing from outside. | None from outside: the requests reach your content server, which serves fixed, pinned files. | Live widgets, which read your data and must have no network of their own (P079). | `Libraries, served from this frame's own address` with a `<script>` line for each | [P079](DECISIONS.md#p079--2026-10-15--live-widgets-no-network-of-their-own-portholes-libraries-on-their-origin-the-hosts-data-behind-the-viewers-consent-and-frames-that-never-navigate-away--accepted-amended-by-p084-p094-p103) | `test/libraries.test.ts`; `leak/served/live.spec.ts` (they load and draw; an external script, a stylesheet, an image and every fetch reach no oracle) |

How to decide: **start closed; add `LIBRARY_CDNS` if agents use libraries; add passive `anyHttps`
only for existing content with hotlinks**, and only the kinds it hotlinks (usually `img`). An
agent writing new content can inline what it shows, so agent-made pages never need `anyHttps`.

```js
import { defineDisplays, LIBRARY_CDNS } from "@botiverse/porthole";

export const displays = defineDisplays({
  // Closed: nothing to write.
  widget: { preset: "inlineWidget" },
  // Library CDNs (and, if you need one, a script host of your own).
  artifact: { preset: "artifact", options: { egress: { ...LIBRARY_CDNS, script: [...(LIBRARY_CDNS.script ?? []), "https://cdn.example.com"] } } },
  // Existing pages with hotlinked images: Library CDNs, and images from any https site.
  attachment: { preset: "artifact", options: { egress: { ...LIBRARY_CDNS, anyHttps: ["img"] } } },
});
```

- Each kind's documents name it as their preset (`document.preset: "attachment"`); `egress` is
  the kind's whole policy, so kinds that differ in egress are kinds of their own.
- The libraries' own CDNs serve scripts only (P078). Plotly's maps fetch their shapes from
  `cdn.plot.ly`, which stays closed, so the manual gives agents the copy on jsDelivr
  (`topojsonURL`); Tailwind's Play CDN builds its CSS in the page and needs nothing more.
- Origins are exact (`https://cdn.example.com`), or `https://*.` a domain of your own; a wildcard
  over a public suffix (`*.com`, `*.github.io`) is refused.
- An opaque frame also inherits your page's CSP ([P058](DECISIONS.md#p058--2026-10-11--an-opaque-frame-is-as-closed-as-its-page-the-suite-says-when-a-case-cant-be-observed--accepted)): where your page closes images or
  fetches, opaque content is that closed whatever its egress opens (see "The page's CSP"). A
  served frame has only its own policy.
- `checkPage` and `lintContent` tell the agent when its content reaches past the kind's egress, by
  directive. The manual names exactly the origins the CSP allows (`test/agreement.test.ts`), and
  DESIGN.md § "Egress hardening, each with its test" is the long form.

### Live widgets: content that reads your data

A live widget shows your data, current, read as the person viewing it, with no network of its own
([P079](DECISIONS.md#p079--2026-10-15--live-widgets-no-network-of-their-own-portholes-libraries-on-their-origin-the-hosts-data-behind-the-viewers-consent-and-frames-that-never-navigate-away--accepted-amended-by-p084-p094-p103)).
Its only way out is your host: `readData` (MCP `resources/read`) and `subscribeData` (MCP
`resources/subscribe`, `resources/unsubscribe`, `notifications/resources/updated`). No option opens
its network: `presets.liveWidget` refuses `egress`, and a capability's own `connect` or `resource`
origins (a `ConfigError` naming the option, P103); a display that needs an origin is another kind.

```js
import { defineDisplays, Refused } from "@botiverse/porthole";

export const displays = defineDisplays({
  // No egress option exists for it; served, it loads Porthole's Chart.js and D3 from its origin.
  tile: { preset: "liveWidget", options: { capabilities: { openLink: {} } } },
});

createHost(displays.configFor(instance, contentSource), {
  locator,
  handlers: {
    // As the viewer: your own access rules, never the author's. Return MCP's read result; refuse
    // what you don't serve with a Refused, whose code and sentence the widget shows (P080).
    readData: async ({ uri }, { displayId }) => {
      if (!servedUri(uri)) throw new Refused("not_allowed", "This widget can read issues only.");
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(await load(uri)) }],
      };
    },
    // Call changed() when it changes (the content reads it again), or changed(result) to send it:
    // the content's read of it then passes readData's gates, and counts against its rate (P094).
    subscribeData: ({ uri }, { changed, signal }) => {
      const stop = realtime.on(uri, () => changed());
      signal.addEventListener("abort", stop);
    },
  },
  // Asked once per display, before its first data call: may this widget read this viewer's data?
  // Remember the answer per viewer and widget; a no refuses every data call (`denied`).
  consent: async ({ display }) => allowedBefore(display) ?? (await askTheViewer(display)),
  // Optional: your last copy, shown at once (stale), then the fresh read.
  cached: ({ uri }) => lastCopy(uri),
});
```

- **Your handlers decide what a URI may name.** Answer only the resources you mean widgets to read
  (a whitelist of URI shapes), with the viewer's rights. The content's URI is its word.
- **Consent is your UI.** Without a `consent` function every data call is refused (fail closed).
  React: `PortholeProvider` and `PortholeFrame` take `consent` and `cached`. A consent function
  that throws a `Refused` gives that answer, kept like `false`; anything else it throws is no
  answer yet (the next call asks again).
- **A page where data must not run** (beside a frame that reaches the network, below): pass a
  `Refused` as `consent` and no data handlers. Every data call is refused with it, nothing is asked,
  and the widget shows your sentence:

  ```js
  createHost(displays.configFor(instance, contentSource), {
    locator,
    consent: new Refused("not_allowed", "Live data shows on the dashboard."),
  });
  ```

  Any other capability you declare still needs its handler.
- **Refusals tell the widget why** (P080). A refused call's JSON-RPC error carries
  `data: { code, message }`; the shell's `readData` rejects (and `subscribeData`'s `onError` is
  called) with an `Error` whose `code` and `message` are those. `code` is `consent_required` (no
  answer yet), `denied` (the viewer said no), `rate_limited`, `not_allowed` (not here, or not this
  URI) or `failed` (your handler threw); `message` is your `Refused`'s sentence, else Porthole's.
  The manual tells the agent to draw the widget without the data, with that sentence. A handler's
  other errors are `failed` in Porthole's words: their messages stay yours.
- **Rates stay gates**: 120 reads and 60 subscriptions a minute per display by default; change them
  with the capability's `gates` (keep `"consent"` in the list). Every read counts, a read your
  `changed(result)` answers too (P094): a widget that follows a resource changing faster than
  twice a second needs a higher read rate.
- **Your page's CSP**: send `displays.embedderCsp(source, …)` (`frame-src` of your content origins
  and the authorize route, nothing else). It keeps a frame from navigating to an outside site; the
  shell keeps a served frame from navigating to another content origin (P079), and tells you:
  `display.on("navigationBlocked", ({ url }) => …)` (React `onNavigationBlocked`) gets the address
  whole, and `contentError` a sentence naming it without its query, for the agent (P080). Only
  where the config declares `reportError`, and only served frames: an opaque frame's navigations
  get no events (you hear `navigated` when one replaces its document).
- **Keep live widgets off pages with frames that reach the network.** A frame can `postMessage` any
  frame on its page, and nothing in it can stop that: a url-mode app (a dev server's preview) or an
  `anyHttps` display beside a live widget could be handed what it read. Displays with closed egress
  or `LIBRARY_CDNS` are fine beside it. The rule for any page: its egress is the union of its
  frames' ([THREAT_MODEL.md § S7](THREAT_MODEL.md#s7-several-displays-on-one-page)).
- **Opaque live widgets** (no content domain) work, without libraries: the manual tells the agent
  to draw with SVG and CSS. An opaque frame's only wall against navigating itself away is your
  page's `frame-src` (the shell's guard gets no events in an opaque origin), so show them on pages
  that frame no content origins (`frame-src 'none'`), which is what `defineDisplays` gives a page
  without a content domain.

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
a copy button copied), and `renderConfirm` (your own dialog, given `accept`, `decline` and
`redirect`: Porthole keeps the queue, runs `accept` inside its click, and counts declines toward
muting the display; `redirect`, for "edit it first", answers the call `"redirected"` and neither
counts nor resets the count). The request names the display (`request.display`: its `id`,
`title`, and the `instance` you gave the frame, served or opaque), so the dialog can say what it
is from your own records. It stays on your side: an opaque frame never gets the instance. `useRunAgain()` gives a "run again" button.

### Context for the agent (`setModelContext`)

A widget or an MCP Apps view may tell the agent what the person is looking at
(`ui/update-model-context`, the App SDK's `app.updateModelContext`). That is the content's text,
in your model's next turn, so by default the person is shown every update first (the `show` gate,
[P100](DECISIONS.md#p100--2026-10-19--what-content-tells-the-model-the-person-is-shown-first-the-show-gate-on-by-default-for-setmodelcontext--accepted)): pass `show`. It gets the whole update (`request.args`: text blocks and
structured content, at most `MAX_CONTEXT_CHARS` together) and the display, before your handler,
and draws it outside the frame: the latest per display, since each replaces the last. Without
`show` every update is refused (fail closed). React: `PortholeProvider` draws `ContextNotice`
unless you pass your own `show`.

```js
createHost(config, {
  handlers: { setModelContext: (update, { displayId }) => modelContext.set(displayId, update) },
  // Before the handler has it: the person sees what the agent will read.
  show: ({ args, display }) => composer.contextChip(display.id, display.title, args),
});
```

- **Give it to the model as the content's words** ("the view “Signups” says: …"), never as the
  person's message or as instructions. The manual tells the agent the same.
- **Send it with the person's next message** (MCP Apps lets a host defer it), so they have seen it
  before the model reads it. If your agent takes turns on its own, add `"confirm"` to the gates.
- **Opting out**: `setModelContext: { gates: [{ rateLimit: { perMinute: 30 } }], withoutShow: true }`
  names the gates without `show`, and says so on purpose. Do it only where your handler itself puts
  the text in front of the person (or the content is your own): otherwise the content writes into
  your model's turns unseen. Gates named without `show` and without `withoutShow` (a 0.7 config
  that set its own rate) earn a warning: Porthole logs nothing itself, so log
  `host.compiled.warnings` (or `compile(config).warnings`, `configWarnings(config)`) at startup.
- **What can't be seen is refused**: an update with an invisible character (zero-width ones, bidi
  controls, variation selectors, tag or private-use characters, controls other than new lines and
  tabs), in its text or any string of its structured content, never reaches `show` or your
  handler. Your own `show` resolves only once that very update is visible: if a later update of
  the display replaces it before it is drawn, reject, and it doesn't go.

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
import { nodeServer } from "@botiverse/porthole/node";
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
    pathOf: async (instance) => pathOf(instance),   // the reverse (may look it up): frames come with their link
    signIn: (returnTo) => Response.redirect(`${APP}/login?next=${encodeURIComponent(returnTo)}`, 303),
  },
});

// One mount, under /porthole: POST frames, GET authorize, GET meta, POST/DELETE handoff.
const routes = content.routes(viewerOf);
// The whole server: the content domain to Porthole, then Porthole's routes, then your app.
nodeServer({ content, app: async (request) => (await routes(request)) ?? app(request) }).listen(8790);
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
- **No content domain** (self-hosted without one): still make the host, with `domain: null` (or
  `""`). That is the supported setup: no secret is needed, `GET /porthole/meta` answers
  `{ served: false }`, and pages show every kind opaque (a url kind, its fallback) instead of
  waiting for a meta that never comes. Without a host, `portholeClient` stays pending.
- **`secret`** is at least 32 random bytes (`npx porthole secret`), from the environment
  (`PORTHOLE_SECRET`). A missing or short one throws at `createContentHost`, saying so (with
  `health`, frames stay opaque and the meta says why).
- **`nodeServer`** is the whole Node server: the content domain to Porthole, WebSockets included,
  every other request to `app` (fetch-style: Hono's `app.fetch`) or `request` (a Node listener:
  Express), the health gate started on listen and stopped on close. Behind a TLS edge, add
  `scheme: "https"`. A host that needs the port first (`listen(0)`) can come later: `content:
  () => host` (null until made); requests go to the app until it gives one. `nodeServer` starts
  the host it is given: a host made in a `listen` callback starts right after it, and one made
  later at the next request. `start()` runs once (a started host ignores it), so starting it
  yourself as soon as you make it is fine too.
- **`nodeHost(content, { request })`** is for an app that keeps its own `node:http` server (or a
  framework that owns one): put its `request` and `upgrade` listeners on your server, call
  `content.start()` once it listens and `content.close()` when it stops. A fetch-style app's
  listener there is `nodeListener(app, { scheme })`, not `toRequest` and `sendResponse` by hand:
  `toRequest` throws for a request fetch can't take (`TRACE`, a Host that is no URL), and a throw
  in a listener ends a Node process. `nodeListener`, `nodeHost` and `nodeServer` answer those 405
  and 400, and a handler or listener that fails 500 (P092). Pass `onError: (error, request) =>
  log.error(…)` to any of them to hear your own failures (by default a process warning).
- **Rate limit:** `rateLimit: { perMinute }` keys an anonymous viewer by the address the server
  saw (the socket's peer on Node, `CF-Connecting-IP` on Workers), never by `X-Forwarded-For` a
  client can write (P092). **Behind a proxy** (a TLS edge, a load balancer, a CDN), that address
  is the proxy's: say how many proxies append to `X-Forwarded-For` (`trustedProxies: 1` for one
  edge, `2` for a CDN in front of a balancer), or key it yourself (`key: (request, viewer) =>
  …`). Without either, anonymous requests through the proxy share one allowance. An IPv6
  address counts by its /64 (one client's network). Three cases to know:
  - **No peer address:** the Node adapter leaves the socket's peer on the request it makes. Where
    it is missing (Hono's own Node adapter, an app that rebuilds the request with
    `new Request(req)`, Deno or Bun), every anonymous request shares one allowance: set
    `rateLimit.key`.
  - **`trustedProxies` only where the app can't be reached except through those proxies:** a
    client that reaches it directly writes the very `X-Forwarded-For` entry that is counted.
  - **Uploads after the answer:** once an answer is out, a request body no one read is dropped
    for at most 1 MiB and 5 s, then the connection closes (P092). An app that answers early and
    keeps reading the upload (a handler that returns its Response before it has read the
    request's body) is cut off there.
- **Health:** `health: { probe: nodeProbe(), onServedChange: (served) => … }` checks the content
  domain over the real network and falls back to opaque frames while it doesn't answer.

### Pages made of many files

A stored version may be a set of files (a build's output, a report with its images; P081). The
store answers a manifest and the bytes by path; `{ html }` stays one page:

```js
import { checkFileSet, fileLimits, versionBase, versionedAddress } from "@botiverse/porthole/server";

// When a version is published: every path canonical, within your page kind's limits.
const problems = checkFileSet(manifest, { limits: fileLimits(pageConfig.limits) });  // [] to take it

source: async (id, version) => {
  const stored = await myStore.version(id, version);   // { files: { path: { size, sha256 } }, entry? }
  return stored.html !== undefined
    ? { html: stored.html }
    : { files: stored.files, entry: stored.entry, spa: stored.spa, read: (path) => myStore.bytes(stored.files[path].sha256) };
},
entry: {
  // "/" and "/<file>" are the latest, "/v/<n>/<file>" version n: answer the version's own address.
  at: async (scope, path) => {
    const at = versionedAddress(path);
    const version = at === null ? null : (at.version ?? (await latestOf(scope)));
    return version === null ? null : { instance: pageOf(scope, version), base: versionBase(version), file: at.file, pinned: true };
  },
  pathOf: (instance) => versionBase(instance.document.version),
},
```

- **Each file is served from the manifest only**, typed by its extension (Porthole's table, never
  the type it was published with), `nosniff`, with a CSP that opens the version's own path and
  nothing else of the origin (P082). Files are immutable at a version's address; pages revalidate
  (the host's check runs on every load). `read` returns the whole file (`Uint8Array` or a
  stream); Porthole cuts ranges.
- **A page never mixes versions.** The latest's address (`/`, `/style.css`) goes to the version's
  own (`/v/3/`, `/v/3/style.css`) before the page loads anything, so a version published while it
  loads never reaches it. Answer `entry.at` with the version's `base`, and `pinned: true` when that
  base names one version only (its files are then immutable); a plain instance is served at a
  frame's address instead. A base's segments are letters, digits and `. _ : ~ -`.
- **An artifact's versions share an origin**, so they are one trust domain (P082): give versions
  that must stay apart scopes of their own.
- **Each version is a directory of its origin** (`/v/<n>/`). `/_blob/` (`ASSET_LIBRARY_PATH`) is
  the asset library's, across versions (0.7, below); `versionedAddress` names nothing there.
- **In a frame**, the files' address carries the frame's access (WebKit keeps no cookie there,
  P083): the frame's URL is `/__porthole/f/<sealed>/`, good for the session. A host's
  `issue` and its locator don't change.
- **Every page of the set is in the shell**, and a set's pages open each other in the frame (P084).
  Service workers never register.
- **The agent's side:** `lintFiles` and `admitFiles` before you take a version, `checkPage({ files
  })` to run it, and the manual's Files section where a kind serves files. Show a set served: an
  opaque frame has no origin to serve its files from.

### The capability runtime: pages that are apps

0.7 (P085–P090). A page reaches your services through one global, `porthole.use(name)`, for what
it declared when it was published and what its viewer's level allows. Porthole carries, checks
and gates the calls; you keep the services. It is an optional layer over the display: what it adds
to your side (your API's checks, versions, revocation, each person's data) is in
[THREAT_MODEL.md § The display layer and the app runtime](THREAT_MODEL.md#7-the-display-layer-and-the-app-runtime).

```js
import { declareCapabilities, presets } from "@botiverse/porthole";

// 1. The kind's config offers the runtime and the host functions behind it.
const page = presets.artifact({
  isolation: "domain", contentOrigins: [source], runtime: "1",
  capabilities: { copyText: {}, openLink: {}, comments: {}, user: {}, artifact: {}, assets: {}, db: {} },
});

// 2. At publish: the artifact's declaration (omitted: carried forward; {}: cleared; an object: replaced).
const declared = declareCapabilities({ stored: artifact.declaration, given: body.capabilities, config: page });
if (!declared.ok) return problems(declared.problems);       // [{ path: "capabilities.db.rules", message }]
await myStore.saveDeclaration(artifact.id, declared.declaration); // { capabilities, runtime: "1" }

// 3. The viewer's level, in your access (the issue's answer carries it to the display's bridge).
access: async (instance, viewer) =>
  viewer && { viewer: viewer.id, level: await levelOf(viewer, instance), user: { id: viewer.publicId, name: viewer.name } },

// 4. Your services, as handlers (the page's calls arrive checked: declared, shaped, at level).
handlers: {
  db: (args, { viewer, declared, instance, changed, signal }) => myApi.db(instance, viewer, args, declared?.rules, { changed, signal }),
  artifact: (args, { viewer, instance }) => myApi.artifact(instance, viewer, args),   // Refused("conflict") when base moved
  assets: (args, { viewer, instance }) => myApi.assets(instance, viewer, args),
  comments: ({ anchor }) => composer.open(anchor),                                     // true if it opened
},
// 5. The mount: what this version declared, within what the artifact declares now; null for a
//    page published before 0.7 (required under a runtime). Before rendering: a stored
//    declaration that isn't one's shape is a problem to show, never a mount with null (0.6's
//    surface) or with either declaration alone (P093).
const shown = version.declaration ? tryIntersectDeclarations(version.declaration, artifact.declaration) : null;
if (shown && !shown.ok) return <VersionError problems={shown.problems} />;   // "This version can't be shown"
<PortholeView display="page" instance={instance} declaration={shown ? shown.declaration : null} />
```

- **Built-ins** (`clipboard`, `links`, `downloads`, `comments`) reach every page whose kind offers
  them; everything else only a page that declared it. A page with no declaration (one published
  before 0.7) gets the built-ins through `use` and 0.6's globals as before: give it a declaration
  when it is next published.
- **Levels**: `view < interact < admin < owner`. Reads are `view`; `chat.send`, `data.call`,
  `context.set` and db writes `interact`; `artifact.publish` and asset removal `admin`; uploads
  `admin` unless you set `assets: { levels: { upload: "interact" } }` (then scripts and styles from
  the library never run: P089). Raise any method in its config's `levels`. Without a viewer the
  runtime's own are refused.
- **Your API is the wall.** The bridge refuses early, in your page; your handlers call your API as
  the viewer, and it must check again, from its own session and its own stored declaration: never
  trust `context.viewer` or `context.declared` for what your data allows (a page past the bridge
  could forge them). `dbAccess(request, viewer, rules)` is the db rule set (another person's
  `data/users/<id>` refused, `me` resolved), `atLeast(level, "admin")` for a publish. Hold every
  write to an existing document to its `ifVersion` (updates and deletes too), apply a batch in
  order against one state, and refuse a moved base or version with `new Refused("conflict")`;
  check and admit the merged version as any (`checkFileSet`, `admitFiles`).
- **Per version**: store each version's declaration with it (`declareCapabilities` at its publish)
  and mount a version with `tryIntersectDeclarations(version's, current)` (`intersectDeclarations`
  throws its problems as a `TypeError`); your API's rules for that version are the same
  intersection's (whatever it allows, both declarations allow).
- **Rules hold in any case**: `dbAccess` holds `Votes/a` to its exact name's rule (else `*`'s)
  and to the rule for `votes` too (any rule naming it in another ASCII case), so a store that
  folds case is safe with it; paths reach your handler as the page wrote them (Porthole never
  lowercases them), and a publish that names a collection twice in different cases is refused.
- **Objects without a prototype**: checked declarations (`checkDeclaration`, `declareCapabilities`,
  the intersection) have none, so `.hasOwnProperty()` on one, or one in a template string,
  throws: use `Object.hasOwn` and `JSON.stringify`.
- **Who the page may know**: `Grant.user.id` is one path segment, never `me`; give
  `pseudonymFor(secret, artifact, person)` where pages shouldn't link a person across artifacts.
- **Assets**: `createContentHost({ assets: (id, access) => myStore.asset(id, access) })` answers
  `{ scope, artifact, name, size, sha256, trusted?, read }` for an id you made (32 random hex
  characters, `ASSET_ID`); `/server` serves it at `/_blob/<id>` on that scope's origin only, to an
  access for that artifact (a session, or a framed page's sealed address), after your check,
  revalidated at each load. Store an upload's `trusted` (the bridge sets it: an admin's code where
  uploaded code may run) and give it back: other code-typed assets are served as downloads. Pages
  show assets with `assets.url(id)` (some engines' frames send no address a `/_blob/` load could
  carry). `{ get, bearer: true }` serves by id alone, an explicit opt-in for public artifacts.
  A trusted script goes out as one only while the config still lets uploaded code run, checked at
  each load (P103): in bearer mode, with no access to name the page's config, every artifact
  config your server has must (one where anyone who interacts uploads, or with no `assets`, turns
  them all into downloads).
  Refuse names that aren't assets (`assetNameProblem`).
- **Run the conformance cases** against your handlers (no browser):

  ```js
  import { defineRuntimeConformance } from "@botiverse/porthole/conformance";
  for (const each of defineRuntimeConformance({
    config: page, viewers, handlers: () => freshArtifactHandlers(), assets: () => assetStore,
    // Your own API for the same artifact, signed in as `viewer` with that person's real session:
    // the cases past the bridge then forge the context, as a page past it could.
    api: (handlers, viewer) => apiAs(handlers, viewer),
  })) {
    test(each.name, () => each.run());
  }
  ```

- **The agent** declares capabilities in your publish tool (`capabilities: { db: {} }`) and reads
  topic `capabilities` of the manual: declaring, levels, errors, where state goes, each one's types
  (`types/runtime/v1/*.d.ts`, also in the package for a page's own TypeScript).

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
served. The client's functions take no `this`: pass them bare
(`useSyncExternalStore(porthole.subscribe, porthole.meta)`). A client module that fails to load shows nothing at all: catch its import and say so
(`examples/app.mjs` does).

**Without a bundler**, the page gets Porthole's browser modules from your server, in three parts
(`examples/app.mjs` has all three):

1. Serve the package's `dist/` at a path of your app's (`/porthole-client/`, `.js` files only).
   On Workers it is the static assets directory (`assets.directory`, with `run_worker_first`).
2. Map the bare name in an import map that carries the page's nonce:
   `<script type="importmap" nonce="…">{"imports":{"@botiverse/porthole":"/porthole-client/index.js"}}</script>`.
3. Serve the page its display kinds as a module, made from the same plain object the server's
   `defineDisplays` gets, so they never disagree:
   `` `import { defineDisplays } from "@botiverse/porthole";\nexport const displays = defineDisplays(${JSON.stringify(kinds)});` ``
   at `/porthole-client/displays.mjs`, imported from there.

With a bundler, import `@botiverse/porthole` and your `displays.mjs` as usual.

React: give the provider the client, and show a kind. Flipping the provider's `scheme`, or a new
`themeKey`, re-themes running frames in place: they keep their state.

```jsx
<PortholeProvider client={porthole} scheme={mode} theme={cssVariableTheme(TOKENS)} nonce="auto">
  <PortholeView display="artifact" instance={instance} content={opaqueCopy}
    fallback={({ title, message, link, retry }) => <Fallback {...{ title, message, link, retry }} />} />
</PortholeProvider>
// const { link, open, copy } = usePortholeLink(instance);   "Open in a new tab", "Copy link"
```

Rendered on a server, `PortholeView` draws what the client's meta says: give `portholeClient` the
meta it starts with (`meta`, from your page's data), and the server's HTML has the frame's
placeholder or the fallback, which the page then hydrates. Without it, `pending`.

### The page's CSP

- `frame-src`: `content.frameSources` (the content origins, and the authorize route), also in
  `GET /porthole/meta`; `displays.frameSources(source, { authorizeUrl })` without a server.
- **An opaque display inherits your page's CSP.** Its own policy then narrows it, never widens it.
  If your page sets `default-src`, also allow what agent content uses inline:
  `img-src data: blob:`, `media-src data: blob:`, `font-src data:`, `style-src 'unsafe-inline'`,
  `worker-src blob:`. A nonce-based `script-src` works: give `createHost` the nonce
  (`HostOptions.nonce`) and the shell runs content's scripts under it.

### Sign-in

- Your sign-in page gets the authorize URL as `next` (`signIn`'s `returnTo`), and goes back to it
  when signed in. The authorize URL is `<first app origin>/porthole/authorize` unless
  `entry.authorizeUrl` names another, and `next` is built from it with the entry's state: never
  from the address the request arrived at, which behind a TLS edge or a dev proxy isn't your app's.
- Check `next` with `entryTarget(next, authorizeUrl, { app: true })` (in the page,
  `porthole.entryTarget(next, { app: true })`): the authorize route or any page on your app's
  origin, as an absolute URL, and null for anything else (another site, `//host`, `/\host`,
  `javascript:`), so one check serves sign-ins that go back to a page and those that go back to
  a frame's content. Without `{ app: true }` it takes only the authorize route.
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

What a url-mode app gets from another origin (P101): its cookie opens it for what its own origin
asks (`Origin` its own, or `Sec-Fetch-Site` `same-origin` or `none`) and for a navigation that
opens it (GET or HEAD: your frame, a link, the way back from sign-in); anything else another origin
sends (a sibling app's fetch, form post, script tag or image, an opaque origin's `null`) is a 403
that never reaches the app or your `authorize.check`. A WebSocket opens from the app's own origin
only: `access(request)`, which `nodeHost` asks before `appSocket` and a Worker asks on its own
upgrade path, is null for any other `Origin`. A client that sends neither header (curl with the
cookie) is no browser and goes on. An app whose sign-in posts back from another site (OpenID's
`form_post`) can't sign in through the preview; a tab's `Lax` cookie didn't go with that post
before either.

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

- **`contentHostFor`** makes one content host per `env`, the first time a request needs it. While
  the settings can't be served (no `PORTHOLE_SECRET`, a content domain that shares a site with the
  app), every request gets a plain 503 naming the problem, logged once (`{ log }`), instead of a
  stack trace. `porthole.host(env)` is the host itself (`frameSources` for your CSP) once `fetch`
  has answered null. Settings fixed at build time (no `env`) can make one `createContentHost` at
  module scope instead; a bad setting then fails the Worker as it starts.

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

Names come from the config (`guide.toolName`, `guide.guideToolName`), else `show_<noun>`,
`<noun>_guide` and `check_<noun>` (`show_page`, `page_guide`, `check_page` for a page; naming them
in the config also has the manual name them). The descriptions are the manual's own words.
`examples/mcp/server.mjs` wires all three as an MCP server.

- **`admitContent`** runs `lintContent` and refuses (by default, `refuseOn: "error"`) only what
  would certainly fail or be cut: over the size limit, a document with no body where a fragment
  goes, nested frames, `document.write`. Its refusal says exactly what to change. Everything else
  (hosts outside egress, unpinned libraries, `alert`, forms, the clipboard…) comes back as
  warnings with the result. `refuseOn: "never"` only warns.
- **`guideChanges(from, to)`** is the notice for the agent when a kind flips between served and
  opaque (null when its manual reads the same).
- **`errors: "agent"`** sends what content throws (and what the sandbox blocks, and a navigation
  the shell stopped, P080) back to the agent once people see it: listen for `contentError` and pass
  it on.

### Checking a page before people see it

`checkPage` (`@botiverse/porthole/check`) runs the content in the real sandbox at the manual's
phone and desktop widths, in light and dark, and answers a report whose `text` is a few lines for
the agent: what it threw, what the sandbox blocked, what failed to load, `console.error`, overflow
and a cut height, each problem once with where it happened (at most 8; the rest counted). Lines
are the content's own, as the agent wrote it (a script's error and a lint finding name the same
line).

A served config is checked served: its content runs on an origin of its own under Porthole's
server, with the served CSP, shell, storage and cookies, as people's browsers run it (both drivers
answer a reserved content domain themselves; nothing goes to your server). An opaque config, or
an MCP Apps view, runs opaque.

The host functions the config declares are answered as a host that declines would: a person
asked to confirm says no, and a handler answers no (no prompt sent, a tool call refused). Each
call is in the report (`run.calls`): one hosts refuse whatever the person says (no click, bad
arguments) is a problem; one a person may decline is a note, so the agent makes sure the page
still works then.

```js
import { checkPage, playwrightDriver } from "@botiverse/porthole/check";
const report = await checkPage({ config, content: html, driver: playwrightDriver(browser) });
report.ok; report.text;
```

It needs a browser somewhere: Chromium is best (WebKit mutes a thrown error's message in an
opaque frame, so the agent reads only "Script error.", and names no line in a served one). Where:

- **A server with Chromium** (Node): `playwrightDriver(await chromium.launch())`.
- **An agent on a person's machine, maybe without Chromium** (Ferry's daemon): run
  `lintContent` there (no browser needed), and send `check_page` to your server, which runs
  `checkPage`; or use Playwright where it is installed (`examples/mcp/server.mjs` falls back to
  the lint, saying so).
- **Cloudflare Workers:** Browser Rendering, through a CDP session:

  ```js
  import puppeteer from "@cloudflare/puppeteer";
  import { cdpDriver, checkPage } from "@botiverse/porthole/check";
  const browser = await puppeteer.launch(env.BROWSER);
  const tab = await browser.newPage();
  const report = await checkPage({ config, content, driver: cdpDriver(() => tab.createCDPSession()) });  // no cast
  await browser.close();
  ```

**Bundling:** every entry point bundles whole (a Worker, a single executable): `/check` imports
its check page's script as a module, and `/conformance` its harness, so nothing is looked up
beside a module at run time. Each release is bundled with rolldown and esbuild and checked for
that before it is published (`test:bundle`). `/conformance`, which runs under Playwright, still
looks for the optional MCP Apps App SDK where it runs; without it, the App SDK probes say so and
don't run.

## 7. Conformance: prove your integration

`@botiverse/porthole/conformance` runs Porthole's suite (egress and escape probes, the served
cases, redirect entry) against your app's real page, its CSP and session, in Playwright:

```js
// playwright.config.mjs
import { defineConfig, devices } from "@playwright/test";
import { conformanceProjects } from "@botiverse/porthole/conformance";
export default defineConfig({
  fullyParallel: true,                       // else one spec file is one worker: minutes longer
  // The list, then why each skipped case was skipped (the list alone shows a bare "-").
  reporter: [["list"], ["@botiverse/porthole/conformance/reporter"]],
  projects: conformanceProjects(devices, {
    engines: ["chromium", "webkit", "firefox"],              // the default
    // launchOptions: { chromium: { executablePath: "/usr/bin/chromium" } },   a system browser
  }),
  webServer: { … },
});

// porthole.spec.mjs
import { test } from "@playwright/test";
import { defineHostConformance } from "@botiverse/porthole/conformance";
defineHostConformance(test, {
  name: "my-app",
  open: async (page) => { /* sign in, open the page that shows content */ },
  issue: { url: "/porthole/frames" },
  displays, contentSource: () => `http://*.content.localhost:${port}`,   // asked per case: a port known later
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

Each engine needs its browser (`npx playwright install chromium webkit firefox`); a subset is
`engines: ["chromium"]`. Where Playwright has no build of one (arm64 Linux's Chromium), point at
the system's: `launchOptions: { chromium: { executablePath, args } }`, merged with Porthole's own
(`use` adds to every project's).

The leak probes run opaque displays on your page: where its own CSP closes what a probe needs,
the probe reports itself inapplicable, saying which directive. Those are facts about your page's
opaque fallback, not failures: a page with a `default-src` sees `[1.connect]` and
`[2.resources]` skipped, its `connect-src` already closing what they probe. The reporter above
prints each reason at the end; so does `--reporter=json`.

## 8. Expected, and how to tell

- Chromium logs `Unrecognized Content-Security-Policy directive 'webrtc'` for every frame: the
  directive closes WebRTC where an engine knows it, and is ignored where it doesn't.
- Content's CSP allows `'unsafe-eval'`. Content is the agent's own script already
  (`'unsafe-inline'`), so eval adds no capability, and libraries content uses compile with it
  (Vue's in-browser build, Alpine.js, Vega's expressions, WebAssembly). Egress, the sandbox and the
  origin are what isolate it (P071).
- On `http` loopback the session cookies are `porthole-<key>`; on `https`, `__Host-porthole-<key>`,
  and only that name is read (P101: a sibling label can set any other for the whole domain).
  A frame's are `Secure; SameSite=None; Partitioned` on loopback too: browsers keep `Secure`
  cookies on `localhost`.
- A served frame is one iframe on the content's own origin (no frame inside it), first loaded at
  `/__porthole/d/<key>?ticket=…`: in a test, `page.frameLocator('iframe[src*="/__porthole/d/"]')`.
- A clean address that names nothing (a label the naming never makes, the bare domain, a path
  `entry.at` says has nothing) is a 404 on the content domain: it never reaches your sign-in.
- Host errors name the content origin and leave out ticket URLs.

## 9. Reference

| Import | What |
| --- | --- |
| `@botiverse/porthole` | `createHost`, `presets`, `defineDisplays`, `portholeClient`, `frameFallback`, `entryTarget`, `lintContent`, `admitContent`, `showTool`, `guideTool`, `checkTool`, `answerGuide`, `guideChanges`, `compile` |
| `@botiverse/porthole` (the runtime, 0.7) | `declareCapabilities`, `declarationProblems`, `checkDeclaration`, `dbAccess`, `atLeast`, `methodLevel`, `rosterOf`, `assetNameProblem`, `RUNTIME_CAPABILITIES`, `RUNTIME_TYPES`, `Refused` (`conflict`, `forbidden`, `too_large`); `types/runtime/v1/*.d.ts` |
| `@botiverse/porthole/react` | `PortholeProvider`, `PortholeFrame`, `PortholeView`, `usePortholeLink`, `cssVariableTheme`, `useRunAgain` |
| `@botiverse/porthole/server` | `createContentHost` (`routes`, `forget`), `contentHostFor`, `prefixedName`, `memoryTicketStore`, `d1TicketStore`, `upstreamHeaders`, `statusPage`, `conformancePage`, the callbacks' types |
| `@botiverse/porthole/node` | `nodeServer`, `nodeHost`, `nodeListener`, `nodeProbe`, `toRequest`, `sendResponse` |
| `@botiverse/porthole/check` | `checkPage`, `playwrightDriver`, `cdpDriver` (`CHECK_ORIGIN`, `CHECK_CONTENT_DOMAIN`: the names a driver of your own answers); `/check/page`, the check page's script (`checkPage` has it already) |
| `@botiverse/porthole/mcp` | the MCP Apps adapter (views, the sandbox proxy) |
| `@botiverse/porthole/conformance` | `defineHostConformance`, `conformanceProjects`, `onDemand`, `conformancePage`, `defineRuntimeConformance` (no browser); `/conformance/reporter`, skip reasons |

The types' doc comments are the precise reference; DESIGN.md § "The host kit" is the long form.
