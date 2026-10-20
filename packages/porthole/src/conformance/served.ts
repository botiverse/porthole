/**
 * The served modes' conformance cases (P016, P020): domain mode and url mode, probed in a real
 * browser against a host's own serving. A host implements `ServedConformanceHost` (show an
 * instance the way it does: located through its backend, framed under the config's policy), then
 * registers the cases in its Playwright project:
 *
 *   import { test } from "@playwright/test";
 *   import { defineServedSuite } from "@botiverse/porthole/conformance";
 *   defineServedSuite(test, myServedHost);
 *
 * Each case attempts one escape or access channel and asserts, with an out-of-band oracle where
 * one exists (a canary URL the host counts requests to), that nothing got through.
 */
import { expect, type Frame, type Page, type TestInfo, type TestType } from "@playwright/test";
import type { ConformanceTest } from "./probes.ts";
import type { EgressConfig } from "../config/schema.ts";
import type { FrameLocation, InstanceRef } from "../isolation/types.ts";
import { MCP_APPS_METHODS } from "../protocol/mcp-apps.ts";
import { keepsFramedCookies } from "./cookies.ts";

/** One served display, as the host shows it. */
export interface ServedDisplay {
  /** The content origin the frame was located on. */
  readonly origin: string;
  /** The display's frame, once its document loaded. */
  frame(): Promise<Frame>;
  /** Removes the frame. */
  destroy(): Promise<void>;
  /** Posts `message` to the frame as the host does (to the frame's window, at its origin). */
  post(message: unknown): Promise<void>;
  /** The messages the host took from the frame so far (from its window and origin only). */
  received(): Promise<readonly unknown[]>;
}

/** What a host implements to run the served-mode cases against its integration. */
export interface ServedConformanceHost {
  readonly name: string;
  /**
   * Shows `instance` in `page` as the host does: a fresh ticket from its backend, framed under
   * the config's sandbox, in an embedding page that sends the config's `embedderCsp`. The same page
   * may show several, one after another.
   *
   * For a served shell the suite gives `options.content`, a line of HTML: a host that speaks to
   * the shell (`createHost`, the React binding) sends it as the display's content, since a shell
   * draws nothing (and reports no height) until it has content, and the cases click inside it. A
   * host whose frame has a height of its own may ignore it.
   */
  show(
    page: Page,
    instance: InstanceRef,
    options?: { readonly content?: string },
  ): Promise<ServedDisplay>;
  /** A fresh ticketed location for `instance`, as the host's backend issues it. */
  locate(instance: InstanceRef): Promise<FrameLocation>;
  /** Navigates `page` to a page on an origin that is not one of the host's, framing `url`. */
  frameFromForeignOrigin(page: Page, url: string): Promise<void>;
  /** A URL whose requests the host counts, on an origin that is neither the host's nor content's. */
  canary(name: string): Promise<string>;
  /** How many requests reached `canary(name)`. */
  canaryHits(name: string): Promise<number>;
  /** A served shell (domain isolation) for `scope`. */
  shell(scope: string): InstanceRef | Promise<InstanceRef>;
  /**
   * A url-mode app for `scope`: its page loads a script from its own origin that sets
   * `document.documentElement.dataset.app = "ready"`.
   */
  app(scope: string): InstanceRef | Promise<InstanceRef>;
  /**
   * A stored artifact page (domain isolation) for `scope`: version `"1"` and `"2"` of one page,
   * each with `<main id="artifact">version N</main>` and a script that records
   * `document.documentElement.dataset.rtc = typeof RTCPeerConnection`.
   */
  artifact(scope: string, version: "1" | "2"): InstanceRef | Promise<InstanceRef>;
  /** The MCP Apps sandbox proxy (domain isolation) for `scope`, opening the view's `egress`. */
  proxy(scope: string, egress?: EgressConfig): InstanceRef | Promise<InstanceRef>;
}

export interface ServedSuiteOptions {
  /** Case ids to skip, each with the reason (shown in the report). */
  readonly skip?: Readonly<Record<string, string>>;
}

type Fixtures = { page: Page; browserName: string };

const SETTLE_MS = 800;

/** What a served shell is given to draw (`ServedConformanceHost.show`'s `content`). */
const SHELL_CONTENT = '<p id="porthole-probe-content">Porthole conformance probe</p>';

