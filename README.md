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

- **A framework layer** — mechanisms only: origin isolation, egress hardening,
  the in-frame shell runtime, streaming render, auto-sizing, theming, the
  host-function bridge, and the guide generator.
- **A preset policy layer** — ready-made, safe-by-default bundles a host picks up
  with near-zero config: **inline widget**, **artifact** (a standalone page),
  **MCP Apps** (the standard protocol), and **URL** (a running app, such as a dev
  server's preview). Each preset fixes the CSP and allowed origins, which host
  functions are exposed and how they are gated, the theme vocabulary, and the
  generated manual.

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

**Private. Phase 1 in progress.** One package, `@botiverse/porthole`, with
`/react`, `/mcp`, `/conformance`, `/server` and `/node` subpaths. Since 0.2.0 the host kit
(`createContentHost`) is the whole host side an app needs around served content: it writes its
policy (DESIGN.md § The host kit). The config, compiler,
presets and public interfaces are in; the runtime pieces land milestone by
milestone (see DESIGN.md). Read, in order:

1. [docs/PRINCIPLES.md](docs/PRINCIPLES.md) — the rules decisions are made by.
2. [docs/OBJECTIVES.md](docs/OBJECTIVES.md) — what Porthole is for, with success criteria and non-goals.
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the layers, flows, trust boundaries and extension points (stable while APIs change).
4. [docs/DESIGN.md](docs/DESIGN.md) — the concrete phase-1 design.
5. [docs/DECISIONS.md](docs/DECISIONS.md) — why things are the way they are.

Adopting it in an app: [docs/ADOPTING.md](docs/ADOPTING.md), and before you open anything to
the network, [Choosing egress](docs/ADOPTING.md#choosing-egress): the three levels, what each
opens and the risk it re-opens.

See also [AGENTS.md](AGENTS.md) for how to work in this repo.

## License

[Apache-2.0](LICENSE), copyright Botiverse.
