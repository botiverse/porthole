# Changelog

`@botiverse/porthole`. Each release is a `v*` tag; the reasons for every change are in
[docs/DECISIONS.md](docs/DECISIONS.md), by the P-numbers below.

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
