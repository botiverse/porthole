# Changelog

`@botiverse/porthole`. Each release is a `v*` tag; the reasons for every change are in
[docs/DECISIONS.md](docs/DECISIONS.md), by the P-numbers below.

## Unreleased

- **A comment's draft from the page** (P108): `comments.open(anchor, { draft })` opens the host's
  composer starting with `draft` (at most 2,000 characters), which the person edits and posts, or
  doesn't; the handler gets `{ anchor, draft }`. The page still never posts or reads a comment. A
  draft is visible text only (P100's `unseen`): anything else is refused before the handler.
  - **Hosts:** show the draft whole, as the person's editable plain text; post it only on their
    Send; arm the composer as THREAT_MODEL §6 arms a view the content brought (no press, and no
    Enter that sends, for 500 ms; Send not focused). `defineRuntimeConformance` now sends a draft.

## 0.11.0

The agent hears, before publishing, that its page's own styles hold it to one screen (P106), and
the manual says a page scrolls as a document. A host can mark a person's unposted comments,
drafts, apart from posted ones (P107).

- **A warning for a page held to one screen** (P106): `lintContent`, `admitContent`, `lintFiles`
  and `admitFiles` warn (rule `scroll-lock`, never an error: a one-screen app means it) where the
  page's own CSS stops it at its first screen in the frame: html or body with `overflow: hidden`
  (or `clip`), or the body's one element of content (`#root`) one screen tall (100vh, dvh, svh,
  100% of a one-screen parent, fixed at the frame's edges) with `overflow: hidden` or
  `position: fixed`, and no element in the page's markup below body scrolls itself (by
  `style=""`, a Tailwind class, or a rule whose selector matches it: the page may scroll there;
  the root counts only where it is one screen tall, or, in a one-screen body, under a flex or
  grid body or in a height it can't read). A
  page its script draws (an empty `#root`) has nothing to match: it is warned as one that "looks
  held", which it may ignore if a box its script draws scrolls the content. It reads `<style>`,
  the version's linked stylesheets and their `@import`s, `style=""` on those elements, and
  Tailwind's utilities where the page loads Tailwind, by the cascade (specificity, order,
  `!important`, layers), so a later override is seen; each sheet once, at most 32 and 4 MiB a
  page (its own `<style>` included), 1,024 layers, and layer names of 256 characters. The warning names what holds the page and
  the rule that undoes it, e.g. `add html, body, #root { height: auto; overflow: visible;
  position: static } after those rules`; only values of a known shape and plain selectors are
  echoed (and the root's id, else `body > div`, or `body > *` for a custom element), each at most
  60 characters with its `!important`. In `lintFiles` it reads the entry and at most 7 other
  pages (path order), within one budget for them all (8 MiB of stylesheet, two million match
  steps); past either, the pages left aren't checked, and one warning says how many. In `lintFiles` its `path` is the stylesheet's, where
  the rule is there. Not read: rules under `@media` (but `all` and `screen`), `@supports`,
  `@container`, `:is()`/`:where()`/`:not()` and sibling selectors, nested rules, `var()`, scripts.
- **The manual** (every kind): "It scrolls as a document: unless it's meant to fit one screen (a
  game, a canvas), don't hold html, body or the element that holds it all to one screen …; a box that scrolls by itself takes the wheel while the
  pointer is over it: keep those to parts of the page, never the whole of it."
- `LintRule` and `FileFinding["rule"]` take `"scroll-lock"`.
- **Drafts** (P107): `AnnotationMark.kind` is `"posted"` (the default, as absent) or `"draft"`. A
  draft is drawn with a dashed underline (a dashed outline on an element) and a hollow marker with
  no number, beside its words as a posted marker is; its click is `activated`, its place
  `anchored`, and it is followed after a scroll, with or without a count. Posted marks are drawn,
  sent and reported as before.
  - **The page reads which marks are drafts**: send a person's drafts only to the frame that person
    views (THREAT_MODEL §7). A draft's `count` is dropped before the frame.
  - **Upgrade the content server's Porthole before sending drafts**: the shell is the content
    server's. A shell before this one, given a draft by a newer host, draws it as a posted mark
    without a marker (a solid underline, nothing to click), not apart.
  - Any other `kind` is refused, as a bad anchor is: `annotations.show` throws; React's
    `annotations` is refused (`onHostError`, kind `"annotations"`).
  - New: `AnnotationMarkKind`.

## 0.10.0

After the review of P104 (P105): a host guards the view a marker's click opens, `activated` needs
a gesture, follow-ups share one clock, and text markers sit beside their line instead of over the
next word. What a host must act on comes first.

