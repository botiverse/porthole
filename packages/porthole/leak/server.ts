import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

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

async function serve(pathname: string): Promise<{ body: string; type: string } | null> {
  const relative = pathname === "/" ? "leak/host/index.html" : pathname.replace(/^\/+/u, "");
  if (!/^(src|leak\/host)\//u.test(relative) || relative.includes("..")) {
    return null;
  }
  const file = path.join(root, relative);
  const type = TYPES[path.extname(file)];
  if (type === undefined) {
    return null;
  }
  const text = await readFile(file, "utf8");
  return { body: file.endsWith(".ts") ? stripTypeScriptTypes(text) : text, type };
}

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  serve(url.pathname).then(
    (found) => {
      if (found === null) {
        response.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      response
        .writeHead(200, { "content-type": found.type, "cache-control": "no-store" })
        .end(found.body);
    },
    () => response.writeHead(404, { "content-type": "text/plain" }).end("not found"),
  );
}).listen(port, "127.0.0.1");
