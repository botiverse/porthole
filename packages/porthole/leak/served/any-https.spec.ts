import { expect, test } from "@playwright/test";
import { servedTests, type ServedConformanceHost } from "../../src/conformance/served.ts";
import { servedHost, showServed } from "./harness.ts";

/**
 * `served.domain.egress` on a host whose shells open images and media to any https site
 * (`anyHttps`, P059), with its canaries on a stranger's https site (routed by the test): the case
 * reads the policy that applied, asserts an image reaches the site as the config means, and that
 * scripts, styles, fetches and frames still don't.
 */

const SITE = "https://any-site.example";
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const hits = new Map<string, number>();

test.beforeEach(async ({ context }) => {
  hits.clear();
  await context.route(`${SITE}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const name = path.replace(/^\/(canary|allowed|outside)\//u, "$1:").replace("canary:", "");
    hits.set(name, (hits.get(name) ?? 0) + 1);
    return path.endsWith(".js")
      ? route.fulfill({
          contentType: "text/javascript",
          body: "document.documentElement.dataset.script = (document.documentElement.dataset.script || '') + 'ran';",
        })
      : route.fulfill({
          contentType: "image/gif",
          body: PIXEL,
          headers: { "access-control-allow-origin": "*" },
        });
  });
});

const anyHttps: ServedConformanceHost = {
  ...servedHost,
  name: "anyHttps",
  shell: (scope) => ({ scope, document: { kind: "shell", preset: "inlineAnyHttps" } }),
  canary: (name) => Promise.resolve(`${SITE}/canary/${name}`),
  canaryHits: (name) => Promise.resolve(hits.get(name) ?? 0),
};

test.describe(`served modes (${anyHttps.name})`, () => {
  for (const each of servedTests(anyHttps).filter((entry) => entry.id === "served.domain.egress")) {
    test(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
  }
});

/** A host whose shells reach the site only under `/allowed/` (P063). */
const pathPrefix: ServedConformanceHost = {
  ...anyHttps,
  name: "path prefix",
  shell: (scope) => ({ scope, document: { kind: "shell", preset: "inlinePathPrefix" } }),
};

test.describe(`served modes (${pathPrefix.name})`, () => {
  // Its canaries are outside the prefix: the case's walls hold as for a closed host.
  for (const each of servedTests(pathPrefix).filter(
    (entry) => entry.id === "served.domain.egress",
  )) {
    test(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
  }

  test("a path-prefixed source opens only under its prefix: a URL there loads, one outside doesn't (P063)", async ({
    page,
  }) => {
    const display = await showServed(page, pathPrefix.shell("prefix-loads"));
    const frame = await display.frame();
    const seen = await frame.evaluate(async (site) => {
      const fetched = async (path: string) => {
        try {
          await fetch(site + path);
          return "sent";
        } catch {
          return "blocked";
        }
      };
      const image = (path: string) =>
        new Promise<string>((resolve) => {
          const each = new Image();
          each.addEventListener("load", () => resolve("loaded"));
          each.addEventListener("error", () => resolve("blocked"));
          each.src = site + path;
        });
      const script = (path: string) =>
        new Promise<string>((resolve) => {
          const each = document.createElement("script");
          each.addEventListener("load", () => resolve("loaded"));
          each.addEventListener("error", () => resolve("blocked"));
          each.src = site + path;
          document.head.append(each);
        });
      return {
        fetchIn: await fetched("/allowed/data.json"),
        fetchOut: await fetched("/outside/data.json"),
        imageIn: await image("/allowed/deep/pixel.gif"),
        imageOut: await image("/outside/pixel.gif"),
        scriptIn: await script("/allowed/lib.js"),
        scriptOut: await script("/allowedx/lib.js"),
      };
    }, SITE);
    expect(seen).toEqual({
      fetchIn: "sent",
      fetchOut: "blocked",
      imageIn: "loaded",
      imageOut: "blocked",
      scriptIn: "loaded",
      scriptOut: "blocked",
    });
    expect([...hits.keys()].sort()).toEqual([
      "allowed:data.json",
      "allowed:deep/pixel.gif",
      "allowed:lib.js",
    ]);
  });
});
