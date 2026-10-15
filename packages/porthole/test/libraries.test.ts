import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GENERATED, generate } from "../scripts/vendor-libraries.ts";
import {
  LIBRARY_PATH,
  VENDORED_LIBRARIES,
  libraryPath,
  licensePath,
  presets,
} from "../src/index.ts";
import { LIBRARY_FILES } from "../src/libraries/files.generated.ts";
import { createServer } from "../src/server/index.ts";

/**
 * Porthole's vendored libraries (P079): the module /server serves them from is npm's files byte
 * for byte (pinned, so the lockfile fixes them), each with its license; every content origin serves
 * them, unauthenticated and immutable, and nothing else under their path.
 */

const DOMAIN = "example-usercontent.com";

const porthole = createServer({
  content: { domain: DOMAIN, scheme: "https" },
  secret: new Uint8Array(32).fill(7),
  hostOrigins: ["https://app.example.com"],
  configs: {
    liveWidget: presets.liveWidget({
      isolation: "domain",
      contentOrigins: [`https://*.${DOMAIN}`],
    }),
  },
});

const get = (url: string, method = "GET") =>
  new Request(url, { method, headers: { "sec-fetch-dest": "script" } });

describe("the vendored libraries", () => {
  it("are what the pinned npm packages hold (node scripts/vendor-libraries.ts)", async () => {
    expect(await readFile(GENERATED, "utf8")).toBe(await generate());
  });

  it("are each pinned to an exact version, with its license, and nothing else", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(import.meta.dirname, "../package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };
    const served: string[] = [];
    for (const library of VENDORED_LIBRARIES) {
      expect(manifest.devDependencies[library.name], library.name).toBe(library.version);
      expect(LIBRARY_FILES[libraryPath(library)], library.name).toContain(library.version);
      expect(LIBRARY_FILES[licensePath(library)], library.name).toMatch(/permission/iu);
      served.push(libraryPath(library), licensePath(library));
    }
    expect(Object.keys(LIBRARY_FILES).sort()).toEqual(served.sort());
  });

  it("are served on every content origin, without a ticket, cached for good", async () => {
    const origin = porthole.originFor("conversation-1");
    for (const library of VENDORED_LIBRARIES) {
      const response = (await porthole.handle(get(`${origin}${libraryPath(library)}`))) as Response;
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-site");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toBe(LIBRARY_FILES[libraryPath(library)]);
      const license = (await porthole.handle(get(`${origin}${licensePath(library)}`))) as Response;
      expect(license.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const head = (await porthole.handle(
        get(`${origin}${libraryPath(library)}`, "HEAD"),
      )) as Response;
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
  });

  it("serve nothing else under their path, and take no writes", async () => {
    const origin = porthole.originFor("conversation-1");
    for (const pathname of [
      `${LIBRARY_PATH}chart.js@4.4.1/dist/chart.umd.min.js`,
      `${LIBRARY_PATH}chart.js@4.5.1/package.json`,
      LIBRARY_PATH,
      `${LIBRARY_PATH}../d`,
    ]) {
      expect((await porthole.handle(get(`${origin}${pathname}`)))?.status, pathname).toBe(404);
    }
    const library = VENDORED_LIBRARIES[0];
    if (library !== undefined) {
      const post = await porthole.handle(get(`${origin}${libraryPath(library)}`, "POST"));
      expect(post?.status).toBe(404);
    }
  });
});
