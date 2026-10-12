import { expect, type Frame, type Page, type TestInfo } from "@playwright/test";
import type { FrameOutcome } from "../host/types.ts";
import type { ConformanceTest } from "./probes.ts";

/**
 * Redirect entry's cases (P068): a clean address opens directly, signed in or not, and never
 * shows content without access; its one-time code works once, on its own origin; in a frame, the
 * app's sign-in never shows. A host implements `EntryConformanceHost` (or gives
 * `defineHostConformance` its `entry`).
 */

export interface EntryConformanceHost {
  readonly name: string;
  /** Signs `page`'s browser in at the app, as a person does, leaving it on the app's page. */
  signIn(page: Page): Promise<void>;
  /**
   * The clean address of a stored page the signed-in viewer may open (`ContentHost.urlOf`), for
   * `scope`: it draws `<main id="artifact">version 1</main>`.
   */
  url(scope: string): string;
  /** A clean address the signed-in viewer may not open. */
  denied(scope: string): string;
  /** Whether `page` shows the app's own sign-in. */
  atSignIn(page: Page): Promise<boolean>;
  /** On the app's sign-in page: signs in, as a person does (and the app goes back). */
  completeSignIn(page: Page): Promise<void>;
  /**
   * Frames a clean address on the app's page as the app would (a location of that address),
   * returning the frame and the display's outcome once it has one.
   */
  frame(
    page: Page,
    url: string,
  ): Promise<{ frame(): Promise<Frame>; outcome(): Promise<FrameOutcome> }>;
}

export interface EntrySuiteOptions {
  readonly skip?: Readonly<Record<string, string>>;
}

type Fixtures = { page: Page; browserName: string };

/** Whether a page shows the stored page's own content. */
const shows = async (where: Page | Frame): Promise<boolean> =>
  (await where.locator("#artifact").count()) > 0;

/** Walks a redirect entry by hand, as the browser would on a tab: the code URL it ends with. */
async function codeFor(page: Page, url: string): Promise<string> {
  const request = page.context().request;
  const top = { "sec-fetch-dest": "document" };
  const begin = await request.get(url, { maxRedirects: 0, headers: top });
  expect(begin.status(), "a clean address without a cookie goes to the app").toBe(302);
  const authorized = await request.get(begin.headers().location ?? "", {
    maxRedirects: 0,
    headers: top,
  });
  expect(authorized.status(), "the app's authorize route gives a code").toBe(302);
  const code = authorized.headers().location ?? "";
  expect(code).toContain("/__porthole/entry?code=");
  return code;
}

export function entryTests(
  host: EntryConformanceHost,
  options: EntrySuiteOptions = {},
): ConformanceTest[] {
  const tests: ConformanceTest[] = [];
  const define = (
    id: string,
    title: string,
    body: (fixtures: Fixtures, info: TestInfo) => Promise<void>,
  ) => {
    tests.push({
      id,
      title: `${id}: ${title}`,
      async run({ page, browserName }, info) {
        const reason = options.skip?.[id];
        info.skip(reason !== undefined, reason);
        await body({ page, browserName }, info);
      },
    });
  };

  define(
    "served.entry.direct",
    "a clean address opens directly for a signed-in viewer, and stays clean; a reload rides on its cookie",
    async ({ page }) => {
      await host.signIn(page);
      const url = host.url("entry-direct");
      await page.goto(url);
      await expect(page.locator("#artifact")).toHaveText("version 1");
      expect(page.url(), "the address bar shows the clean address, no code").toBe(url);
      const entries: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/__porthole/entry")) {
          entries.push(request.url());
        }
      });
      await page.reload();
      await expect(page.locator("#artifact")).toHaveText("version 1");
      expect(entries, "a reload needs no entry").toEqual([]);
    },
  );

  define(
    "served.entry.signed-out",
    "signed out, a clean address goes to the app's own sign-in, then back to the content",
    async ({ page }) => {
      const url = host.url("entry-signed-out");
      await page.goto(url);
      expect(await host.atSignIn(page), "the app's sign-in").toBe(true);
      expect(await shows(page)).toBe(false);
      await host.completeSignIn(page);
      await expect(page.locator("#artifact")).toHaveText("version 1");
      expect(page.url()).toBe(url);
    },
  );

  define(
    "served.entry.denied",
    "a viewer without access gets the app's refusal, never the content",
    async ({ page }) => {
      await host.signIn(page);
      const url = host.denied("entry-denied");
      const answer = await page.goto(url);
      expect(answer?.status()).toBe(403);
      expect(await shows(page)).toBe(false);
      expect(new URL(page.url()).origin, "the refusal is the app's").not.toBe(new URL(url).origin);
    },
  );

  define(
    "served.entry.code-once",
    "an entry code works once: replayed, it opens nothing",
    async ({ page }) => {
      await host.signIn(page);
      const code = await codeFor(page, host.url("entry-once"));
      const request = page.context().request;
      const top = { "sec-fetch-dest": "document" };
      const first = await request.get(code, { maxRedirects: 0, headers: top });
      expect(first.status()).toBe(303);
      const again = await request.get(code, { maxRedirects: 0, headers: top });
      expect(again.status()).toBe(403);
      expect(await again.text()).not.toContain('id="artifact"');
    },
  );

  define(
    "served.entry.code-elsewhere",
    "an entry code taken to another instance's origin opens nothing there",
    async ({ page }) => {
      await host.signIn(page);
      const code = new URL(await codeFor(page, host.url("entry-mine")));
      const other = new URL(host.url("entry-theirs"));
      const request = page.context().request;
      const answer = await request.get(`${other.origin}${code.pathname}${code.search}`, {
        maxRedirects: 0,
        headers: { "sec-fetch-dest": "document" },
      });
      expect(answer.status()).toBe(403);
      expect(answer.headers()["set-cookie"] ?? "").not.toMatch(/porthole-[a-z2-7]{16}=/u);
    },
  );

  define(
    "served.entry.framed",
    "a clean address in a frame shows the content where the browser keeps the cookies, else asks for a tab: never the app's sign-in",
    async ({ page, browserName }, info) => {
      await host.signIn(page);
      const shown = await host.frame(page, host.url("entry-framed"));
      const outcome = await shown.outcome();
      const frame = await shown.frame();
      expect(await host.atSignIn(page)).toBe(false);
      expect(new URL(frame.url()).pathname).not.toMatch(/sign-?in/iu);
      if (outcome.state === "loaded") {
        await expect(frame.locator("#artifact")).toHaveText("version 1");
      } else {
        expect(outcome).toMatchObject({ state: "blocked" });
        expect(["cookies", "sign-in"]).toContain((outcome as { readonly reason: string }).reason);
        expect(await shows(frame)).toBe(false);
      }
      const said = outcome.state === "blocked" ? `blocked: ${outcome.reason}` : outcome.state;
      info.annotations.push({
        type: "measured",
        description: `${browserName}: framed entry ${said}`,
      });
    },
  );

  define(
    "served.entry.framed-signed-out",
    "signed out, a clean address in a frame asks for a tab to sign in: the sign-in never shows in a frame",
    async ({ page }) => {
      await host.signIn(page);
      // The app's page stays; the browser forgets every sign-in.
      await page.context().clearCookies();
      const shown = await host.frame(page, host.url("entry-framed-out"));
      expect(await shown.outcome()).toMatchObject({ state: "blocked", reason: "sign-in" });
      const frame = await shown.frame();
      await expect(frame.locator("h1")).toHaveText("Open this in a new tab to sign in");
      expect(await shows(frame)).toBe(false);
    },
  );

  return tests;
}
