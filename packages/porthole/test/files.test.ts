import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitFiles,
  checkFileSet,
  fileLimits,
  filePathProblem,
  fileSetCspDirectives,
  fileTypeOf,
  lintFiles,
  lookupFile,
  presets,
  requestFilePath,
} from "../src/index.ts";
import { compile } from "../src/compile/compile.ts";
import { addressWithoutQuery, withoutSealedAddresses } from "../src/bridge/navigation.ts";
import { createHost } from "../src/host/create-host.ts";
import { LATE_NOTICE_MS } from "../src/host/pages-of-set.ts";
import type { PlatformHost } from "../src/platform/types.ts";
import type { PortholeConfig } from "../src/config/schema.ts";
import type { InstanceRef } from "../src/isolation/types.ts";
import {
  createContentHost,
  createServer,
  prefixedName,
  versionBase,
  versionedAddress,
  type StoredFiles,
} from "../src/server/index.ts";

/**
 * A version made of files (P081-P084): the path rules, the type table, the CSP for a set's own
 * files, and serving: in frames by the sealed access in the path, on tabs under the version's own
 * address; headers, ETags, ranges, 404s and traversal.
 */

const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

/** A store of file sets by `id@version`, each file's text or bytes. */
function fileStore(sets: Record<string, Record<string, string | Uint8Array>>, spa = false) {
  const reads: string[] = [];
  return {
    reads,
    get: (id: string, version: string): Promise<StoredFiles | null> => {
      const set = sets[`${id}@${version}`];
      if (set === undefined) {
        return Promise.resolve(null);
      }
      const bytes = (each: string | Uint8Array) =>
        typeof each === "string" ? new TextEncoder().encode(each) : each;
      return Promise.resolve({
        files: Object.fromEntries(
          Object.entries(set).map(([path, body]) => [
            path,
            { size: bytes(body).byteLength, sha256: sha(bytes(body)), type: "text/html" },
          ]),
        ),
        spa,
        read: (path: string) => {
          reads.push(path);
          const body = set[path];
          return Promise.resolve(body === undefined ? null : bytes(body));
        },
      });
    },
  };
}

const PAGE = (version: string) =>
  `<!doctype html><html><head><link rel="stylesheet" href="./style.css"><script type="module" src="./assets/app.js"></script></head><body><main id="v">version ${version}</main><a href="about">about</a></body></html>`;

const SET = (version: string): Record<string, string | Uint8Array> => ({
  "index.html": PAGE(version),
  "about.html": `<!doctype html><title>About</title><p>about ${version}</p>`,
  "style.css": `main { color: rgb(${version}, 0, 0); }`,
  "assets/app.js": `document.body.dataset.v = "${version}";`,
  "data.json": `{"version":"${version}"}`,
  "notes.txt": "<script>alert(1)</script>",
  "logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"><script>parent.x=1</script></svg>`,
  "media/clip.bin": new Uint8Array(Array.from({ length: 100 }, (_, index) => index)),
  "media/clip.mp4": new Uint8Array(Array.from({ length: 100 }, (_, index) => index)),
  "docs/index.html": "<!doctype html><title>Docs</title>",
  "docs/404.html": "<!doctype html><title>Docs 404</title><p>no such doc</p>",
  "404.html": "<!doctype html><title>404</title><p>nothing here</p>",
});

const HOST = "https://app.example.com";
const DOMAIN = "example-usercontent.com";
const CONTENT = `https://*.${DOMAIN}`;
const secret = new Uint8Array(32).fill(9);

function frames(store = fileStore({ "site@1": SET("1"), "site@2": SET("2") })) {
  const checks: string[] = [];
  const revoked = new Set<string>();
  const server = createServer({
    content: { domain: DOMAIN, scheme: "https" },
    secret,
    hostOrigins: [HOST],
    configs: { artifact: presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] }) },
    artifacts: store,
    authorize: {
      check: ({ subject, request }) => {
        checks.push(new URL(request.url).pathname);
        return subject !== undefined && revoked.has(subject)
          ? { allow: false, code: "revoked" }
          : { allow: true };
      },
    },
  });
  return { server, store, checks, revoked };
}

const site = (version: string, scope = "site-scope"): InstanceRef => ({
  scope,
  document: { kind: "artifact", id: "site", version },
});

