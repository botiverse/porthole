# Changelog

`@botiverse/porthole`. Each release is a `v*` tag; the reasons for every change are in
[docs/DECISIONS.md](docs/DECISIONS.md), by the P-numbers below.

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