- **Act on these when upgrading:**
  - **Guard the view a report opens or moves** (P105, THREAT_MODEL §6): a comment's bubble opened
    on `activated`, or a composer placed by `selected` or `anchored`, takes no press of any kind
    for 500 ms after it appears or moves, ignores a press that began before that, opens beside the
    frame where the layout allows, takes no focus, and has no destructive action one click away.
    The content chooses when it appears and where, and can bring it under the person's own press
    in the content. ADOPTING.md § Annotations has the code (`guardPresses`: the view `inert` while
    it arms); its portaled menus and popovers go in a container inside it, or are guarded too.
  - **`activated` is taken only within a gesture** (P105): while the host's page has transient
    user activation, as a real click or tap on a marker gives it. A custom `PlatformHost` whose
    `userActivation()` answers `false` (rather than `undefined`, can't tell) drops every marker
    click, as it refuses every gesture-gated call. A gesture anywhere on the page in the last 5 s
    lets a fake through: the guard above is the defence.
  - **`selected` comes again after a scroll only when its box moved** more than 0.5 px, and on the
    same clock as `anchored`'s follow-ups: at most one report a second together (P105). A host's
    button placed by the selection's box can lag a scroll by up to a second; the person's own new
    selections are told at once, as before.
  - **`parseAnchor` takes out of a label everything the person can't see** (P105): every format
    character (bidi controls, zero-width ones), default-ignorable code point, variation selector,
    tag, private-use character and control. A label stored before may come back shorter;
    selectors are kept as they are.
- **Text markers beside their line** (P105, #36): centred on the anchor's last line, in the line's
  gutter past its block; at the frame's right edge where the frame is too narrow; past the line's
  last word where something else is beside the block (a table's cell, a card). Never over another
  word but where two or three anchors end on one full line of a narrow screen; the number alone
  where the bubble with its glyph doesn't fit. The pointer on a marker lights its words. A tap on a
  marker is reported on WebKit too (it was never, since 0.9.0).
- **What the shell guarantees, said against what** (P105): a marker's press is unheard and can't
  be cancelled, and the layer out of reach, against content that patches none of the built-ins.
  The shell now reads and stops a press through the platform's own functions, so patching
  `Event`'s or `MouseEvent`'s prototypes no longer lets content hear or suppress it; reaching the
  layer's nodes through other built-ins still works (nothing there is secret).
- **A custom platform's `viewport()` that answers no size or throws** clamps every box to nothing
  at the frame's corner, and nothing throws out of the frame's listener (it raised a TypeError).
- Negative controls `marker-prevent`, `marker-originals`, `marker-tap`, `marker-place`,
  `follow-throttle`, `follow-count`, `selection-follow` and `annotation-activated-gesture`, in
  `scripts/controls.ts`.

## 0.9.0

Annotation markers (P104): a host can show how many comments sit at each anchor, hear a click
on one, and follow the marks as the page scrolls. Every box a page reports is now held to the
frame, which changes what a host hears for a mark outside the viewport (below).

- **Annotation markers** (P104): `AnnotationMark.count` (0 to 999, `ANNOTATION_LIMITS.count`)
  draws a small bubble with the number ("99+" above 99, the bubble alone for 0) at the end of a
  text anchor and on an element's top right corner; that element's outline is then a thin line.
  A click on a marker reaches none of the content's handlers and is reported as a new
  `AnnotationReport`, `{ type: "activated", id, rect }` (`porthole/annotate.activated`), taken by
  the host only for a mark it shows with a count. Open the host's own view of that mark with it,
  never act on it: the content can fake it, can read every mark's count, and can tell that a
  marker was pressed, and roughly where (it can't act on or cancel the click). Markers have no
  tab stop; the host's own list of marks is the keyboard path.
- **Marks follow a scroll** (P104), while any mark has a count: once a scroll, a resize or a run of
  content changes has settled (150 ms), `anchored` reports only the marks that moved since the
  host was last told, at most once a second. A host that gives no counts hears exactly what 0.8
  told it.
- **Reported boxes are clamped to the frame** (P104): every `rect` in `selected`, `activated`
  and `anchored` reaches the host held to the frame's viewport as it is then; one wholly outside
  becomes a box of no size on the nearest edge. A page can no longer make a host place its own UI
  outside the frame. Act on this when upgrading: a mark scrolled out of the viewport is now told
  on the edge it went past (below: `y` equals the viewport's height, `height` 0), not at its
  place beyond it. A custom `PlatformHost` gives its surfaces `viewport()` (the new optional
  `Surface.viewport`), or every box reaches the host as nothing at the frame's corner.
- **Wordless elements are named** (P104): a picked element with no text of its own (an image, an
  icon button, a chart) is labelled by its `alt`, `aria-label` or `title`, in that order, instead
  of its tag and classes alone.
- Negative controls `annotation-rect-clamp`, `annotation-activated`, `annotation-activated-count`,
  `marker-trusted` and `marker-click`, in `scripts/controls.ts`.

## 0.8.0

The fixes from the security review of 0.7.0 (2026-10-19): P092–P095, P098–P101 and P103, each
with its regression; a release that waits for its commit's CI (P097); and a threat model (P102).
Most of it refuses more than 0.7 did. What a host must act on when it upgrades comes first.

- **Act on these when upgrading:**
  - `callTool` defaults to a confirmation and 30 a minute; it was a confirmation alone (P103). A
    host whose `confirm` says yes by itself, for a view that polls a tool more often than every
    2 s, gives `callTool` its own `gates`.
  - `setModelContext` defaults to 30 a minute and the new `show` gate (P100): the host shows the
    person each update, whole, before it goes. Give `createHost` a `show` (`HostOptions.show`), or
    the call is refused (`no-show`); the React provider shows updates with `ContextNotice` unless
    `PortholeProvider.show` replaces it. A config that names its gates without `show` says so with
    `withoutShow: true` (else it is warned of).
  - Behind a proxy, set `rateLimit.trustedProxies` (how many proxies append to
    `X-Forwarded-For`) or `rateLimit.key`. The issue endpoint's rate limit no longer reads
    `X-Forwarded-For` by default: it keys an anonymous request by the socket's peer on Node and
    `CF-Connecting-IP` on Workers, so without either setting every anonymous request through a
    proxy shares that proxy's limit (P092).
  - `callTool`'s arguments, `setModelContext`'s update and `downloadFile`'s contents are bounded
    plain JSON or refused as malformed: an object reached twice, a `Date`, a `Map`, `NaN` or a
    boxed value no longer passes (P095). A model-context update is text blocks and plain JSON, at
    most 20,000 characters (`MAX_CONTEXT_CHARS`), with no invisible characters (P100).
  - Under https Porthole's cookies are only its exact `__Host-porthole-` names: a `porthole-*`
    cookie (which any sibling label can plant) is no longer read; loopback keeps its unprefixed
    names (P101).
  - A url-mode app answers its own origin only: a request with another `Origin`, or with
    `Sec-Fetch-Site` `same-site` or `cross-site` that isn't a GET or HEAD navigation, is a 403, on
    HTTP and on the socket path (`content.access`) alike (P101).
  - Every served page carries its frame's sandbox in its CSP header and a `Permissions-Policy`
    that denies what its frame's `allow` doesn't grant, on a tab as in a frame; on a tab the shell
    opens no window (P099). An edge that rewrites headers keeps both.
  - `presets.liveWidget` refuses a capability's `connect` or `resource` origins, and its config
    is frozen (P103).
  - New: `nodeListener(app, { scheme, onError })` (a fetch-style app as a Node listener) and
    `onError` on `nodeHost`, `nodeServer` and `nodeListener` (P092); `tryIntersectDeclarations`,
    which answers its problems instead of throwing (P093). The objects `intersectDeclarations`
    returns have no prototype (P093).
- **The fixes:**
  - **P092**: no request ends the Node process (a method fetch can't carry is a 405, anything
    else it can't take a 400, a handler's failure a 500); the issue endpoint reads at most 64 KiB
    of a body (`ISSUE_BODY_BYTES`); the rate limit's key is an address the client can't set.
  - **P093**: `intersectDeclarations` reads each side as `dbAccess` does, wildcards included, so a
    version keeps nothing the current declaration refuses; a collection named `__proto__` is a
    rule.
  - **P094**: a page's declared `data` names hold without a viewer; a result pushed with
    `changed(result)` is a read, past `readData`'s gates; a `db` batch runs under its writes'
    `methodGates` and a watch under its read's (`ConfirmRequest.askedBy` says which).
  - **P095**: what content sends is read after its gate, into bounded text, and nothing it sends
    throws out of an adapter; at most 10 confirmations wait per display.
  - **P098**: a page of a file set whose notice arrives late is taken as the set's, not as a
    navigation away (red on Chromium since 0.6.0); tests that waited a fixed time now wait for
    what they check.
  - **P099**: a served page on a tab of its own is sandboxed like its frame.
  - **P100**: what content tells the model is shown to the person first, and what is shown is
    what is sent; the manual calls it the content's unconfirmed text, never instructions.
  - **P101**: siblings on the content domain: only `__Host-` names, an entered mark bound to its
    label, and a url-mode app that answers its own origin.
  - **P103**: a live widget takes no capability's origins; a trusted asset runs as code only while
    the current config lets uploaded code run, in bearer mode too; `callTool` has a rate.
- **Release** (P097): a release is a commit of main whose CI passed, every job of it; the job
  that publishes runs no project code; Actions are pinned to reviewed commits; third-party notices
  for the vendored libraries and the leak suite's fixture.
- **Docs**: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) (P102) says, use by use, what Porthole
  guarantees, what the host must do, and what is out of scope; [SECURITY.md](SECURITY.md) says how
  to report a vulnerability privately, which versions get fixes, and what happens next.

## 0.7.0

The capability runtime (P085–P090): a page published as an artifact is an app, and reaches its host
through one global, `porthole.use(name)`, under a contract pinned per artifact. Porthole provides
the mechanism (declarations, levels, the wire, the gates, the asset library's serving); the app
provides the services behind the handlers. Additive for 0.6 hosts: a config without `runtime` is
0.6's, frames, globals and manual alike.

- **The runtime** (P085): `config.runtime: "1"` (`presets.*({ runtime: "1" })`, inline widgets and
  artifact pages). The shell defines `porthole`, frozen, with `use` only: `await
  porthole.use("db")` is a frozen namespace or null (not offered, not declared, no host: the same
  null), never a rejection. The roster comes in the handshake
  (`hostCapabilities.experimental["porthole/runtime"]`); calls are `porthole/call { capability,
  method, args }`, watches `porthole/event` / `porthole/unwatch`. Contract 1:
  `clipboard`, `links`, `downloads`, `comments` (built in), `user`, `chat`, `data`, `context`,
  `artifact`, `assets`, `db` (declared), each method served by one of the config's host functions
  (`RUNTIME_CAPABILITIES`, the mapping in P085). New host functions: `user`, `comments`,
  `artifact`, `assets`, `db`.
- **Types**: `types/runtime/v1/*.d.ts` (shipped; one per capability and the call contract), taught
  by the manual's new `capabilities` topic with declaring, levels, errors and where state goes.
- **Declarations** (P086): `PageDeclaration` `{ capabilities, runtime }`; `declareCapabilities`
  at publish (omitted carries forward with its pin, `{}` clears, an object replaces),
  `declarationProblems`, `checkDeclaration`; `mount({ declaration })` (React: `declaration`). The
  bridge refuses what a page didn't declare on every path, 0.6's requests included.
- **Levels** (P087): `view < interact < admin < owner`; each method's level (`CapabilityConfig.levels`
  at or above its floor; a page may raise). `Grant.level` and `Grant.user` go in the issue's answer
  (`FrameLocation.viewer`) through `httpLocator` to the bridge; `mount({ viewer })` (React:
  `viewer`) otherwise. Refusals carry new codes: `forbidden`, `conflict`, `too_large`
  (`REFUSAL_CODES`); handlers get `context.viewer` and `context.declared`.
- **State the host keeps** (P088, amending P023): `artifact.get()`/`publish({ base, files })`
  (base-checked, admin), `db` (`get`, `query`, `onSnapshot`, `set`, `update`, `delete`, `batch`,
  `ifVersion`, per-level `rules`, `data/users/<id>` private; `dbAccess` for the host's own API).
- **The asset library** (P089): `ServerOptions.assets` / `createContentHost({ assets })` serves
  `/_blob/<id>` on the asset's own origin (its pages' loads, or a session with the host's check),
  typed by name, never a page, inert, immutable; a page's CSP opens `<origin>/_blob/` for images,
  media, fonts and data, and for scripts and styles only where uploads are the admins'.
- **Comments** (P090): `comments.open(anchor)` opens the host's composer at the page's anchor;
  content hears only whether it opened.
- **Legacy**: 0.6's globals stay (`shell/legacy.ts`), untaught under a runtime, held to a declared
  page's declaration.
- **Conformance**: `defineRuntimeConformance` (`/conformance`, no browser) runs an app's real
  handlers through the bridge and past it; `leak/runtime/memory.ts` is the in-memory reference.
- **Leak suite**: `leak/served/runtime.spec.ts` on Chromium, WebKit and Firefox, with negative
  controls `runtime-declaration`, `runtime-level`, `db-private`, `comments-result`, `blob-trusted`,
  `blob-script,blob-trusted`, `blob-inert`, each required to fail exactly its probes
  (`test:controls`, a CI job per engine).
- **From the security review of the first cut** (P091): assets need an access to their own artifact
  and the host's check (`AssetStore.get(id, access)`, `StoredAsset.artifact`, `trusted`,
  `bearer`; `assets.url(id)`; revalidated), db checks bounded and cheap ones first, gates per
  method (`artifact.publish`, `assets.delete`: a click and a yes; `methodGates`), a batch at its
  writes' levels and a watch at its read's, `data/users/me` in answers, no viewer refused above
  view, own-property rules, watches ended on a new page, code-typed uploads refused where people
  who interact upload, `MountOptions.declaration` required under a runtime (`null` for a page from
  before 0.7), viewer ids one path segment, `intersectDeclarations`, `pseudonymFor`,
  `defineRuntimeConformance({ api })`, `checkPage({ declaration })`, and a 0.6 config's own
  `capabilities` topic kept.

## 0.6.0

A served page may be many files (P081–P084): a build's output, a report with its images, a
dashboard that reads its data, published as it was made. Additive: a store that answers `{ html }`
is served as in 0.5, and so is everything else.

- **The store** (`ArtifactStore.get`, the kit's `source`) may answer a `StoredFiles`: `files`
  (`path → { size, sha256, type? }`), `entry` (default `index.html`), `spa`, and `read(path)` (a
  `Uint8Array` or a `ReadableStream`, whole). The published type is never served.
- **Paths and limits** (`@botiverse/porthole`, `/server`): `checkFileSet(files, { entry, limits })`
  for a host to call when a version is published (canonical, case-sensitive, no `..`/`.`/empty
  segments, no leading `/`, no `\ % ? #`, control or format characters, NFC, length caps, no case-fold
  collisions, no file that is also a directory, the entry present), `filePathProblem`,
  `fileLimits(config.limits)`; the config's `limits.maxFiles`, `maxFileBytes`, `maxVersionBytes`
  (1,000, 25 MiB, 100 MiB by default). `requestFilePath`, `lookupFile`, `fileTypeOf`.
- **Serving** (P081): every file from the manifest only (decoded once; `dir/` its `index.html`,
  `name` its `name.html`, the nearest `404.html`, the entry for a single-page app's navigations),
  typed by Porthole's table (unknown: `application/octet-stream`, a download), `nosniff`, a CSP
  header on every answer (anything but a page or a script: `default-src 'none'; sandbox`), files
  `private, max-age=31536000, immutable` with their sha256 as ETag, pages revalidated with an
  ETag, 304s, `Range` (206, 416), `Cross-Origin-Resource-Policy: same-origin`, service workers
  refused. Every page of a set is in the shell.
- **Addresses.** On a tab, `entry.at` answers a `FileAddress` (`{ instance, base, file }`) and the
  latest's address (`/`, `/style.css`) is redeemed to the version's own (`/v/3/`, `/v/3/style.css`),
  so a page never loads a newer version's file published while it loads; `pinned: true` makes its
  files immutable there (only then); `versionedAddress(path)` and `versionBase(n)` read the usual
  convention. A subresource on a clean address with no session gets a 401 (no entry, no cookie). In a frame, the ticket's answer is the entry,
  whose files are at `/__porthole/f/<sealed access>/` (AES-GCM, so WebKit, which keeps no cookie
  in frames, loads them too: P083). The address opens on its own for an hour, renewed by the shell;
  reports name it `./`.
- **The CSP** of a page with files opens its version's own path for scripts, styles, fonts, images,
  media, fetches and workers, never `'self'` (P082, amending P022). Opaque frames and single pages
  are unchanged.
- **A set's pages open each other in the frame** (P084): the shell lets a navigation to a page of
  its set go on and tells the host first (`porthole/navigating`, `NAVIGATING_METHOD`); the display
  goes on. Anything else is still stopped (P079).
- **The agent's side:** `lintFiles(config, files)` (each page linted, every relative reference
  looked up in the set, a page's `/`-rooted reference an error), `admitFiles`, `checkPage({ files
  })` (the whole set served, its entry run), and the manual's Files section where a kind serves
  files. Tool schemas are unchanged.

## 0.5.1

From Ferry's adoption of 0.5.0's live widgets (P080). Additive, except that a refused data call's
error message in the shell's globals is now a sentence for the person (its old text, `Refused
(denied)`, stays the JSON-RPC error's own message).

- **The host hears a navigation the shell stopped** (#12): `DisplayEvents.navigationBlocked`
  (`{ url }`, the address whole; React `onNavigationBlocked`), and a `contentError` naming the
  address without its query or fragment, so a host that passes content errors to the agent
  (`errors: "agent"`) tells it its widget tried to leave its page. It is an error report: only
  where the config declares `reportError`, within its reports and rate. The shell sends Porthole's
  own `porthole/navigation-blocked` (`NAVIGATION_BLOCKED_METHOD`); both adapters carry it, MCP Apps
  views included. Served frames only: an opaque frame's navigations get no events (the host hears
  `navigated` when one replaces its document). `checkPage` reports it.
- **A host that refuses every data call needs no handlers** (#13): pass a `Refused` as `consent`
  (`HostOptions.consent`, React's provider and frame `consent`), e.g.
  `consent: new Refused("not_allowed", "Live data shows on the dashboard.")`: every
  `consent`-gated call is refused with it, nothing is asked, and `readData`/`subscribeData` may be
  declared without handlers. React compares it by value.
- **A refusal tells content why** (#14): a refused request's error carries
  `data: { code, message }` (`RefusalReason`, `REFUSAL_CODES`): `consent_required`, `denied`,
  `rate_limited`, `not_allowed` or `failed`, and a sentence to show. Hosts word their own with
  `throw new Refused(code, message)` from a handler or a consent function (kept as the answer);
  any other error a handler throws is `failed` in Porthole's words (its message stays the host's).
  The shell's `readData` rejects, and `subscribeData`'s `onError` is called, with an `Error` whose
  `code` is the code and whose `message` is the sentence. The manual teaches both. A consent
  function that throws anything else is now `consent_required` to content (`denied` before).

## 0.5.0

Live widgets (P079): content that shows its host's data, current, read as the person viewing it,
with no network of its own. Additive, but every shell now cancels its served frame's own
navigations to another document (below).

- **`presets.liveWidget(options)`**: an inline widget whose egress stays closed (its options have
  no `egress`; passing one throws). It declares `readData` and `subscribeData`, each behind the
  viewer's consent and a rate (120 and 60 a minute). Served (domain isolation), it loads
  Porthole's own libraries from its origin. `defineDisplays` takes it as a preset.
- **Porthole's libraries (`egress.libraries`)**: Chart.js 4.5.1 and D3 7.9.0 (`VENDORED_LIBRARIES`),
  npm's files byte for byte with their licenses, served by `/server` on every content origin at
  `/__porthole/lib/<name>@<version>/<file>` (no ticket, immutable). The frame's `script-src` gets
  that path on the content origins, nothing else. Domain isolation only; the manual gives a
  `<script>` line for each.
- **The `consent` gate**: `HostOptions.consent` (React: `PortholeProvider`/`PortholeFrame`
  `consent`) is asked once per display before its first consent-gated call; a no refuses them all
  (`denied`), none refuses them (`no-consent`). Not a default gate of `readData` (hosts that declare
  it keep working); the live widget preset has it.
- **`subscribeData`** (a new capability, needs `readData`): MCP's `resources/subscribe` and
  `resources/unsubscribe`, and `notifications/resources/updated` from the host, after which the
  content reads again. Offered as `hostCapabilities.serverResources.subscribe`. The handler gets
  `changed(result?)` and an `AbortSignal` (`SubscriptionContext`). Both adapters (the shell's and
  `/mcp`'s) carry it.
- **The host's cache** (`HostOptions.cached`, `DataCache`; React `cached`): a read of a subscribed
  resource is answered from it at once, marked `_meta["porthole/stale"]` (`STALE_META`), and the
  fresh read follows as an update.
- **Shell globals**: `readData(uri)` (a promise of the value: JSON parsed, else text) and
  `subscribeData(uri, onData, onError)` (onData(value, { stale, uri }) now and at every change;
  returns a stop function). The manual teaches them, the consent and the libraries.
- **No frame navigates itself away**: the shell cancels every navigation its frame starts to
  another document (the Navigation API's `navigate` event), so a served frame can't carry data in a
  URL to another content origin, which the page's `frame-src` must allow. Reloads and
  same-document navigations go on. Opaque frames get no navigate events; their wall stays the
  page's `frame-src`. Negative control `navigate-guard`.
- A shell config that declares `readData` (inline, artifact) now gives content a `readData`
  global, fixed in place like the others: content that defines its own `readData` must rename it.
- `checkPage` answers consent-gated calls as a viewer who says no; `lintContent` points live
  widgets at the libraries served here and at `readData`.

## 0.4.1

- Annotation marks keep the words under them readable on a light page and a dark one: a lighter
  fill (18%, 26% for the active mark) with an amber underline (text) or outline (an element), and
  a ring around the active mark and a flash instead of more fill over its words (the 50% and 90%
  yellow left light text yellow on dark yellow).

## 0.4.0

- `LIBRARY_CDNS` adds three libraries' own CDNs, for scripts only: Tailwind's Play CDN
  (`https://cdn.tailwindcss.com`), jQuery (`https://code.jquery.com`) and Plotly
  (`https://cdn.plot.ly`) (P078, #11). **Hosts that pass `LIBRARY_CDNS` get them on upgrade**;
  write the list out to keep the old one. The manual gives each a pinned line, and tells agents
  how Plotly's maps draw here (`topojsonURL`, the copy on jsDelivr); `lintContent` asks for a
  version in their URLs. Verified against the real CDNs under every preset, on three engines.
- `checkPage`: nobody clicks in a check, on any engine: a call on load that needs a click is
  refused and reported as a problem (Firefox counted the check's own evaluations as gestures).

## 0.3.5

- ADOPTING.md § "Choosing egress" (#7): the three levels (closed, `LIBRARY_CDNS`, passive kinds
  from any https site) in one table, with the config for each, what it opens, the risk it
  re-opens, who uses it, what the agent's manual says, and its decisions and tests; linked from
  the README. The manual and the tool description word the any-https level the same way.

## 0.3.4

- A confirmation names the instance the host gave the frame in opaque frames too, not only served
  ones (`request.display.instance`): `PortholeView` passes it either way, and an opaque frame never
  gets it (P077).

## 0.3.3

- A confirmation names the instance a served frame shows (`request.display.instance`, in
  `confirm` and `renderConfirm`), so a host can word its dialog from its own records (P076, #10).
- `ContentHost.start()` runs once; `nodeServer` starts a host made in its `listen` callback right
  away instead of at the first request, and no longer starts again one the app started (P076,
  #10).

## 0.3.2

- Every entry point bundles whole (P075): `/check` imports its check page's script as a module,
  and `/conformance` its harness, instead of loading files beside the module at run time, which a
  bundle (a single executable built by rolldown, a Worker) doesn't have. `checkPage` needs no
  `page` option anywhere now. Each release is bundled with rolldown and esbuild, checked for loads
  left for run time, and runs a check from its bundle before it is published (`test:bundle`).

## 0.3.1

From Ferry's and Raft Artifacts' adoptions of 0.3.0 and a second cold adoption (P074). Additive.

- `checkPage` runs a served config served: its own origin, the served CSP, shell, storage and
  cookies, under an in-process server both drivers answer; errors name the content's own lines,
  as the lint does. Configs that declare host functions can be checked (#8): each is answered as
  a host that declines, and each call is reported (one hosts refuse is a problem, one a person
  may decline a note). The manual's examples are checked under presets with every host function.
- React: flipping the provider's scheme, or a new themeKey, re-themes running frames in place;
  it no longer makes every display again, losing widgets' state and reloading previews (#9).
- Sign-in comes back to `authorizeUrl` with the entry's state, never the request's own URL, so a
  TLS edge or a dev proxy in front of the app no longer strands the person on the sign-in.
- `entryTarget(next, authorizeUrl, { app: true })` also takes the app's own pages.
  `renderConfirm` gets `redirect()` ("redirected", not counted toward muting). `nodeServer` takes a
  function for a host made after it listens. `entry.pathOf` may be async. A missing secret is
  named. `portholeClient`'s functions pass bare (`this: void`). `PortholeView` renders its
  placeholder or fallback on the server from the client's meta. `domain: null` is the documented
  no-content-domain setup.
- Conformance: `@botiverse/porthole/conformance/reporter` prints why each case was skipped;
  `contentSource` may be a function; `conformanceProjects` takes `use` and per-engine
  `launchOptions` (a system Chromium).
- The examples run on `nodeServer` and `contentHostFor`, as ADOPTING recommends; ADOPTING says
  when the other paths are right, how a page without a bundler loads Porthole's modules, and the
  default authorize URL.

## 0.3.0

Developer experience, for the people adopting Porthole and the agents writing for it.

- The host kit's client, bootstrap and relay (P072): `defineDisplays` (one registry of display
  kinds for the server, the page, the CSP and the manual); `content.routes(viewerOf)` (one mount
  under `/porthole`: frames, authorize, meta, handoff; `issue` answers the clean `link`);
  `contentHostFor` (Workers) and `nodeServer` (Node); `portholeClient`, `frameFallback`,
  `entryTarget`; React `PortholeView`, `usePortholeLink`, `cssVariableTheme`, `useRunAgain`, and
  provider-wide `scheme`, `theme`, `nonce: "auto"`, `handlers`, `openLink`, `notify`,
  `renderConfirm`; the viewer handoff for token-authenticated pages; `upstreamHeaders`,
  `statusPage`, cookie-clean `appSocket` and `content.forget()` for url-mode relays;
  `health.onServedChange`; logger adapters.
- The agent's side (P073): `lintContent`, `admitContent` (the show tool refuses only what certainly
  fails, saying what to change), `checkPage` with `playwrightDriver` and `cdpDriver` (Cloudflare
  Browser Rendering), `showTool`, `guideTool`, `checkTool`, `answerGuide`, `guideChanges`, and an
  MCP server example. Every example in the manual passes the check under every preset.
- Additive: every 0.2 import works. Apps move their old frame and authorize routes to
  `/porthole` themselves.

## 0.2.4

- The package ships `docs/ADOPTING.md`, which 0.2.3's README links to and its build left out;
  every doc in `docs/` is shipped from now on, and a test checks the README's links (P071).

## 0.2.3

- Adopting from the package alone (P071): a README with a quickstart, `docs/ADOPTING.md`, and
  runnable examples (`examples/`: one app on Node and Workers, and the conformance suite against
  it). `npx porthole secret` and `npx porthole d1-schema`. `MountOptions.fill` and
  `<PortholeFrame fill>` are deprecated in favor of `layout.kind: "fill"`. The runner asks less of
  an app that serves only stored pages (`instances.shell`, `entry.denied`, `atSignIn`,
  `completeSignIn` optional; `entry.unknown: "derive"`; `conformancePage`, `conformanceProjects`,
  `onDemand`). `14.inline-assets` reports an inherited block as inapplicable. Host errors no
  longer quote ticket URLs. DESIGN's snippet fixed; `'unsafe-eval'` documented.

## 0.2.2

- From the host kit's first two adopters (P070, #5, #6): an address that names nothing (a label
  the naming never makes, the bare domain, a path `entry.at` says has nothing) is a 404 on the
  content domain, never a trip to the app's sign-in; `reserved` is only for labels the app
  serves; the entry hooks get the address decoded (`EntryContext`) and `refusal` may return
  nothing; `/server` exports `InstanceRef` and the other callback types; the server's pages talk
  past a desktop scheme among the host origins (`ferry://app`), so framed url-mode apps no longer
  hang; `nodeHost` streams with backpressure, stops with the client, and never ends a broken body
  as whole; `health.onChange`; the runner takes async instances and entry addresses, adds
  `served.entry.unknown`, and locates its tests in the app's spec file; the package ships the
  docs.

## 0.2.1

- The manual, for a whole-page viewer (P069): "Call <guide tool> once" with `guideToolName`;
  `layout.kind: "fill"` says the page fills the app's viewer (not the window), keeping
  phone-width-first; `theme.documents: "never"` drops every theme line but "always light". The
  `14.sound` probe reports itself inapplicable where the page's own CSP blocks its media.

## 0.2.0

- The host kit (P066): an app writes its policy (`instance`, `access`, `authorize`, `source`) and
  its settings; Porthole does the rest. `createContentHost` (`/server`) gives the routing
  middleware (reserved labels handed back), the issue endpoint (`{ instance }`, a proposal the
  app maps; the client never chooses an origin), `meta`, `frameSources`, the content-domain
  helpers (`contentDomain`, `ContentDomainError`: a clash throws at startup, or with the health
  gate is a lasting "misconfigured", logged once) and the optional health gate with its opaque
  fallback. New `/node` subpath: `nodeHost` (requests and WebSocket upgrades) and `nodeProbe`.
  Client: `httpLocator`, `LocateError`, `servedOrOpaque`.
- Redirect entry (P068): `entry` gives every instance a clean address (`urlOf`) that opens
  directly, through the app's authorize route (`authorize`) and its own sign-in, with a one-time
  code bound to the address and the browser. Never the sign-in inside a frame (`FrameBlock`
  `sign-in`); tickets stay the way frames load. `prefixedName` says a label's scope (`Naming`).
- The conformance runner: `defineHostConformance` / `hostConformance` run the leak suite, the
  served cases and the redirect entry cases (`entryTests`) against an app's real page, with a
  framework-free harness on `createHost` loaded under the page's nonce
  (`dist/conformance/harness.js`). `served.url.ticket` uses a fresh browser.
- The prod-shape profile (`ops/prod-shape/run.sh`): Caddy's TLS, wildcard DNS, same-site
  sibling origins, the kit reference app, a clash; CI on every push (checks, loopback on three
  engines, prod shape).
- Compatible: every 0.1.x import works unchanged.

## 0.1.8

- The manual's silent line says where a block is reported, following `errors`: back to the agent
  (`agent`), to the app only (`host`), to the app (unset), or nowhere (no `reportError`), so it no
  longer contradicts the Errors line (#4, P067). `14.silent` checks the host's side too.

## 0.1.7

- The manual's "The sandbox:" list states every limit that silently changes behavior, derived
  from the config (`manualLimits`), and each has a browser check (`LIMIT_CHECKS`, item-14 probes,
  `served.domain.address`); a unit test fails on a line without one (P064). The forms advice is
  now `type="button"` and a click handler: Chromium and Firefox fire no submit event in the
  sandbox.
- A config can say a whole-page viewer's shape, and the manual and behavior follow (P065):
  `layout.kind: "fill"` (every mount fills; fixed/sticky work), `theme.documents: "never"`
  (always light, no theme changes), `storage.scope` (what one display's storage is kept for),
  `errors: "agent" | "host" | "none"` (where content errors go); `limits.maxBytes` stated in KB
  or MB. `LaunchSpec.heightPx` for checks that fill.

## 0.1.6

- `served.domain.egress` holds a host to its own config's egress (P062).

## 0.1.5

- Wildcards over public suffixes refused (P060); passive content from any https site by
  `egress.anyHttps` (P059); inapplicable cases reported, not failed (P058); theme events only on
  a change (P061).

## 0.1.4

- Content and host errors apart (P055); nonce support (P054); `/server` routing (P056); fill
  mode, by-value React props, settled annotations, shared-storage note (P057).

## 0.1.3

- Content never writes the clipboard (P051); `copyText` (P052); annotations (P053).

## 0.1.2

- `/server` on Workers with D1 tickets (P044, P045); anonymous grants (P046); host naming
  (P047); artifact CDN opt-in (P048); url-mode delegation (P049); the host's check (P050).

## 0.1.1 and 0.1.0

- Phase 1's milestones (M1–M5) and the first host's adoption fixes.