const req = (url: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(url, { method, headers: { "sec-fetch-dest": "iframe", ...headers } });

/** Opens a version in a frame: the ticket's answer, and the base its files are under. */
async function framed(
  app: ReturnType<typeof frames>,
  instance: InstanceRef,
  grant: { viewer: string; subject?: string } = { viewer: "ada", subject: "share-1" },
) {
  const location = await app.server.issue(instance, grant);
  const answer = await app.server.handle(
    req(location.url, { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" }),
  );
  if (answer === null) {
    throw new Error("nothing answered");
  }
  // The entry comes in the ticket's answer; its shell moves the frame to its files' address.
  const html = await answer.clone().text();
  const base =
    /"files":\{"base":"[^"]+","address":"([^"]+)","expires":\d+,"set":\{[^}]*\}\}/u.exec(
      html,
    )?.[1] ?? "";
  return { location, answer, base, html };
}

const fetchAt = async (
  app: ReturnType<typeof frames>,
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Response> => {
  const answer = await app.server.handle(req(url, headers, method));
  if (answer === null) {
    throw new Error(`nothing answered ${url}`);
  }
  return answer;
};

const navigate = { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" };
const subresource = (dest: string) => ({ "sec-fetch-dest": dest, "sec-fetch-mode": "no-cors" });

afterEach(() => {
  vi.useRealTimers();
});

describe("published paths (P081)", () => {
  it("takes canonical relative paths, case-sensitive", () => {
    for (const path of [
      "index.html",
      "assets/index-Dc-CZvvv.js",
      "a b/c d.png",
      "Über/ß.txt",
      "x".repeat(255),
    ]) {
      expect(filePathProblem(path), path).toBeNull();
    }
  });

  it("refuses what isn't canonical, or could mean something else on the way", () => {
    for (const path of [
      "",
      "/index.html",
      "dir/",
      "a//b",
      "./a",
      "a/./b",
      "../a",
      "a/../b",
      "a\\b",
      "a%2fb",
      "%2e%2e/x",
      "a?b",
      "a#b",
      "a\u0000b",
      "a\u001fb",
      "a\u007fb",
      "a\u0085b",
      "Café.txt",
      " a.txt",
      "a /b",
      "__porthole/x.js",
      "x".repeat(256),
      `${"a/".repeat(300)}b`,
    ]) {
      expect(filePathProblem(path), JSON.stringify(path)).not.toBeNull();
    }
    expect(filePathProblem(42)).not.toBeNull();
  });

  it("checks a version: collisions by case, a file that is a directory, the entry, the limits", () => {
    const ok = checkFileSet({ "index.html": { size: 10 }, "a/b.js": { size: 5 } });
    expect(ok).toEqual([]);
    const codes = (problems: ReturnType<typeof checkFileSet>) => problems.map((each) => each.code);
    expect(
      codes(
        checkFileSet({ "index.html": { size: 1 }, "A.png": { size: 1 }, "a.png": { size: 1 } }),
      ),
    ).toEqual(["collision"]);
    expect(
      codes(checkFileSet({ "index.html": { size: 1 }, a: { size: 1 }, "a/b": { size: 1 } })),
    ).toEqual(["collision"]);
    expect(codes(checkFileSet({ "main.html": { size: 1 } }))).toEqual(["entry"]);
    expect(checkFileSet({ "main.html": { size: 1 } }, { entry: "main.html" })).toEqual([]);
    expect(codes(checkFileSet({ "index.html": { size: 1 }, "../x": { size: 1 } }))).toEqual([
      "path",
    ]);
    const limits = { maxFiles: 2, maxFileBytes: 10, maxVersionBytes: 15 };
    expect(
      codes(
        checkFileSet(
          { "index.html": { size: 9 }, "a.js": { size: 11 }, "b.js": { size: 1 } },
          { limits },
        ),
      ),
    ).toEqual(["count", "size", "total"]);
    expect(fileLimits()).toEqual({
      maxFiles: 1000,
      maxFileBytes: 25 * 1024 * 1024,
      maxVersionBytes: 100 * 1024 * 1024,
    });
    expect(fileLimits({ maxFiles: 5 }).maxFiles).toBe(5);
  });
});

describe("a request's path (P081)", () => {
  it("decodes once and refuses what decodes into a separator, an escape or a dot segment", () => {
    expect(requestFilePath("assets/app.js")).toBe("assets/app.js");
    expect(requestFilePath("a%20b/c.png")).toBe("a b/c.png");
    expect(requestFilePath("")).toBe("");
    expect(requestFilePath("docs/")).toBe("docs/");
    for (const raw of [
      "..%2fx",
      "%2e%2e%2fx",
      "%252e%252e/x",
      "a%5cb",
      "a%00b",
      "a//b",
      "%2e",
      "%2E%2E",
      "%zz",
      "a%3fb",
      "a%23b",
    ]) {
      expect(requestFilePath(raw), raw).toBeNull();
    }
  });

  it("finds files as static hosts do: dir/ is its index, name is name.html, nearest 404.html", () => {
    const files = new Set([
      "index.html",
      "about.html",
      "docs/index.html",
      "docs/404.html",
      "404.html",
      "app.js",
    ]);
    const has = (path: string) => files.has(path);
    const nav = { navigation: true };
    expect(lookupFile(has, "", nav)).toEqual({ kind: "file", path: "index.html", status: 200 });
    expect(lookupFile(has, "about", nav)).toEqual({
      kind: "file",
      path: "about.html",
      status: 200,
    });
    expect(lookupFile(has, "about/", nav)).toEqual({ kind: "redirect", to: "about" });
    expect(lookupFile(has, "docs", nav)).toEqual({ kind: "redirect", to: "docs/" });
    expect(lookupFile(has, "docs/", nav)).toEqual({
      kind: "file",
      path: "docs/index.html",
      status: 200,
    });
    expect(lookupFile(has, "docs/x/y", nav)).toEqual({
      kind: "file",
      path: "docs/404.html",
      status: 404,
    });
    expect(lookupFile(has, "nope", nav)).toEqual({ kind: "file", path: "404.html", status: 404 });
    expect(lookupFile(has, "nope.js", { navigation: false })).toEqual({ kind: "none" });
    expect(lookupFile(has, "route/a", { navigation: true, spa: true })).toEqual({
      kind: "file",
      path: "index.html",
      status: 200,
    });
    expect(lookupFile(has, "route/a.js", { navigation: false, spa: true })).toEqual({
      kind: "none",
    });
    expect(lookupFile(has, "x", { navigation: true, entry: "app/main.html" })).toEqual({
      kind: "file",
      path: "404.html",
      status: 404,
    });
    expect(
      lookupFile((path) => path === "app/main.html", "", {
        navigation: true,
        entry: "app/main.html",
      }),
    ).toEqual({ kind: "redirect", to: "app/main.html" });
    expect(lookupFile(() => false, "x", nav)).toEqual({ kind: "none" });
  });
});

describe("types (P081)", () => {
  it("come from Porthole's table by extension, never the uploader's", () => {
    expect(fileTypeOf("index.html")).toEqual({ type: "text/html; charset=utf-8", role: "page" });
    expect(fileTypeOf("A.HTM").role).toBe("page");
    expect(fileTypeOf("assets/x.mjs")).toEqual({
      type: "text/javascript; charset=utf-8",
      role: "script",
    });
    expect(fileTypeOf("notes.txt")).toEqual({ type: "text/plain; charset=utf-8", role: "file" });
    expect(fileTypeOf("logo.svg")).toEqual({ type: "image/svg+xml", role: "file" });
    expect(fileTypeOf("x.wasm").type).toBe("application/wasm");
    for (const path of ["x.exe", "x", ".html", "x.xhtml", "x.php", "x.toString", "x.__proto__"]) {
      expect(fileTypeOf(path), path).toEqual({ type: "application/octet-stream", role: "file" });
    }
  });
});

describe("the CSP of a set's page (P082)", () => {
  it("opens the version's own path for what loads, never 'self', and nothing else", () => {
    const config = presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] });
    const source = `https://a.${DOMAIN}/v/3/`;
    const directives = new Map(
      fileSetCspDirectives(compile(config).cspDirectives, source).map(([name, ...sources]) => [
        name,
        sources,
      ]),
    );
    for (const name of [
      "script-src",
      "style-src",
      "font-src",
      "img-src",
      "media-src",
      "connect-src",
      "worker-src",
    ]) {
      expect(directives.get(name), name).toContain(source);
      expect(directives.get(name), name).not.toContain("'none'");
    }
    for (const [name, sources] of directives) {
      expect(sources, name).not.toContain("'self'");
    }
    expect(directives.get("frame-src")).toEqual(["'none'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'none'"]);
    expect(directives.get("default-src")).toEqual(["'none'"]);
    // The config's own CSP is unchanged: opaque frames and single pages keep P022 whole.
    expect(compile(config).csp).not.toContain(DOMAIN);
  });
});

describe("a file set in a frame (P083)", () => {
  it("the ticket's answer is the entry, moved to its files' address, where its access is in the path", async () => {
    const app = frames();
    const { answer, base, location, html: first } = await framed(app, site("1"));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("content-security-policy")).toContain(
      `connect-src ${location.origin}/__porthole/f/`,
    );
    expect(first).toContain("version 1");
    expect(first).toContain(`"files":{"base":"${base}","address":"${base}","expires":`);
    expect(base.startsWith(`${location.origin}/__porthole/f/`)).toBe(true);
    expect(base.endsWith("/")).toBe(true);
    // The access is sealed: neither the viewer nor the host's subject is in it.
    const token = base.slice(`${location.origin}/__porthole/f/`.length, -1);
    const raw = Buffer.from(token, "base64url").toString("latin1");
    expect(raw).not.toContain("ada");
    expect(raw).not.toContain("share-1");
    expect(token).not.toContain("ada");

    const page = await fetchAt(app, base, navigate);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("cache-control")).toBe("private, no-cache");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(
      `script-src 'unsafe-inline' 'unsafe-eval' blob: ${location.origin}/__porthole/f/`,
    );
    expect(csp).toContain(`connect-src ${location.origin}/__porthole/f/`);
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain(`frame-ancestors ${HOST}`);
    expect(csp).not.toContain("'self'");
    // Its frame's sandbox and denied features, should its address be opened on a tab (P099).
    expect(csp).toContain("; sandbox allow-scripts allow-same-origin;");
    expect(page.headers.get("permissions-policy")).toContain("camera=()");
    expect(answer.headers.get("content-security-policy")).toContain(
      "; sandbox allow-scripts allow-same-origin;",
    );
    const html = await page.text();
    // The page is in the shell, as data, with the base its navigations may stay under.
    expect(html).toContain('"files":{"base":');
    expect(html).toContain(JSON.stringify(base).slice(1, -1));
    expect(html).toContain("version 1");
  });

  it("serves each file with Porthole's type, nosniff, its own CSP, immutable, a strong ETag", async () => {
    const app = frames();
    const { base } = await framed(app, site("1"));
    const css = await fetchAt(app, `${base}style.css`, subresource("style"));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("x-content-type-options")).toBe("nosniff");
    expect(css.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(css.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(css.headers.get("content-security-policy")).toBe(
      `default-src 'none'; sandbox; frame-ancestors ${HOST}`,
    );
    const etag = `"${sha(SET("1")["style.css"] as string)}"`;
    expect(css.headers.get("etag")).toBe(etag);
    expect(await css.text()).toBe("main { color: rgb(1, 0, 0); }");

    const again = await fetchAt(app, `${base}style.css`, {
      ...subresource("style"),
      "if-none-match": etag,
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");

    // A script gets the page's CSP: a worker's policy is its script's.
    const script = await fetchAt(app, `${base}assets/app.js`, subresource("script"));
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("content-security-policy")).toContain("worker-src blob: ");
    expect(script.headers.get("content-security-policy")).not.toContain("sandbox");
    expect(script.headers.get("permissions-policy")).toBeNull();

    // An .html uploaded as .txt is text, and never sniffed.
    const notes = await fetchAt(app, `${base}notes.txt`, navigate);
    expect(notes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(notes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await notes.text()).toBe("<script>alert(1)</script>");

    // An SVG opened as a document runs nothing: sandboxed, nothing loads.
    const svg = await fetchAt(app, `${base}logo.svg`, navigate);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toContain("sandbox");

    // A type the table doesn't know is a download.
    const bin = await fetchAt(app, `${base}media/clip.bin`, subresource("empty"));
    expect(bin.headers.get("content-type")).toBe("application/octet-stream");
    expect(bin.headers.get("content-disposition")).toBe("attachment");

    const head = await fetchAt(app, `${base}data.json`, subresource("empty"), "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(
      String((SET("1")["data.json"] as string).length),
    );
    expect(await head.text()).toBe("");
  });

  it("answers ranges: 206 for one that fits, 416 for one that doesn't", async () => {
    const app = frames();
    const { base } = await framed(app, site("1"));
    const url = `${base}media/clip.mp4`;
    const part = await fetchAt(app, url, { ...subresource("video"), range: "bytes=10-19" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(part.headers.get("content-length")).toBe("10");
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    const tail = await fetchAt(app, url, { ...subresource("video"), range: "bytes=-5" });
    expect(tail.headers.get("content-range")).toBe("bytes 95-99/100");
    const open = await fetchAt(app, url, { ...subresource("video"), range: "bytes=98-" });
    expect([...new Uint8Array(await open.arrayBuffer())]).toEqual([98, 99]);
    const beyond = await fetchAt(app, url, { ...subresource("video"), range: "bytes=100-200" });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */100");
    const many = await fetchAt(app, url, { ...subresource("video"), range: "bytes=0-1,5-6" });
    expect(many.status).toBe(200);
    expect(many.headers.get("accept-ranges")).toBe("bytes");
  });

  it("cuts ranges from a stream too", async () => {
    const bytes = new Uint8Array(Array.from({ length: 64 }, (_, index) => index));
    const app = frames({
      reads: [],
      get: () =>
        Promise.resolve({
          files: {
            "index.html": { size: 5, sha256: sha("<p>x</p>") },
            "a.webm": { size: 64, sha256: sha(bytes) },
          },
          read: (path: string) =>
            Promise.resolve(
              path === "a.webm"
                ? new ReadableStream<Uint8Array>({
                    start(controller) {
                      for (let at = 0; at < 64; at += 16) {
                        controller.enqueue(bytes.slice(at, at + 16));
                      }
                      controller.close();
                    },
                  })
                : new TextEncoder().encode("<p>x</p>"),
            ),
        }),
    });
    const { base } = await framed(app, site("1"));
    const part = await fetchAt(app, `${base}a.webm`, {
      ...subresource("video"),
      range: "bytes=14-33",
    });
    expect(part.status).toBe(206);
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 14),
    );
    const whole = await fetchAt(app, `${base}a.webm`, subresource("video"));
    expect((await whole.arrayBuffer()).byteLength).toBe(64);
  });

  it("finds pages as static hosts do, and 404s what isn't in the set", async () => {
    const app = frames();
    const { base } = await framed(app, site("1"));
    const about = await fetchAt(app, `${base}about`, navigate);
    expect(about.status).toBe(200);
    expect(await about.text()).toContain("about 1");
    const docs = await fetchAt(app, `${base}docs`, navigate);
    expect(docs.status).toBe(307);
    expect(docs.headers.get("location")).toBe(`${base}docs/`);
    const missing = await fetchAt(app, `${base}docs/nothing`, navigate);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("no such doc");
    const top = await fetchAt(app, `${base}nothing`, navigate);
    expect(top.status).toBe(404);
    expect(await top.text()).toContain("nothing here");
    const asset = await fetchAt(app, `${base}nothing.js`, subresource("script"));
    expect(asset.status).toBe(404);
    expect(asset.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(app.store.reads).not.toContain("nothing.js");
  });

  it("refuses traversal, however it is spelled, and never reads outside the manifest", async () => {
    const app = frames();
    const { base } = await framed(app, site("1"));
    for (const raw of [
      "..%2findex.html",
      "%2e%2e%2findex.html",
      "%252e%252e/index.html",
      "assets%5capp.js",
      "assets%2fapp.js",
      "a%00.js",
    ]) {
      const answer = await fetchAt(app, `${base}${raw}`, subresource("script"));
      expect(answer.status, raw).toBe(404);
    }
    // The URL parser resolves what it sees: dots and backslashes stay within the origin's paths,
    // and out of the token they open nothing.
    for (const path of ["/../../d/x", "\\..\\..\\x", "/%2e%2e/%2e%2e/x"]) {
      const url = new URL(`${base.slice(0, -1)}${path}`);
      const answer = await fetchAt(app, url.href, subresource("script"));
      expect([401, 404], `${path} → ${url.pathname}`).toContain(answer.status);
    }
  });

  it("never lets a service worker in", async () => {
    const app = frames();
    const { base } = await framed(app, site("1"));
    const script = await fetchAt(app, `${base}assets/app.js`, {
      "sec-fetch-dest": "serviceworker",
      "service-worker": "script",
    });
    expect(script.status).toBe(403);
  });

  it("a version's access serves that version only, whatever is published after", async () => {
    const app = frames();
    const one = await framed(app, site("1"));
    const two = await framed(app, site("2"));
    expect(await (await fetchAt(app, `${one.base}data.json`)).text()).toBe('{"version":"1"}');
    expect(await (await fetchAt(app, `${two.base}data.json`)).text()).toBe('{"version":"2"}');
  });

  it("an access is this origin's only, unforgeable, and ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const app = frames();
    const { base, location } = await framed(app, site("1"));
    const token = base.slice(`${location.origin}/__porthole/f/`.length, -1);
    const elsewhere = app.server.originFor("another-scope");
    expect((await fetchAt(app, `${elsewhere}/__porthole/f/${token}/data.json`)).status).toBe(401);
    const tampered = `${token.slice(0, 20)}${token[20] === "A" ? "B" : "A"}${token.slice(21)}`;
    expect(
      (await fetchAt(app, `${location.origin}/__porthole/f/${tampered}/data.json`)).status,
    ).toBe(401);
    expect((await fetchAt(app, `${base}data.json`)).status).toBe(200);
    vi.setSystemTime(Date.now() + 3_601_000);
    expect((await fetchAt(app, `${base}data.json`)).status).toBe(401);
  });

  it("asks the host's check on every file, and a revoked subject gets nothing more", async () => {
    const app = frames();
    const { base } = await framed(app, site("1"));
    expect((await fetchAt(app, `${base}style.css`)).status).toBe(200);
    expect(app.checks).toContain(new URL(`${base}style.css`).pathname);
    app.revoked.add("share-1");
    expect((await fetchAt(app, `${base}style.css`)).status).toBe(403);
  });

  it("a single-page app answers its routes with the entry, navigations only", async () => {
    const app = frames(
      fileStore({ "site@1": { "index.html": "<p>app</p>", "app.js": "1" } }, true),
    );
    const { base } = await framed(app, site("1"));
    const route = await fetchAt(app, `${base}settings/profile`, navigate);
    expect(route.status).toBe(200);
    // The entry, as data in the shell's plan.
    expect(await route.text()).toContain('"document":"\\u003cp>app');
    expect((await fetchAt(app, `${base}settings/profile.js`, subresource("script"))).status).toBe(
      404,
    );
  });

  it("a one-page version is served as in 0.5, at its document", async () => {
    const server = createServer({
      content: { domain: DOMAIN, scheme: "https" },
      secret,
      hostOrigins: [HOST],
      configs: { artifact: presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] }) },
      artifacts: { get: () => Promise.resolve({ html: "<p>one page</p>" }) },
    });
    const location = await server.issue(site("1"), { viewer: "ada" });
    const answer = await server.handle(req(location.url));
    expect(answer?.status).toBe(200);
    expect(answer?.headers.get("cache-control")).toBe("no-store");
    expect(await answer?.text()).toContain("one page");
  });
});

