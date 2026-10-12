import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The shipped Workers example (P071), bundled as wrangler bundles it and run in workerd: its D1
 * migration applied as shipped, Porthole's browser modules behind an ASSETS binding.
 */

let mf: Miniflare;
const APP = "http://localhost:8793";

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [new URL("../examples/workers/worker.mjs", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    write: false,
    platform: "neutral",
    logLevel: "silent",
  });
  const settings = JSON.parse(
    readFileSync(new URL("../examples/workers/wrangler.jsonc", import.meta.url), "utf8")
      // JSONC: its comments and trailing commas.
      .replace(/^\s*\/\/.*$/gmu, "")
      .replace(/,(\s*[}\]])/gu, "$1"),
  ) as { vars: Record<string, string> };
  mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]?.text ?? "",
    compatibilityDate: "2026-07-24",
    d1Databases: ["DB"],
    bindings: { ...settings.vars, PORTHOLE_SECRET: "example-secret-for-tests-only-0123456789" },
    serviceBindings: {
      ASSETS: (request: Request) =>
        Promise.resolve(
          new URL(request.url).pathname === "/index.js"
            ? new Response("export {};", { headers: { "content-type": "text/javascript" } })
            : new Response("not found", { status: 404 }),
        ),
    },
  });
  const db = await mf.getD1Database("DB");
  const migration = readFileSync(
    new URL("../examples/workers/migrations/0001_porthole_tickets.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration
    .split(";")
    .map((each) => each.trim())
    .filter(Boolean)) {
    await db.prepare(statement).run();
  }
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

const at = (url: string, init: RequestInit = {}) =>
  mf.dispatchFetch(url, { redirect: "manual", ...init } as never);

describe("the Workers example", () => {
  it("serves the app, issues frames from D1, and keeps the content domain Porthole's", async () => {
    const cookie = { cookie: "example-viewer=ada" };
    expect((await at(`${APP}/`)).status).toBe(303);
    const page = await (await at(`${APP}/`, { headers: cookie })).text();
    expect(page).toContain('id="open-tab"');
    expect((await at(`${APP}/porthole-client/index.js`)).status).toBe(200);
    const issued = await at(`${APP}/porthole/frames`, {
      method: "POST",
      headers: { ...cookie, "content-type": "application/json" },
      body: JSON.stringify({
        instance: { scope: "x", document: { kind: "artifact", id: "hello", version: "1" } },
      }),
    });
    expect(issued.status).toBe(201);
    const location = (await issued.json()) as { url: string };
    const shown = await at(location.url, { headers: { "sec-fetch-dest": "iframe" } });
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain("Hello from an agent");
    // A clean address goes to the app's authorize route; a name nothing makes is a 404, and the
    // app's static files are never served on a content origin.
    const clean = await at("http://a-hello.content.localhost:8793/", {
      headers: { "sec-fetch-dest": "document" },
    });
    expect(clean.status).toBe(302);
    expect(clean.headers.get("location")).toContain(`${APP}/porthole/authorize?state=`);
    expect((await at("http://www.content.localhost:8793/")).status).toBe(404);
    expect(
      (await at("http://a-hello.content.localhost:8793/porthole-client/index.js")).status,
    ).not.toBe(200);
  });
});