/** What the frame can see of its host: everything here must be closed to it. */
async function reachIntoHost(frame: Frame): Promise<Record<string, string>> {
  return frame.evaluate(() => {
    const attempt = (read: () => string | null | undefined): string => {
      try {
        const value = read();
        return value === undefined || value === null ? "empty" : `read: ${value}`;
      } catch {
        return "blocked";
      }
    };
    return {
      parentDocument: attempt(() => window.parent.document.title),
      topLocation: attempt(() => window.top?.location.href),
      parentStorage: attempt(() => window.parent.localStorage.getItem("porthole-probe")),
      ownStorage: attempt(() => window.localStorage.getItem("porthole-probe")),
      cookie: attempt(() => (document.cookie.includes("porthole-probe") ? document.cookie : null)),
      referrer: attempt(() => document.referrer || null),
    };
  });
}

const CLOSED = {
  parentDocument: "blocked",
  topLocation: "blocked",
  parentStorage: "blocked",
  ownStorage: "empty",
  cookie: "empty",
  referrer: "empty",
};

/**
 * A view as an MCP Apps server would send it, speaking the protocol by hand: it asks its parent to
 * initialize, and reports what its realm offers and whether a fetch got out.
 */
const PROBE_VIEW = (canary: string) => `<!doctype html><html><head><title>View</title></head><body>
<p id="view">A view.</p>
<script>
  document.documentElement.dataset.rtc = typeof RTCPeerConnection;
  window.parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "probe", version: "1" }, appCapabilities: {} } }, "*");
  fetch(${JSON.stringify(canary)}, { mode: "no-cors" }).then(
    () => { document.documentElement.dataset.fetch = "sent"; },
    () => { document.documentElement.dataset.fetch = "blocked"; },
  );
</script></body></html>`;

const methodsOf = (messages: readonly unknown[]): string[] =>
  messages.flatMap((message) =>
    message !== null &&
    typeof message === "object" &&
    typeof (message as { method?: unknown }).method === "string"
      ? [(message as { method: string }).method]
      : [],
  );

/** Marks the host page with secrets the content must not see. */
async function plantHostSecrets(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem("porthole-probe", "host-secret");
    document.cookie = "porthole-probe=host-secret; Path=/";
  });
}

/** Registers every served-mode case as a test. */
/**
 * Registers every served-mode case as a test. A host that wants to select them by its own spec
 * file registers `servedTests` itself (see `ConformanceTest`).
 */
