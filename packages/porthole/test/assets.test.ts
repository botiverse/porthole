import { describe, expect, test } from "vitest";
import { presets, type PortholeConfig } from "../src/index.ts";
import { httpLocator } from "../src/host/locator.ts";
import { locateServed } from "../src/host/locate.ts";
import type { InstanceRef } from "../src/isolation/types.ts";
import { createServer, prefixedName, type StoredAsset } from "../src/server/index.ts";

/**
 * The asset library on the content origin (P089), and the viewer a host's access gives a
 * display (P087): `/_blob/<id>` for its own origin's pages and for a session of one of its
 * artifacts, typed by name, inert, never a page; each page's CSP opening it; a grant's level in
 * the issue's answer, through the locator, to the bridge.
 */

const HOST = "https://app.example.com";
const DOMAIN = "example-usercontent.com";
const CONTENT = `https://*.${DOMAIN}`;
const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const encoder = new TextEncoder();

const asset = (
  scope: string,
  name: string,
  text: string,
  extra: { readonly artifact?: string; readonly trusted?: boolean } = {},
): StoredAsset => ({
  scope,
  artifact: extra.artifact ?? "page",
  ...(extra.trusted === undefined ? {} : { trusted: extra.trusted }),
  name,
  size: encoder.encode(text).length,
  sha256: "a".repeat(64),
  read: () => Promise.resolve(encoder.encode(text)),
});

const SCRIPT = "1234567890abcdef1234567890abcdef";
const TRUSTED = "abcdefabcdefabcdefabcdefabcdefab";
const OF_FILES = "00000000000000000000000000000001";

function serve(
  config: Partial<Parameters<typeof presets.artifact>[0]> = {},
  options: {
    readonly bearer?: boolean;
    /** More configs the server serves artifacts under, beside `artifact`. */
    readonly configs?: Readonly<Record<string, PortholeConfig>>;
  } = {},
) {
  const assets = new Map<string, StoredAsset>([
    [
      ID,
      asset(
        "one",
        "logo.svg",
        "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
      ),
    ],
    [OTHER, asset("one", "page.html", "<script>alert(1)</script>")],
    [SCRIPT, asset("one", "app.js", "alert(1)")],
    [TRUSTED, asset("one", "app.js", "alert(1)", { trusted: true })],
    [OF_FILES, asset("one", "dot.png", "png", { artifact: "files" })],
  ]);
  const asked: (string | null)[] = [];
  let allow = true;
  const artifact: PortholeConfig = presets.artifact({
    isolation: "domain",
    contentOrigins: [CONTENT],
    runtime: "1",
    capabilities: { assets: {} },
    ...config,
  });
  const encoded = encoder.encode("<!doctype html><title>F</title>");
  const server = createServer({
    content: { domain: DOMAIN, scheme: "https", name: prefixedName("a-") },
    secret: new Uint8Array(32).fill(3),
    hostOrigins: [HOST],
    configs: { artifact, ...options.configs },
    artifacts: {
      get: (id) =>
        Promise.resolve(
          id === "page" || id === "other"
            ? { html: "<!doctype html><title>P</title><img src='/_blob/x'>" }
            : id === "files"
              ? {
                  files: { "index.html": { size: encoded.length, sha256: "b".repeat(64) } },
                  read: () => Promise.resolve(encoded),
                }
              : null,
        ),
    },
    assets: {
      get: (id, access) => {
        asked.push(
          access === null
            ? null
            : access.instance.document.kind === "artifact"
              ? access.instance.document.id
              : "?",
        );
        return Promise.resolve(assets.get(id) ?? null);
      },
      ...(options.bearer === true ? { bearer: true } : {}),
    },
    authorize: { check: () => (allow ? { allow: true } : { allow: false, code: "revoked" }) },
  });
  return { server, assets, asked, deny: () => (allow = false) };
}

const instance = (scope: string, id = "page"): InstanceRef => ({
  scope,
  document: { kind: "artifact", id, version: "1" },
});

const at = (label: string, path: string) => `https://${label}.${DOMAIN}${path}`;
const ownLoad = {
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-dest": "image",
};

/** A tab's session cookie for `id` on scope `one` (the ticket's answer on a tab). */
async function tabCookie(server: ReturnType<typeof serve>["server"], id = "page"): Promise<string> {
  const location = await server.issue(instance("one", id), { viewer: "ada" });
  const entered = await server.handle(
    new Request(location.url, {
      headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
    }),
  );
  return entered?.headers.get("set-cookie")?.split(";")[0] ?? "";
}