// Tabs: clean addresses (P068) where the app names the version's own address (P081).
const APP = "https://app.example.com";
const AUTHORIZE = `${APP}/porthole/authorize`;
const origin = (scope: string) => `https://a-${scope}.usercontent.example.net`;

class Browser {
  readonly jar = new Map<string, string>();
  headers(extra: Record<string, string> = {}): Headers {
    const cookies = [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    return new Headers({
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      ...(cookies === "" ? {} : { cookie: cookies }),
      ...extra,
    });
  }
  keep(response: Response): void {
    for (const each of response.headers.getSetCookie()) {
      const [pair = ""] = each.split(";");
      const at = pair.indexOf("=");
      this.jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
}

function tabs() {
  const latest = new Map<string, string>([["abc", "1"]]);
  const store = fileStore({ "abc@1": SET("1"), "abc@2": SET("2") });
  const instance = (scope: string, version: string): InstanceRef => ({
    scope,
    document: { kind: "artifact", id: scope, version },
  });
  const content = createContentHost<{ id: string }>({
    domain: "usercontent.example.net",
    appOrigins: [APP],
    secret: "a test secret that is at least thirty-two bytes long",
    configs: (source) => ({
      artifact: presets.artifact({ isolation: "domain", contentOrigins: [source] }),
    }),
    name: prefixedName("a-"),
    instance: () => null,
    access: (_instance, viewer) => (viewer === null ? null : { viewer: viewer.id }),
    source: store.get,
    entry: {
      authorizeUrl: AUTHORIZE,
      at: (scope, path) => {
        const at = versionedAddress(path);
        const version = at === null ? null : (at.version ?? latest.get(scope) ?? null);
        return at === null || version === null
          ? null
          : {
              instance: instance(scope, version),
              base: versionBase(version),
              file: at.file,
              pinned: true,
            };
      },
    },
  });
  const authorize = content.authorize((request) => {
    const who = request.headers.get("x-viewer");
    return who === null ? null : { id: who };
  });
  /** A request as the browser sends it, following redirects; the hops and the last answer. */
  async function open(browser: Browser, url: string, extra: Record<string, string> = {}) {
    const hops = [url];
    let at = url;
    for (;;) {
      const request = new Request(at, {
        headers: browser.headers({ "x-viewer": "ada", ...extra }),
      });
      const answer = at.startsWith(APP) ? await authorize(request) : await content.fetch(request);
      if (answer === null) {
        throw new Error(`nothing answered ${at}`);
      }
      browser.keep(answer);
      if (![302, 303, 307].includes(answer.status)) {
        return { hops, answer, at };
      }
      at = new URL(answer.headers.get("location") ?? "", at).href;
      hops.push(at);
    }
  }
  return { content, latest, open };
}

describe("a file set on a tab (P081)", () => {
  it("the latest address goes to the version's own, where its files are", async () => {
    const app = tabs();
    const browser = new Browser();
    const { answer, at, hops } = await app.open(browser, `${origin("abc")}/`);
    expect(at).toBe(`${origin("abc")}/v/1/`);
    expect(hops.some((each) => each.startsWith(AUTHORIZE))).toBe(true);
    expect(answer.status).toBe(200);
    const csp = answer.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`script-src 'unsafe-inline' 'unsafe-eval' blob: ${origin("abc")}/v/1/`);
    expect(csp).not.toContain(`${origin("abc")}/v/2/`);
    // On a tab no frame sandboxes it: its own CSP does, with the frame's tokens (P099).
    expect(csp).toContain("; sandbox allow-scripts allow-same-origin;");
    // Its version named for the host's notices (P098), no ticket's address.
    expect(await answer.text()).toContain(
      `"files":{"base":"${origin("abc")}/v/1/","set":{"id":"abc","version":"1"}}`,
    );
    // Its files ride on the session, immutable at the version's own address.
    const css = await app.open(browser, `${origin("abc")}/v/1/style.css`, subresource("style"));
    expect(css.hops.length).toBe(1);
    expect(css.answer.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(await css.answer.text()).toContain("rgb(1, 0, 0)");
    // A file of the latest goes to the same file of the version's own address.
    const direct = await app.open(new Browser(), `${origin("abc")}/data.json`);
    expect(direct.at).toBe(`${origin("abc")}/v/1/data.json`);
    expect(await direct.answer.text()).toBe('{"version":"1"}');
    // The version's address without its slash is its directory.
    const bare = await app.open(browser, `${origin("abc")}/v/1`);
    expect(bare.hops).toEqual([`${origin("abc")}/v/1`, `${origin("abc")}/v/1/`]);
  });

  it("a page loaded as the latest keeps its own version's files when a newer one is published", async () => {
    const app = tabs();
    const browser = new Browser();
    const first = await app.open(browser, `${origin("abc")}/`);
    expect(first.at).toBe(`${origin("abc")}/v/1/`);
    app.latest.set("abc", "2");
    // The page's relative loads, made after the publish, are version 1's.
    const data = await app.open(browser, `${origin("abc")}/v/1/data.json`, subresource("empty"));
    expect(data.hops.length).toBe(1);
    expect(await data.answer.text()).toBe('{"version":"1"}');
    // The latest address now opens the new version, at its own address.
    const next = await app.open(browser, `${origin("abc")}/`);
    expect(next.at).toBe(`${origin("abc")}/v/2/`);
    expect(await (await app.open(browser, `${origin("abc")}/v/2/data.json`)).answer.text()).toBe(
      '{"version":"2"}',
    );
    // And the first version's session never serves the second's address.
    const other = new Browser();
    await app.open(other, `${origin("abc")}/v/1/`);
    const crossed = await app.content.fetch(
      new Request(`${origin("abc")}/v/2/data.json`, {
        headers: other.headers(subresource("empty")),
      }),
    );
    // A subresource without a session for its address is refused, never sent to sign in (P081).
    expect(crossed?.status).toBe(401);
    expect(crossed?.headers.get("set-cookie")).toBeNull();
  });

  it("versionedAddress reads the usual convention", () => {
    expect(versionedAddress("/")).toEqual({ version: null, file: "" });
    expect(versionedAddress("/style.css")).toEqual({ version: null, file: "style.css" });
    expect(versionedAddress("/v/3")).toEqual({ version: "3", file: "" });
    expect(versionedAddress("/v/3/")).toEqual({ version: "3", file: "" });
    expect(versionedAddress("/v/3/assets/a.js")).toEqual({ version: "3", file: "assets/a.js" });
    expect(versionedAddress("/v/%2e%2e/x")).toBeNull();
    // Kept for an asset library across versions: no version's address.
    expect(versionedAddress("/_blob/abc")).toBeNull();
    expect(versionedAddress("/v/3/_blob/abc")).toEqual({ version: "3", file: "_blob/abc" });
    expect(versionBase("3")).toBe("/v/3/");
  });
});

describe("the agent's side: a page with files, linted and admitted (P081)", () => {
  const served = presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] });
  const GOOD = {
    "index.html": `<!doctype html><html><head><link rel="stylesheet" href="css/site.css"><script type="module" src="./js/app.mjs"></script></head>
<body><img src="img/a.png" alt=""><a href="about">About</a><a href="docs/">Docs</a><a href="#top">Top</a><a href="https://example.com/">out</a></body></html>`,
    "about.html": "<!doctype html><title>About</title><a href='./'>home</a>",
    "docs/index.html": "<!doctype html><title>Docs</title><a href='../about.html'>about</a>",
    "css/site.css": "body { background: url(../img/a.png); } @import 'more.css';",
    "css/more.css": "",
    "js/app.mjs":
      "import { x } from './lib.mjs'; fetch('./data.json'); new Worker(new URL('./worker.js', import.meta.url));",
    "js/lib.mjs": "export const x = 1;",
    "js/worker.js": "fetch('../data.json');",
    "data.json": "{}",
    "img/a.png": new Uint8Array([1, 2, 3]),
  };

  it("finds nothing wrong with a set whose references are all its own files", () => {
    expect(lintFiles(served, GOOD)).toEqual([]);
  });

  it("the Vite + React fixture lints clean", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.join(import.meta.dirname, "..", "leak", "fixtures", "vite-react", "out");
    const files: Record<string, Uint8Array> = {};
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const full = path.join(entry.parentPath, entry.name);
        files[path.relative(root, full).split(path.sep).join("/")] = await readFile(full);
      }
    }
    expect(Object.keys(files).sort()).toContain("index.html");
    expect(lintFiles(served, files)).toEqual([]);
  });

  it("errs on a page's root-relative reference and a broken set; warns on what isn't there", () => {
    const findings = lintFiles(served, {
      ...GOOD,
      "index.html": `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index.js"></script></head>
<body><img src="img/missing.png" alt=""><script>document.write("x")</script></body></html>`,
      "Data.json": "{}",
      "tool.exe": new Uint8Array([0]),
      "js/app.mjs": "import './nope.mjs'; fetch('./gone.json');",
    });
    const brief = findings.map((each) => [
      each.rule,
      each.severity,
      each.path ?? "",
      each.line ?? 0,
    ]);
    expect(brief).toEqual(
      expect.arrayContaining([
        ["files", "error", "Data.json", 0],
        ["root-path", "error", "index.html", 2],
        ["missing-file", "warning", "index.html", 3],
        ["document-write", "error", "index.html", 3],
        ["file-type", "warning", "tool.exe", 0],
        ["missing-file", "warning", "js/app.mjs", 1],
      ]),
    );
    expect(findings.find((each) => each.rule === "root-path")?.message).toContain('base: "./"');
    expect(findings.filter((each) => each.rule === "missing-file").length).toBe(3);
  });

  it("a page that isn't served can't come with files; nor can a set without its entry", () => {
    expect(lintFiles(presets.artifact(), GOOD).map((each) => each.rule)).toEqual(["files"]);
    const { "index.html": _entry, ...rest } = GOOD;
    expect(
      lintFiles(served, rest).some((each) => each.rule === "files" && each.path === "index.html"),
    ).toBe(true);
    expect(lintFiles(served, { "app.html": "<p>x</p>" }, { entry: "app.html" })).toEqual([]);
  });

  it("admitFiles refuses what certainly fails, naming the file and line, and notes the rest", () => {
    const refused = admitFiles(served, { "index.html": '<script src="/x.js"></script>' });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.refusal).toContain("- index.html line 1: /x.js starts with /");
    const noted = admitFiles(served, { "index.html": '<img src="missing.png">' });
    expect(noted.ok).toBe(true);
    expect(noted.ok ? noted.note : "").toContain(
      "index.html line 1: missing.png names missing.png",
    );
    expect(admitFiles(served, GOOD)).toEqual({ ok: true, findings: [], note: null });
    expect(
      admitFiles(served, { "index.html": '<script src="/x.js"></script>' }, { refuseOn: "never" })
        .ok,
    ).toBe(true);
  });
});

