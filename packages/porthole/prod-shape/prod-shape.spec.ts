import { expect, test, type Page } from "@playwright/test";
import {
  defineHostConformance,
  hostConformance,
  type HostConformanceOptions,
} from "../src/conformance/host-kit.ts";
import { kitConfigOf } from "../leak/kit/app.ts";

/**
 * The host kit in production's shape (P066): the conformance runner against the kit app on
 * https://app.test, its content on same-site siblings (https://*.content.test, no Public Suffix
 * List entry, as a content domain is until it has one), behind a TLS edge with real DNS; then
 * what only this shape shows: the health gate over the real network, cookies between sibling
 * labels, a sibling label (an app's preview) and another site attacking content, and a clash.
 */
const APP = "https://app.test";
const content = (label: string) => `https://${label}.content.test`;

const options: HostConformanceOptions = {
  name: "kit, prod shape",
  open: async (page) => {
    await page.goto(`${APP}/login?as=probe`);
  },
  issue: { url: "/api/frames" },
  config: (instance) => kitConfigOf("https://*.content.test", instance),
  instances: {
    shell: (scope) => ({ scope, document: { kind: "shell", preset: "inlineWidget" } }),
    artifact: (scope, version) => ({ scope, document: { kind: "artifact", id: "page", version } }),
    app: (scope) => ({ scope, document: { kind: "external", url: "http://any.invalid/" } }),
  },
  entry: {
    url: (scope) => `${content(`k-${scope}`)}/`,
    denied: (scope) => `${content(`k-secret-${scope}`)}/`,
    atSignIn: async (page) => (await page.locator("#sign-in-page").count()) > 0,
    completeSignIn: (page) => page.locator("#sign-in").click(),
    // A label the app never assigns, the bare domain, a path no page has (P070).
    unknown: () => [
      "https://www.content.test/",
      "https://f.content.test/",
      "https://content.test/",
      "https://zz-x.content.test/",
      `${content("k-abc")}/nothing`,
    ],
  },
};

defineHostConformance(test, options);

const kit = hostConformance(options);

/**
 * Whether any frame of `page` (but the top) has an element of these ids. A refused frame shows the
 * engine's error page, in which Firefox never lets a script finish: one that doesn't answer in
 * time showed nothing.
 */
