# Adopting Porthole

How to put Porthole in an app, from the npm package alone. `examples/` does all of it:
`examples/app.mjs` is the app (runtime-agnostic), run by `examples/node/server.mjs` (`nodeServer`,
§4) or `examples/workers/` (`contentHostFor`, §5); `examples/mcp/server.mjs` gives the agent its
tools. How it works: DESIGN.md. Why: DECISIONS.md (the P-numbers the code cites). Before you show
content that matters, read your use's section of [THREAT_MODEL.md](THREAT_MODEL.md) (chat widgets,
live data, private and public pages, MCP Apps, previews, several displays on one page): what is
guaranteed, what you must do, what isn't covered.

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

It gives `displays.opaque(kind)`, `displays.served(contentSource)`,
`displays.configFor(instance, source)`, `displays.frameSources(source, { authorizeUrl })` (a CSP
without a server: a dev server, a desktop shell) and `displays.guideConfig(kind, "served" | "opaque")`
(the agent's manual). A kind's name is the preset its documents carry: a stored page names
`artifact` unless its `document.preset` says otherwise.

**Fill**: `layout: { kind: "fill" }` makes the frame fill its box and tells the agent the page
scrolls itself (`position: fixed` works). The deprecated `MountOptions.fill` and
`<PortholeFrame fill>` size the frame but leave the manual saying the height follows the content.

### Choosing egress

Egress is what content may load and send out: scripts, styles, fonts, images, audio and video, and
data (fetch, WebSocket). Every preset starts closed; a kind opens more only through its
`options.egress`. Three levels, and Porthole's own libraries for served content:

| Level | Config (`options`) | What it opens | The risk it re-opens | Typical host | The agent's manual says | Why | Tested by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Closed** (the default) | nothing to write | Nothing from outside the frame: content runs on what it carries (inline code, `data:` and `blob:` URLs). | None. | Widgets that draw their own SVG and CSS; any host that hasn't decided yet. | `Network: none. Nothing loads from outside` (and `write everything inline`) | [P006](DECISIONS.md#p006--2026-10-11--egress-is-closed-by-default-including-channels-a-frame-csp-doesnt-cover--accepted), [P022](DECISIONS.md#p022--2026-10-11--every-preset-starts-with-egress-closed-library-cdns-are-a-one-line-opt-in--accepted-amended-by-p082-p089) | probes `1.connect`, `2.resources`, `3.webrtc`, `4.*` (nested frames), `5.*` (navigating out), `8.*` (resource hints), `10.self`; served `served.domain.egress` |
| **Library CDNs** (`LIBRARY_CDNS`, plus script hosts of your own) | `egress: LIBRARY_CDNS`; more script hosts: `egress: { ...LIBRARY_CDNS, script: [...LIBRARY_CDNS.script, "https://cdn.example.com"] }` | Scripts, styles, fonts, images and data from cdnjs, jsDelivr, unpkg and esm.sh; Google Fonts; scripts only from three libraries' own CDNs (Tailwind's Play CDN, jQuery, Plotly). Nothing else. | Code you don't control runs in the frame (a compromised or look-alike package), still inside the sandbox and egress; and a path requested from a CDN is a narrow channel out, read by the CDN's operator. The manual tells agents to pin versions. | Ferry's widgets, Raft Artifacts' pages: agents load Chart.js, ECharts, d3, Mermaid, Tailwind, jQuery, Plotly. | `scripts, styles, fonts, images and data (fetch, WebSocket) from https://cdnjs.cloudflare.com` …, `scripts from https://cdn.tailwindcss.com, https://code.jquery.com, https://cdn.plot.ly` and `pin an exact version` | [P078](DECISIONS.md#p078--2026-10-13--library_cdns-adds-tailwinds-jquerys-and-plotlys-own-cdns-for-scripts-only--accepted), [P022](DECISIONS.md#p022--2026-10-11--every-preset-starts-with-egress-closed-library-cdns-are-a-one-line-opt-in--accepted-amended-by-p082-p089), [P048](DECISIONS.md#p048--2026-10-11--artifact-pages-reach-library-cdns-only-by-the-hosts-config--accepted) | `leak/cdn.spec.ts` (a CDN library loads only when the config opens it, opaque and served; another origin never; the libraries' own CDNs serve scripts and nothing else); probes `1.connect`, `2.resources` (an allowed origin loads, no other does) |
| **Passive from any https site** (`anyHttps`, on top of either) | `egress: { ...LIBRARY_CDNS, anyHttps: ["img"] }`; closed but for them: `egress: { anyHttps: ["img"] }` | The passive kinds you name (`img`, `media`, `font`) from any https site. Never scripts, styles, data, workers or frames, and never `http:`: a config naming another kind is refused. | Any site an image names learns that someone viewed the content, and from which address; content can send data out in an image URL to a server of its choosing (the channel P006 closes); whoever owns an image controls what it shows, inside the frame. | A host showing content that already exists, with hotlinked media: Raft's HTML attachment previews, reports whose `<img>` point at other sites (the case P059 was written for). | `images from any https site` (`fonts, images, audio and video from any https site` for all three) | [P059](DECISIONS.md#p059--2026-10-11--passive-content-may-load-from-any-https-site-by-the-hosts-explicit-choice--accepted), [P062](DECISIONS.md#p062--2026-10-11--serveddomainegress-holds-a-host-to-its-own-configs-egress--accepted) | `leak/cdn.spec.ts` (a hotlinked image loads; a script, a stylesheet and a fetch to the same site never reach it; without the flag, nothing does); served `served.domain.egress` (the image must reach an https canary; scripts, styles, fetches and frames never), `leak/served/any-https.spec.ts` |
| **Porthole's libraries** (`egress.libraries`, served kinds only; on in `presets.liveWidget`) | `egress: { libraries: true }` with `isolation: "domain"` | Chart.js 4.5.1 and D3 7.9.0 as scripts, from the frame's own origin (`/__porthole/lib/…`, served by `/server` on every content origin). Nothing from outside. | None from outside: the requests reach your content server, which serves fixed, pinned files. | Live widgets, which read your data and must have no network of their own (P079). | `Libraries, served from this frame's own address` with a `<script>` line for each | [P079](DECISIONS.md#p079--2026-10-15--live-widgets-no-network-of-their-own-portholes-libraries-on-their-origin-the-hosts-data-behind-the-viewers-consent-and-frames-that-never-navigate-away--accepted-amended-by-p084-p094-p103) | `test/libraries.test.ts`; `leak/served/live.spec.ts` (they load and draw; an external script, a stylesheet, an image and every fetch reach no oracle) |

**Start closed; add `LIBRARY_CDNS` if agents use libraries; add passive `anyHttps` only for
existing content with hotlinks**, and only the kinds it hotlinks (usually `img`). Agents writing new
content can inline what they show, so agent-made pages never need `anyHttps`.

- `egress` is a kind's whole policy, so kinds that differ in egress are kinds of their own, named by
  their documents (`document.preset: "attachment"`). Add a script host with
  `script: [...(LIBRARY_CDNS.script ?? []), "https://cdn.example.com"]`.
- The libraries' own CDNs serve scripts only (P078). Plotly's maps fetch shapes from `cdn.plot.ly`,
  which stays closed, so the manual gives agents jsDelivr's copy (`topojsonURL`). Tailwind's Play CDN
  builds its CSS in the page.
- Origins are exact (`https://cdn.example.com`) or `https://*.` a domain of your own; a wildcard over
  a public suffix (`*.com`, `*.github.io`) is refused.
- An opaque frame also inherits your page's CSP ([P058](DECISIONS.md#p058--2026-10-11--an-opaque-frame-is-as-closed-as-its-page-the-suite-says-when-a-case-cant-be-observed--accepted)):
  what your page closes stays closed, whatever egress opens ("The page's CSP"). A served frame has
  only its own policy.
- `checkPage` and `lintContent` tell the agent, by directive, when content reaches past the egress.
  The manual names exactly the origins the CSP allows (`test/agreement.test.ts`). Long form:
  DESIGN.md § "Egress hardening, each with its test".

### Live widgets: content that reads your data

A live widget shows your data, current, read as its viewer, with no network of its own
([P079](DECISIONS.md#p079--2026-10-15--live-widgets-no-network-of-their-own-portholes-libraries-on-their-origin-the-hosts-data-behind-the-viewers-consent-and-frames-that-never-navigate-away--accepted-amended-by-p084-p094-p103)).
Its only way out is your host: `readData` (MCP `resources/read`) and `subscribeData`
(`resources/subscribe`, `resources/unsubscribe`, `notifications/resources/updated`).
`presets.liveWidget` refuses `egress` and a capability's own `connect` or `resource` origins
(`ConfigError`, P103): a display that needs an origin is another kind. Guarantees and duties:
[THREAT_MODEL.md § S2](THREAT_MODEL.md#s2-live-widgets-content-that-reads-the-hosts-data).

```js
const displays = defineDisplays({ tile: { preset: "liveWidget", options: { capabilities: { openLink: {} } } } });

createHost(displays.configFor(instance, contentSource), {
  locator,
  handlers: {
    // As the viewer, by your access rules: MCP's read result, or a Refused (P080).
    readData: async ({ uri }, { displayId }) => {
      if (!servedUri(uri)) throw new Refused("not_allowed", "This widget can read issues only.");
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(await load(uri)) }] };
    },
    // changed(): the content reads again. changed(result): sent, through readData's gates (P094).
    subscribeData: ({ uri }, { changed, signal }) => signal.addEventListener("abort", realtime.on(uri, () => changed())),
  },
  // Once per display, before its first data call. Remember the answer per viewer and widget.
  consent: async ({ display }) => allowedBefore(display) ?? (await askTheViewer(display)),
  cached: ({ uri }) => lastCopy(uri), // optional: shown at once (stale), then the fresh read
});
```

| What | How |
| --- | --- |
| What a URI may name | Your handlers decide, with the viewer's rights; the content's URI is its word. |
| Consent is your UI | With no `consent` every data call is refused; a no refuses them all (`denied`). A thrown `Refused` is that answer, kept like `false`; any other throw is no answer yet. Where data must not run, pass a `Refused` as `consent` (`new Refused("not_allowed", "Live data shows on the dashboard.")`) and no data handlers: nothing is asked and the widget shows your sentence. Other capabilities still need their handlers. React: `PortholeProvider` and `PortholeFrame` take `consent` and `cached`. |
| Refusals say why (P080) | The call rejects with an `Error` whose `code` is `consent_required`, `denied`, `rate_limited`, `not_allowed` or `failed` (your handler threw) and whose `message` is your `Refused`'s sentence, else Porthole's; a handler's other errors stay yours. The manual has the agent draw the widget without the data, with that sentence. |
| Rates | 120 reads and 60 subscriptions a minute per display, set in the capability's `gates` (keep `"consent"`). `changed(result)` counts as a read (P094): a resource changing more than twice a second needs a higher read rate. |
| Your page's CSP | Send `displays.embedderCsp(source, …)`. The shell stops a served frame's navigation to another content origin (P079); with `reportError` declared you get `display.on("navigationBlocked", ({ url }) => …)` (React `onNavigationBlocked`) and the agent gets `contentError` (P080). An opaque frame's navigations raise no events. |
| Neighbours | Any frame can `postMessage` the widget's, so keep live widgets off pages with frames that reach the network (a url-mode app, an `anyHttps` display). Closed and `LIBRARY_CDNS` displays are fine ([THREAT_MODEL.md § S7](THREAT_MODEL.md#s7-several-displays-on-one-page)). |
| Opaque live widgets (no content domain) | They draw with SVG and CSS. Show them only on pages that frame no content origins (`frame-src 'none'`, which `defineDisplays` gives a page without one). |

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

React: `<PortholeProvider>` near the root, `<PortholeFrame config displayId title content partial />`
per display. The provider holds what frames share: `scheme`, `theme` and `themeKey`
(`cssVariableTheme(tokens)` reads your page's CSS variables), `nonce` (`"auto"` reads the page's),
`handlers`, `openLink` (default: a new tab), `notify` (your toast for what a copy button copied) and
`renderConfirm` (your dialog, given `accept`, `decline` and `redirect`). Porthole keeps the queue,
runs `accept` inside its click and counts declines toward muting the display; `redirect` ("edit it
first") answers `"redirected"` and neither counts nor resets the count. `request.display` gives the
display's `id`, `title` and the `instance` you gave the frame (never sent to an opaque frame), so the
dialog can name it from your records. `useRunAgain()` gives a "run again" button.

A window of your own (P154): a frame may be drawn into a window your page opened and renders into
from its own code (a React portal into `window.open("about:blank", name)`, a desktop app's object
window). Its answers then come from your page's window, the popup's opener, which the shell hears as
its host's. The popup must be same-origin with your page and have a document of its own: write it
(`doc.open()`, `doc.write(…)`, `doc.close()`), since an untouched `about:blank` says
`location.origin` `"null"` and an opaque display refuses to mount there. Upgrade the content server
with the host: an older served shell hears its parent alone, and a display in such a window never
initializes.

### Context for the agent (`setModelContext`)

A widget or MCP Apps view may tell the agent what the person sees (`ui/update-model-context`, the
App SDK's `app.updateModelContext`). By default the person sees each update first: the `show` gate
([P100](DECISIONS.md#p100--2026-10-19--what-content-tells-the-model-the-person-is-shown-first-the-show-gate-on-by-default-for-setmodelcontext--accepted)).
Before your handler, `show` gets the display and the whole update (`request.args`: text blocks and
structured content, at most `MAX_CONTEXT_CHARS` together) and draws it outside the frame (the latest
per display). Without `show` every update is refused. React: `PortholeProvider` draws
`ContextNotice` unless you pass your own `show`.

```js
createHost(config, {
  handlers: { setModelContext: (update, { displayId }) => modelContext.set(displayId, update) },
  show: ({ args, display }) => composer.contextChip(display.id, display.title, args), // before the handler
});
```

| What | How |
| --- | --- |
| **Give it to the model as the content's words** | For example "the view “Signups” says: …"; never as the person's message or as instructions, and with their next message (MCP Apps lets a host defer it). If your agent takes turns on its own, add `"confirm"` to the gates. |
| **Your own `show`** | Resolve only once that very update is visible; if a later one replaces it before it is drawn, reject, and it doesn't go. |
| **Opting out** | `setModelContext: { gates: [{ rateLimit: { perMinute: 30 } }], withoutShow: true }`, only where your handler itself shows the text to the person (or the content is your own). Gates named without `show` or `withoutShow` earn the warning `model-context-unshown`. Porthole logs nothing: read `host.compiled.warnings` (or `compile(config).warnings`, `configWarnings(config)`) at startup, or pass `validateConfig(config, { onWarning })`. |
| **Invisible characters are refused** | An update with one in its text or any string of its structured content (zero-width, bidi controls, variation selectors, tag or private-use characters, controls but new line and tab) never reaches `show` or your handler. Real emoji pass (☀️, 👨‍👩‍👧, 👩🏽‍💻, 1️⃣: a selector after a pictograph or in a keycap, a joiner between two pictographs), as do U+200C and U+200D between letters or marks of Arabic, Syriac, N'Ko, Mongolian, the Indic scripts, Sinhala or Myanmar (Persian's می‌خواهم). Subdivision flags (tag characters) don't. |

### Annotations: comments on a display

With `annotate` declared (`capabilities: { annotate: {} }`), people point at a display and you keep
their comments beside it (P053, P104). A mark with a `count` gets a numbered marker button at the
end of its words' paragraph (P133); a click, Enter or Space on it is `activated`. A draft
(`kind: "draft"`, not yet posted, P107) gets a hollow marker and no number, and is clicked and
followed like a posted mark. Every report is the page's word: a hint where to draw, never a
permission. How it works: [DESIGN.md § Annotations](DESIGN.md#annotations). What a page learns and
can fake: [THREAT_MODEL.md §7](THREAT_MODEL.md#7-the-display-layer-and-the-app-runtime).

```js
display.annotations.show([
  ...comments.map((c) => ({ id: c.markId, anchor: c.anchor, count: c.replies })),
  ...myDrafts.map((d) => ({ id: d.markId, anchor: d.anchor, kind: "draft" })), // author's frame only
]);
display.annotations.start({ elements: false, text: true }); // comment mode: the person selects words
display.on("annotation", (report) => {
  if (report.type === "selected") composer.openBeside(frame, report.rect, report.anchor);
  if (report.type === "activated") bubble.openBeside(frame, report.rect, report.id);
  if (report.type === "anchored") bubble.follow(report.results);
});
composer.onClose(() => display.annotations.clearSelection()); // however it closed
```

**React** (P118): `PortholeFrame` and `PortholeView` take `annotating`, `annotations`,
`focusedAnnotation`, `trackedAnnotation` (the mark to follow, by value; `null` stops),
`trackedSelection` (from the first render, `false` until then: it is read as the mode starts, P140)
and `onAnnotation`. `clearSelection()`, `focusMark(id)` and `place()` are on the `ref` (a
`PortholeFrameHandle`, not the display) and do nothing with no display running. Errors the core's calls throw (an id no
shown mark has, a config without `annotate`) reach `onHostError`, kind `"annotations"`.

What the host must do (why: THREAT_MODEL.md §6 "What every host must do"):

| Duty | How |
| --- | --- |
| **Clear the selection on every close of the composer** | Kept or dismissed (`annotations.clearSelection()`, P115), or as it opens, or leave it to the person's next click. Never only when a draft is added: the page sees the clear (P121) and would learn a draft exists there, and when. Nothing else changes (marks, drafts, the mode, a followed mark). An older shell ignores it. |
| **Ids say nothing; counts only where the page may know them** | The content reads every `show`; who wrote what stays outside the frame. |
| **Drafts only in their author's frame** | Never a shared one: the page reads which marks are drafts. A draft's `count` is dropped before the frame; give its id at random like any other. A `kind` other than `"posted"` or `"draft"` throws. Upgrade the content server first: an older shell draws a draft as a posted mark without a marker. |
| **No drafts to a page that can pass them on** | Or accept that its author and other viewers can learn of them. `host.mayPassOn(declaration)` (or `mayPassOn(config, declaration)`, P112) is true for a page that can reach `db`, `artifact`, `assets`, `openLink`, `sendPrompt`, `setModelContext`, `callTool`, `readData` or `subscribeData` (or `reportError` with errors to the agent), or egress beyond the library CDNs. |
| **Labels, quotes and context are the page's text** | Show them as text, and give them to a model only as the page's words. A label and an anchor's `context` (P152) omit what the person can't see; a quote (`exact`) keeps it. A place's `page` and `hash` (P155) are the page's word too: where to open it, in its own frame or tab only. |

- **Guard every view a report opens or moves** (`activated`, `selected`, a card following a `tracked`
  mark each time it moves more than a few px): the content picks the moment and the place (P105).
  For 500 ms after it appears or moves, the view takes no press (`pointerdown`, `pointerup`, `click`
  or key) and ignores one begun before. It opens beside the frame rather than over `rect` where the
  layout allows, takes no focus (but for THREAT_MODEL §6's exceptions), and has nothing one click away
  that posts, submits, resolves, deletes or discards (a draft's view too: no "Post", "Submit review"
  or "Discard"). Making it `inert` while it arms does the first part:

  ```js
  // Call placed() each time the view appears or moves. For 500 ms it takes nothing (inert: no
  // press, no click, no focus; the pointer reaches what is under it), then only a press or a key
  // that began on it after that.
  function guardPresses(...parts) {
    let timer = 0;
    let fresh = false;
    for (const part of parts) {
      part.addEventListener("pointerdown", () => (fresh = true), true);
      part.addEventListener("keydown", () => (fresh = true), true);
      for (const type of ["pointerup", "mouseup", "touchend", "click"]) {
        part.addEventListener(type, (event) => {
          if (!fresh) {
            event.preventDefault();
            event.stopPropagation();
          }
        }, true);
      }
    }
    const arm = (on) => {
      for (const part of parts) {
        part.inert = on;
        part.style.pointerEvents = on ? "none" : "";
      }
    };
    return {
      placed() {
        fresh = false;
        arm(true);
        clearTimeout(timer);
        timer = setTimeout(() => arm(false), 500);
      },
    };
  }
  ```

  Portaled menus and popovers (Base UI's, Radix's) are drawn outside the view, beyond the guard: give
  them a `container` inside it (both take one) or pass that container to `guardPresses` too, and
  close them each time the view appears or moves.

Where to draw:

| What | How |
| --- | --- |
| **Boxes** (`rect`, P104) | In the frame's CSS px, clamped to its viewport: add the frame element's position and map them through any transform on the frame (`frame.getBoundingClientRect().width / frame.clientWidth` for a plain scale). |
| **Places in the document** (P132) | `tracked` and each attached result of `anchored` carry a `documentRect` (unclamped, fixed as the page scrolls) and the report's `scroll`. A mark's top in the frame's viewport is `documentRect.y - scroll.y`, so margin cards need no new ask. A box the page scrolls itself moves its marks: show again, or follow the mark, to hear where. Clip what you draw to the frame's box or your region beside it. An older shell sends neither: test for `scroll`, else place by `rect`. |
| **A composer that follows the selection** (P138, P140) | Start with `keepSelection: true` (React: while you give `trackedSelection`) and on `selected` call `annotations.track({ selection: true })`. The frame highlights the selection and reports `selectionTracked` as `tracked` reports a mark (at most 60 a second, the same boxes, and `inView`: hide the composer while it is false). `state: "orphaned"`: it left the page; keep the person's words. One thing is followed at a time; `track(null)`, a mark's id or `clear` ends it. End it on every close, as you clear the selection (the frame's own Escape doesn't), and guard the composer as it moves. Ask for the follow before a `start` or `stop` you send as the composer opens (React orders them so). Without `keepSelection`, a follow asked after `selected` answers `orphaned`. An older shell sends no `selectionTracked`: place by `selected` until the first one. |

**After the last line** (P133), for UI after a selection's or a mark's words (a composer's button):
`selected`, each attached result and `tracked` carry `lastLineDocumentRect`, the last line with words
(an element's whole box), unclamped. `createHost` drops a report with a last line and no `scroll`,
so where you have the line you have the scroll (P137). Clip it; use `rect` where it is absent (an
older shell):

```js
display.on("annotation", (report) => {
  if (report.type !== "selected") return;
  const line = report.lastLineDocumentRect;
  const at = line
    ? { x: line.x + line.width - report.scroll.x, y: line.y + line.height - report.scroll.y }
    : { x: report.rect.x + report.rect.width, y: report.rect.y + report.rect.height };
  composer.openAt(frame, clipToFrame(at), report.anchor); // the frame's px: clip them, then add its position
});
```

**Where an element was picked** (P150): an element pick by a click or tap also carries `pointDocument`
(with `scroll`), the point it was picked at in the same coordinates. Where the element fills most of
the frame, place your UI at `pointDocument.x - scroll.x`, `pointDocument.y - scroll.y`, clipped. A
pick from the keyboard, a text selection and an older shell send none.

**Where it is in the page** (P152, P153): an anchor (`selected`'s, of either kind) may carry
`context`, `{ headings?: string[], region?: string }`, from what the page tells a screen reader: the
headings from the top of the page down to its section, outermost first (a heading picked, or an
element's own, last; a hidden tab's never; the page's only h1, its title, left out unless it is the
only one), and the name of the named container around it (a tab panel's tab, a labelled
`section`, a figure's caption). At most 6 headings, 80 characters each and for the region. Store it
with the anchor and show it with the comment ("Results › Revenue tab") so readers, people and
agents, know which part it is on; it is absent where the page has neither, and from an older shell.
`parseAnchor` keeps it; `show` leaves it out of what goes to the frame.

**Where the reader is** (P155): each `selected` also carries `place`, a `PagePlace`
`{ page?, hash?, scroll }`, and `display.annotations.place()` asks for it when a comment has no pick
(one on the whole page). `page` is which of the content's own pages it is (`"./report.html"`, `"./"`
for an entry at the files' root; absent for content without files); `hash` is the address's fragment
(`"#pricing"`, percent-encoded) only where it names an element in the page, never a route or a
token; `scroll` is P132's. Store it beside the anchor and show it as the comment's place
(`report.html#pricing`); to open the page there, resolve `page` against the content's own address
and add `hash`. Both are the page's word: show them as text and never open them anywhere but the
content's own frame or tab.

```js
display.on("annotation", (report) => {
  if (report.type === "selected") composer.open({ anchor: report.anchor, place: report.place });
});
wholePageButton.onclick = async () => {
  const place = await display.annotations.place(); // "unsupported": an older shell, no answer in 3 s
  composer.open({ place: place === "unsupported" ? undefined : place });
};
```

React: `place()` on the `ref` (`"unsupported"` with no display running; a config without `annotate`
reaches `onHostError`). An older shell sends no `place` and answers `"unsupported"`: upgrade the
content server with the host.

The keyboard:

| Case | What to do |
| --- | --- |
| **Markers are buttons** (P133, P134) | In the frame's Tab order after the page's own stops, named for what they are (`3 comments on "the words"`, in English); Enter or Space is `activated`. The page owns that focus order and can steal from it: keep your own list of marks as the keyboard path that holds (`annotations.focus(id)` brings one into view), and keep your view's guard. |
| **Key or pointer** (P134) | `activated` doesn't say which. `document.activeElement === container.querySelector("iframe")` (in a shadow root of yours, its `activeElement`) is true when focus is in the frame, as after a key on a marker; a pointer's press moves no focus. It is a hint, not proof: the page can focus its frame and forge `activated`. Moving the keyboard into your view on it is THREAT_MODEL §6's second exception: gate whatever posts from that view yourself, its key handlers and your page-wide shortcuts that write included (P137). |
| **Back to the marker** (P134, P135, P137) | Only when the person's key closes your view of a mark from inside it (Escape, or Tab past its ends): close it and call `display.annotations.focusMark(id)` at once. It carries no content and reports nothing; an id with no marker does nothing. A call the frame must wait on, or arriving over 100 ms after you sent it, lands only if focus is in the frame by then; once your card closes focus is on your `<body>`, so the call is dropped silently. If `document.activeElement` is still your `<body>` 200 ms later, call `display.focus()` (React: the frame element's `focus()`), then `focusMark(id)` again; on a button of yours, the person moved on. Upgrade the host and the content server together. |

### Find in page: the host's find bar

With `find` declared (`capabilities: { find: {} }`), your own find bar searches a display (P131): the
shell highlights the matches (case-insensitive by default, any spacing), brings the current one into
view and answers the counts. How it works: [DESIGN.md § Find in page](DESIGN.md#find-in-page). The
page reads every query: declare `find` only where it may learn what the person searches for
(THREAT_MODEL §7). Send a query when the person pauses or presses Enter, never at every key, which
would show the page each prefix and the rhythm of the typing.

```js
display.find.takeShortcut(true);               // Cmd+F / Ctrl+F in the frame opens your bar, not the browser's
display.on("findRequested", () => bar.open()); // the page's word too: open the bar, nothing more
// A result is "unsupported" or `${active}/${total}` ("+" after the total where `capped`).
const show = (result) => bar.show(result === "unsupported" ? "Not available here" : result);
let asked = 0, pause;                          // only the answer to the latest query is shown
const ask = (query, options) => {
  const mine = ++asked;
  void display.find.query(query, options).then((result) => mine === asked && show(result));
};
bar.onInput((query) => (clearTimeout(pause), (pause = setTimeout(() => ask(query), 300))));
bar.onEnter((query) => (clearTimeout(pause), ask(query)));
bar.onStep((direction) => ask(bar.query, { direction })); // "next" or "prev"
display.on("findUpdated", show);               // the page changed: new numbers
bar.onClose(() => display.find.clear());       // Escape in your bar: highlights gone
display.on("navigated", () => bar.reset()); // the query is forgotten; also on reload() or new content
```

| Case | What happens |
| --- | --- |
| **`"unsupported"`** | No `find` in the config; a shell older than your host (upgrade the content server first); no answer within `FIND_LIMITS.timeoutMs` (3 s) of the frame running; a query a later one superseded (only a burst's latest is searched); or one waiting when its content went. |
| **Edge queries** | One asked before the frame runs waits for it. An empty one clears and answers `{ total: 0, active: 0 }`; one longer than `FIND_LIMITS.query` (256) rejects with a `TypeError`. |
| **New content** | A new run (`reload()`, `navigated`) or other content (a `setContent` that doesn't continue the last) forgets the query: reset your bar. The shortcut stays taken. |
| **The numbers are the page's word** | At most 1,000 (`capped`), the current one from 1. `rect` is its box in the frame's CSS px, clamped to the viewport; for a display that grows with its content, scroll your page to the frame's position plus `rect`. |
| **The shortcut** | Yours only while you take it and where the page doesn't handle Cmd+F itself; `findRequested` counts only with focus in the frame. Escape and Cmd+G in the frame stay the page's. |
| **Not found** | Words in open shadow roots, a page's own frames (P128), form fields, images or a canvas, and words split across cells with no space between them. |
| **React** | Props `onFindRequested` (given, the shortcut is yours) and `onFindUpdated`; the `ref`'s `find(query, options)` and `clearFind()`. With no display running, `find` answers `"unsupported"` and keeps the query for a display made later for the same content. Other content forgets it (a `content` that doesn't continue it, a new `generation`, `document`, `instance`, `config`, `declaration` or `viewer`). A refused query reaches `onHostError`, kind `"find"`. |

### Link labels: titles for bare links

With `linkLabels` declared (`capabilities: { linkLabels: {} }`), you can have a display's bare links
(a link whose text is its own address) show the title of the page they open, as the person viewing
may see it: an artifact that links to other artifacts of yours shows their names (P151). Label from
your own list of what the page links to (your server knows each linked page and what this viewer may
see of it); the page reports nothing. How it works: [DESIGN.md § Link labels](DESIGN.md#link-labels).
The page reads every label: send only titles this viewer may see and the page may learn
(THREAT_MODEL §6, §7). With React, give `linkLabels` in the same render as the `content` they are
for, and `[]` until the new content's titles are in hand (fetched per content, never carried over):
the prop is sent to each new document as soon as it loads, so labels kept from the last content
would be read by this one.

```js
// After each document loads (and whenever your list changes): this viewer's titles for its links.
display.on("initialized", () => display.links.label(labelsFor(artifact, viewer)));
// [{ href: "https://app.example/a/123", text: "Q3 plan", tag: "artifact" }, ...]
```

| Case | What happens |
| --- | --- |
| **Bare or not** | A link whose only child is a text node whose words (white space around them aside) are its `href` as written or as resolved shows `text`; one with words of its own, or markup inside, keeps them. Every link to the address gets `data-porthole-label="<tag>"` where you give a `tag` (`[a-z0-9-]{1,32}`). |
| **Which address** | The link's `href` resolved against the page's base, by the platform's own parser, equals the label's `href` as the platform writes it: give absolute http(s) URLs (`https://app.example` and `https://app.example/` are one; `/a/123` is another address, on the content's own origin). No other normalising (a trailing slash on a path, a query, a fragment all count). |
| **Malformed** | Dropped, the rest applied: not an absolute http(s) URL, over 2,048 characters, `text` over 300 or blank. Bidirectional controls are taken out of `text`; past 500 labels the rest are dropped. Anything but a list throws a `TypeError` (React: `onHostError`, kind `"links"`). |
| **Changes** | A new set replaces the last; `label([])` gives every link its own words back. Links the page adds or changes later are labelled once its changes settle. Words the page writes over a label stay its own. |
| **New content** | A new run (`reload()`, `navigated`) or other content (a `setContent` that doesn't continue the last) forgets the labels: label again (on `initialized`, as above). Another page of the set (P084) is the same content: it is given them again as it loads, at most 60 a minute by default (the capability's rate; a page over it is `refused`, `rate_limited`). |
| **Not labelled** | Links in open shadow roots, a page's own frames (P128), SVG links, image-map areas' text (they have none; they are tagged). |
| **React** | `linkLabels` on `PortholeFrame` (and `PortholeView`), compared by value: sent when it changes and again to each new document. |

### The keyboard: a display can take it

Any display can move the keyboard into its frame (`element.focus()`, with no gesture on Chromium and
WebKit), and what the person goes on typing in your composer goes to the page until they click back.
Porthole neither stops that nor stops a display for it (P149; THREAT_MODEL §7 "The keyboard").
Beside a field that must never lose a key (a password, a payment field), show no display you don't
trust.

- Move focus into a display with `display.focus()`, and to a field of yours with `focusField(field)`
  (from `@botiverse/porthole`), not the field's `focus()`: Firefox ignores that while a frame that
  takes focus back on its blur holds it.
- A platform of your own (a native web view): `display.focus()` calls `focus` on its surface;
  `focused`, if given, says whether the keyboard is in the display (the find shortcut reads it,
  P131). There is no `focusTaken` event, and `onFocusTaken` is not read.
- **Outside clicks and unhandled Escapes (P157):** `display.on("press", …)` (`onPress`) fires on a
  trusted `pointerdown` inside the frame, before any annotation marker's `activated` report (so a
  host can dismiss an open card on the press without losing same-marker toggle state).
  `display.on("escape", …)` (`onEscape`) fires in any mode (not only while annotating) when a
  trusted, non-composing `Escape` reaches the frame's `window` without `defaultPrevented`. Both
  are UI hints only (THREAT_MODEL §6): never discard unsaved user input or close confirmations on
  them.

## 4. Served pages: the host kit

### Local development

Run the app and the content domain on one server: app `http://localhost:8790`, content domain
`content.localhost:8790` (pages at `http://a-<id>.content.localhost:8790`). Browsers resolve every
`*.localhost` name to loopback, each a site of its own, so the app and its content never share
cookies or storage. `http` is allowed only on loopback; everything else is `https`.

In production the content domain is a registrable domain your app uses for nothing else
(`example-usercontent.com`), with wildcard DNS and a wildcard certificate pointing at the same app.
Porthole refuses one that holds or may share a site with an app origin (`ContentDomainError`). Put
it on the Public Suffix List when you can, so its labels are sites of their own.

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

| Option | What to give |
| --- | --- |
| `instance` | The client's proposal (`{ scope, document }`) in, your instance (or null) out. Derive the scope (the origin) from what it names: the client never chooses an origin. |
| `access` | A grant (`{ viewer }`, or `{ anonymous: true }` for a public page) or null. `authorize` (optional) checks again on every later request; `content.forget({ scope, subject })` drops its cached answers when you revoke. |
| `routes(viewerOf)` | `viewerOf(request)` is your app's: who is signed in (its cookie or token), or null. |
| `entry.signIn` | `Response.redirect` needs an absolute URL outside a browser (Node throws on `/login`). |
| `reserved` | Only labels your app itself serves on the content domain (dev-server previews, `p-*`). Labels nothing serves need nothing: they are a 404 there. |
| `secret` | At least 32 random bytes (`npx porthole secret`), from the environment (`PORTHOLE_SECRET`). A missing or short one throws at `createContentHost`, saying so (with `health`, frames stay opaque and the meta says why). |
| `domain: null` (or `""`) | No content domain (self-hosted), a supported setup: no secret needed, `GET /porthole/meta` answers `{ served: false }`, pages show every kind opaque (a url kind, its fallback). Without a host at all, `portholeClient` stays pending. |
| `health` | `health: { probe: nodeProbe(), onServedChange: (served) => … }` checks the content domain over the real network and falls back to opaque frames while it doesn't answer. |
| `rateLimit` | `rateLimit: { perMinute }` keys an anonymous viewer by the address the server saw (the socket's peer on Node, `CF-Connecting-IP` on Workers, IPv6 by its /64), never a client-written `X-Forwarded-For` (P092). Behind proxies, set `trustedProxies` (how many append to `X-Forwarded-For`) only where the app is reachable through them alone, or give `key: (request, viewer) => …`. Without a peer address (Hono's own Node adapter, `new Request(req)`, Deno, Bun), set `rateLimit.key`. Without `trustedProxies` or `key` where these apply, anonymous requests share one allowance. |

| What | Detail |
| --- | --- |
| **`framedBy`** (P141) | Where another app frames yours (a dashboard), its exact https origins (`http://` on loopback), none an app origin: `framedBy: ["https://dashboard.example.com"]`. Without it your frames are blank there. They become ancestors of every frame Porthole serves, never hosts: no frame hears or tells them, and redirect entry and the handoff stay `appOrigins`'. Your page stays the frame's parent and sets its own `frame-ancestors`. A content Worker of your own passes the list to `statusPage`, `doorResponse` and `doorStatusResponse`. Content can `postMessage` the outer page, so its authors must check `event.source` and `event.origin` in every message listener ([THREAT_MODEL.md § What every host must do](THREAT_MODEL.md#what-every-host-must-do)). |
| **`embeds`** (P143) | To let any site embed a public artifact page, set `embeds: true` and issue it from one route of your own that decides the page is public (never your reader's issue endpoint): `host.server.issue(instance, { anonymous: true, embed: true })` (no `level`, no `user`). Never answer `embed` from `access`: the kit refuses it there with a 409 (P145). Only that session says `frame-ancestors *`; it has no host and no door, and its links out go nowhere. Frame it from an outer page of your own that listens to nothing (its `frame-src` the one label), with your own "Open" link. `authorize.check` gets `embed: true`. A content Worker of your own answers refusals before a session with `statusPage({ embed: true, … })` or `doorStatusResponse({ embed: true, … })`. The page learns where it is embedded ([THREAT_MODEL.md S4](THREAT_MODEL.md#s4-public-links-and-pages-that-are-apps)). |
| **`nodeServer`** | The whole Node server: the content domain to Porthole (WebSockets included), the rest to `app` (fetch-style: Hono's `app.fetch`) or `request` (a Node listener: Express), the health gate started on listen. Behind a TLS edge, add `scheme: "https"`. A host that needs the port first (`listen(0)`) can come later: `content: () => host` (null until made). `nodeServer` starts it; `start()` runs once, so starting it yourself as well is fine. |
| **`nodeHost(content, { request })`** | For an app that keeps its own `node:http` server: add its `request` and `upgrade` listeners, call `content.start()` once it listens and `content.close()` when it stops. Wrap a fetch-style app with `nodeListener(app, { scheme })`, not `toRequest` and `sendResponse` by hand: `toRequest` throws for a request fetch can't take, and a throw in a listener ends a Node process (`nodeListener` answers 405, 400 or 500, P092). Pass `onError: (error, request) => …` to any of them to hear your own failures. |
| **Request bodies** | An unread one is drained for at most 1 MiB and 5 s after the answer, then the connection closes, so an app that answers before reading an upload is cut off. |
| **Behind an edge that rewrites headers** (a CDN, a proxy) | Pass Porthole's `Content-Security-Policy` on unchanged: in a tab of its own a served page has no frame, and the header's `sandbox allow-scripts allow-same-origin` is its sandbox (P099). The conformance runner's `served.domain.tab-*` cases fail if it is lost. |

### Pages made of many files

A stored version may be a set of files (a build's output, a report with its images; P081): the store
answers a manifest and the bytes by path; `{ html }` stays one page. How they are served: DESIGN.md
§ "Isolation modes and served content".

```js
import { checkFileSet, fileLimits, versionBase, versionedAddress } from "@botiverse/porthole/server";

// At publish: every path canonical, within your page kind's limits ([] to take it).
const problems = checkFileSet(manifest, { limits: fileLimits(pageConfig.limits) });

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

| Rule | Detail |
| --- | --- |
| **Files are served from the manifest only** | Typed by their extension, never by the type they were published with (P082). `read` returns the whole file (`Uint8Array` or a stream); Porthole cuts ranges. |
| **A page never mixes versions** | The latest's address (`/`, `/style.css`) goes first to the version's own (`/v/3/`, `/v/3/style.css`). Answer `entry.at` with the version's `base`, and `pinned: true` when that base names one version only (its files are then immutable); a plain instance is served at a frame's address instead. A base's segments are letters, digits and `. _ : ~ -`. |
| **An artifact's versions share an origin** | They are one trust domain (P082): give versions that must stay apart scopes of their own. `/_blob/` (`ASSET_LIBRARY_PATH`) is the asset library's, across versions; `versionedAddress` names nothing there. |
| **Which page the frame is on** | A link opens another page of the set in the same frame (P084). `display.on("page", ({ page }) => …)` (React `onPage`) tells each page it moves to, as a place names it (`"./report.html"`, P155), once per page and after `initialized`; each run (`initialized`) starts on the page you framed. Show that page's comments and file comments on it there. Not for a link within a page (ask `annotations.place()` for the fragment). The page's word (P156). |
| **The agent's side** | `lintFiles` and `admitFiles` before you take a version, `checkPage({ files })` to run it, and the manual's Files section where a kind serves files. Show a set served: an opaque frame has no origin to serve its files from. |

### A page's own nested frames (opt-in)

By default the shell refuses every nested frame content makes: markup frames are removed, and a
script that creates one (`createElement("iframe")`, `object`, `embed`, …) gets a `NotSupportedError`
at that line (P130). The manual and the lint tell agents to build pages without them. Pasting or
dropping formatted content into an editable element inserts its plain text only.

`nestedFrames: "own"` (P128) in a kind's `options` lets a page keep an `<iframe>` of one of its
version's own files (a relative `src`, served kinds) or with `srcdoc` (every kind), as Claude's
Artifacts do. Frames of other sites, `<object>` and `<embed>` stay out; url mode and live widgets
refuse it. It is a weakening: a nested frame runs without the shell's defenses (WebRTC past
`connect-src`, clipboard writes from a click with no notice; THREAT_MODEL.md S1), though the CSP
still governs every frame's loads and navigations. Turn it on only where your product accepts that.

### The capability runtime: pages that are apps

A page reaches your services through one global, `porthole.use(name)`, for what it declared when it
was published and what its viewer's level allows. Porthole carries, checks and gates the calls; you
keep the services. It is an optional layer over the display. How it works: DESIGN.md § "The
capability runtime". What it adds to your side:
[THREAT_MODEL.md § The display layer and the app runtime](THREAT_MODEL.md#7-the-display-layer-and-the-app-runtime).

```js
import { declareCapabilities, presets } from "@botiverse/porthole";

// 1. The kind's config offers the runtime and the host functions behind it.
const page = presets.artifact({
  isolation: "domain", contentOrigins: [source], runtime: "1",
  capabilities: { copyText: {}, openLink: {}, comments: {}, user: {}, artifact: {}, assets: {}, db: {} },
});

// 2. At publish, the artifact's declaration (omitted: carried forward; {}: cleared; an object: replaced).
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
  // true if it opened; never over the person's own words or place (inUse). A page's draft: below.
  comments: ({ anchor, draft }) =>
    composer.inUse() ? false : draft === undefined ? composer.open(anchor) : openPageDraft(composer, anchor, draft),
},
// 5. The mount: this version's declaration within the artifact's current one; null for a page stored
//    without one (required under a runtime). A stored declaration of the wrong shape is a problem to
//    show, never a mount with null or with either declaration alone (P093).
const shown = version.declaration ? tryIntersectDeclarations(version.declaration, artifact.declaration) : null;
if (shown && !shown.ok) return <VersionError problems={shown.problems} />;   // "This version can't be shown"
<PortholeView display="page" instance={instance} declaration={shown ? shown.declaration : null} />
```

| Rule | Detail |
| --- | --- |
| **Built-ins** (`clipboard`, `links`, `downloads`, `comments`) | Reach every page whose kind offers them; everything else only a page that declared it. A page stored without a declaration takes the legacy path (the built-ins through `use`, and the legacy globals): give it a declaration when it is next published. |
| **Levels** | `view < interact < admin < owner`. Reads are `view`; `chat.send`, `data.call`, `context.set` and db writes `interact`; `artifact.publish` and asset removal `admin`; uploads `admin` unless `assets: { levels: { upload: "interact" } }` (then the library's scripts and styles never run: P089). Raise any method in its config's `levels`. Without a viewer the runtime's own are refused. |
| **Your API is the wall** | Your handlers call your API as the viewer, and it checks again from its own session and stored declaration, never from `context.viewer` or `context.declared` (a page past the bridge could forge them). `dbAccess(request, viewer, rules)` is the db rule set, `atLeast(level, "admin")` for a publish. Hold every write to an existing document to its `ifVersion` (updates and deletes too), apply a batch in order against one state, refuse a moved base or version with `new Refused("conflict")`, and check and admit a merged version as any other. |
| **Per version** | Store each version's declaration with it and mount it with `tryIntersectDeclarations(version's, current)` (`intersectDeclarations` throws its problems as a `TypeError`); your API's rules for it are that intersection's. |
| **Details** | `dbAccess` holds `Votes/a` to its exact name's rule (else `*`'s) and to any rule naming it in another ASCII case, so a store that folds case is safe with it; paths reach your handler as the page wrote them, and a publish naming a collection twice in different cases is refused. Checked declarations have no prototype: use `Object.hasOwn` and `JSON.stringify`. `Grant.user.id` is one path segment, never `me`; `pseudonymFor(secret, artifact, person)` keeps pages from linking a person across artifacts. |
| **Assets** | `createContentHost({ assets: (id, access) => myStore.asset(id, access) })` answers `{ scope, artifact, name, size, sha256, trusted?, read }` for an id you made (`ASSET_ID`: 32 random hex characters). `/server` serves it at `/_blob/<id>` on that scope's origin only, to an access for that artifact, after your check, revalidated at each load. Store an upload's `trusted` (set by the bridge) and give it back: other code-typed assets are downloads, and a trusted script runs only while the config still lets uploaded code run (P103). Pages show assets with `assets.url(id)`. `{ get, bearer: true }` serves by id alone, an opt-in for public artifacts; then every artifact config your server has must let uploaded code run, or all code is a download. Refuse names that aren't assets (`assetNameProblem`). |
| **The agent** | Declares capabilities in your publish tool (`capabilities: { db: {} }`) and reads the manual's topic `capabilities`, with each one's types (`types/runtime/v1/*.d.ts`, also in the package). |

**A page's draft in your composer** (P108): `comments.open` reaches your handler whenever the page
calls it (30 a minute by default), with no proof of a click (P149). Whether the composer opens is
yours to say (not while the person is writing, or after they closed several unused). A composer the
page filled is the person's to act on:

```js
function openPageDraft(composer, anchor, draft) {
  // Beside the frame, without focus: keys stay where the person was typing.
  composer.open(anchor, { text: draft, focus: false }); // where your composer focuses, focusField
  guardPresses(composer.element).placed(); // no press for 500 ms (§ Annotations)
  // Said by you, outside the frame, until they edit it: never shown as one of their own drafts.
  composer.setNote("Suggested by this page");
  composer.input.addEventListener("input", () => composer.setNote(null), { once: true });
  // Enter sends only once the person has focused or edited it themselves; until then Send is a click.
  let theirs = false;
  for (const type of ["pointerdown", "focus", "input"]) {
    composer.input.addEventListener(type, () => (theirs = true), { once: true });
  }
  composer.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !theirs) event.preventDefault();
  });
  return true;
}
```

Never replace, append to or retarget what the person wrote. Show the draft whole, as plain text,
and the anchor's `label` and `quote` as isolated text (`<bdi>`, `dir="auto"`). Nothing one click
away posts, submits or discards. The full list: THREAT_MODEL.md §7 "The app runtime".

**Run the conformance cases** against your handlers (no browser). `api` is your own API for the
same artifact, signed in as `viewer` with that person's real session: the cases past the bridge
then forge the context, as a page past it could.

```js
import { defineRuntimeConformance } from "@botiverse/porthole/conformance";
for (const each of defineRuntimeConformance({ config: page, viewers, handlers: () => freshArtifactHandlers(),
  assets: () => assetStore, api: (handlers, viewer) => apiAs(handlers, viewer) })) test(each.name, () => each.run());
```

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
aren't, and null until the meta is known, so a frame never starts opaque and then restarts served.
The client's functions take no `this`: pass them bare
(`useSyncExternalStore(porthole.subscribe, porthole.meta)`). A client module that fails to load
shows nothing at all: catch its import and say so (`examples/app.mjs` does).

Draw the fallback from `outcome` only: a `blocked` outcome is the word of Porthole's own pages,
never the content's (P124, P125), except a url-mode app's, which can say any outcome (THREAT_MODEL
S6). A frame status Porthole doesn't take (an opaque frame's, or one said after a frame's first
word) reaches you as a `hostError` of kind `"frame-status"`: log it, show nothing.

**The door (P125).** `createHost` takes a served display's outcome from its **door** (a page of
Porthole's on the display's origin, in a hidden opaque frame the content can't reach;
`FrameLocation.door`, which `issue` returns), never from the content frame, whose silence is a
`timeout`. Why: THREAT_MODEL.md §7 "The host's fallback". `createHost` and `/server` wire it. Yours:

| Your part | Detail |
| --- | --- |
| **Deploy the server (or your content Worker) before the host** | A hard requirement: a host given a served location with no door builds no frame (`blocked: locate`, and a `hostError` of kind `"door"` naming the fix). |
| **A custom locator passes `door` through unchanged and issues anew for every run** | `locate` is called again on every run (a reload, a restart after the content navigated away): answer each with a fresh issue (a new ticket and door ticket). A reused location's door says `blocked: session` ("this link has been used"), with a `hostError` of kind `"locate"`. `httpLocator` and the host kit's client already do both. |
| **A platform of your own** | One wrapping `webPlatform.createSurface` must also give `createDoor` (delegate to `webPlatform.createDoor`), or it frames no served display. |
| **The door sits in the display's container while it decides** (a hidden 0×0 frame, `data-porthole-door`) | Select `iframe:not([data-porthole-door])`, not the first `iframe`. |
| **A clean address is for a tab** | Never give `createHost` a clean address (`urlOf`, `link`) as a frame's location: it has no door, so it is refused. Resolve it through your issue endpoint first: `client.resolve(address)` (or `<PortholeView address>`) answers the location for what it names (a file set's page below its version opens at that page), or the refusal its tab would get. |
| **A locate's refusals** | Become the outcome, with no frame built: 401 `blocked: sign-in`, 403 `blocked: denied` (with your `error.reason`, if given), 404 `blocked: not-found`, any other failure `blocked: locate` with a `locate` host error, and no answer a `timeout`. |
| **A content Worker of your own** (answering the content origins instead of `/server`) | Serves the door too. `issue` mints the door ticket and returns `door: { url }`. The Worker routes `DOOR_PATH + <key>` (`/__porthole/door/<key>`) on every label: it takes the door ticket (`TicketRecord.door === true`, bound to the label and key), runs the access, document and entry checks the content route runs for that grant, then answers `doorResponse({ hostOrigins, framedBy })` or `doorStatusResponse({ status, reason, code?, hostOrigins, framedBy })` (401 `session`, 403 `denied`, 404 `not-found`, 500 `error`). It refuses a door ticket at `/__porthole/d/`. All three are exported from `@botiverse/porthole/server`. |
| **A host that signs its own tickets** (P126) | Its Worker holds no Porthole ticket for the door: answer it with `await server.doorAnswer(instance, grant, request)` on the object `createServer` returns (pass the request: `authorize.check` sees it; `{ page }` as a fourth argument for a file set's page below its version). Its Worker first verifies its own ticket (signature, single use, bound to the label and the instance, a door's and never its content's) and recovers the grant. `doorAnswer` gives exactly what `/server`'s door route gives after its ticket (the host's `authorize` check, the document and version, the entry, the door's CSP, no cookie), but takes no ticket and checks nothing about the request but its method: **you must have authenticated the request and established the grant yourself**, as for `issue`. It throws for an instance with no door (a url-mode app) or one `issue` would refuse. The content route still takes its own ticket and checks again (P050). |

**Without a bundler**, the page gets Porthole's browser modules from your server (`examples/app.mjs`
does all three):

1. Serve the package's `dist/` at a path of your app's (`/porthole-client/`, `.js` files only). On
   Workers it is the static assets directory (`assets.directory`, with `run_worker_first`).
2. Map the bare name in an import map that carries the page's nonce:
   `<script type="importmap" nonce="…">{"imports":{"@botiverse/porthole":"/porthole-client/index.js"}}</script>`.
3. Serve the page its display kinds at `/porthole-client/displays.mjs`, as a module made from the
   same plain object the server's `defineDisplays` gets, so they never disagree:
   `` `import { defineDisplays } from "@botiverse/porthole";\nexport const displays = defineDisplays(${JSON.stringify(kinds)});` ``

**React**: give the provider the client and show a kind. Flipping `scheme`, or a new `themeKey`,
re-themes running frames in place. Rendered on a server, `PortholeView` draws what the client's meta
says: give `portholeClient` the meta it starts with (`meta`, from your page's data), or it renders
`pending`.

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
- **An opaque display inherits your page's CSP**; its own policy narrows it, never widens it. If your
  page sets `default-src`, also allow what agent content uses inline: `img-src data: blob:`,
  `media-src data: blob:`, `font-src data:`, `style-src 'unsafe-inline'`, `worker-src blob:`. A
  nonce-based `script-src` works: give `createHost` the nonce (`HostOptions.nonce`) and the shell
  runs content's scripts under it.

### Sign-in

| What | Detail |
| --- | --- |
| **`next`** | Your sign-in page gets the authorize URL as `next` (`signIn`'s `returnTo`) and goes back to it when signed in. The authorize URL is `<first app origin>/porthole/authorize` unless `entry.authorizeUrl` names another; `next` is built from it with the entry's state, never from the address the request arrived at (behind a TLS edge or a dev proxy, that isn't your app's). |
| **Check `next`** | `entryTarget(next, authorizeUrl, { app: true })` (in the page, `porthole.entryTarget(next, { app: true })`) answers the authorize route or any page on your app's origin, as an absolute URL, and null for anything else (another site, `//host`, `/\host`, `javascript:`). One check serves sign-ins that go back to a page and to a frame's content. Without `{ app: true }` it takes only the authorize route. |
| **Warning: no `form-action 'self'` on a sign-in page that posts a form** | `form-action` holds every redirect of a submission, and redirect entry continues from your sign-in through the content origin, so the browser blocks the last hop and the person stays on your sign-in. Leave `form-action` out of that page's CSP, or add the content source. |
| **A page that authenticates with a token** (a single-page app holding a bearer token, a desktop app) | It has no cookie for the authorize route to know the viewer by: use the viewer handoff (P072). Give `entry.handoff: { id: (viewer) => viewer.id, viewer: (id) => lookUp(id) }` on the server and `portholeClient({ displays, headers: () => ({ authorization: `Bearer ${token()}` }), handoff: true })` on the page. It posts to `/porthole/handoff` with your own credential (refused from another origin), on load and when the page regains focus, and gets an `HttpOnly` cookie scoped to `/porthole` holding a key Porthole signs: the viewer's id and ten minutes, no credential for your API. An expired one costs only a quiet trip through your sign-in route. `entry.spa: { route: "/sign-in" }` sends a signed-out person to your app's route with `next`. |

### Url mode: a relay of your own

`proxyTo` relays a url-mode app by HTTP. A relay of your own (over your own transport) uses the same
parts: `upstreamHeaders.request(headers, { origin, target, websocket })` and `.response(...)` (the
header rewrite, Porthole's cookies kept out), `statusPage({ status, title, detail, reason,
hostOrigins })` (a page that tells the frame's host why it shows nothing, desktop schemes included),
and `nodeHost`'s `appSocket` (a WebSocket, Porthole's cookies already removed).

What other origins get (P101): the app's cookie opens it only for its own origin and for a
navigation that opens it (GET or HEAD); anything else another origin sends is a 403 that never
reaches the app or your `authorize.check`. A WebSocket opens from the app's own origin only
(`access(request)`, asked by `nodeHost` before `appSocket` and by a Worker on its own upgrade path).
The full rule: [THREAT_MODEL.md § S6](THREAT_MODEL.md#s6-previews-of-a-running-app). An app whose
sign-in posts back from another site (OpenID's `form_post`) can't sign in through the preview; a
tab's `Lax` cookie doesn't go with that post either.

## 5. Cloudflare Workers

Route the content domain's wildcard (`*.<content domain>/*`, with wildcard DNS and a certificate for
every level served, `*.f.<domain>` included) and your own domain to the same Worker, or the content
domain to a Worker of its own.

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

| What | Detail |
| --- | --- |
| **`contentHostFor`** | Makes one content host per `env`, the first time a request needs it. While the settings can't be served (no `PORTHOLE_SECRET`, a content domain sharing a site with the app), every request gets a plain 503 naming the problem, logged once (`{ log }`), instead of a stack trace. `porthole.host(env)` is the host itself (`frameSources` for your CSP) once `fetch` has answered null. Settings fixed at build time (no `env`) can make one `createContentHost` at module scope instead; a bad setting then fails the Worker as it starts. |
| **Tickets in D1** (never KV, which is eventually consistent) | `npx porthole d1-schema > migrations/0001_porthole_tickets.sql`, then `wrangler d1 migrations apply <db>`. |
| **`PORTHOLE_SECRET`** | `npx porthole secret`, then `wrangler secret put PORTHOLE_SECRET` (`.dev.vars` locally). It signs tickets, cookies, entry codes and handoffs. |
| **Static assets** | Set `"assets": { "run_worker_first": true }`, or Workers serves your static files before the Worker runs, on every host, content origins included. |
| **Locally** | No `nodejs_compat` needed. `wrangler dev` passes the Host through, so `*.content.localhost:<port>` works locally. |

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
`<noun>_guide` and `check_<noun>` (`show_page`, `page_guide`, `check_page` for a page); naming them
in the config also has the manual name them. The descriptions are the manual's own words.
`examples/mcp/server.mjs` wires all three as an MCP server.

| What | Detail |
| --- | --- |
| **`admitContent`** | Runs `lintContent` and refuses (by default, `refuseOn: "error"`) only what would certainly fail or be cut: over the size limit, a document with no body where a fragment goes, nested frames, `document.write`. Its refusal says exactly what to change. Everything else (hosts outside egress, unpinned libraries, `alert`, forms, the clipboard…) comes back as warnings with the result. `refuseOn: "never"` only warns. |
| **`guideChanges(from, to)`** | The notice for the agent when a kind flips between served and opaque (null when its manual reads the same). |
| **`errors: "agent"`** | Sends what content throws (and what the sandbox blocks, and a navigation the shell stopped, P080) back to the agent once people see it: listen for `contentError` and pass it on. |

### Checking a page before people see it

`checkPage` (`@botiverse/porthole/check`) runs the content in the real sandbox at the manual's phone
and desktop widths, light and dark (served configs served, on an origin of their own; nothing goes
to your server), with every host function answered as a declining host would. Its report's `text`
is a few lines for the agent, each problem once with its line (at most 8): what it threw, what was
blocked or failed to load, `console.error`, overflow, a cut height. How it works: DESIGN.md §
"The agent's side: lint, check, tools".

```js
import { checkPage, playwrightDriver } from "@botiverse/porthole/check";
const report = await checkPage({ config, content: html, driver: playwrightDriver(browser) });
report.ok; report.text;
```

It needs a browser somewhere. Chromium is best: WebKit mutes a thrown error's message in an opaque
frame (the agent reads only "Script error.") and names no line in a served one.

- **A server with Chromium** (Node): `playwrightDriver(await chromium.launch())`.
- **An agent on a person's machine, maybe without Chromium** (Ferry's daemon): run `lintContent`
  there (no browser needed) and send `check_page` to your server, which runs `checkPage`; or use
  Playwright where it is installed (`examples/mcp/server.mjs` falls back to the lint, saying so).
- **Cloudflare Workers**: Browser Rendering, through a CDP session:

  ```js
  import puppeteer from "@cloudflare/puppeteer";
  import { cdpDriver, checkPage } from "@botiverse/porthole/check";
  const browser = await puppeteer.launch(env.BROWSER);
  const tab = await browser.newPage();
  const report = await checkPage({ config, content, driver: cdpDriver(() => tab.createCDPSession()) });  // no cast
  await browser.close();
  ```

**Bundling**: every entry point bundles whole (a Worker, a single executable): nothing is looked up
beside a module at run time. `/conformance` still looks for the optional MCP Apps App SDK where it
runs; without it, the App SDK probes say so and don't run.

## 7. Conformance: prove your integration

`@botiverse/porthole/conformance` runs Porthole's suite (egress and escape probes, the served cases,
redirect entry) against your app's real page, its CSP and session, in Playwright:

```js
// playwright.config.mjs
import { defineConfig, devices } from "@playwright/test";
import { conformanceProjects } from "@botiverse/porthole/conformance";
export default defineConfig({
  fullyParallel: true,                                       // else one spec file is one worker: minutes longer
  reporter: [["list"], ["@botiverse/porthole/conformance/reporter"]], // why each skip was skipped, not a bare "-"
  projects: conformanceProjects(devices, { engines: ["chromium", "webkit", "firefox"] }), // the default
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

| What | Detail |
| --- | --- |
| **Test mode** | The suite names its own scopes, so an app serves them through a test mode (`examples/app.mjs`: `PORTHOLE_CONFORMANCE=1`): the test page under `t-<scope>`, and a private page. **Never ship test mode**: with it, anyone signed in can make content origins of their choosing. |
| **Fixtures** | `onDemand(make)` memoizes fixtures made the first time a case asks (a page published on demand); `instances` and `entry.url` may be async. The tests are located at your `defineHostConformance` call, so `playwright test porthole.spec.mjs` selects them. |
| **Browsers** | Each engine needs its own (`npx playwright install chromium webkit firefox`); a subset is `engines: ["chromium"]`. Where Playwright has no build of one (arm64 Linux's Chromium), point at the system's: `launchOptions: { chromium: { executablePath, args } }` in `conformanceProjects`' options (`executablePath: "/usr/bin/chromium"`), merged with Porthole's own (`use` adds to every project's). |
| **Skips are facts about your page, not failures** | The leak probes run opaque displays on your page; where its CSP closes what a probe needs, the probe reports itself inapplicable, naming the directive. A page with a `default-src` sees `[1.connect]` and `[2.resources]` skipped, its `connect-src` already closing what they probe. The reporter prints each reason at the end; so does `--reporter=json`. |

## 8. Expected, and how to tell

| You see | Why |
| --- | --- |
| Chromium logs `Unrecognized Content-Security-Policy directive 'webrtc'` for every frame | The directive closes WebRTC where an engine knows it and is ignored where it doesn't. |
| Content's CSP allows `'unsafe-eval'` | Content is the agent's own script already (`'unsafe-inline'`), so eval adds no capability, and libraries compile with it (Vue's in-browser build, Alpine.js, Vega's expressions, WebAssembly). Egress, the sandbox and the origin isolate it (P071). |
| Session cookies `porthole-<key>` on `http` loopback, `__Host-porthole-<key>` on `https` | Only that name is read (P101: a sibling label can set any other for the whole domain). A frame's are `Secure; SameSite=None; Partitioned` on loopback too: browsers keep `Secure` cookies on `localhost`. |
| A served frame is one iframe on the content's own origin (no frame inside it), first loaded at `/__porthole/d/<key>?ticket=…` | In a test: `page.frameLocator('iframe[src*="/__porthole/d/"]')`. |
| A clean address that names nothing (a label the naming never makes, the bare domain, a path `entry.at` says has nothing) is a 404 on the content domain | It never reaches your sign-in. |
| Host errors name the content origin | They leave out ticket URLs. |

## 9. Reference

| Import | What |
| --- | --- |
| `@botiverse/porthole` | `createHost`, `presets`, `defineDisplays`, `portholeClient`, `frameFallback`, `entryTarget`, `lintContent`, `admitContent`, `showTool`, `guideTool`, `checkTool`, `answerGuide`, `guideChanges`, `compile` |
| `@botiverse/porthole` (the runtime) | `declareCapabilities`, `declarationProblems`, `checkDeclaration`, `dbAccess`, `atLeast`, `methodLevel`, `rosterOf`, `assetNameProblem`, `RUNTIME_CAPABILITIES`, `RUNTIME_TYPES`, `Refused` (`conflict`, `forbidden`, `too_large`); `types/runtime/v1/*.d.ts` |
| `@botiverse/porthole/react` | `PortholeProvider`, `PortholeFrame`, `PortholeView`, `usePortholeLink`, `cssVariableTheme`, `useRunAgain` |
| `@botiverse/porthole/server` | `createContentHost` (`routes`, `forget`), `contentHostFor`, `prefixedName`, `memoryTicketStore`, `d1TicketStore`, `upstreamHeaders`, `statusPage`, `conformancePage`, the callbacks' types |
| `@botiverse/porthole/node` | `nodeServer`, `nodeHost`, `nodeListener`, `nodeProbe`, `toRequest`, `sendResponse` |
| `@botiverse/porthole/check` | `checkPage`, `playwrightDriver`, `cdpDriver` (`CHECK_ORIGIN`, `CHECK_CONTENT_DOMAIN`: the names a driver of your own answers); `/check/page`, the check page's script (`checkPage` has it already) |
| `@botiverse/porthole/mcp` | the MCP Apps adapter (views, the sandbox proxy) |
| `@botiverse/porthole/conformance` | `defineHostConformance`, `conformanceProjects`, `onDemand`, `conformancePage`, `defineRuntimeConformance` (no browser); `/conformance/reporter`, skip reasons |

The types' doc comments are the precise reference; DESIGN.md § "The host kit" is the long form.
