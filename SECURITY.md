# Security policy

Porthole is an isolation layer: a host hands it untrusted HTML and relies on what it keeps out.
A way past any of its walls is a vulnerability, and we fix it before anything else.

## Reporting a vulnerability

GitHub's private vulnerability reporting is the channel for reports:
<https://github.com/botiverse/porthole/security/advisories/new> (the repository's Security tab,
"Report a vulnerability"). Only the maintainers see what you send there.

Please don't open a public issue, pull request or discussion about it, and don't publish details
until a fix is released. If the form isn't available to you, open an issue that says only that you
have a report and asks for a private channel, with no details.

What helps us most: the version or commit, the browser engine and its version, the config or
preset, the content that crosses the wall, and what it reached. A probe in the shape of the leak
suite's (`packages/porthole/leak/`) is ideal.

## Supported versions

Porthole is pre-1.0. Security fixes go into the latest release only (what `npm view
@botiverse/porthole version` prints), as a new patch or minor version; earlier versions get no
backports, so upgrading is how a host gets a fix.

| Version        | Supported |
| -------------- | --------- |
| latest release | yes       |
| anything older | no        |

## What happens to a report

1. We aim to acknowledge it within three business days, and to tell you whether we can reproduce
   it.
2. We fix it in private (a draft GitHub security advisory and its temporary private fork): first
   the test that fails (a leak probe or a unit test), then the fix, with a decision entry in
   [docs/DECISIONS.md](docs/DECISIONS.md) where a boundary changes.
3. We release the fix, publish the advisory (with a CVE where one applies), and credit you unless
   you'd rather not be named. For a high-severity report we aim to release within 30 days, and tell
   you if it will take longer.

## Scope

In scope: anything that lets content (agent-made HTML, an MCP App, a served page) do more than its
config allows: leave its frame or its origin, reach the network beyond its egress, call a host
function it didn't declare or at a level its viewer doesn't hold, get past a gate (a gesture, a
confirmation, consent, a rate), or read another page's or another viewer's data; and anything in
`/server`, `/node` or the host kit that serves content to someone its policy wouldn't (tickets,
sealed addresses, assets, the issue endpoint), or that a page or a request can crash.

Boundaries Porthole documents and accepts (a report that one is wider than documented is welcome):

- Content origins under one registrable domain are same-site with each other until the content
  domain is on the Public Suffix List ([P047](docs/DECISIONS.md)).
- A framed page's sealed files address is a bearer credential for that version's files until its
  session ends ([P083](docs/DECISIONS.md)).
- An engine without the Navigation API falls back to `frame-src` for a served frame's navigation:
  outside sites stay shut, other content origins don't ([P079](docs/DECISIONS.md)).
- What a host's own handlers do with a call: Porthole validates and gates it; the handler's effect
  is the host's.

The package has no runtime dependencies. The libraries it vendors (Chart.js, D3) are listed, with
their versions, in [packages/porthole/THIRD_PARTY_NOTICES.md](packages/porthole/THIRD_PARTY_NOTICES.md);
a vulnerability in one of them that Porthole exposes is in scope. Report others upstream.
