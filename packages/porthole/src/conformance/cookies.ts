import type { Browser, BrowserContext, Page } from "@playwright/test";

/**
 * Whether this browser keeps a cookie a cross-site frame's own document was answered with
 * (P025, P098): what a framed url-mode app needs, since its every request rides on the cookie its
 * ticket's answer set. Measured, never assumed from the engine's name: Playwright's WebKit keeps
 * none on Linux and keeps them on macOS (the audit of 2026-10-19), and an engine's policy changes
 * between versions.
 *
 * The probe is the browser's own, outside the host under test: in a context of its own, a page on
 * one site frames a page on another (both answered by the probe's routes, never the network,
 * never the host's server), whose answer sets a cookie as Porthole's server sets a framed one
 * (`Secure; SameSite=None; Partitioned`, over the display's own scheme); the frame then reads
 * whether it was kept. Asked once per browser.
 */
export function keepsFramedCookies(page: Page, scheme: "http:" | "https:"): Promise<boolean> {
  const browser = page.context().browser();
  const key = `${scheme} ${browser === null ? "persistent" : browser.version()}`;
  const known = cache(browser ?? page.context());
  let answer = known.get(key);
  if (answer === undefined) {
    answer = probe(browser, page.context(), scheme);
    known.set(key, answer);
  }
  return answer;
}

const answers = new WeakMap<Browser | BrowserContext, Map<string, Promise<boolean>>>();

function cache(owner: Browser | BrowserContext): Map<string, Promise<boolean>> {
  let known = answers.get(owner);
  if (known === undefined) {
    known = new Map();
    answers.set(owner, known);
  }
  return known;
}

/** Two sites the probe makes up: the embedding page's, and the frame's. */
function sites(scheme: "http:" | "https:"): { top: string; framed: string } {
  // Over http, as a loopback host and its content origins are (a `*.localhost` frame on a
  // `127.0.0.1` page, the leak suite's own shape); over https, two names that are each a site.
  // Default ports: a browser refuses to navigate to some others (9 is on Fetch's bad-port list).
  return scheme === "http:"
    ? {
        top: "http://127.0.0.1/__porthole-cookie-probe/",
        framed: "http://porthole-cookie-probe.localhost/",
      }
    : {
        top: "https://porthole-cookie-probe-top.test/",
        framed: "https://porthole-cookie-probe-frame.test/",
      };
}

async function probe(
  browser: Browser | null,
  context: BrowserContext,
  scheme: "http:" | "https:",
): Promise<boolean> {
  const own = browser === null ? null : await browser.newContext();
  const page = await (own ?? context).newPage();
  try {
    const { top, framed } = sites(scheme);
    await page.route(`${framed}**`, (route) =>
      route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": "porthole-cookie-probe=1; Path=/; Secure; SameSite=None; Partitioned",
        },
        body: "<!doctype html><title>probe</title>",
      }),
    );
    await page.route(top, (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        body: `<!doctype html><title>probe</title><iframe src="${framed}frame"></iframe>`,
      }),
    );
    await page.goto(top);
    const frame = await (await page.locator("iframe").elementHandle())?.contentFrame();
    if (frame === null || frame === undefined) {
      throw new Error("keepsFramedCookies: the probe's frame didn't load");
    }
    await frame.waitForLoadState("load");
    return await frame.evaluate(() => document.cookie.includes("porthole-cookie-probe=1"));
  } finally {
    await page.close();
    await own?.close();
  }
}
