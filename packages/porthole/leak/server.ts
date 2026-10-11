import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { build } from "esbuild";
import path from "node:path";
import { weaken, weakened } from "./weakenings.ts";

/**
 * The leak suite's web server: the reference host page (`leak/host/`), and the package's own
 * source, its TypeScript stripped as Node does (no bundler), so the page runs the real core.
 * Bound to loopback only.
 */

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.PORTHOLE_LEAK_PORT ?? 8797);

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
};

/**
 * The React binding's test app, bundled on request (React ships CommonJS only), with the same
 * weakenings applied to the core's sources as the stripped files get.
 */
async function bundleReactApp(): Promise<string> {
  const result = await build({
    entryPoints: [path.join(root, "leak/react/app.tsx")],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "weaken",
        setup(plugin) {
          plugin.onLoad({ filter: /[/]src[/].*[.]ts$/ }, async (args) => ({
            contents: weaken(path.relative(root, args.path), await readFile(args.path, "utf8")),
            loader: "ts",
          }));
        },
      },
    ],
  });
  return result.outputFiles[0]?.text ?? "";
}

async function serve(pathname: string): Promise<{ body: string; type: string } | null> {
  if (pathname === "/leak/react/app.js") {
    return { body: await bundleReactApp(), type: "text/javascript; charset=utf-8" };
  }
  if (pathname === "/leak/react/" || pathname === "/leak/react") {
    return {
      body: await readFile(path.join(root, "leak/react/index.html"), "utf8"),
      type: "text/html; charset=utf-8",
    };
  }
  const relative = pathname === "/" ? "leak/host/index.html" : pathname.replace(/^\/+/u, "");
  if (!/^(src|leak\/host)\//u.test(relative) || relative.includes("..")) {
    return null;
  }
  const file = path.join(root, relative);
  const type = TYPES[path.extname(file)];
  if (type === undefined) {
    return null;
  }
  const text = weaken(relative, await readFile(file, "utf8"));
  return { body: file.endsWith(".ts") ? stripTypeScriptTypes(text) : text, type };
}

/**
 * The embedding page's CSP, as the test asks for it (frame directives only), else the default.
 * The `embedder-self` control lets frames navigate to this origin, as `'self'` would (P033).
 */
function embedderPolicy(url: URL): string {
  const asked = url.searchParams.get("csp") ?? "";
  const policy = /^(frame-src|child-src) [^;]+(; (frame-src|child-src) [^;]+)*$/u.test(asked)
    ? asked
    : "frame-src 'none'";
  return weakened.includes("embedder-self")
    ? policy
        .replaceAll("'none'", "'self'")
        .replace(/(frame-src|child-src)(?! 'self')/gu, "$1 'self'")
    : policy;
}

/**
 * `?nonce=1`: the host page as a strict host serves it (P054): a nonce-based `script-src` (no
 * 'unsafe-inline', no 'strict-dynamic'), which opaque frames inherit, its own scripts carrying
 * the nonce, and the nonce handed to `createHost`.
 */
function strictPolicy(html: string): { policy: string; body: string } {
  const nonce = randomBytes(18).toString("base64");
  return {
    policy: `script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'`,
    body: html.replaceAll("<script ", `<script nonce="${nonce}" `),
  };
}

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  serve(url.pathname).then(
    (found) => {
      if (found === null) {
        response.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      const html = found.type.startsWith("text/html");
      const strict =
        html && url.searchParams.get("nonce") === "1" ? strictPolicy(found.body) : null;
      const policies = [
        ...(html && !weakened.includes("embedder-csp") ? [embedderPolicy(url)] : []),
        ...(strict === null ? [] : [strict.policy]),
      ];
      response
        .writeHead(200, {
          "content-type": found.type,
          "cache-control": "no-store",
          ...(policies.length === 0 ? {} : { "content-security-policy": policies.join("; ") }),
        })
        .end(strict === null ? found.body : strict.body);
    },
    (error: unknown) => {
      console.error(error);
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    },
  );
}).listen(port, "127.0.0.1");
