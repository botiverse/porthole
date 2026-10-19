# Porthole

`@botiverse/porthole`: show HTML an agent wrote (a widget, a whole page, an MCP Apps view)
inside your app, safely. One config gives the frame its isolation, its CSP, a themed shell, the
host functions it may call (each behind a gate), and the manual your agent reads.

```bash
npm install @botiverse/porthole
```

Node 24 or later, or Cloudflare Workers. The browser part is plain ES modules with no
dependencies (bundle it, or serve `dist/` with an import map: docs/ADOPTING.md § 4).

## Two ways to show content

- **Opaque, in the page.** No server needed: content runs in a sandboxed frame with an opaque
  origin. For widgets in a conversation.
- **Served, on an origin of its own.** Each page, or each conversation's widgets, gets an origin
  like `a-<id>.example-usercontent.com`, so it can keep storage, open at a clean address in a
  new tab, and be framed by your app only. The host kit (`createContentHost`) is the server side;
  your app writes only its policy: which pages exist and who may see them.

## Try it in two minutes

The package ships a whole app, the same code on Node and on Workers:

```bash
PORTHOLE_SECRET=$(npx porthole secret) node node_modules/@botiverse/porthole/examples/node/server.mjs
# open http://localhost:8790: a stored page, served on http://a-hello.content.localhost:8790
```

- `examples/app.mjs`: the app (policy, routes, page), runtime-agnostic.
- `examples/node/server.mjs` (`nodeServer`), `examples/workers/` (`contentHostFor`, with its D1
  migration and `wrangler.jsonc`).
- `examples/conformance/`: Porthole's conformance suite run against it, on three engines.
- `examples/mcp/server.mjs`: the agent's tools (show, guide, check) as an MCP server.

## The smallest opaque display

```js
import { createHost, presets } from "@botiverse/porthole";

const host = createHost(presets.inlineWidget());
const display = host.mount(document.getElementById("widget"), {
  displayId: "w1",
  title: "A chart",
  scheme: "light",
});
display.setContent("<p>Hello from an agent</p>");
```

In React: `<PortholeProvider>` around `<PortholeFrame config displayId title scheme content />` from
`@botiverse/porthole/react`.

## Pages made of many files

A served page may come with files of its own: a build's output, a report with its images, a
dashboard that reads its data (0.6). The store answers a manifest and the bytes by path, and the
page's relative addresses are its own version's:

```js
source: async (id, version) => ({
  files: { "index.html": { size: 397, sha256: "…" }, "assets/app.js": { size: 142870, sha256: "…" } },
  read: (path) => myStore.bytes(id, version, path),        // Uint8Array or a stream, whole
}),
entry: {
  // "/v/3/<file>" is version 3, any other path the latest's: answer with the version's own address.
  at: async (scope, path) => {
    const at = versionedAddress(path), version = at?.version ?? (await latestOf(scope));
    return at && { instance: pageOf(scope, version), base: versionBase(version), file: at.file, pinned: true };
  },
},
```

Each file is served from the manifest only, typed by Porthole's own table, `nosniff`, with a CSP
that opens that version's path and nothing else of its origin; `checkFileSet` checks a version's
paths and limits when it is published, `lintFiles` and `checkPage({ files })` are the agent's
side. docs/ADOPTING.md § Pages made of many files.

## A page that is an app: the capability runtime

With `runtime: "1"` in its config (0.7), a page reaches its host through one global, for what it
declared when it was published and what its viewer's level allows:

```js
const db = await porthole.use("db");                 // a frozen namespace, or null: draw without it
const votes = db && (await db.query("votes")).docs;  // a refusal rejects with error.code and a sentence
```

The host keeps the services: its handlers (`db`, `artifact`, `assets`, `comments`; `user` is the
viewer it gives), `declareCapabilities` at publish, the viewer's level in its access
(`Grant.level`), and an asset store `/server` serves at `/_blob/<id>`. `defineRuntimeConformance`
checks the handlers. The types: `types/runtime/v1/*.d.ts`. docs/ADOPTING.md § The capability
runtime.

## What the agent gets

```js
import { admitContent, checkTool, guideTool, showTool } from "@botiverse/porthole";

const tools = [showTool(config), guideTool(config), checkTool(config)]; // name, description, JSON Schema
const admitted = admitContent(config, html); // refuses only what certainly fails, saying what to change
```

`checkPage` (`@botiverse/porthole/check`) runs a page in the real sandbox at phone and desktop
width, light and dark, before anyone sees it, and tells the agent what broke in a few lines.
`examples/mcp/server.mjs` wires the tools as an MCP server.

## Read next

- [docs/ADOPTING.md](docs/ADOPTING.md): getting started, step by step: the server, the page, its
  CSP, Workers, local development, the agent's tools, conformance, troubleshooting.
- [Choosing egress](docs/ADOPTING.md#choosing-egress): what content may load (closed, library
  CDNs, passive media from any https site), what each level opens and the risk it re-opens.
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): what Porthole protects and from whom; for each
  use, what it guarantees, what is left to you, and what isn't covered.
- [docs/DESIGN.md](docs/DESIGN.md): how it works. [docs/DECISIONS.md](docs/DECISIONS.md): why,
  by P-number (the code cites them).

## Subpaths

| Import | What |
| --- | --- |
| `@botiverse/porthole` | `createHost`, `presets`, `defineDisplays`, `portholeClient`, `lintContent`, the tools (browser and server) |
| `@botiverse/porthole/react` | `PortholeProvider`, `PortholeFrame`, `PortholeView` |
| `@botiverse/porthole/server` | `createContentHost` (`routes`), `contentHostFor`, `prefixedName`, `d1TicketStore` (any runtime) |
| `@botiverse/porthole/node` | `nodeServer`, `nodeHost`, `nodeListener`, `nodeProbe` (Node's http server) |
| `@botiverse/porthole/mcp` | the MCP Apps adapter |
| `@botiverse/porthole/check` | `checkPage`, `playwrightDriver`, `cdpDriver`: the agent's pre-show check |
| `@botiverse/porthole/conformance` | `defineHostConformance`: the suite, against your app (Playwright) |

`npx porthole secret` makes a secret; `npx porthole d1-schema` prints the D1 migration.

Apache-2.0. `/server` also serves copies of [Chart.js](https://www.chartjs.org) 4.5.1 (MIT) and
[D3](https://d3js.org) 7.9.0 (ISC) to live widgets (P079), each with its license beside it
(`/__porthole/lib/<name>@<version>/`), from `src/libraries/files.generated.ts`; their notices,
and those of the packages their files bundle, are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Found a vulnerability? Report it privately, as
[SECURITY.md](https://github.com/botiverse/porthole/blob/main/SECURITY.md) says, never in a public
issue.