export function defineServedSuite(
  test: TestType<object, object>,
  host: ServedConformanceHost,
  options: ServedSuiteOptions = {},
): void {
  const typed = test as unknown as TestType<Fixtures, object>;
  typed.describe(`served modes (${host.name})`, () => {
    for (const each of servedTests(host, options)) {
      // Playwright reads the fixtures a test uses from its parameter's destructuring.
      typed(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
    }
  });
}

/** Every served-mode case as a test entry (see `ConformanceTest`). */
export function servedTests(
  host: ServedConformanceHost,
  options: ServedSuiteOptions = {},
): ConformanceTest[] {
  const tests: ConformanceTest[] = [];
  let info: TestInfo | null = null;
  // The case being run's own TestInfo (for an expected failure measured on one engine).
  const typed = {
    fail: (condition: boolean, reason: string) => info?.fail(condition, reason),
  };
  const define = (id: string, title: string, body: (fixtures: Fixtures) => Promise<void>) => {
    tests.push({
      id,
      title: `${id}: ${title}`,
      async run({ page, browserName }, testInfo) {
        const reason = options.skip?.[id];
        testInfo.skip(reason !== undefined, reason);
        info = testInfo;
        await body({ page, browserName });
      },
    });
  };

  {
    const modes = [
      ["domain", (scope: string) => host.shell(scope)],
      ["url", (scope: string) => host.app(scope)],
    ] as const;
    // A served shell draws (and has a height to click in) once its host gives it content.
    const showMode = async (
      page: Page,
      mode: "domain" | "url",
      instance: InstanceRef | Promise<InstanceRef>,
    ) => host.show(page, await instance, mode === "domain" ? { content: SHELL_CONTENT } : {});

    for (const [mode, instance] of modes) {
      define(
        `served.${mode}.origin`,
        "content runs on its own origin, never the host's",
        async ({ page }) => {
          const display = await showMode(page, mode, instance(`${mode}-origin`));
          const frame = await display.frame();
          const origin = await frame.evaluate(() => window.origin);
          expect(origin).toBe(display.origin);
          expect(origin).not.toBe(new URL(page.url()).origin);
        },
      );

      define(
        `served.${mode}.no-reach`,
        "content can't reach the host's DOM, storage, cookies or URL",
        async ({ page }) => {
          const display = await showMode(page, mode, instance(`${mode}-reach`));
          await plantHostSecrets(page);
          expect(await reachIntoHost(await display.frame())).toEqual(CLOSED);
        },
      );

      define(
        `served.${mode}.no-top-navigation`,
        "content can't navigate the host's page, even after a click",
        async ({ page }) => {
          const display = await showMode(page, mode, instance(`${mode}-top`));
          const frame = await display.frame();
          const before = page.url();
          const target = await host.canary(`${mode}-top`);
          await frame.evaluate((url) => {
            const button = document.createElement("button");
            button.id = "porthole-probe-top";
            button.textContent = "go";
            button.addEventListener("click", () => {
              try {
                window.top!.location.href = url;
              } catch {
                // Blocked: what we want.
              }
            });
            document.body.append(button);
            try {
              window.top!.location.href = url;
            } catch {
              // Blocked.
            }
          }, target);
          await frame.click("#porthole-probe-top");
          await page.waitForTimeout(SETTLE_MS);
          expect(page.url()).toBe(before);
          expect(await host.canaryHits(`${mode}-top`)).toBe(0);
        },
      );

      define(
        `served.${mode}.no-popups`,
        "content can't open a window, even after a click",
        async ({ page }) => {
          const display = await showMode(page, mode, instance(`${mode}-popup`));
          const frame = await display.frame();
          const target = await host.canary(`${mode}-popup`);
          const opened: Page[] = [];
          page.context().on("page", (each) => opened.push(each));
          const programmatic = await frame.evaluate((url) => {
            const button = document.createElement("button");
            button.id = "porthole-probe-popup";
            button.textContent = "open";
            // Without allow-popups, Chromium and WebKit return null; Firefox throws. Both refuse.
            const open = () => {
              try {
                return window.open(url) !== null;
              } catch {
                return false;
              }
            };
            button.addEventListener("click", () => {
              document.body.dataset.popup = String(open());
            });
            document.body.append(button);
            return open();
          }, target);
          await frame.click("#porthole-probe-popup");
          await page.waitForTimeout(SETTLE_MS);
          expect(programmatic).toBe(false);
          expect(await frame.evaluate(() => document.body.dataset.popup)).toBe("false");
          expect(opened).toHaveLength(0);
          expect(await host.canaryHits(`${mode}-popup`)).toBe(0);
        },
      );
    }

    define(
      "served.domain.address",
      "a served frame's address is its own, carrying at most Porthole's ticket: never the app's",
      async ({ page }) => {
        const display = await host.show(page, await host.shell("address"), {
          content: SHELL_CONTENT,
        });
        const frame = await display.frame();
        const seen = await frame.evaluate(() => ({
          origin: location.origin,
          search: location.search,
          hash: location.hash,
        }));
        expect(seen.origin).toBe(display.origin);
        expect(seen.search).toMatch(/^(\?ticket=[^&]+)?$/u);
        expect(seen.hash).toBe("");
        expect(seen.origin).not.toBe(new URL(page.url()).origin);
      },
    );

    define(
      "served.domain.storage-scope",
      "storage persists within a scope and is never shared across scopes",
      async ({ page }) => {
        const first = await host.show(page, await host.shell("scope-a"), {
          content: SHELL_CONTENT,
        });
        await (await first.frame()).evaluate(() => localStorage.setItem("kept", "a"));
        await first.destroy();
        const again = await host.show(page, await host.shell("scope-a"), {
          content: SHELL_CONTENT,
        });
        expect(await (await again.frame()).evaluate(() => localStorage.getItem("kept"))).toBe("a");
        expect(again.origin).toBe(first.origin);
        const other = await host.show(page, await host.shell("scope-b"), {
          content: SHELL_CONTENT,
        });
        expect(other.origin).not.toBe(first.origin);
        expect(await (await other.frame()).evaluate(() => localStorage.getItem("kept"))).toBeNull();
      },
    );

    define(
      "served.artifact.versions",
      "each version of a page shows as stored, on its scope's origin, hardened before it runs",
      async ({ page }) => {
        const one = await host.show(page, await host.artifact("artifact-scope", "1"));
        const two = await host.show(page, await host.artifact("artifact-scope", "2"));
        expect(two.origin).toBe(one.origin);
        for (const [display, version] of [
          [one, "1"],
          [two, "2"],
        ] as const) {
          const frame = await display.frame();
          await expect(frame.locator("#artifact")).toHaveText(`version ${version}`);
          expect(await frame.evaluate(() => document.documentElement.dataset.rtc)).toBe(
            "undefined",
          );
        }
      },
    );

    define(
      "served.domain.ticket-once",
      "a ticket opens its content once; without it there is nothing",
      async ({ page, browserName }) => {
        const location = await host.locate(await host.shell("ticket-once"));
        const first = await page.goto(location.url);
        expect(first?.status()).toBe(200);
        // A fresh browser state: no cookie, only the used ticket.
        const fresh = await page.context().browser()!.newContext();
        try {
          const other = await fresh.newPage();
          const again = await other.goto(location.url);
          expect(again?.status(), browserName).toBe(401);
          expect(await other.locator("#porthole-root").count()).toBe(0);
        } finally {
          await fresh.close();
        }
      },
    );

    define(
      "served.domain.frame-ancestors",
      "only the host's origins may frame content",
      async ({ page }) => {
        const location = await host.locate(await host.shell("foreign"));
        await host.frameFromForeignOrigin(page, location.url);
        await page.waitForTimeout(SETTLE_MS);
        for (const frame of page.frames().slice(1)) {
          // A refused frame shows the engine's error page, which Firefox never lets a script
          // finish in: a frame that doesn't answer in time showed nothing of the content.
          const unreachable = { origin: "unreachable", root: false };
          const shown = await Promise.race([
            frame
              .evaluate(() => ({
                origin: window.origin,
                root: document.getElementById("porthole-root") !== null,
              }))
              .catch(() => unreachable),
            new Promise<typeof unreachable>((resolve) =>
              setTimeout(() => resolve(unreachable), 3_000),
            ),
          ]);
          expect(shown.root).toBe(false);
          expect(shown.origin).not.toBe(location.origin);
        }
      },
    );

    define(
      "served.domain.egress",
      "the CSP in the document's headers closes egress; only what the config opens to any https site (images, media) reaches it",
      async ({ page }) => {
        const display = await host.show(page, await host.shell("egress"), {
          content: SHELL_CONTENT,
        });
        const frame = await display.frame();
        const kinds = ["fetch", "img", "media", "script", "style", "frame"] as const;
        const urls = Object.fromEntries(
          await Promise.all(kinds.map(async (kind) => [kind, await host.canary(`egress-${kind}`)])),
        ) as Record<(typeof kinds)[number], string>;
        // Each kind tried once; the policy that applied is read from the violations it raises.
        const seen = await frame.evaluate(async (each) => {
          const policies: string[] = [];
          document.addEventListener("securitypolicyviolation", (event) =>
            policies.push(event.originalPolicy),
          );
          let fetched = "sent";
          try {
            await fetch(each.fetch, { mode: "no-cors" });
          } catch {
            fetched = "blocked";
          }
          const image = new Image();
          image.src = each.img;
          document.body.append(image);
          const audio = document.createElement("audio");
          audio.preload = "auto";
          audio.src = each.media;
          document.body.append(audio);
          const script = document.createElement("script");
          script.src = each.script;
          document.body.append(script);
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = each.style;
          document.head.append(link);
          const nested = document.createElement("iframe");
          nested.src = each.frame;
          document.body.append(nested);
          await new Promise((resolve) => setTimeout(resolve, 800));
          return { fetched, policy: policies.find((policy) => /connect-src/u.test(policy)) ?? "" };
        }, urls);
        await page.waitForTimeout(SETTLE_MS);
        expect(seen.fetched).toBe("blocked");
        expect(seen.policy, "a CSP applied to the document").not.toBe("");
        const sources = new Map(
          seen.policy
            .split(";")
            .map((directive) => directive.trim().split(/\s+/u))
            .map(([name = "", ...rest]) => [name, rest] as const),
        );
        // What runs or talks never opens to any site (P059), whatever the config.
        for (const name of ["script-src", "style-src", "connect-src", "frame-src", "default-src"]) {
          expect(sources.get(name) ?? [], `${name} opens no scheme`).not.toContain("https:");
        }
        for (const kind of ["fetch", "script", "style", "frame"] as const) {
          expect(await host.canaryHits(`egress-${kind}`), kind).toBe(0);
        }
        // Images and media: closed, unless the config opened them to any https site (P059);
        // then, the canary being an https site, an image reaches it, as the config means.
        const https = (kind: "img" | "media") =>
          (sources.get(`${kind}-src`) ?? []).includes("https:") &&
          new URL(urls[kind]).protocol === "https:";
        const opened = (["img", "media"] as const).filter(https);
        if (opened.length > 0) {
          info?.annotations.push({
            type: "expected",
            description: `${opened.join(" and ")} load from any https site under this config (anyHttps, P059): ${opened.includes("img") ? "the image is asserted to reach the outside site" : "measured, not asserted"}; script, style, connect and frames still can't`,
          });
        }
        if (https("img")) {
          expect(
            await host.canaryHits("egress-img"),
            "the image, as the config opens it",
          ).toBeGreaterThan(0);
        } else {
          expect(await host.canaryHits("egress-img"), "img").toBe(0);
        }
        if (!https("media")) {
          expect(await host.canaryHits("egress-media"), "media").toBe(0);
        }
      },
    );

    const resourceReady = (html: string) => ({
      jsonrpc: "2.0",
      method: MCP_APPS_METHODS.sandboxResourceReady,
      params: { html },
    });
    const proxyReady = async (display: ServedDisplay) =>
      expect
        .poll(async () => methodsOf(await display.received()))
        .toContain(MCP_APPS_METHODS.sandboxProxyReady);

    define(
      "served.proxy.view",
      "the sandbox proxy becomes the view, hardened, talking to its host directly",
      async ({ page }) => {
        const display = await host.show(page, await host.proxy("proxy-view"));
        await proxyReady(display);
        const canary = await host.canary("proxy-undeclared");
        await display.post(resourceReady(PROBE_VIEW(canary)));
        const frame = await display.frame();
        await expect(frame.locator("#view")).toHaveText("A view.");
        await expect
          .poll(async () => methodsOf(await display.received()))
          .toContain(MCP_APPS_METHODS.initialize);
        await expect(frame.locator("html")).toHaveAttribute("data-fetch", "blocked");
        expect(
          await frame.evaluate(() => [window.origin, document.documentElement.dataset.rtc]),
        ).toEqual([display.origin, "undefined"]);
        expect(await host.canaryHits("proxy-undeclared")).toBe(0);
      },
    );

    define(
      "served.proxy.parent-only",
      "the sandbox proxy takes a view only from its host",
      async ({ page }) => {
        const display = await host.show(page, await host.proxy("proxy-parent"));
        await proxyReady(display);
        const frame = await display.frame();
        await frame.evaluate(
          (message) => window.postMessage(message, "*"),
          resourceReady('<p id="view">Not from the host.</p>'),
        );
        await page.waitForTimeout(SETTLE_MS);
        expect(await frame.locator("#view").count()).toBe(0);
      },
    );

    define(
      "served.proxy.egress",
      "the sandbox proxy opens what the view declares, and nothing else",
      async ({ page }) => {
        const canary = await host.canary("proxy-declared");
        const display = await host.show(
          page,
          await host.proxy("proxy-egress", { connect: [new URL(canary).origin] }),
        );
        await proxyReady(display);
        await display.post(resourceReady(PROBE_VIEW(canary)));
        const frame = await display.frame();
        await expect(frame.locator("html")).toHaveAttribute("data-fetch", "sent");
        expect(await host.canaryHits("proxy-declared")).toBe(1);
      },
    );

    define(
      "served.url.ticket",
      "an app shows nothing to a browser without its ticket's cookie",
      async ({ page }) => {
        const location = await host.locate(await host.app("url-ticket"));
        // A fresh browser: no cookie of the content's, none of the app's. Porthole refuses it, or
        // (redirect entry, P068) hands it to the app's authorize route, which asks it to sign in.
        const fresh = await page.context().browser()!.newContext();
        try {
          const other = await fresh.newPage();
          const bare = await other.goto(`${location.origin}/`);
          const away = new URL(other.url()).origin !== location.origin;
          expect(bare?.status() === 401 || away, `ended at ${other.url()}`).toBe(true);
          expect(
            await other.evaluate(() => document.documentElement.dataset.app ?? null),
          ).toBeNull();
        } finally {
          await fresh.close();
        }
      },
    );

    define(
      "served.url.tab",
      "an app opened on a tab of its own runs, its requests riding on its cookie",
      async ({ page }) => {
        const location = await host.locate(await host.app("url-tab"));
        await page.goto(location.url);
        await expect(page.locator("html")).toHaveAttribute("data-app", "ready");
      },
    );

    define(
      "served.url.framed",
      "a framed app's own requests ride on its partitioned cookie",
      async ({ page }) => {
        // Where the browser keeps no cookie in a cross-site frame (P025: Playwright's WebKit on
        // Linux), a framed app's own requests are refused and such hosts open it on a tab: the
        // case must fail there. Measured by a probe of the browser's own, not by its name (P098:
        // the same WebKit on macOS keeps them).
        const display = await host.show(page, await host.app("url-framed"));
        const scheme = new URL(display.origin).protocol === "https:" ? "https:" : "http:";
        typed.fail(
          !(await keepsFramedCookies(page, scheme)),
          "this browser keeps no cookie in a cross-site frame (measured)",
        );
        const frame = await display.frame();
        await expect
          .poll(() => frame.evaluate(() => document.documentElement.dataset.app ?? null), {
            timeout: 3_000,
          })
          .toBe("ready");
      },
    );

    define(
      "served.url.siblings",
      "another origin's page never rides an app's cookie: its load of the app's script is refused",
      async ({ page, browserName }) => {
        // P101: two apps framed on one host page share its cookie partition, and sibling labels
        // are same-site until the content domain is on the Public Suffix List (P047), so a tab's
        // Lax cookie goes with a sibling's requests too. The app's own load is the control.
        const load = (frame: Frame, src: string) =>
          frame.evaluate(
            (url) =>
              new Promise<string>((resolve) => {
                const script = document.createElement("script");
                script.addEventListener("load", () => resolve("load"));
                script.addEventListener("error", () => resolve("error"));
                script.src = url;
                document.head.append(script);
                setTimeout(() => resolve("timeout"), 3_000);
              }),
            src,
          );
        const ready = (frame: Frame) =>
          expect
            .poll(() => frame.evaluate(() => document.documentElement.dataset.app ?? null), {
              timeout: 3_000,
            })
            .toBe("ready");
        const scriptOf = async (frame: Frame, origin: string): Promise<string> => {
          const src = await frame.evaluate(
            () => document.querySelector<HTMLScriptElement>("script[src]")?.src ?? "",
          );
          expect(src, "the app's page loads a script").not.toBe("");
          expect(new URL(src).origin, "from its own origin").toBe(origin);
          return src;
        };
        // Framed side by side, where the engine keeps a framed cookie (WebKit doesn't, P025).
        if (browserName !== "webkit") {
          const a = await host.show(page, await host.app("url-siblings-a"));
          const frameA = await a.frame();
          await ready(frameA);
          const script = await scriptOf(frameA, a.origin);
          expect(await load(frameA, script), "the app's own load").toBe("load");
          const b = await host.show(page, await host.app("url-siblings-b"));
          const frameB = await b.frame();
          await ready(frameB);
          expect(await load(frameB, script), "another app's frame loading it").toBe("error");
        }
        // Each on a tab of its own, in one browser.
        const c = await host.locate(await host.app("url-siblings-c"));
        const d = await host.locate(await host.app("url-siblings-d"));
        const tab = await page.context().newPage();
        try {
          await tab.goto(c.url);
          await ready(tab.mainFrame());
          const script = await scriptOf(tab.mainFrame(), c.origin);
          expect(await load(tab.mainFrame(), script), "the app's own load").toBe("load");
          await tab.goto(d.url);
          await ready(tab.mainFrame());
          expect(await load(tab.mainFrame(), script), "another app's tab loading it").toBe("error");
        } finally {
          await tab.close();
        }
      },
    );
  }
  return tests;
}
