import { expect, type Frame, type Page, type TestInfo } from "@playwright/test";
import type { FrameOutcome } from "../host/types.ts";
import type { ConformanceTest } from "./probes.ts";

/**
 * Redirect entry's cases (P068, P125): a clean address opens directly in a tab, signed in or not,
 * and never shows content without access; its one-time code works once, on its own origin. A clean
 * address is for a tab: a host frames what one names by resolving it through its issue endpoint
 * first (a door, a ticket), and signed out, denied or not found, it builds no frame at all and
 * shows its fallback from that answer. A clean address framed as it is goes nowhere: the host
 * refuses it (no door), and the content origin answers it with a page that says nothing. A host
 * implements `EntryConformanceHost` (or gives `defineHostConformance` its `entry`).
 */

export interface EntryConformanceHost {
  readonly name: string;
  /** Signs `page`'s browser in at the app, as a person does, leaving it on the app's page. */
  signIn(page: Page): Promise<void>;
  /**
   * The clean address of a stored page the signed-in viewer may open (`ContentHost.urlOf`), for
   * `scope`: it draws `<main id="artifact">version 1</main>`.
   */
  url(scope: string): string | Promise<string>;
  /** A clean address the signed-in viewer may not open. Absent: `served.entry.denied` is skipped. */
  denied?(scope: string): string | Promise<string>;
  /**
   * Addresses on the content domain that name nothing (a label the app never assigns, the bare
   * domain, a path no instance has): each must be Porthole's 404 there, never the app's sign-in
   * (P070). Absent: the case is skipped.
   */
  unknown?(): readonly string[] | Promise<readonly string[]>;
  /**
   * Whether `page` shows the app's own sign-in. Absent: the browser left the content origin for
   * another (the app's) and shows no content.
   */
  atSignIn?(page: Page): Promise<boolean>;
  /**
   * On the app's sign-in page: signs in, as a person does (and the app goes back). Absent: the
   * signed-out case stops at the sign-in.
   */
  completeSignIn?(page: Page): Promise<void>;
  /**
   * Shows a clean address on the app's page as the app would (P125): resolved through the app's
   * issue endpoint (`client.resolve`, `<PortholeView address>`), then framed through the location
   * it issued. Returns the frame, the display's outcome once it has one, and whether any frame was
   * ever made for it.
   */
  frame(
    page: Page,
    url: string,
  ): Promise<{
    frame(): Promise<Frame>;
    outcome(): Promise<FrameOutcome>;
    framed(): Promise<boolean>;
  }>;
  /**
   * Gives the app's `createHost` a clean address as a frame's location, as it is (no issue, no
   * door), as a host of the wrong kind would. Returns the outcome, whether a frame was made, and
   * the host errors it heard.
   */
  frameDirectly(
    page: Page,
    url: string,
  ): Promise<{
    outcome(): Promise<FrameOutcome>;
    framed(): Promise<boolean>;
    hostErrors(): Promise<readonly { readonly message: string; readonly kind: string }[]>;
  }>;
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
      const url = await host.url("entry-direct");
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
    async ({ page }, info) => {
      const url = await host.url("entry-signed-out");
      await page.goto(url);
      const atSignIn =
        host.atSignIn === undefined
          ? new URL(page.url()).origin !== new URL(url).origin
          : await host.atSignIn(page);
      expect(atSignIn, `the app's sign-in (ended at ${page.url()})`).toBe(true);
      expect(await shows(page)).toBe(false);
      if (host.completeSignIn === undefined) {
        info.annotations.push({
          type: "note",
          description: "the sign-in wasn't completed: entry.completeSignIn not given",
        });
        return;
      }
      await host.completeSignIn(page);
      await expect(page.locator("#artifact")).toHaveText("version 1");
      expect(page.url()).toBe(url);
    },
  );

  define(
    "served.entry.denied",
    "a viewer without access gets the app's refusal, never the content",
    async ({ page }, info) => {
      info.skip(
        host.denied === undefined,
        "the host gave no address its viewer may not open (denied)",
      );
      await host.signIn(page);
      const url = (await host.denied?.("entry-denied")) ?? "";
      const answer = await page.goto(url);
      expect(answer?.status()).toBe(403);
      expect(await shows(page)).toBe(false);
      expect(new URL(page.url()).origin, "the refusal is the app's").not.toBe(new URL(url).origin);
    },
  );

  define(
    "served.entry.unknown",
    "an address that names nothing is a 404 on the content domain: never a trip to the app's sign-in",
    async ({ page }, info) => {
      info.skip(
        host.unknown === undefined,
        "the host gave no addresses that name nothing (unknown)",
      );
      const request = page.context().request;
      for (const url of (await host.unknown?.()) ?? []) {
        const answer = await request.get(url, {
          maxRedirects: 0,
          headers: { "sec-fetch-dest": "document" },
        });
        expect(answer.status(), url).toBe(404);
        expect(answer.headers().location, url).toBeUndefined();
        const opened = await page.goto(url);
        expect(opened?.status(), url).toBe(404);
        expect(new URL(page.url()).origin, url).toBe(new URL(url).origin);
      }
    },
  );

  define(
    "served.entry.code-once",
    "an entry code works once: replayed, it opens nothing",
    async ({ page }) => {
      await host.signIn(page);
      const code = await codeFor(page, await host.url("entry-once"));
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
      const code = new URL(await codeFor(page, await host.url("entry-mine")));
      const other = new URL(await host.url("entry-theirs"));
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
    "a clean address shown in a frame is resolved through issue first, then framed through its door: the content, never the app's sign-in",
    async ({ page, browserName }, info) => {
      await host.signIn(page);
      const before = page.url();
      const shown = await host.frame(page, await host.url("entry-framed"));
      expect(await shown.outcome(), "probe: the issued frame loaded").toEqual({ state: "loaded" });
      const frame = await shown.frame();
      expect(page.url(), "the app's page stays where it was").toBe(before);
      // An issued frame (P125): Porthole's own document address, never the clean address, and
      // never the app's sign-in. Its access is the ticket's (P083), so every engine shows it.
      expect(new URL(frame.url()).pathname, "probe: framed through issue").toMatch(
        /^\/__porthole\/(d|f)\//u,
      );
      await expect(frame.locator("#artifact")).toHaveText("version 1");
      info.annotations.push({
        type: "measured",
        description: `${browserName}: framed entry loaded`,
      });
    },
  );

  define(
    "served.entry.framed-signed-out",
    "signed out, a clean address shown in a frame builds no frame: issue says sign in, and the fallback comes from that answer",
    async ({ page }) => {
      await host.signIn(page);
      // The app's page stays; the browser forgets every sign-in.
      await page.context().clearCookies();
      const shown = await host.frame(page, await host.url("entry-framed-out"));
      expect(await shown.outcome(), "probe: issue's answer is the outcome").toEqual({
        state: "blocked",
        reason: "sign-in",
        status: 401,
      });
      expect(await shown.framed(), "probe: no frame was made").toBe(false);
    },
  );

  define(
    "served.entry.framed-denied",
    "a clean address its viewer may not open, shown in a frame, builds no frame: issue says denied",
    async ({ page }, info) => {
      info.skip(
        host.denied === undefined,
        "the host gave no address its viewer may not open (denied)",
      );
      await host.signIn(page);
      const shown = await host.frame(page, (await host.denied?.("entry-framed-denied")) ?? "");
      expect(await shown.outcome(), "probe: issue's answer is the outcome").toMatchObject({
        state: "blocked",
        reason: "denied",
        status: 403,
      });
      expect(await shown.framed(), "probe: no frame was made").toBe(false);
    },
  );

  define(
    "served.entry.framed-not-found",
    "a clean address that names nothing, shown in a frame, builds no frame: issue says not found",
    async ({ page }, info) => {
      const unknown = (await host.unknown?.()) ?? [];
      // An address under a label the app never assigns: the first one that has a path.
      const address = unknown.find((each) => new URL(each).hostname.split(".").length > 2);
      info.skip(address === undefined, "the host gave no address that names nothing (unknown)");
      await host.signIn(page);
      const shown = await host.frame(page, address ?? "");
      expect(await shown.outcome(), "probe: issue's answer is the outcome").toEqual({
        state: "blocked",
        reason: "not-found",
        status: 404,
      });
      expect(await shown.framed(), "probe: no frame was made").toBe(false);
    },
  );

  define(
    "served.entry.in-a-frame",
    "a clean address framed as it is goes nowhere: the host refuses it (no door), and the content origin answers a page with no script, never the app",
    async ({ page }) => {
      await host.signIn(page);
      const url = await host.url("entry-in-a-frame");
      // The host's own createHost, given the clean address as a location: refused before any
      // frame (a served display needs a door from issue), and told why.
      const direct = await host.frameDirectly(page, url);
      expect(await direct.outcome(), "probe: refused before any frame").toEqual({
        state: "blocked",
        reason: "locate",
      });
      expect(await direct.framed(), "probe: no frame was made").toBe(false);
      expect(
        (await direct.hostErrors()).map((each) => each.kind),
        "probe: the host heard why (door)",
      ).toContain("door");
      // A plain frame of the app's page at the clean address: the content origin answers it with
      // a page of its own that has no script and goes nowhere (never the app's authorize).
      const seen = await page.evaluate(async (address) => {
        const frame = document.createElement("iframe");
        const loaded = new Promise((resolve) =>
          frame.addEventListener("load", resolve, { once: true }),
        );
        frame.src = address;
        document.body.append(frame);
        await loaded;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return frame.getAttribute("src");
      }, url);
      expect(seen).toBe(url);
      const frame = page.frames().find((each) => each.url() === url);
      expect(
        frame,
        "probe: the frame stayed on the clean address (never the app's authorize)",
      ).toBeDefined();
      expect(
        await frame?.locator("script").count(),
        "probe: the page in the frame has no script",
      ).toBe(0);
      await expect(frame!.locator("h1")).toHaveText("Open this in a new tab");
      expect(await shows(frame!), "probe: no content in the frame").toBe(false);
    },
  );

  return tests;
}
