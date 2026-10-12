import type { Browser } from "@playwright/test";
import type { CheckDriver, CheckSession } from "./check.ts";

/**
 * Drivers for `checkPage` (P073): Playwright's browser on Node, or any Chrome DevTools Protocol
 * session (Puppeteer's `page.createCDPSession()`, `@cloudflare/puppeteer` on Cloudflare Browser
 * Rendering from a Worker).
 */

/** Checks in a page of a Playwright browser (`chromium.launch()`), one page per check. */
export function playwrightDriver(browser: Browser): CheckDriver {
  return {
    async open(): Promise<CheckSession> {
      const page = await browser.newPage();
      let html = "";
      // The check page needs an origin of its own (a host's): served from a name no network has.
      await page.route(`${CHECK_ORIGIN}/**`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
      );
      return {
        setViewport: (width, height) => page.setViewportSize({ width, height }),
        async load(document) {
          html = document;
          await page.goto(`${CHECK_ORIGIN}/`, { waitUntil: "load" });
        },
        evaluate: (expression) => page.evaluate(expression),
        screenshot: async (selector) => new Uint8Array(await page.locator(selector).screenshot()),
        close: () => page.close(),
      };
    },
  };
}

/** Where the check page is served from: a name no network has, answered by the driver. */
export const CHECK_ORIGIN = "https://porthole-check.invalid";

/** A Chrome DevTools Protocol session: its commands and its events (Puppeteer's `CDPSession`). */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(
    event: "Fetch.requestPaused",
    listener: (params: { readonly requestId: string }) => void,
  ): unknown;
}

const toBase64 = (text: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const base64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/**
 * Checks over a CDP session to a page (P073): `cdpDriver(() => page.createCDPSession())` with
 * Puppeteer, or `@cloudflare/puppeteer` in a Worker with a Browser Rendering binding. `open` is
 * asked for a session per check; the caller closes its page.
 */
export function cdpDriver(open: () => Promise<CdpSession>): CheckDriver {
  return {
    async open(): Promise<CheckSession> {
      const session = await open();
      await session.send("Page.enable");
      await session.send("Runtime.enable");
      let html = "";
      // The check page needs an origin of its own: the driver answers its address itself.
      await session.send("Fetch.enable", { patterns: [{ urlPattern: `${CHECK_ORIGIN}/*` }] });
      session.on("Fetch.requestPaused", (event: { requestId: string }) => {
        void session.send("Fetch.fulfillRequest", {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
          body: toBase64(html),
        });
      });
      const evaluate = async <T>(expression: string): Promise<T> => {
        const answer = (await session.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        })) as {
          result?: { value?: unknown };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        };
        if (answer.exceptionDetails !== undefined) {
          throw new Error(
            answer.exceptionDetails.exception?.description ??
              answer.exceptionDetails.text ??
              "Evaluation failed",
          );
        }
        return answer.result?.value as T;
      };
      return {
        async setViewport(width, height) {
          await session.send("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
        },
        async load(document) {
          html = document;
          await session.send("Page.navigate", { url: `${CHECK_ORIGIN}/` });
          // The page's script runs when it loads: wait until it says so.
          for (let tries = 0; tries < 100; tries += 1) {
            const ready = await evaluate<boolean>(
              'document.documentElement?.dataset.portholeCheck === "ready"',
            ).catch(() => false);
            if (ready) {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("The check page didn't start");
        },
        evaluate,
        async screenshot(selector) {
          const box = await evaluate<{
            x: number;
            y: number;
            width: number;
            height: number;
          } | null>(
            `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`,
          );
          if (box === null) {
            return new Uint8Array();
          }
          const shot = (await session.send("Page.captureScreenshot", {
            format: "png",
            clip: { ...box, scale: 1 },
          })) as { data: string };
          return base64(shot.data);
        },
        close: () => Promise.resolve(),
      };
    },
  };
}