/** A framed file set's sealed address (P083), as its page's `Referer` carries it (P091). */
async function sealedReferer(server: ReturnType<typeof serve>["server"]): Promise<string> {
  const location = await server.issue(instance("one", "files"), { viewer: "ada" });
  const answer = await server.handle(
    new Request(location.url, {
      headers: { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
    }),
  );
  expect(answer?.headers.get("referrer-policy")).toBe("same-origin");
  const html = (await answer?.text()) ?? "";
  const address = /"address":"([^"]+)"/u.exec(html)?.[1] ?? "";
  expect(address).toMatch(/\/__porthole\/f\/[A-Za-z0-9_-]+\/$/u);
  return `${address}index.html`;
}

describe("/_blob/<id> on the content origin (P089, P091)", () => {
  test("never by a same-origin claim alone: an access, then the host's check", async () => {
    const { server, deny, asked } = serve();
    // A forged Sec-Fetch-Site, no cookie, no sealed address: refused, and the store never asked.
    const forged = await server.handle(
      new Request(at("a-one", `/_blob/${ID}`), { headers: ownLoad }),
    );
    expect(forged?.status).toBe(401);
    expect(asked).toEqual([]);
    const cookie = await tabCookie(server);
    const tab = await server.handle(
      new Request(at("a-one", `/_blob/${ID}`), { headers: { ...ownLoad, cookie } }),
    );
    expect(tab?.status).toBe(200);
    expect(asked).toEqual(["page"]);
    deny();
    const revoked = await server.handle(
      new Request(at("a-one", `/_blob/${ID}`), { headers: { ...ownLoad, cookie } }),
    );
    expect(revoked?.status).toBe(403);
  });

  test("a framed set's page, by its sealed address as Referer; another origin's Referer is none", async () => {
    const { server } = serve();
    const referer = await sealedReferer(server);
    const own = await server.handle(
      new Request(at("a-one", `/_blob/${OF_FILES}`), {
        headers: { ...ownLoad, referer },
      }),
    );
    expect(own?.status).toBe(200);
    // Its access is the set's artifact's: another artifact's asset on the scope is none of it.
    const theirs = await server.handle(
      new Request(at("a-one", `/_blob/${ID}`), { headers: { ...ownLoad, referer } }),
    );
    expect(theirs?.status).toBe(404);
    // The sealed address of this artifact, taken to another origin's request: nothing.
    const moved = referer.replace("a-one", "a-two");
    const elsewhere = await server.handle(
      new Request(at("a-one", `/_blob/${OF_FILES}`), { headers: { ...ownLoad, referer: moved } }),
    );
    expect(elsewhere?.status).toBe(401);
  });

  test("an asset is its artifact's: a session for another artifact on the scope opens none of it", async () => {
    const { server } = serve();
    const cookie = await tabCookie(server, "other");
    const answer = await server.handle(
      new Request(at("a-one", `/_blob/${ID}`), {
        headers: {
          cookie,
          "sec-fetch-site": "none",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      }),
    );
    expect(answer?.status).toBe(404);
  });

  test("served typed by name, inert, revalidated, never a page; code only where trusted", async () => {
    const { server } = serve();
    const cookie = await tabCookie(server);
    const get = (id: string, extra: Record<string, string> = {}) =>
      server.handle(
        new Request(at("a-one", `/_blob/${id}`), { headers: { ...ownLoad, cookie, ...extra } }),
      );
    const answer = await get(ID);
    expect(answer?.headers.get("content-type")).toBe("image/svg+xml");
    expect(answer?.headers.get("content-security-policy")).toBe(
      `default-src 'none'; sandbox; frame-ancestors ${HOST}`,
    );
    expect(answer?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(answer?.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(answer?.headers.get("cache-control")).toBe("private, no-cache");
    expect(answer?.headers.get("etag")).toBe(`"${"a".repeat(64)}"`);
    expect((await get(ID, { "if-none-match": `"${"a".repeat(64)}"` }))?.status).toBe(304);
    const ranged = await get(ID, { range: "bytes=0-3" });
    expect([ranged?.status, await ranged?.text()]).toEqual([206, "<svg"]);
    const page = await get(OTHER);
    expect(page?.headers.get("content-type")).toBe("application/octet-stream");
    expect(page?.headers.get("content-disposition")).toBe("attachment");
    // A script nobody trusted is a download; one an admin uploaded where code runs is a script.
    expect((await get(SCRIPT))?.headers.get("content-type")).toBe("application/octet-stream");
    expect((await get(TRUSTED))?.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
  });

  test("only on its own scope's origin; only /_blob/ and 32 hex characters is an asset", async () => {
    const { server } = serve();
    const cookie = await tabCookie(server);
    const get = (label: string, path: string) =>
      server.handle(new Request(at(label, path), { headers: { ...ownLoad, cookie } }));
    expect((await get("a-two", `/_blob/${ID}`))?.status).toBe(401);
    expect((await get("a-one", `/_blob/${"0".repeat(32)}`))?.status).toBe(404);
    // Anything else under /_blob/ is a clean address as before (no entry here: 404, never 401).
    for (const path of [
      "/_blob/../x",
      `/_blob/${ID.toUpperCase()}`,
      "/_blob/x",
      `/_blob/${ID}/x`,
    ]) {
      expect((await get("a-one", path))?.status, path).toBe(404);
    }
  });

  test("bearer mode, an explicit opt-in: by id alone, the store asked with no access", async () => {
    const { server, asked } = serve({}, { bearer: true });
    const answer = await server.handle(new Request(at("a-one", `/_blob/${ID}`)));
    expect(answer?.status).toBe(200);
    expect(asked).toEqual([null]);
    expect((await server.handle(new Request(at("a-two", `/_blob/${ID}`))))?.status).toBe(404);
  });

  // P103.2: a trusted code asset runs only while the config still lets uploaded code run, asked
  // at every request: in bearer mode too (it served one as code by its upload's word alone), and
  // where the config no longer serves assets at all. A stricter config wins.
  test("code only while the current config lets uploaded code run, in bearer mode too (P103)", async () => {
    const typeOf = async (server: ReturnType<typeof serve>["server"], cookie?: string) =>
      (
        await server.handle(
          new Request(at("a-one", `/_blob/${TRUSTED}`), {
            headers: cookie === undefined ? ownLoad : { ...ownLoad, cookie },
          }),
        )
      )?.headers.get("content-type");
    const script = "text/javascript; charset=utf-8";
    const download = "application/octet-stream";
    // Uploads the admins' alone: the trusted script is one, by access and by id alone.
    expect(await typeOf(serve({}, { bearer: true }).server)).toBe(script);
    // Anyone who interacts uploads now: the script it was is a download, either way.
    const opened = { capabilities: { assets: { levels: { upload: "interact" as const } } } };
    expect(await typeOf(serve(opened, { bearer: true }).server)).toBe(download);
    const tab = serve(opened);
    expect(await typeOf(tab.server, await tabCookie(tab.server))).toBe(download);
    // The config serves no assets any more (dropped): nothing of its library runs.
    const dropped = serve({ capabilities: {} });
    expect(await typeOf(dropped.server, await tabCookie(dropped.server))).toBe(download);
    expect(await typeOf(serve({ capabilities: {} }, { bearer: true }).server)).toBe(download);
    // By id alone the server can't tell which of its artifact configs the asset's page is under:
    // the strictest one it might be wins.
    const strict = presets.artifact({
      isolation: "domain",
      contentOrigins: [CONTENT],
      runtime: "1",
      capabilities: { assets: { levels: { upload: "interact" } } },
    });
    const either = serve({}, { bearer: true, configs: { page: strict } });
    expect(await typeOf(either.server)).toBe(download);
    // An access names its page's config: that one alone decides.
    const named = serve({}, { configs: { page: strict } });
    expect(await typeOf(named.server, await tabCookie(named.server))).toBe(script);
  });

  test("a page whose config serves assets opens /_blob/ on its own origin in its CSP", async () => {
    const { server } = serve();
    const location = await server.issue(instance("one"), { viewer: "ada" });
    const page = await server.handle(
      new Request(location.url, {
        headers: { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
      }),
    );
    const csp = page?.headers.get("content-security-policy") ?? "";
    const origin = `https://a-one.${DOMAIN}`;
    expect(csp).toContain(`img-src data: blob: ${origin}/_blob/`);
    expect(csp).not.toContain("'self'");
    const open = serve({ capabilities: { assets: { levels: { upload: "interact" } } } });
    const shown = await open.server.issue(instance("one"), { viewer: "ada" });
    const strict = await open.server.handle(
      new Request(shown.url, {
        headers: { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
      }),
    );
    const script = (strict?.headers.get("content-security-policy") ?? "")
      .split("; ")
      .find((each) => each.startsWith("script-src"));
    expect(script).not.toContain("/_blob/");
  });

  test("without an asset store, /_blob/ is a clean address as before", async () => {
    const server = createServer({
      content: { domain: DOMAIN, scheme: "https" },
      secret: new Uint8Array(32).fill(3),
      hostOrigins: [HOST],
      configs: { artifact: presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] }) },
    });
    const answer = await server.handle(
      new Request(at("a-one", `/_blob/${ID}`), { headers: ownLoad }),
    );
    expect(answer?.status).toBe(404);
  });
});

describe("the viewer a host's access gives a display (P087)", () => {
  test("a grant's level and user go in the issue's answer, and only with a level", async () => {
    const { server } = serve();
    const location = await server.issue(instance("one"), {
      viewer: "u_1",
      level: "interact",
      user: { id: "ada", name: "Ada" },
    });
    expect(location.viewer).toEqual({ level: "interact", id: "ada", name: "Ada" });
    expect((await server.issue(instance("one"), { viewer: "u_1" })).viewer).toBeUndefined();
    await expect(
      server.issue(instance("one"), { viewer: "u_1", user: { id: "ada" } }),
    ).rejects.toThrow(/with its level/u);
    await expect(
      server.issue(instance("one"), { viewer: "u_1", level: "boss" as never }),
    ).rejects.toThrow(/level/u);
    // Never in the ticket's page or cookie.
    const page = await server.handle(
      new Request(location.url, {
        headers: { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
      }),
    );
    expect(await page?.text()).not.toContain("interact");
  });

  test("the locator carries it to the display's source; one that doesn't parse is an error", async () => {
    const answer = (viewer: unknown) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            url: `https://a-one.${DOMAIN}/x`,
            origin: `https://a-one.${DOMAIN}`,
            viewer,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    const config = presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] });
    const locate = async (viewer: unknown) => {
      const locator = httpLocator("/porthole/frames", { fetch: () => answer(viewer) });
      return locateServed(locator, instance("one"), config, HOST);
    };
    expect(await locate({ level: "admin", id: "ann" })).toMatchObject({
      viewer: { level: "admin", id: "ann" },
    });
    // One that doesn't parse is the host's error, never no viewer (after the review).
    await expect(locate({ level: "root" })).rejects.toThrow(/isn't one/u);
    await expect(locate({ level: "view", id: "x\u0000y" })).rejects.toThrow(/isn't one/u);
    await expect(locate({ level: "view", id: "a/b" })).rejects.toThrow(/isn't one/u);
    await expect(locate({ level: "view", id: "me" })).rejects.toThrow(/isn't one/u);
    expect(await locate(undefined)).not.toHaveProperty("viewer");
  });
});

describe("the host kit carries both (P087, P089)", () => {
  test("access's level reaches the issue's answer; the kit serves its assets", async () => {
    const { createContentHost } = await import("../src/server/index.ts");
    const config = presets.artifact({
      isolation: "domain",
      contentOrigins: ["https://*.usercontent.example.net"],
      runtime: "1",
      capabilities: { assets: {}, user: {} },
    });
    const content = createContentHost<{ id: string }>({
      domain: "usercontent.example.net",
      appOrigins: [HOST],
      secret: new Uint8Array(32).fill(5),
      configs: { artifact: config },
      name: prefixedName("a-"),
      instance: (proposal) => proposal,
      access: (_instance, viewer) =>
        viewer === null ? null : { viewer: viewer.id, level: "admin", user: { id: viewer.id } },
      source: () => Promise.resolve({ html: "<!doctype html><title>P</title>" }),
      // The store itself, in bearer mode (an explicit opt-in): the kit passes it on as it is.
      assets: {
        get: (id) => Promise.resolve(id === ID ? asset("one", "logo.png", "png bytes") : null),
        bearer: true,
      },
    });
    const issue = content.issue(() => ({ id: "ada" }));
    const answer = await issue(
      new Request(`${HOST}/porthole/frames`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: HOST },
        body: JSON.stringify({ instance: instance("one") }),
      }),
    );
    expect(answer.status).toBe(201);
    expect(((await answer.json()) as { viewer?: unknown }).viewer).toEqual({
      level: "admin",
      id: "ada",
    });
    const served = await content.fetch(
      new Request(`https://a-one.usercontent.example.net/_blob/${ID}`, { headers: ownLoad }),
    );
    expect([served?.status, served?.headers.get("content-type")]).toEqual([200, "image/png"]);
  });
});
