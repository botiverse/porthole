<p align="center"><img src="docs/assets/porthole-logo.svg" width="128" alt="Porthole"></p>

# Porthole [![Built with Raft](https://raw.githubusercontent.com/raft-builders/awesome-raft-build/main/badge/built-with-raft.svg)](https://raft.build)

Show HTML an agent wrote inside your app, safely: inline cards and standalone pages, like the
ones in ChatGPT and the Claude app.

**One config for the sandbox, the shell and the agent's manual, so they never drift apart.**

## Quick start

```bash
npm install @botiverse/porthole
```

```js
import { createHost, presets } from "@botiverse/porthole";

const host = createHost(presets.inlineWidget());
const display = host.mount(document.getElementById("widget"), { displayId: "w1", title: "A chart", scheme: "light" });
display.setContent("<p>Hello from an agent</p>");
```

React: `<PortholeFrame>` from `@botiverse/porthole/react`. A whole app on Node or Cloudflare
Workers, and every entry point: [package README](packages/porthole/README.md).

## What you get

- **Presets, safe by default.** Inline widget, live widget (the host's data, no network of its
  own), artifact (a standalone page of one file or many), [MCP Apps](https://modelcontextprotocol.io)
  and URL. Each fixes the CSP, the host functions it may call and the manual the agent reads.
- **Isolation that is tested.** An opaque frame, or an origin of its own per page; egress
  hardening; a leak suite with a negative control for every defense, on Chromium, WebKit and
  Firefox ([threat model](docs/THREAT_MODEL.md)).
- **A host kit.** `createContentHost` serves pages on their own origins (routing, tickets, clean
  addresses) on Node and Workers; `PortholeView` mounts them.
- **Comments and find.** The host's comment marks drawn on content it can't trust, and its find
  bar over a display ([annotations](docs/ADOPTING.md#annotations-comments-on-a-display),
  [find](docs/ADOPTING.md#find-in-page-the-hosts-find-bar)).
- **The agent's side.** `lintContent`, `admitContent` and `checkPage` check a page before people
  see it.
- **An optional app runtime.** `porthole.use(name)` lets a page reach the host's services
  (`user`, `comments`, `db`, …), each call declared and gated.

Used by [Raft](https://docs.raft.build/features/collaboration/artifacts/) (workspace Artifacts and HTML previews). Pre-1.0: only the latest
release is supported; what each changed is in the [CHANGELOG](CHANGELOG.md).

## Docs

- [Adopting](docs/ADOPTING.md): putting it in an app, [choosing egress](docs/ADOPTING.md#choosing-egress) and [local development](docs/ADOPTING.md#local-development).
- [Threat model](docs/THREAT_MODEL.md): what each use is protected from, and what is left to you.
- [Principles](docs/PRINCIPLES.md), [objectives](docs/OBJECTIVES.md), [architecture](docs/ARCHITECTURE.md), [design](docs/DESIGN.md) and [decisions](docs/DECISIONS.md).
- [AGENTS.md](AGENTS.md): working in this repo.

## Security and license

Found a way past one of Porthole's walls? Report it privately: [SECURITY.md](SECURITY.md).

[Apache-2.0](LICENSE), copyright Botiverse. Third-party code keeps its own license: the
[package's notices](packages/porthole/THIRD_PARTY_NOTICES.md) and the
[leak suite fixture's](packages/porthole/leak/fixtures/vite-react/THIRD_PARTY_NOTICES.md).
