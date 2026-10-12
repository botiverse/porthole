# Changelog

`@botiverse/porthole`. Each release is a `v*` tag; the reasons for every change are in
[docs/DECISIONS.md](docs/DECISIONS.md), by the P-numbers below.

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
