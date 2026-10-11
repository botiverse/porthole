import { test } from "@playwright/test";
import { servedTests, type ServedConformanceHost } from "../../src/conformance/served.ts";
import { servedHost } from "./harness.ts";

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
  await context.route(`${SITE}/canary/**`, (route) => {
    const name = new URL(route.request().url()).pathname.replace("/canary/", "");
    hits.set(name, (hits.get(name) ?? 0) + 1);
    return route.fulfill({ contentType: "image/gif", body: PIXEL });
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