describe("a page with files held to one screen (P106)", () => {
  const served = presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] });
  const SHELL =
    "html, body { height: 100%; overflow: hidden; }\n#root { position: fixed; height: 100dvh; overflow: hidden; }";
  const UNDO = "html, body, #root { height: auto; overflow: visible; position: static; }";
  const page = (head: string) =>
    `<!doctype html><html><head>${head}</head><body><div id="root"></div><script type="module" src="./app.js"></script></body></html>`;
  const held = (files: Record<string, string>) =>
    lintFiles(served, { "app.js": "", ...files }).filter((each) => each.rule === "scroll-lock");

  it("reads the stylesheets a page links and what they import, and names the file and line", () => {
    const linked = held({
      "index.html": page('<link rel="stylesheet" href="./assets/index.css">'),
      "assets/index.css": `.x { color: red }\n${SHELL}`,
    });
    expect(linked.map((each) => [each.severity, each.path, each.line])).toEqual([
      ["warning", "assets/index.css", 2],
    ]);
    expect(linked[0]?.message).toContain(
      "add html, body, #root { height: auto; overflow: visible; position: static } after those rules",
    );
    const imported = held({
      "index.html": page('<link rel="stylesheet" href="css/site.css">'),
      "css/site.css": "@import 'base/shell.css';\nbody { color: black }",
      "css/base/shell.css": SHELL,
    });
    expect(imported.map((each) => [each.path, each.line])).toEqual([["css/base/shell.css", 1]]);
    // Each page of the set, by what it links; a page's own <style> once, not twice.
    const pages = held({
      "index.html": page(`<style>${SHELL}</style>`),
      "about.html": page('<link rel="stylesheet" href="shell.css">'),
      "plain.html": page(""),
      "shell.css": SHELL,
    });
    expect(pages.map((each) => each.path)).toEqual(["index.html", "shell.css"]);
  });

  it("an override in a later stylesheet or <style>, in either order, is seen", () => {
    expect(
      held({
        "index.html": page(
          '<link rel="stylesheet" href="shell.css"><link rel="stylesheet" href="undo.css">',
        ),
        "shell.css": SHELL,
        "undo.css": UNDO,
      }),
    ).toEqual([]);
    expect(
      held({
        "index.html": page(`<link rel="stylesheet" href="shell.css"><style>${UNDO}</style>`),
        "shell.css": SHELL,
      }),
    ).toEqual([]);
    // The override before the shell's rules loses to them.
    expect(
      held({
        "index.html": page(`<style>${UNDO}</style><link rel="stylesheet" href="shell.css">`),
        "shell.css": SHELL,
      }).length,
    ).toBe(1);
    // A sheet for print, one that isn't in the set, or an alternate one: not read.
    expect(
      held({
        "index.html": page(
          '<link rel="stylesheet" href="shell.css" media="print"><link rel="alternate stylesheet" href="shell.css"><link rel="stylesheet" href="gone.css">',
        ),
        "shell.css": SHELL,
      }),
    ).toEqual([]);
  });

  it("reads each stylesheet once, within one budget a page: fan-out and repeated links stay cheap", async () => {
    const { scrollLock, SHEETS } = await import("../src/check/scroll.ts");
    // Ten sheets, each importing the next six times: 6^10 imports if each were followed.
    const sheets: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) {
      sheets[`s${index}.css`] = `${`@import "s${index + 1}.css";\n`.repeat(6)}p { color: red }`;
    }
    sheets["s10.css"] = SHELL;
    let asked = 0;
    const sheet = (href: string) => {
      asked += 1;
      const text = sheets[href];
      return text === undefined ? null : { path: href, text };
    };
    const started = performance.now();
    const fanned = scrollLock(page('<link rel="stylesheet" href="s0.css">'), {
      noun: "page",
      path: "index.html",
      sheet,
    });
    expect(fanned?.path).toBe("s10.css");
    expect(asked).toBeLessThanOrEqual(11);
    // A thousand links to one sheet: asked for and read once.
    asked = 0;
    scrollLock(page('<link rel="stylesheet" href="s10.css">'.repeat(1_000)), {
      noun: "page",
      path: "index.html",
      sheet,
    });
    expect(asked).toBe(1);
    // Past SHEETS distinct sheets, the rest isn't read: the hold in the last one goes unseen.
    const many: Record<string, string> = {};
    for (let index = 0; index < SHEETS; index += 1) {
      many[`m${index}.css`] = "p { color: red }";
    }
    many["last.css"] = SHELL;
    const links = Object.keys(many)
      .map((path) => `<link rel="stylesheet" href="${path}">`)
      .join("");
    expect(
      scrollLock(page(links), {
        noun: "page",
        path: "index.html",
        sheet: (href) => (many[href] === undefined ? null : { path: href, text: many[href] }),
      }),
    ).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("reads each stylesheet once for the version: many pages cost what their pages and sheets do, added", () => {
    // P106's fourth review: each page read every sheet it links again (only decoding was shared),
    // so the work was the pages times the sheets: 500 pages sharing one 250 KB sheet took 13.8 s,
    // 10 pages linking two 2 MiB `div,` sheets 15.9 s. Each sheet is now read once a version and
    // replayed for each page, only its rules that may match the page's top. Timed as P098 has it,
    // pages and sheets both cut to a sixteenth for the parts: linear, the whole costs what the
    // sixteen parts do; a product of the two, sixteen times as much (and past the bound beside it).
    const appSheet = (bytes: number) => {
      let css = `${SHELL}\n`;
      for (let index = 0; css.length < bytes; index += 1) {
        css +=
          index % 20 === 0
            ? `.list-${index} { overflow-y: auto; max-height: 20rem }\n`
            : `.c-${index} > .d-${index} { color: #123; padding: ${index}px; margin: 0 auto }\n`;
      }
      return css;
    };
    const divs = (bytes: number) => `${"div,".repeat(bytes / 4 - 4)}div{top:0}`;
    const version = (pages: number, sheets: Record<string, string>) => {
      const files: Record<string, string> = { "app.js": "", ...sheets };
      const links = Object.keys(sheets)
        .map((path) => `<link rel="stylesheet" href="${path}">`)
        .join("");
      for (let index = 0; index < pages; index += 1) {
        files[`p${index}.html`] = page(links);
      }
      return files;
    };
    const timed = (files: Record<string, string>, times: number): number => {
      const started = performance.now();
      for (let each = 0; each < times; each += 1) {
        lintFiles(served, files);
      }
      return performance.now() - started;
    };
    const mib = 1024 * 1024;
    const inputs = [
      {
        name: "512 pages, one 256 KB sheet",
        whole: version(512, { "app.css": appSheet(256 * 1024) }),
        part: version(32, { "app.css": appSheet(16 * 1024) }),
      },
      {
        name: "16 pages, two 2 MiB div, sheets",
        whole: version(16, { "a.css": divs(2 * mib), "b.css": divs(2 * mib) }),
        part: version(1, { "a.css": divs(128 * 1024), "b.css": divs(128 * 1024) }),
      },
    ];
    for (const { name, whole, part } of inputs) {
      let once = Infinity;
      let parts = Infinity;
      for (let round = 0; round < 3; round += 1) {
        once = Math.min(once, timed(whole, 1));
        expect(once, `${name}: ${once.toFixed(1)} ms`).toBeLessThan(3_000);
        parts = Math.min(parts, timed(part, 16));
      }
      const said = `${name}: ${once.toFixed(1)} ms, 16 sixteenths ${parts.toFixed(1)} ms`;
      expect(once / parts, said).toBeLessThan(8);
    }
    // Every page is still checked.
    expect(
      lintFiles(served, inputs[0]?.whole ?? {}).filter((each) => each.rule === "scroll-lock"),
    ).toHaveLength(512);
  });

  it("checks a version's pages within one budget: past it, the pages left aren't checked", () => {
    // VERSION_READ (16 MiB) of sheets read and replayed for all its pages: twelve pages, each with
    // a sheet of its own just under 2 MiB, are eight checked and four not.
    const files: Record<string, string> = { "app.js": "" };
    for (let index = 0; index < 12; index += 1) {
      let css = `${SHELL}\n`;
      for (let rule = 0; css.length < 2 * 1024 * 1024 - 4_096; rule += 1) {
        css += `.s${index}-${rule} > .d${rule} { color: #123; padding: ${rule}px }\n`;
      }
      files[`p${index}.html`] = page(`<link rel="stylesheet" href="s${index}.css">`);
      files[`s${index}.css`] = css;
    }
    const started = performance.now();
    const findings = held(files);
    const took = performance.now() - started;
    expect(findings.map((each) => each.path)).toEqual(
      Array.from({ length: 8 }, (_, index) => `s${index}.css`),
    );
    expect(took, `${took.toFixed(0)} ms`).toBeLessThan(5_000);
  });

  it("matches scroll rules against a version's markup within one budget of steps", () => {
    // VERSION_STEPS (2,000,000) for all its pages: each of these spends a page's million (2,000
    // elements 32 deep, 256 scroll rules whose first compound matches none of them), so two are
    // checked and two not.
    const nest = `${"<div>".repeat(31)}<div></div>${"</div>".repeat(31)}`;
    const deep = `<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><div id="root">${nest.repeat(63)}</div></body></html>`;
    const rules = Array.from(
      { length: 256 },
      (_, index) => `.n${index} ${"div ".repeat(30)}div { overflow: auto }`,
    );
    const files: Record<string, string> = {
      "app.css": `html, body { height: 100%; overflow: hidden }\n${rules.join("\n")}`,
    };
    for (let index = 0; index < 4; index += 1) {
      files[`p${index}.html`] = deep;
    }
    // Two warnings (each named by the sheet's line): the first two pages'.
    expect(held(files).map((each) => [each.path, each.line])).toEqual([
      ["app.css", 1],
      ["app.css", 1],
    ]);
  });

  it("lints a page linking a 1.8 MB stylesheet of declarations for body in linear time", () => {
    // P106's second review: each declaration copied the list of those before it, so this one sheet
    // (230,000 declarations) took 285 s on an arm64 box (over 400 s in the review). Kept as each
    // layer's winner so far: about 0.2 s there, so the bound is many times that; quadratic, minutes.
    const sheet = `html, body { height: 100%; }\nbody { ${"top: 0; ".repeat(230_000)}overflow: hidden }`;
    expect(sheet.length).toBeGreaterThan(1_800_000);
    const started = performance.now();
    const findings = held({
      "index.html": page('<link rel="stylesheet" href="shell.css">'),
      "shell.css": sheet,
    });
    const took = performance.now() - started;
    expect(findings.map((each) => [each.path, each.line])).toEqual([["shell.css", 2]]);
    expect(took, `${took.toFixed(0)} ms`).toBeLessThan(3_000);
  });

  it("admitFiles publishes it, with the warning in its note", () => {
    const admitted = admitFiles(served, {
      "index.html": page('<link rel="stylesheet" href="shell.css">'),
      "shell.css": SHELL,
      "app.js": "",
    });
    expect(admitted.ok).toBe(true);
    expect(admitted.ok ? admitted.note : "").toContain(
      "- shell.css line 1: The page looks held to one screen in its frame",
    );
  });
});