async function framesShow(page: Page, ids: readonly string[]): Promise<boolean> {
  for (const frame of page.frames().slice(1)) {
    const shown = await Promise.race([
      frame
        .evaluate((each) => each.some((id) => document.getElementById(id) !== null), ids)
        .catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    if (shown) {
      return true;
    }
  }
  return false;
}

const contentShown = (page: Page) => framesShow(page, ["porthole-root", "artifact"]);

test.describe("prod shape", () => {
  test("the health gate sees the content domain through the edge, and frames are served", async ({
    request,
  }) => {
    const meta = (await (await request.get(`${APP}/api/meta`)).json()) as {
      served: boolean;
      contentSource: string;
      health: { state: string };
    };
    expect(meta).toMatchObject({
      served: true,
      contentSource: "https://*.content.test",
      health: { state: "healthy" },
    });
  });

  test("Porthole's cookies stay on their own label: host-only, __Host-, Secure, never a sibling's", async ({
    page,
  }) => {
    await kit.begin(page);
    await page.goto(`${APP}/login?as=probe`);
    await page.goto(`${content("k-sib-a")}/`);
    await expect(page.locator("#artifact")).toHaveText("version 1");
    const mine = (await page.context().cookies(content("k-sib-a"))).filter((each) =>
      each.name.includes("porthole-"),
    );
    expect(mine.length).toBeGreaterThan(0);
    for (const cookie of mine) {
      expect(cookie.name.startsWith("__Host-porthole-"), cookie.name).toBe(true);
      expect(cookie.secure).toBe(true);
      expect(cookie.path).toBe("/");
      expect(cookie.domain, "host-only: no Domain attribute").toBe("k-sib-a.content.test");
    }
    const sibling = await page.context().cookies(content("k-sib-b"));
    expect(sibling.filter((each) => each.name.includes("porthole-"))).toEqual([]);
  });

  test("a sibling label (an app's preview) can't plant a cookie that opens content", async ({
    page,
  }, info) => {
    await kit.begin(page);
    await page.goto(`${content("p-evil")}/`);
    await expect(page.locator("#preview")).toBeVisible();
    const planted = await page.evaluate(() => {
      const attempts = [
        "__Host-porthole-forged=1; Path=/; Secure; Domain=content.test",
        "porthole-forged=1; Path=/; Secure; SameSite=None; Domain=content.test",
        "tossed=1; Path=/; Secure; SameSite=None; Domain=content.test",
      ];
      for (const each of attempts) {
        document.cookie = each;
      }
      return document.cookie;
    });
    expect(planted).not.toContain("__Host-porthole-forged");
    const reached = await page.context().cookies(content("k-sib-c"));
    expect(reached.some((each) => each.name.startsWith("__Host-"))).toBe(false);
    info.annotations.push({
      type: "measured",
      description: `a Domain cookie from a sibling label reaches content origins: ${reached.some((each) => each.name === "tossed") ? "yes" : "no"} (same site without a PSL entry, P047)`,
    });
    // Signed out at the app: what the sibling planted opens nothing; the app's sign-in instead.
    const answer = await page.goto(`${content("k-sib-c")}/`);
    expect(
      await page.locator("#sign-in-page").count(),
      `ended at ${page.url()} (${answer?.status()})`,
    ).toBe(1);
    expect(await page.locator("#artifact").count()).toBe(0);
  });

  for (const [who, framer] of [
    ["a sibling label (an app's preview)", content("p-evil")],
    ["another site", "https://evil.test"],
  ] as const) {
    test(`${who} can't frame content, by ticket or by clean address`, async ({ page }) => {
      await kit.begin(page);
      await page.goto(`${APP}/login?as=probe`);
      const location = await kit.served.locate(await kit.served.shell("framed-by-other"));
      await page.goto(`${framer}/?frame=${encodeURIComponent(location.url)}`);
      await page.waitForTimeout(800);
      expect(await contentShown(page)).toBe(false);
      await page.goto(`${framer}/?frame=${encodeURIComponent(`${content("k-framed-clean")}/`)}`);
      await page.waitForTimeout(1_500);
      expect(await contentShown(page)).toBe(false);
      expect(
        await framesShow(page, ["sign-in-page"]),
        "the app's sign-in never shows in a frame",
      ).toBe(false);
    });
  }

  test("a content domain that holds the app's origin is never served: opaque, and said once", async ({
    page,
    request,
  }) => {
    const meta = (await (await request.get("https://clash.test/api/meta")).json()) as {
      served: boolean;
      health: { state: string; misconfigured?: boolean; reason?: string };
    };
    expect(meta.served).toBe(false);
    expect(meta.health).toMatchObject({ state: "unhealthy", misconfigured: true });
    expect(meta.health.reason).toMatch(/^misconfigured: .*holds the app's own origin/u);
    const events = (await (await request.get("https://clash.test/api/events")).json()) as {
      evt: string;
      code?: string;
    }[];
    expect(events.filter((each) => each.evt === "porthole.content.misconfigured")).toEqual([
      expect.objectContaining({ code: "clash" }),
    ]);
    await page.goto("https://clash.test/login?as=probe");
    const asked = await page.context().request.post("https://clash.test/api/frames", {
      data: { instance: { scope: "x", document: { kind: "shell", preset: "inlineWidget" } } },
    });
    expect(asked.status()).toBe(503);
    expect(((await asked.json()) as { error: { code: string } }).error.code).toBe("not-served");
    // The page frames nothing served: its CSP names no content source, and no clean link.
    expect(await page.locator("#open-tab").count()).toBe(0);
  });
});
