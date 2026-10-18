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

const asset = (scope: string, name: string, text: string): StoredAsset => ({
  scope,
  name,
  size: encoder.encode(text).length,
  sha256: "a".repeat(64),
  read: () => Promise.resolve(encoder.encode(text)),
});

function serve(config: Partial<Parameters<typeof presets.artifact>[0]> = {}) {
  const assets = new Map<string, StoredAsset>([
    [
      ID,
      asset(
        "one",
        "logo.svg",
        "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
      ),
    ],
    [OTHER, asset("two", "page.html", "<script>alert(1)</script>")],
  ]);
  const artifact: PortholeConfig = presets.artifact({
    isolation: "domain",
    contentOrigins: [CONTENT],
    runtime: "1",
    capabilities: { assets: {} },
    ...config,
  });
  const server = createServer({
    content: { domain: DOMAIN, scheme: "https", name: prefixedName("a-") },
    secret: new Uint8Array(32).fill(3),
    hostOrigins: [HOST],
    configs: { artifact },
    artifacts: {
      get: (id) =>
        Promise.resolve(
          id === "page" ? { html: "<!doctype html><title>P</title><img src='/_blob/x'>" } : null,
        ),
    },
    assets: { get: (id) => Promise.resolve(assets.get(id) ?? null) },
  });
  return { server, assets };
}

const instance = (scope: string): InstanceRef => ({
  scope,
  document: { kind: "artifact", id: "page", version: "1" },
});

const at = (label: string, path: string) => `https://${label}.${DOMAIN}${path}`;
const ownLoad = {
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-dest": "image",
};

describe("/_blob/<id> on the content origin (P089)", () => {
  test("a page of its own origin loads it: typed by name, inert, its own origin's only, immutable", async () => {
    const { server } = serve();
    const answer = await server.handle(
      new Request(at("a-one", `/_blob/${ID}`), { headers: ownLoad }),
    );
    expect(answer?.status).toBe(200);
    expect(answer?.headers.get("content-type")).toBe("image/svg+xml");
    expect(answer?.headers.get("content-security-policy")).toBe(
      `default-src 'none'; sandbox; frame-ancestors ${HOST}`,
    );
    expect(answer?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(answer?.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(answer?.headers.get("cache-control")).toContain("immutable");
    expect(answer?.headers.get("etag")).toBe(`"${"a".repeat(64)}"`);
    const ranged = await server.handle(
      new Request(at("a-one", `/_blob/${ID}`), { headers: { ...ownLoad, range: "bytes=0-3" } }),
    );
    expect([ranged?.status, await ranged?.text()]).toEqual([206, "<svg"]);
  });

  test("only on its own scope's origin; an id that isn't one names nothing", async () => {
    const { server } = serve();
    expect(
      (await server.handle(new Request(at("a-two", `/_blob/${ID}`), { headers: ownLoad })))?.status,
    ).toBe(404);
    expect(
      (await server.handle(new Request(at("a-one", "/_blob/../x"), { headers: ownLoad })))?.status,
    ).toBe(404);
    expect(
      (
        await server.handle(
          new Request(at("a-one", `/_blob/${ID.toUpperCase()}`), { headers: ownLoad }),
        )
      )?.status,
    ).toBe(404);
    expect(
      (
        await server.handle(
          new Request(at("a-one", `/_blob/${"0".repeat(32)}`), { headers: ownLoad }),
        )
      )?.status,
    ).toBe(404);
  });

  test("never a page: an asset named so goes as a download", async () => {
    const { server } = serve();
    const answer = await server.handle(
      new Request(at("a-two", `/_blob/${OTHER}`), { headers: ownLoad }),
    );
    expect(answer?.headers.get("content-type")).toBe("application/octet-stream");
    expect(answer?.headers.get("content-disposition")).toBe("attachment");
  });

  test("anything else needs a session for an artifact of the origin, and the host's check; never an entry", async () => {
    const { server } = serve();
    // Another site's request, or a sibling's, or a navigation without a cookie: no.
    for (const headers of [
      { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" },
      { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" },
      {
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
      {},
    ]) {
      const answer = await server.handle(new Request(at("a-one", `/_blob/${ID}`), { headers }));
      expect(answer?.status, JSON.stringify(headers)).toBe(401);
      expect(answer?.headers.get("location")).toBeNull();
    }
    // A tab with a session for the origin's artifact: let in.
    const location = await server.issue(instance("one"), { viewer: "ada" });
    const entered = await server.handle(
      new Request(location.url, {
        headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
      }),
    );
    const cookie = entered?.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).toContain("porthole-");
    const tab = await server.handle(
      new Request(at("a-one", `/_blob/${ID}`), {
        headers: {
          cookie,
          "sec-fetch-site": "none",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      }),
    );
    expect(tab?.status).toBe(200);
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
    expect(csp).toContain(`${origin}/_blob/`);
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

  test("the locator carries it to the display's source, dropping one that doesn't parse", async () => {
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
    expect(await locate({ level: "root" })).not.toHaveProperty("viewer");
    expect(await locate({ level: "view", id: "x\u0000y" })).not.toHaveProperty("viewer");
  });
});