describe("after the security review of 0.6.0's first cut", () => {
  it("publish refuses Unicode format characters: an override, a zero-width space, a BOM (Cf)", () => {
    for (const path of ["a‮gnp.js", "a​b.html", "﻿index.html", "soft­hyphen.css"]) {
      expect(filePathProblem(path), JSON.stringify(path)).toContain("format character");
    }
    expect(requestFilePath("a%E2%80%AEb.js")).toBeNull();
  });

  it("traversal: the inputs do traverse under a weaker decoder, never under requestFilePath, and read is asked only for manifest paths", async () => {
    const adversarial = [
      "%252e%252e/secret.txt",
      "..%2fsecret.txt",
      "%2e%2e%2fsecret.txt",
      "sub%5c..%5c..%5csecret.txt",
      "sub%2f..%2f..%2fsecret.txt",
    ];
    // The control: decoding twice (or once, then normalizing) would reach above the version.
    const weaker = (raw: string) =>
      decodeURIComponent(decodeURIComponent(raw)).replaceAll("\\", "/");
    for (const raw of adversarial) {
      expect(weaker(raw).split("/"), raw).toContain("..");
      expect(requestFilePath(raw), raw).toBeNull();
    }
    // A store that would answer anything it is asked (a filesystem's way): Porthole asks only
    // for the manifest's own paths.
    const asked: string[] = [];
    const app = frames({
      reads: asked,
      get: () =>
        Promise.resolve({
          files: {
            "index.html": { size: 3, sha256: sha("<p>") },
            "sub/a.js": { size: 1, sha256: sha("1") },
          },
          read: (path: string) => {
            asked.push(path);
            return Promise.resolve(
              new TextEncoder().encode(path === "index.html" ? "<p>" : `secret ${path}`),
            );
          },
        }),
    });
    const { base } = await framed(app, site("1"));
    for (const raw of adversarial) {
      const answer = await fetchAt(app, `${base}${raw}`, subresource("script"));
      expect(answer.status, raw).toBe(404);
      expect(await answer.text()).not.toContain("secret");
    }
    expect(
      asked.every((each) => each === "index.html" || each === "sub/a.js"),
      asked.join(),
    ).toBe(true);
  });

  it("lint reads adversarial text in linear time: 1 MB costs what sixteen times 64 KB does; nothing past a limit", () => {
    const served = presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] });
    const mb = 1024 * 1024;
    // What this guards (after the review of 0.6.0, P081-P084): no pattern that grows faster than
    // the text (72 KB of `import a ` took 3.9 s). A time limit says how fast the machine is, not
    // that (659 ms for 1 MB on a busy box, P098): so the same work is timed both ways, once as
    // 1 MB and once as sixteen 64 KB texts, each the fastest of three (interleaved, so a busy
    // machine slows both alike). Linear, the two cost about the same (measured 0.2-1.3x; under
    // 3x CPU oversubscription, at most 4.2x); quadratic, 1 MB costs sixteen times as much (the
    // scans before the review: 9.6-16x at 48 KB). Six times the old case's work: 9.6 s on a machine
    // three times oversubscribed, so its cap is a minute, not the default 5 s.
    const fastest = (files: Record<string, string>, times: number): number => {
      const started = performance.now();
      for (let each = 0; each < times; each += 1) {
        admitFiles(served, files);
      }
      return performance.now() - started;
    };
    const setsOf = (unit: string, bytes: number) => {
      const big = unit.repeat(Math.ceil(bytes / unit.length));
      const page = unit.repeat(Math.floor((190_000 * bytes) / mb / unit.length));
      return [
        { "index.html": "<p>x</p>", "a.js": big },
        { "index.html": "<p>x</p>", "a.css": big },
        { "index.html": page, "a.mjs": big },
      ];
    };
    for (const unit of [
      "import a ",
      "<img ",
      "<script ",
      '<img src="',
      "url(",
      "fetch('",
      "from './",
      "import('./",
      "new URL('",
      "new Worker('",
      "@import '",
      "a\n",
    ]) {
      const small = setsOf(unit, mb / 16);
      const whole = setsOf(unit, mb);
      for (const [index, files] of whole.entries()) {
        let parts = Infinity;
        let once = Infinity;
        for (let round = 0; round < 3; round += 1) {
          parts = Math.min(parts, fastest(small[index] as Record<string, string>, 16));
          once = Math.min(once, fastest(files, 1));
        }
        const said = `${JSON.stringify(unit)} ${Object.keys(files).join(" ")}: 1 MB ${once.toFixed(1)} ms, 16 × 64 KB ${parts.toFixed(1)} ms`;
        expect(once / parts, said).toBeLessThan(8);
        // And a bound beside it, twenty times what a busy machine takes (the slowest 1 MB here: 31 ms
        // idle, 143 ms at load 52 on 16 CPUs): a scan that grew faster than the text needs minutes.
        expect(once, said).toBeLessThan(3_000);
      }
    }
    // Over a limit: only the set's problem, nothing read.
    const limited = presets.artifact({
      isolation: "domain",
      contentOrigins: [CONTENT],
      limits: { maxFileBytes: 1_000 },
    });
    const findings = lintFiles(limited, {
      "index.html": "<p>x</p>",
      "a.js": "import a ".repeat(200),
    });
    expect(findings.map((each) => each.rule)).toEqual(["files"]);
    // A page over its own limit is said so, and not read.
    const oversize = lintFiles(served, {
      "index.html": `<p>${"x".repeat(250_000)}<iframe></iframe>`,
    });
    expect(oversize.map((each) => each.rule)).toEqual(["size"]);
  }, 60_000);

  it("a sealed address opens on its own for an hour; then only the running page's own loads, while its session lasts; its shell renews it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const app = frames();
    const location = await app.server.issue(site("1"), {
      viewer: "ada",
      subject: "share-1",
      sessionSeconds: 4 * 3_600,
    });
    const answer = await app.server.handle(req(location.url, navigate));
    const html = (await answer?.text()) ?? "";
    const base = /"address":"([^"]+)"/u.exec(html)?.[1] ?? "";
    const expires = Number(/"expires":(\d+)/u.exec(html)?.[1]);
    expect(expires - Date.now()).toBeGreaterThan(3_590_000);
    expect(expires - Date.now()).toBeLessThanOrEqual(3_600_000);
    const own = {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
    // Only the page itself renews its address: never a navigation, never another site.
    expect((await fetchAt(app, `${base}__porthole/renew`, navigate)).status).toBe(403);
    expect(
      (await fetchAt(app, `${base}__porthole/renew`, { ...own, "sec-fetch-site": "cross-site" }))
        .status,
    ).toBe(403);
    vi.setSystemTime(Date.now() + 3_700_000);
    // Opened on its own (a tab, a history entry): ended.
    expect((await fetchAt(app, base, navigate)).status).toBe(401);
    expect((await fetchAt(app, `${base}data.json`, { "sec-fetch-site": "none" })).status).toBe(401);
    // The running page's own loads, from the address it holds: until the session ends.
    expect((await fetchAt(app, `${base}data.json`, own)).status).toBe(200);
    // Its shell renews the address, from the address it holds; opened on its own, it has ended.
    expect((await fetchAt(app, `${base}__porthole/renew`, navigate)).status).toBe(401);
    const renewed = (await (await fetchAt(app, `${base}__porthole/renew`, own)).json()) as {
      base: string;
      expires: number;
    };
    expect(renewed.base).not.toBe(base);
    expect(renewed.base.startsWith(`${location.origin}/__porthole/f/`)).toBe(true);
    expect((await fetchAt(app, renewed.base, navigate)).status).toBe(200);
    // The host's check still decides, and the session's end is the end.
    app.revoked.add("share-1");
    expect((await fetchAt(app, `${base}data.json`, own)).status).toBe(403);
    app.revoked.delete("share-1");
    vi.setSystemTime(Date.now() + 4 * 3_600_000);
    expect((await fetchAt(app, `${base}data.json`, own)).status).toBe(401);
    expect((await fetchAt(app, `${renewed.base}data.json`, own)).status).toBe(401);
  });

  it("a tab: a subresource without a session is refused with no state; only a page opening begins an entry", async () => {
    const app = tabs();
    for (const mode of ["cors", "no-cors", "same-origin"]) {
      const answer = await app.content.fetch(
        new Request(`${origin("abc")}/v/1/data.json`, {
          headers: { "sec-fetch-mode": mode, "sec-fetch-dest": "empty" },
        }),
      );
      expect(answer?.status, mode).toBe(401);
      expect(answer?.headers.get("set-cookie"), mode).toBeNull();
      expect(answer?.headers.get("cache-control"), mode).toBe("no-store");
    }
    const page = await app.content.fetch(
      new Request(`${origin("abc")}/v/1/`, {
        headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
      }),
    );
    expect(page?.status).toBe(302);
    expect(page?.headers.get("set-cookie")).toContain("porthole-n-");
  });

  it("a tab: files are immutable only where the app says the base is pinned; the most specific base serves", async () => {
    const instance = (version: string): InstanceRef => ({
      scope: "abc",
      document: { kind: "artifact", id: "abc", version },
    });
    const store = fileStore({ "abc@1": SET("1"), "abc@2": SET("2") });
    const content = createContentHost<{ id: string }>({
      domain: "usercontent.example.net",
      appOrigins: [APP],
      secret: "a test secret that is at least thirty-two bytes long",
      configs: (source) => ({
        artifact: presets.artifact({ isolation: "domain", contentOrigins: [source] }),
      }),
      name: prefixedName("a-"),
      instance: () => null,
      access: (_instance, viewer) => (viewer === null ? null : { viewer: viewer.id }),
      source: store.get,
      entry: {
        authorizeUrl: AUTHORIZE,
        // "/latest/…" is the latest, not pinned; "/v/1/…" version 1, pinned.
        at: (_scope, path) =>
          path.startsWith("/latest/")
            ? { instance: instance("2"), base: "/latest/" }
            : path.startsWith("/v/1/")
              ? { instance: instance("1"), base: "/v/1/", pinned: true }
              : null,
      },
    });
    const authorize = content.authorize(() => ({ id: "ada" }));
    const browser = new Browser();
    const open = async (url: string, extra: Record<string, string> = {}) => {
      let at = url;
      for (;;) {
        const request = new Request(at, { headers: browser.headers(extra) });
        const answer = at.startsWith(APP) ? await authorize(request) : await content.fetch(request);
        browser.keep(answer as Response);
        if (![302, 303, 307].includes(answer?.status ?? 0)) {
          return answer as Response;
        }
        at = new URL(answer?.headers.get("location") ?? "", at).href;
      }
    };
    await open(`${origin("abc")}/latest/`);
    const latest = await open(`${origin("abc")}/latest/style.css`, subresource("style"));
    expect(latest.headers.get("cache-control")).toBe("private, no-cache");
    await open(`${origin("abc")}/v/1/`);
    const pinned = await open(`${origin("abc")}/v/1/style.css`, subresource("style"));
    expect(pinned.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(await pinned.text()).toContain("rgb(1, 0, 0)");
  });

  it("an entry's base and file stay what they say: no dot segment, no odd character, nothing past the base", async () => {
    const server = createServer({
      content: { domain: DOMAIN, scheme: "https", name: prefixedName("a-") },
      secret,
      hostOrigins: [HOST],
      configs: { artifact: presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] }) },
      artifacts: fileStore({ "site@1": SET("1") }),
      entry: { authorizeUrl: `${HOST}/porthole/authorize` },
    });
    const begun = await server.handle(
      new Request(`https://a-x.${DOMAIN}/`, {
        headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
      }),
    );
    const state = server.entryState(
      new URL(begun?.headers.get("location") ?? "").searchParams.get("state") ?? "",
    );
    expect(state).not.toBeNull();
    const instance: InstanceRef = {
      scope: "x",
      document: { kind: "artifact", id: "site", version: "1" },
    };
    for (const address of [
      { base: "/v/../" },
      { base: "/v/./" },
      { base: "/a;b/" },
      { base: "/a,b/" },
      { base: "/a'b/" },
      { base: "/a b/" },
      { base: "/v/1" },
      { base: "/__porthole/x/" },
      { base: "/v/1/", file: "../2/index.html" },
      { base: "/v/1/", file: "a/%2e%2e/%2E%2e/x" },
      { base: "/v/1/", file: "a\\..\\x" },
      { base: "/v/1/", file: "/x" },
      { base: "/v/1/", file: "a?b" },
    ]) {
      await expect(
        server.enterBy(state as NonNullable<typeof state>, instance, { viewer: "ada" }, address),
        JSON.stringify(address),
      ).rejects.toThrow(TypeError);
    }
    await expect(
      server.enterBy(
        state as NonNullable<typeof state>,
        instance,
        { viewer: "ada" },
        { base: "/v/1.2/", file: "a b.png", pinned: true },
      ),
    ).resolves.toContain("/__porthole/entry?code=");
    expect(versionedAddress("/v/./x")).toBeNull();
    expect(versionedAddress("/v/../x")).toBeNull();
  });

  it("the host is never told a sealed address: a report's, a blocked navigation's (P083)", () => {
    const token = "A".repeat(60);
    const sealed = `https://a-x.${DOMAIN}/__porthole/f/${token}/`;
    expect(withoutSealedAddresses(`TypeError: x at ${sealed}assets/app.js:1:2`)).toBe(
      "TypeError: x at ./assets/app.js:1:2",
    );
    expect(withoutSealedAddresses(`/__porthole/f/${token}/notes.txt`)).toBe("./notes.txt");
    expect(addressWithoutQuery("./notes.txt?secret=1")).toBe("./notes.txt?…");
  });

  it("the host takes `porthole/navigating` only from a display whose pages may come with files, for one load, soon (P084)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const run = async (config: PortholeConfig) => {
      const navigated: (() => void)[] = [];
      const listeners: ((message: unknown) => void)[] = [];
      let surfaces = 0;
      const platform: PlatformHost = {
        name: "stand-in",
        createSurface: () => {
          surfaces += 1;
          return {
            transport: {
              send: () => {},
              listen: (listener) => {
                listeners.push(listener);
                return () => {};
              },
              close: () => {},
            },
            element: null,
            setHeight: () => {},
            setColorScheme: () => {},
            userActivation: () => undefined,
            onNavigated: (listener) => {
              navigated.push(listener);
              return () => {};
            },
            onLoad: () => () => {},
            destroy: () => {},
          };
        },
      };
      const container = {
        ownerDocument: {
          defaultView: { location: { origin: HOST }, navigator: { language: "en" } },
        },
        getBoundingClientRect: () => ({ width: 600 }),
      } as unknown as HTMLElement;
      const locator = {
        locate: () =>
          Promise.resolve({
            url: `https://abc.${DOMAIN}/__porthole/d/x`,
            origin: `https://abc.${DOMAIN}`,
            reports: true,
          }),
      };
      const display = createHost(config, { platform, locator }).mount(container, {
        displayId: "d1",
        title: "Page",
        scheme: "light",
        instance: site("1", "abc"),
      });
      const events: string[] = [];
      display.on("navigated", () => events.push("navigated"));
      await vi.advanceTimersByTimeAsync(0);
      const say = () => {
        for (const listener of listeners) {
          listener({ jsonrpc: "2.0", method: "porthole/navigating", params: { url: "./about" } });
        }
      };
      const load = () => navigated.at(-1)?.();
      say();
      load();
      const first = [...events];
      // Banked: said, then a load much later (started again once a late notice can't come, P098).
      say();
      vi.setSystemTime(Date.now() + 11_000);
      load();
      await vi.advanceTimersByTimeAsync(LATE_NOTICE_MS);
      const banked = [...events];
      display.destroy();
      return { first, banked, surfaces };
    };
    const files = await run(presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] }));
    expect(files.first).toEqual([]);
    expect(files.banked).toEqual(["navigated"]);
    const widget = await run(
      presets.inlineWidget({ isolation: "domain", contentOrigins: [CONTENT] }),
    );
    expect(widget.first).toEqual(["navigated"]);
  });

  // P098: a set's page whose notice came late (on Chromium a cross-process postMessage can reach
  // the host after the next page's load) is the same display: nothing the frame asked meanwhile
  // was answered, and it is answered once the notice for the mounted version comes; a load no
  // notice explained starts the display again once the wait is over (pages-of-set.test.ts says
  // the rest).
  it("a display waits LATE_NOTICE_MS for a set's page's late notice, answering nothing meanwhile (P098)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const navigated: (() => void)[] = [];
    const listeners: ((message: unknown) => void)[] = [];
    const sent: unknown[] = [];
    let surfaces = 0;
    const platform: PlatformHost = {
      name: "stand-in",
      createSurface: () => {
        surfaces += 1;
        return {
          transport: {
            send: (message) => void sent.push(message),
            listen: (listener) => {
              listeners.push(listener);
              return () => {};
            },
            close: () => {},
          },
          element: null,
          setHeight: () => {},
          setColorScheme: () => {},
          userActivation: () => undefined,
          onNavigated: (listener) => {
            navigated.push(listener);
            return () => {};
          },
          onLoad: () => () => {},
          destroy: () => {},
        };
      },
    };
    const container = {
      ownerDocument: {
        defaultView: { location: { origin: HOST }, navigator: { language: "en" } },
      },
      getBoundingClientRect: () => ({ width: 600 }),
    } as unknown as HTMLElement;
    const locator = {
      locate: () =>
        Promise.resolve({
          url: `https://abc.${DOMAIN}/__porthole/d/x`,
          origin: `https://abc.${DOMAIN}`,
          reports: true,
        }),
    };
    const display = createHost(
      presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] }),
      {
        platform,
        locator,
      },
    ).mount(container, {
      displayId: "d1",
      title: "Page",
      scheme: "light",
      instance: site("1", "abc"),
    });
    const events: string[] = [];
    display.on("navigated", () => events.push("navigated"));
    await vi.advanceTimersByTimeAsync(0);
    const say = (message: unknown) => {
      for (const listener of listeners.slice()) {
        listener(message);
      }
    };
    const ping = (id: number) => ({ jsonrpc: "2.0", id, method: "ping", params: {} });
    const answered = (id: number) =>
      sent.some((each) => (each as { id?: unknown; result?: unknown }).id === id);
    say(ping(1));
    expect(answered(1)).toBe(true);
    // A load, then a request, then the arriving page's notice for this version.
    navigated.at(-1)?.();
    say(ping(2));
    await vi.advanceTimersByTimeAsync(LATE_NOTICE_MS - 1);
    expect(answered(2)).toBe(false);
    say({
      jsonrpc: "2.0",
      method: "porthole/navigating",
      params: { url: "./about", arrived: true, set: { id: "site", version: "1" } },
    });
    expect(answered(2)).toBe(true);
    await vi.advanceTimersByTimeAsync(LATE_NOTICE_MS);
    expect({ events, surfaces }).toEqual({ events: [], surfaces: 1 });
    // A load nobody announced: its request never answered, the display started again.
    navigated.at(-1)?.();
    say(ping(3));
    await vi.advanceTimersByTimeAsync(LATE_NOTICE_MS);
    expect(answered(3)).toBe(false);
    expect({ events, surfaces }).toEqual({ events: ["navigated"], surfaces: 2 });
    display.destroy();
  });
});
