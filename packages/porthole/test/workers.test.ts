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

  test("a version made of files on workerd: the entry in the ticket's answer, its files by their sealed path, streamed and ranged (P081, P083)", async () => {
    const location = await issue("id=301&doc=site&v=2");
    const first = await fetchAt(location.url);
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(html).toContain("site 2");
    const address = /"address":"([^"]+)"/u.exec(html)?.[1] ?? "";
    expect(address).toMatch(/^https:\/\/a-301\.usercontent\.test\/__porthole\/f\/[\w-]+\/$/u);
    const css = await fetchAt(`${address}style.css`, { "sec-fetch-dest": "style" });
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("h1 { color: red; }");
    const part = await fetchAt(`${address}clip.mp4`, {
      "sec-fetch-dest": "video",
      range: "bytes=60-69",
    });
    expect(part.status).toBe(206);
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([
      60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
    ]);
    const elsewhere = address.replace("a-301", "a-302");
    expect((await fetchAt(`${elsewhere}style.css`)).status).toBe(401);
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

  test("the host kit: the issue endpoint and the routing middleware, on workerd with D1 (P066)", async () => {
    const ask = (viewer?: string) =>
      mf.dispatchFetch("https://host.test/kit/issue", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(viewer === undefined ? {} : { "x-viewer": viewer }),
        },
        body: JSON.stringify({
          instance: { scope: "anything", document: { kind: "artifact", id: "k1", version: "x" } },
        }),
      });
    expect((await ask()).status).toBe(401);
    const answer = await ask("person-7");
    expect(answer.status).toBe(201);
    const location = (await answer.json()) as { url: string; origin: string };
    expect(location.origin).toBe("https://a-k1.kitcontent.test");
    const page = await fetchAt(location.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("kit 1");
    expect((await fetchAt(location.url)).status).toBe(401);
    expect(await (await mf.dispatchFetch("https://x.f.kitcontent.test/")).text()).toBe(
      "the host's own routes",
    );
  });

  test("the host kit's redirect entry on workerd: a clean address, authorize, a code, the page (P068)", async () => {
    const top = { "sec-fetch-dest": "document" };
    const begin = await fetchAt("https://a-k2.kitcontent.test/", top);
    expect(begin.status).toBe(302);
    const authorizeAt = begin.headers.get("location") ?? "";
    expect(authorizeAt.startsWith("https://artifacts.example/kit/authorize?state=")).toBe(true);
    const nonce = (begin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    // Signed out on a tab: the app's sign-in.
    const signedOut = await fetchAt(authorizeAt, top);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toContain("/signin?next=");
    const authorized = await fetchAt(authorizeAt, { ...top, "x-viewer": "person-8" });
    expect(authorized.status).toBe(302);
    const code = authorized.headers.get("location") ?? "";
    expect(code.startsWith("https://a-k2.kitcontent.test/__porthole/entry?code=")).toBe(true);
    const redeemed = await fetchAt(code, { ...top, cookie: nonce });
    expect(redeemed.status).toBe(303);
    expect(redeemed.headers.get("location")).toBe("https://a-k2.kitcontent.test/");
    const session = redeemed.headers
      .getSetCookie()
      .map((each) => each.split(";")[0] ?? "")
      .join("; ");
    const shown = await fetchAt("https://a-k2.kitcontent.test/", { ...top, cookie: session });
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain("kit 1");
    expect((await fetchAt(code, { ...top, cookie: nonce })).status).toBe(403);
  });

  test("P0.3 / S6 on workerd: a url-mode app answers its own origin, by HTTP and by socket (P101)", async () => {
    const location = (await (
      await mf.dispatchFetch("https://host.test/issue-app?id=app1")
    ).json()) as {
      url: string;
      origin: string;
    };
    const entered = await fetchAt(location.url);
    expect(entered.status).toBe(200);
    const cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^__Host-porthole-/u);
    const own = { cookie, origin: location.origin, "sec-fetch-site": "same-origin" };
    const sibling = {
      cookie,
      origin: "https://a-evil.usercontent.test",
      "sec-fetch-site": "same-site",
    };
    const post = (headers: Record<string, string>) =>
      mf.dispatchFetch(`${location.origin}/api`, {
        method: "POST",
        headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", ...headers },
        body: "x",
      });
    const ownPost = await post(own);
    expect(await ownPost.text()).toBe("app: POST /api");
    expect((await post(sibling)).status).toBe(403);
    // The planted copy a sibling can set for the whole domain: not Porthole's name over https.
    expect((await post({ ...own, cookie: cookie.replace(/^__Host-/u, "") })).status).toBe(401);
    const socket = (headers: Record<string, string>) =>
      mf.dispatchFetch(`${location.origin}/ws`, {
        headers: { upgrade: "websocket", "sec-fetch-mode": "websocket", ...headers },
      });
    const opened = await socket(own);
    expect(opened.status).toBe(101);
    opened.webSocket?.accept();
    opened.webSocket?.close();
    expect((await socket(sibling)).status).toBe(404);
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
