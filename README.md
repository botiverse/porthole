<p align="center"><img src="docs/assets/porthole-logo.svg" width="128" alt="Porthole"></p>

# Porthole

A host-side library for safely showing agent-made HTML inside an app, like the
inline cards and standalone pages you see in ChatGPT and the Claude app.

An agent (or any untrusted source) writes an HTML fragment or page. Porthole is
the piece a host app embeds to render it: it isolates the HTML from the host,
hardens what it can reach on the network, gives it a themed shell and a small,
gated set of host functions (such as sending a prompt back to the agent), and
generates the agent-facing manual that teaches how to write for it — all from one
config, so the sandbox, the shell and the manual never drift apart.

## What it is

**The display layer** is what most hosts need: it shows untrusted HTML safely.

- **Presets**, safe by default and picked with near-zero config: **inline widget**,
  **live widget** (shows the host's data, current, with no network of its own),
  **artifact** (a standalone page), **MCP Apps** (the standard protocol), and **URL**
  (a running app, such as a dev server's preview). Each preset fixes the CSP and
  allowed origins, which host functions are exposed and how they are gated, the
  theme vocabulary, and the generated manual.
- **Mechanisms** under them: origin isolation (an opaque frame, or an origin of its
  own served by the host kit), egress hardening, the in-frame shell runtime,
  streaming render, auto-sizing, theming, the host-function bridge, and the guide
  generator.

**The app runtime** is an optional layer on top (0.7, off unless a config sets
`runtime`): a page becomes a small app that reaches the host's services through
one global, `porthole.use(name)` (`user`, `comments`, `artifact`, `assets`, `db`),
for what it declared and what its viewer's level allows. Porthole checks and gates
each call; the services stay the host's, and so does the final check of who may do
what with its data.

What each layer guarantees, use by use (chat widgets, live data, private and public
pages, MCP Apps, previews, several displays on one page), what the host must do,
and what isn't covered: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

The external contract for agent-written UI is the **MCP Apps** standard
(`io.modelcontextprotocol/ui`, spec 2026-01-26). Porthole does not define a new
widget-side protocol; the host side is protocol-pluggable behind thin adapters.

Web is the first platform (framework-agnostic TypeScript core, plus a thin React
binding). Native hosts (iOS/WKWebView, maybe Android) come later.

## Why

Isolating untrusted HTML well takes several layers that have to agree: the CSP,
the iframe sandbox flags, the embedding page's own policy, a runtime shell, and a
manual the agent follows. Hosts rebuild this each time, usually missing an egress
path or letting the manual drift from what the sandbox actually allows. Porthole
makes one config the single source for all of them and ships a conformance suite
that proves the isolation holds.

## Status

**Pre-1.0, published on npm.** One package, [`@botiverse/porthole`](packages/porthole/README.md),
with `/react`, `/mcp`, `/conformance`, `/server`, `/node` and `/check` subpaths; its versions and
what each changed are in [CHANGELOG.md](CHANGELOG.md) (until 1.0 a minor version may change the API,
and says how). Phase 1's core milestones (M1–M5, DESIGN.md § Milestones) are done; CI runs the leak
suite on Chromium, WebKit and Firefox for every change, and the release workflow publishes only a
commit of main that passed all of CI (P097: until the repository's release settings are on, that
guards against mistakes, not against someone who can push). Since 0.2.0 the host kit
(`createContentHost`) is the whole host side an app needs around served content: it writes its
policy (DESIGN.md § The host kit). Since 0.6.0 a served page may be many files (a build's output, a
report with its images), each served from its version's manifest under that version's own address
(P081–P084). Since 0.7.0 a page may be an app, through the optional capability runtime, under a
contract pinned per artifact (P085–P090). Read, in order:

1. [docs/PRINCIPLES.md](docs/PRINCIPLES.md) — the rules decisions are made by.
2. [docs/OBJECTIVES.md](docs/OBJECTIVES.md) — what Porthole is for, with success criteria and non-goals.
3. [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — what it protects, from whom, and where that ends, use by use.
4. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the layers, flows, trust boundaries and extension points (stable while APIs change).
5. [docs/DESIGN.md](docs/DESIGN.md) — the concrete phase-1 design.
6. [docs/DECISIONS.md](docs/DECISIONS.md) — why things are the way they are.

Adopting it in an app: [docs/ADOPTING.md](docs/ADOPTING.md), and before you open anything to
the network, [Choosing egress](docs/ADOPTING.md#choosing-egress): the three levels, what each
opens and the risk it re-opens; for content that reads your data,
[Live widgets](docs/ADOPTING.md#live-widgets-content-that-reads-your-data). Before you show
content that matters, the [threat model](docs/THREAT_MODEL.md)'s section for your use says what
is left to you.

See also [AGENTS.md](AGENTS.md) for how to work in this repo.

## Security

Found a way past one of Porthole's walls? Report it privately, never in a public issue: see
[SECURITY.md](SECURITY.md) for how, which versions get fixes, and what happens next.

## License

[Apache-2.0](LICENSE), copyright Botiverse. Third-party code keeps its own license: the libraries
the package vendors are in
[packages/porthole/THIRD_PARTY_NOTICES.md](packages/porthole/THIRD_PARTY_NOTICES.md) (shipped with
it), and the leak suite's committed Vite + React build in
[its fixture's notices](packages/porthole/leak/fixtures/vite-react/THIRD_PARTY_NOTICES.md).
