import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { d1TicketSchema } from "../src/server/index.ts";

/**
 * `/server` on Cloudflare Workers (P044, P045): bundled as a host would bundle it, run in workerd
 * (Miniflare) without `nodejs_compat`, its tickets in a real D1 database.
 */

let mf: Miniflare;

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [path.join(import.meta.dirname, "workers/worker.ts")],
    bundle: true,
    format: "esm",
    write: false,
    platform: "neutral",
    logLevel: "silent",
  });
  mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]?.text ?? "",
    compatibilityDate: "2026-07-24",
    compatibilityFlags: [],
    d1Databases: ["DB"],
    bindings: { SECRET: "a test secret that is at least thirty-two bytes long" },
  });
  const db = await mf.getD1Database("DB");
  for (const statement of d1TicketSchema()
    .split(";")
    .map((each) => each.trim())
    .filter(Boolean)) {
    await db.prepare(statement).run();
  }
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

const fetchAt = (url: string, headers: Record<string, string> = {}) =>
  mf.dispatchFetch(url, {
    headers: { "sec-fetch-dest": "iframe", ...headers },
    redirect: "manual",
  });

async function issue(query: string): Promise<{ url: string; origin: string }> {
  return (await (await mf.dispatchFetch(`https://host.test/issue?${query}`)).json()) as {
    url: string;
    origin: string;
  };
}

/** Every module `/server` loads, by following its relative imports. */
function serverModules(): Map<string, string> {
  const modules = new Map<string, string>();
  const visit = (file: string): void => {
    if (modules.has(file)) {
      return;
    }
    const text = readFileSync(file, "utf8");
    modules.set(file, text);
    for (const [, specifier] of text.matchAll(/(?:import|export)[^;]*?from\s+"([^"]+)"/gu)) {
      if (specifier?.startsWith(".") === true) {
        visit(path.resolve(path.dirname(file), specifier));
      }
    }
  };
  visit(path.join(import.meta.dirname, "../src/server/index.ts"));
  return modules;
}

describe("/server on Workers", () => {
  test("loads nothing of Node's: no node: module, no Buffer, no process", () => {
    const modules = serverModules();
    expect(modules.size).toBeGreaterThan(10);
    for (const [file, text] of modules) {
      const code = text.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
      expect(code, file).not.toMatch(/from\s+"(node:|[a-z@])/u);
      expect(code, file).not.toMatch(/\b(Buffer|process|require)\b/u);
    }
  });

  test("runs without Node's modules: no Buffer, no process", async () => {
    expect(await (await mf.dispatchFetch("https://host.test/runtime")).json()).toEqual({
      buffer: "undefined",
      process: "undefined",
    });
  });

  test("serves a page once per ticket, from D1, on a flat name; the cookie serves a reload", async () => {
    const location = await issue("id=101&v=3");
    expect(location.origin).toBe("https://a-101.usercontent.test");
    const first = await fetchAt(location.url);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('\\u003ch1 id=\\"v\\">3\\u003c/h1>');
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^__Host-porthole-[a-z2-7]{16}=/u);
    expect((await fetchAt(location.url)).status).toBe(401);
    expect((await fetchAt(location.url.replace(/\?ticket=.*/u, ""), { cookie })).status).toBe(200);
  });

  test("a ticket raced from two requests opens once", async () => {
    const location = await issue("id=102");
    const [a, b] = await Promise.all([fetchAt(location.url), fetchAt(location.url)]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 401]);
  });

  test("an anonymous ticket opens a public page, under the same one-time rule", async () => {
    const location = await issue("id=103&anonymous=1");
    expect((await fetchAt(location.url)).status).toBe(200);
    expect((await fetchAt(location.url)).status).toBe(401);
  });

  test("the host's check runs on every request: revoking a subject ends a live cookie at once", async () => {
    const location = await issue("id=104&subject=share-9");
    const first = await fetchAt(location.url);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const page = location.url.replace(/\?ticket=.*/u, "");
    expect((await fetchAt(page, { cookie })).status).toBe(200);
    await mf.dispatchFetch("https://host.test/revoke?subject=share-9");
    const denied = await fetchAt(page, { cookie });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain(
      'data-porthole-reason="denied" data-porthole-code="revoked"',
    );
  });

  test("another server's namespace and the bare domain go to the host's routes", async () => {
    for (const url of [
      "https://x.f.usercontent.test/",
      "https://f.usercontent.test/",
      "https://www.usercontent.test/",
    ]) {
      expect(await (await mf.dispatchFetch(url)).text(), url).toBe("the host's own routes");
    }
    expect((await mf.dispatchFetch("https://usercontent.test/")).status).toBe(404);
  });
});
