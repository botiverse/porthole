# Changelog

`@botiverse/porthole`. Each release is a `v*` tag; the reasons for every change are in
[docs/DECISIONS.md](docs/DECISIONS.md), by the P-numbers below.

## 0.1.7

- Egress sources may carry a directory path prefix (`https://cdn.jsdelivr.net/npm/`), one exact
  host only, for `egress.*` and a capability's `connect`/`resource` (P063). Wildcard hosts with
  a path are refused. Content origins and embedder frames stay origin-only. New exports:
  `isEgressSource`, `egressSourceProblem`, `sourceOrigin`, `allEgressSources`;
  `allEgressOrigins` returns origins (paths dropped). The MCP adapter's `sandbox.csp` domains
  are origins. CSP ignores the path after a redirect: hygiene, not a wall.

## 0.1.6

- `served.domain.egress` holds a host to its own config's egress: images and media opened by
  `anyHttps` must reach an https canary, reported as expected (P062).

## 0.1.5

- Wildcards over public suffixes are refused (P060). Passive content from any https site, by
  `egress.anyHttps` (P059). The suite reports a case inapplicable on a host whose page policy (or
  always-on confirm) makes it unobservable (P058). Theme events only on a change (P061).

## 0.1.4

- Content and host errors apart, with `blocked: locate` (P055); nonce support for strict pages
  (P054); `/server` reserved prefixes, Host check, 404 without upstream (P056); fill mode,
  by-value React props, settled annotations, shared-storage note (P057).

## 0.1.3

- Content never writes the clipboard (P051); `copyText` (P052); annotations (P053).

## 0.1.2

- `/server` on Workers with D1 tickets (P044, P045); anonymous grants (P046); host naming
  (P047); artifact CDN opt-in (P048); url-mode delegation (P049); the host's per-request check
  (P050).

## 0.1.1 and 0.1.0

- The first releases: phase 1's milestones (M1–M5) and the first host's adoption fixes.
