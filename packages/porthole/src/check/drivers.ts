import type { Browser } from "@playwright/test";
import type { CheckDriver, CheckSession } from "./check.ts";

/**
 * Drivers for `checkPage` (P073): Playwright's browser on Node, or any Chrome DevTools Protocol
 * session (Puppeteer's `page.createCDPSession()`, `@cloudflare/puppeteer` on Cloudflare Browser
 * Rendering from a Worker).
 *
 * A driver answers two names no network has itself: the check page's origin (a host's), and a
 * content domain, where a served config's content runs on an origin of its own as people's
 * browsers run it (P074).
 */

/** Where the check page is served from. */
export const CHECK_ORIGIN = "https://porthole-check.invalid";
/** The content domain a served config's content runs under in the check: another site. */
export const CHECK_CONTENT_DOMAIN = "porthole-check-content.invalid";

const CHECK_HOST = new URL(CHECK_ORIGIN).hostname;
/** Whether the driver answers a URL itself. */
const answered = (url: URL): boolean =>
  url.hostname === CHECK_HOST || url.hostname.endsWith(`.${CHECK_CONTENT_DOMAIN}`);

type Handler = (request: Request) => Promise<Response>;

/** A page that answers the check's own names: `/` the given document, the rest 404. */
const pageOnly =
  (html: string): Handler =>
  (request) =>
    Promise.resolve(
      new URL(request.url).hostname === CHECK_HOST && new URL(request.url).pathname === "/"
        ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("not found", { status: 404 }),
    );

/** Checks in a page of a Playwright browser (`chromium.launch()`), one page per check. */
export function playwrightDriver(browser: Browser): CheckDriver {
  return {
    async open(): Promise<CheckSession> {
      const page = await browser.newPage();
      let handler: Handler = pageOnly("");
      await page.route(answered, async (route) => {
        const asked = route.request();
        const headers = Object.entries(await asked.allHeaders()).filter(
          ([name]) => !name.startsWith(":"),
        );
        const method = asked.method();
        const body = method === "GET" || method === "HEAD" ? null : asked.postDataBuffer();
        const answer = await handler(
          new Request(asked.url(), {
            method,
            headers,
            ...(body === null ? {} : { body: new Uint8Array(body) }),
          }),
        );
        const out: Record<string, string> = {};
        for (const [name, value] of answer.headers) {
          if (name !== "set-cookie") {
            out[name] = value;
          }
        }
        const cookies = answer.headers.getSetCookie();
        if (cookies.length > 0) {
          out["set-cookie"] = cookies.join("\n");
        }
        await route.fulfill({
          status: answer.status,
          headers: out,
          body: Buffer.from(await answer.arrayBuffer()),
        });
      });
      return {
        setViewport: (width, height) => page.setViewportSize({ width, height }),
        async load(document) {
          handler = pageOnly(document);
          await page.goto(`${CHECK_ORIGIN}/`, { waitUntil: "load" });
        },
        async serve(given) {
          handler = given;
          await page.goto(`${CHECK_ORIGIN}/`, { waitUntil: "load" });
        },
        evaluate: (expression) => page.evaluate(expression),
        screenshot: async (selector) => new Uint8Array(await page.locator(selector).screenshot()),
        close: () => page.close(),
      };
    },
  };
}

/**
 * A Chrome DevTools Protocol session: its commands and its events. The least the driver uses, so
 * Puppeteer's `CDPSession` (`@cloudflare/puppeteer`'s too) and Playwright's fit as they are, with
 * no cast (P074).
 */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: "Fetch.requestPaused", listener: (params: PausedRequest) => void): unknown;
}

/** What CDP says of a request it paused. */
interface PausedRequest {
  readonly requestId: string;
  readonly request?: {
    readonly url: string;
    readonly method: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly postData?: string;
  };
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
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
      let handler: Handler = pageOnly("");
      // The check's own names are answered here; everything else goes on.
      await session.send("Fetch.enable", {
        patterns: [
          { urlPattern: `${CHECK_ORIGIN}/*` },
          { urlPattern: `https://*.${CHECK_CONTENT_DOMAIN}/*` },
        ],
      });
      session.on("Fetch.requestPaused", (event) => {
        void (async () => {
          const asked = event.request;
          if (asked === undefined || !answered(new URL(asked.url))) {
            await session.send("Fetch.continueRequest", { requestId: event.requestId });
            return;
          }
          const body =
            asked.method === "GET" || asked.method === "HEAD" ? null : (asked.postData ?? null);
          const answer = await handler(
            new Request(asked.url, {
              method: asked.method,
              headers: Object.entries(asked.headers ?? {}),
              ...(body === null ? {} : { body }),
            }),
          );
          await session.send("Fetch.fulfillRequest", {
            requestId: event.requestId,
            responseCode: answer.status,
            responseHeaders: [
              ...[...answer.headers]
                .filter(([name]) => name !== "set-cookie")
                .map(([name, value]) => ({ name, value })),
              ...answer.headers.getSetCookie().map((value) => ({ name: "set-cookie", value })),
            ],
            body: bytesToBase64(new Uint8Array(await answer.arrayBuffer())),
          });
        })();
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
      const goto = async () => {
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
          handler = pageOnly(document);
          await goto();
        },
        async serve(given) {
          handler = given;
          await goto();
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
