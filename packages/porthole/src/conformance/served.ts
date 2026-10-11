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
import { expect, type Frame, type Page, type TestType } from "@playwright/test";
import type { EgressConfig } from "../config/schema.ts";
import type { FrameLocation, InstanceRef } from "../isolation/types.ts";
import { MCP_APPS_METHODS } from "../protocol/mcp-apps.ts";

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
   */
  show(page: Page, instance: InstanceRef): Promise<ServedDisplay>;
  /** A fresh ticketed location for `instance`, as the host's backend issues it. */
  locate(instance: InstanceRef): Promise<FrameLocation>;
  /** Navigates `page` to a page on an origin that is not one of the host's, framing `url`. */
  frameFromForeignOrigin(page: Page, url: string): Promise<void>;
  /** A URL whose requests the host counts, on an origin that is neither the host's nor content's. */
  canary(name: string): Promise<string>;
  /** How many requests reached `canary(name)`. */
  canaryHits(name: string): Promise<number>;
  /** A served shell (domain isolation) for `scope`. */
  shell(scope: string): InstanceRef;
  /**
   * A url-mode app for `scope`: its page loads a script from its own origin that sets
   * `document.documentElement.dataset.app = "ready"`.
   */
  app(scope: string): InstanceRef;
  /** The MCP Apps sandbox proxy (domain isolation) for `scope`, opening the view's `egress`. */
  proxy(scope: string, egress?: EgressConfig): InstanceRef;
}

export interface ServedSuiteOptions {
  /** Case ids to skip, each with the reason (shown in the report). */
  readonly skip?: Readonly<Record<string, string>>;
}

type Fixtures = { page: Page; browserName: string };

const SETTLE_MS = 800;

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
export function defineServedSuite(
  test: TestType<object, object>,
  host: ServedConformanceHost,
  options: ServedSuiteOptions = {},
): void {
  const typed = test as unknown as TestType<Fixtures, object>;
  const define = (id: string, title: string, body: (fixtures: Fixtures) => Promise<void>) => {
    const reason = options.skip?.[id];
    // Playwright reads the fixtures a test uses from its parameter's destructuring.
    typed(`${id}: ${title}`, async ({ page, browserName }) => {
      typed.skip(reason !== undefined, reason);
      await body({ page, browserName });
    });
  };

  typed.describe(`served modes (${host.name})`, () => {
    const modes = [
      ["domain", (scope: string) => host.shell(scope)],
      ["url", (scope: string) => host.app(scope)],
    ] as const;

    for (const [mode, instance] of modes) {
      define(
        `served.${mode}.origin`,
        "content runs on its own origin, never the host's",
        async ({ page }) => {
          const display = await host.show(page, instance(`${mode}-origin`));
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
          const display = await host.show(page, instance(`${mode}-reach`));
          await plantHostSecrets(page);
          expect(await reachIntoHost(await display.frame())).toEqual(CLOSED);
        },
      );

      define(
        `served.${mode}.no-top-navigation`,
        "content can't navigate the host's page, even after a click",
        async ({ page }) => {
          const display = await host.show(page, instance(`${mode}-top`));
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
          const display = await host.show(page, instance(`${mode}-popup`));
          const frame = await display.frame();
          const target = await host.canary(`${mode}-popup`);
          const opened: Page[] = [];
          page.context().on("page", (each) => opened.push(each));
          const programmatic = await frame.evaluate((url) => {
            const button = document.createElement("button");
            button.id = "porthole-probe-popup";
            button.textContent = "open";
            button.addEventListener("click", () => {
              document.body.dataset.popup = String(window.open(url) !== null);
            });
            document.body.append(button);
            return window.open(url) !== null;
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
      "served.domain.storage-scope",
      "storage persists within a scope and is never shared across scopes",
      async ({ page }) => {
        const first = await host.show(page, host.shell("scope-a"));
        await (await first.frame()).evaluate(() => localStorage.setItem("kept", "a"));
        await first.destroy();
        const again = await host.show(page, host.shell("scope-a"));
        expect(await (await again.frame()).evaluate(() => localStorage.getItem("kept"))).toBe("a");
        expect(again.origin).toBe(first.origin);
        const other = await host.show(page, host.shell("scope-b"));
        expect(other.origin).not.toBe(first.origin);
        expect(await (await other.frame()).evaluate(() => localStorage.getItem("kept"))).toBeNull();
      },
    );

    define(
      "served.domain.ticket-once",
      "a ticket opens its content once; without it there is nothing",
      async ({ page, browserName }) => {
        const location = await host.locate(host.shell("ticket-once"));
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
        const location = await host.locate(host.shell("foreign"));
        await host.frameFromForeignOrigin(page, location.url);
        await page.waitForTimeout(SETTLE_MS);
        for (const frame of page.frames().slice(1)) {
          const shown = await frame
            .evaluate(() => ({
              origin: window.origin,
              root: document.getElementById("porthole-root") !== null,
            }))
            .catch(() => ({ origin: "unreachable", root: false }));
          expect(shown.root).toBe(false);
          expect(shown.origin).not.toBe(location.origin);
        }
      },
    );

    define(
      "served.domain.egress",
      "the CSP in the document's headers closes egress",
      async ({ page }) => {
        const display = await host.show(page, host.shell("egress"));
        const frame = await display.frame();
        const fetched = await frame.evaluate(
          async (url) => {
            try {
              await fetch(url, { mode: "no-cors" });
              return "sent";
            } catch {
              return "blocked";
            }
          },
          await host.canary("egress-fetch"),
        );
        await frame.evaluate(
          (url) => {
            const image = new Image();
            image.src = url;
            document.body.append(image);
          },
          await host.canary("egress-img"),
        );
        await page.waitForTimeout(SETTLE_MS);
        expect(fetched).toBe("blocked");
        expect(await host.canaryHits("egress-fetch")).toBe(0);
        expect(await host.canaryHits("egress-img")).toBe(0);
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
        const display = await host.show(page, host.proxy("proxy-view"));
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
        const display = await host.show(page, host.proxy("proxy-parent"));
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
          host.proxy("proxy-egress", { connect: [new URL(canary).origin] }),
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
        const location = await host.locate(host.app("url-ticket"));
        const bare = await page.goto(`${location.origin}/`);
        expect(bare?.status()).toBe(401);
        expect(await page.evaluate(() => document.documentElement.dataset.app ?? null)).toBeNull();
      },
    );

    define(
      "served.url.tab",
      "an app opened on a tab of its own runs, its requests riding on its cookie",
      async ({ page }) => {
        const location = await host.locate(host.app("url-tab"));
        await page.goto(location.url);
        await expect(page.locator("html")).toHaveAttribute("data-app", "ready");
      },
    );

    define(
      "served.url.framed",
      "a framed app's own requests ride on its partitioned cookie",
      async ({ page, browserName }) => {
        // Measured (P025): WebKit keeps no cookie in a cross-site frame, partitioned or not, so a
        // framed app's subresources are refused there; such hosts open the app on a tab.
        typed.fail(browserName === "webkit", "WebKit keeps no cookie in a cross-site frame");
        const display = await host.show(page, host.app("url-framed"));
        const frame = await display.frame();
        await expect
          .poll(() => frame.evaluate(() => document.documentElement.dataset.app ?? null), {
            timeout: 3_000,
          })
          .toBe("ready");
      },
    );
  });
}
