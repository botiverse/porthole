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

/**
 * Negative controls: `PORTHOLE_LEAK_WEAKEN=<name>[,<name>]` serves the core with one defense
 * taken out, so the probes that prove it can be seen to fail (PRINCIPLE 6: a wall never seen to
 * fail proves nothing). Each names the text it removes; if that text is gone, the server refuses
 * to start rather than weaken nothing.
 */
interface Edit {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}
const RUNTIME = "src/shell/runtime.ts";
const POLICY = "src/compile/policy.ts";
const WEAKENINGS: Readonly<Record<string, readonly Edit[] | "embedder-csp">> = {
  "frame-guard": [{ file: RUNTIME, find: "  guardRoot(document);\n", replace: "\n" }],
  webrtc: [{ file: RUNTIME, find: "      lock(window, name, undefined);", replace: "" }],
  "attach-shadow": [
    {
      file: RUNTIME,
      find: "    const root = attachShadow.call(this, init);\n    guardRoot(root);",
      replace: "    const root = attachShadow.call(this, init);",
    },
  ],
  "parser-entry-points": [
    {
      file: RUNTIME,
      find: '  for (const name of ["open", "write", "writeln"]) {\n    lock(Document.prototype, name, noRewrite);\n  }',
      replace: "",
    },
  ],
  "declarative-shadow": [
    {
      file: RUNTIME,
      find: '      lock(proto, "setHTMLUnsafe", function (html) {\n        this.innerHTML = String(html);\n      });',
      replace: "",
    },
  ],
  "sync-guard": [
    {
      file: RUNTIME,
      find: "    if (node.nodeType === 1 && node.matches(GUARDED)) {\n      return false;\n    }\n    strip(node);\n    return true;",
      replace: "    return true;",
    },
    {
      file: RUNTIME,
      find: "    setInner.call(box, String(html));\n    strip(box);",
      replace: "    setInner.call(box, String(html));",
    },
    {
      file: RUNTIME,
      find: "    if (copy.matches(GUARDED)) {\n      element.remove();\n    }",
      replace: "",
    },
  ],
  "connect-src": [
    {
      file: POLICY,
      find: '["connect-src", ...list(origins("connect"))],',
      replace: '["connect-src", "*"],',
    },
  ],
  self: [
    {
      file: POLICY,
      find: '["script-src", "\'unsafe-inline\'", "\'unsafe-eval\'", "blob:", ...origins("script")],',
      replace:
        '["script-src", "\'self\'", "\'unsafe-inline\'", "\'unsafe-eval\'", "blob:", ...origins("script")],',
    },
    {
      file: POLICY,
      find: '["img-src", "data:", "blob:", ...origins("img")],',
      replace: '["img-src", "\'self\'", "data:", "blob:", ...origins("img")],',
    },
    {
      file: POLICY,
      find: '["style-src", "\'unsafe-inline\'", ...origins("style")],',
      replace: '["style-src", "\'self\'", "\'unsafe-inline\'", ...origins("style")],',
    },
    {
      file: POLICY,
      find: '["connect-src", ...list(origins("connect"))],',
      replace: '["connect-src", "\'self\'", ...origins("connect")],',
    },
  ],
  sandbox: [
    {
      file: POLICY,
      find: '      return ["allow-scripts"];',
      replace:
        '      return ["allow-scripts", "allow-forms", "allow-popups", "allow-downloads", "allow-top-navigation", "allow-modals"];',
    },
  ],
  "base-uri": [{ file: POLICY, find: '    ["base-uri", "\'none\'"],\n', replace: "" }],
  "style-split": [
    {
      file: "src/host/create-host.ts",
      find: "(STANDARD.has(name) ? standard : own)[name] = value;",
      replace: "standard[name] = value;",
    },
  ],
  "embedder-csp": "embedder-csp",
  "embedder-self": "embedder-csp",
};
const weakened = (process.env.PORTHOLE_LEAK_WEAKEN ?? "").split(",").filter((name) => name !== "");
for (const name of weakened) {
  if (WEAKENINGS[name] === undefined) {
    throw new Error(`No weakening named ${name}: ${Object.keys(WEAKENINGS).join(", ")}`);
  }
}

function weaken(relative: string, text: string): string {
  let out = text;
  for (const name of weakened) {
    const weakening = WEAKENINGS[name];
    for (const edit of typeof weakening === "object" ? weakening : []) {
      if (edit.file !== relative) {
        continue;
      }
      if (!out.includes(edit.find)) {
        throw new Error(`Weakening ${name} no longer matches ${relative}`);
      }
      out = out.replace(edit.find, edit.replace);
    }
  }
  return out;
}

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
    : "frame-src 'none'; child-src 'none'";
  return weakened.includes("embedder-self")
    ? policy
        .replaceAll("'none'", "'self'")
        .replace(/(frame-src|child-src)(?! 'self')/gu, "$1 'self'")
    : policy;
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
        .writeHead(200, {
          "content-type": found.type,
          "cache-control": "no-store",
          ...(found.type.startsWith("text/html") && !weakened.includes("embedder-csp")
            ? { "content-security-policy": embedderPolicy(url) }
            : {}),
        })
        .end(found.body);
    },
    (error: unknown) => {
      console.error(error);
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    },
  );
}).listen(port, "127.0.0.1");
