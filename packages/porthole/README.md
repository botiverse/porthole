# Porthole

`@botiverse/porthole`: show HTML an agent wrote (a widget, a whole page, an MCP Apps view)
inside your app, safely. One config gives the frame its isolation, its CSP, a themed shell, the
host functions it may call (each behind a gate), and the manual your agent reads.

```bash
npm install @botiverse/porthole
```

Node 24 or later, or Cloudflare Workers. The browser part is plain ES modules with no
dependencies (bundle it, or serve `dist/`).

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
- `examples/node/server.mjs`, `examples/workers/` (with its D1 migration and `wrangler.jsonc`).
- `examples/conformance/`: Porthole's conformance suite run against it, on three engines.

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

## What the agent reads

```js
import { compile } from "@botiverse/porthole";

const compiled = compile(config);
compiled.toolDescription(); // the show tool's description: what it may write, and where it runs
compiled.guide();           // the manual: the sandbox's limits, sizes, colors, examples
```

## Read next

- [docs/ADOPTING.md](docs/ADOPTING.md): getting started, step by step: the server, the page, its
  CSP, Workers, local development, the agent's tools, conformance, troubleshooting.
- [docs/DESIGN.md](docs/DESIGN.md): how it works. [docs/DECISIONS.md](docs/DECISIONS.md): why,
  by P-number (the code cites them).

## Subpaths

| Import | What |
| --- | --- |
| `@botiverse/porthole` | `createHost`, `presets`, `compile`, `httpLocator`, `servedOrOpaque` (browser and server) |
| `@botiverse/porthole/react` | `PortholeProvider`, `PortholeFrame` |
| `@botiverse/porthole/server` | `createContentHost`, `prefixedName`, `d1TicketStore` (any runtime) |
| `@botiverse/porthole/node` | `nodeHost`, `nodeProbe` (Node's http server) |
| `@botiverse/porthole/mcp` | the MCP Apps adapter |
| `@botiverse/porthole/conformance` | `defineHostConformance`: the suite, against your app (Playwright) |

`npx porthole secret` makes a secret; `npx porthole d1-schema` prints the D1 migration.

Apache-2.0.
