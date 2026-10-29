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
  **live widget** (shows the host's data, current, with no network of its own: 0.5, P079),
  **artifact** (a standalone page, of one file or many: 0.6, P081–P084), **MCP Apps** (the
  standard protocol), and **URL** (a running app, such as a dev server's preview). Each preset
  fixes the CSP and allowed origins, which host functions are exposed and how they are gated,
  the theme vocabulary, and the generated manual. `defineDisplays` names a host's display kinds
  once, for the server, the page, the CSP and the manual (0.3, P072).
- **Mechanisms** under them: origin isolation (an opaque frame, or an origin of its own served
  by the host kit), egress hardening, the in-frame shell runtime, streaming render, auto-sizing,
  theming, the host-function bridge, and the guide generator.
- **The host kit** (`/server`, 0.2, P066): `createContentHost` is the whole host side around
  served content (routing, tickets, clean addresses), on Node (`/node`) and Cloudflare Workers
  with D1 tickets (0.1.2, P044, P045). Its client (`portholeClient`, React's `PortholeView`)
  mounts what it serves (0.3, P072).
- **Annotations** (0.1.3, P053): a host lets people comment on content it can't trust. The shell
  draws the host's marks at W3C-selector anchors: markers with counts whose click the host hears
  (0.9–0.10, P104, P105), draft marks for a person's unposted comments (0.12, P107), a draft a
  page's button puts in the host's composer for the person to post or not (0.12–0.13, P108,
  P109), and what a host's comment modes need (0.14, P112: Escape, a followed mark, document
  order, hold on touch, `mayPassOn`).
- **Nested pages** (0.14, P111, `nested: true`): a served artifact's frame loads Porthole's shell
  alone, and the page runs in its child frame with an opaque origin, so it reaches nothing of the
  shell's realm. The host trusts the shell's own word on the person's press and focus there (for
  the keyboard guard and `comments.open`), and only for nested frames
  ([ARCHITECTURE.md § Trust boundaries](docs/ARCHITECTURE.md#trust-boundaries)).
- **The agent's side** (`/check`, 0.3, P073): `lintContent`, `admitContent` and `checkPage` check
  a page before people see it, and warn of one its own styles hold to one screen (P106, P110).

**The app runtime** is an optional layer on top (0.7, P085–P090, off unless a config sets
`runtime`): a page becomes a small app that reaches the host's services through one global,
`porthole.use(name)` (`user`, `comments`, `artifact`, `assets`, `db`), for what it declared and
what its viewer's level allows. Porthole checks and gates each call; the services stay the
host's, and so does the final check of who may do what with its data.

What each layer guarantees, use by use, what the host must do, and what isn't covered:
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) (0.8, P102).

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

**Pre-1.0, published on npm; the latest release is 0.14.3.** One package,
[`@botiverse/porthole`](packages/porthole/README.md), with `/react`, `/mcp`, `/conformance`,
`/server`, `/node` and `/check` subpaths; its versions and what each changed are in
[CHANGELOG.md](CHANGELOG.md) (until 1.0 a minor version may change the API, and says how). Only
the latest release is supported: fixes ship as new releases, and known issues are tracked in
GitHub issues.

The leak suite, with a negative control for every defense (P032, P096), runs on Chromium (also
with frames out of process, 0.14), WebKit and Firefox for every change; the prod-shape profile
(0.2) runs its suite on all three behind a TLS edge, wildcard DNS and sibling apps. An app proves its own integration with the conformance
kits: `defineHostConformance` against its real page (0.2, P066) and `defineRuntimeConformance`
against its runtime services (0.7). A release publishes only a commit of main whose CI passed
(0.8, P097).

**Who uses it:** Raft (its workspace Artifacts, served by its content Worker, and its HTML
attachment previews) and Ferry.

**On one machine, for one person** (an agent harness's web UI, a local tool): it works the same.
An opaque frame needs no second domain and no server; served pages run on loopback, the app on
`http://localhost:<port>` and content on `http://a-<id>.content.localhost:<port>`, each its own
site ([ADOPTING.md § Local development](docs/ADOPTING.md#local-development)). Isolation still
matters there: a page an agent wrote can carry instructions from what it read, and without the
wall it could read the UI's keys or call the agent's own local API. If content is fully trusted
and only needs showing, a plain iframe is enough; Porthole earns its place once you want
streaming, sizing and theming, MCP Apps, host functions, or annotations on top.

Read, in order:

1. [docs/PRINCIPLES.md](docs/PRINCIPLES.md) — the rules decisions are made by.
2. [docs/OBJECTIVES.md](docs/OBJECTIVES.md) — what Porthole is for, with success criteria and non-goals.
3. [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — what it protects, from whom, and where that ends, use by use.
4. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the layers, flows, trust boundaries and extension points (stable while APIs change).
5. [docs/DESIGN.md](docs/DESIGN.md) — the concrete phase-1 design.
6. [docs/DECISIONS.md](docs/DECISIONS.md) — why things are the way they are.

Adopting it in an app: [docs/ADOPTING.md](docs/ADOPTING.md), and before you open anything to
the network, [Choosing egress](docs/ADOPTING.md#choosing-egress): the three levels, what each
opens and the risk it re-opens; for content that reads your data,
[Live widgets](docs/ADOPTING.md#live-widgets-content-that-reads-your-data); for comments,
[Annotations](docs/ADOPTING.md#annotations-comments-on-a-display); for the page below the shell,
[Nested pages](docs/ADOPTING.md#nested-pages-the-page-below-portholes-shell). Before you show
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
