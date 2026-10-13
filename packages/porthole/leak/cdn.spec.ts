import { expect, test, type BrowserContext, type Frame } from "@playwright/test";
import { LIBRARY_CDNS, presets, type PortholeConfig } from "../src/index.ts";
import type { InstanceRef } from "../src/isolation/types.ts";
import { CDN_LIBRARY, harness } from "./served/harness.ts";
import { mount, outcomeOf } from "./served/porthole-host.ts";
import { referenceHost } from "./reference-host.ts";

/**
 * The artifact preset with library CDNs opened (`egress: LIBRARY_CDNS`, P022, P048): a page loads
 * its library from a CDN; anything else stays closed; and without the opt-in (the default) nothing
 * loads at all. The CDN is routed by the test (nothing leaves the machine): a request reaches the
 * route only when the frame's CSP let it go out. Opaque and served (domain mode), on Chromium,
 * WebKit and Firefox.
 */

const ELSEWHERE = "https://not-a-cdn.example/lib.js";
const LIBRARY = `document.documentElement.dataset.library = "loaded";`;

/** Routes the CDN and one other origin; counts what reaches each. */
async function routeCdn(context: BrowserContext): Promise<{ cdn: number; elsewhere: number }> {
  const hits = { cdn: 0, elsewhere: 0 };
  await context.route(CDN_LIBRARY, (route) => {
    hits.cdn += 1;
    return route.fulfill({ contentType: "text/javascript", body: LIBRARY });
  });
  await context.route(ELSEWHERE, (route) => {
    hits.elsewhere += 1;
    return route.fulfill({ contentType: "text/javascript", body: LIBRARY });
  });
  return hits;
}

const PAGE = `<!doctype html><html><head><title>Chart</title><script src="${CDN_LIBRARY}"></script></head><body><main id="artifact">a page with a library</main></body></html>`;
const OTHER = `<!doctype html><html><head><title>Other</title><script src="${ELSEWHERE}"></script></head><body><main id="artifact">a page with a script from elsewhere</main></body></html>`;

const libraryOf = (frame: Frame) =>
  frame.evaluate(() => document.documentElement.dataset.library ?? "none");

/** Waits long enough for a load the CSP let through to have landed. */
const settle = (frame: Frame) => frame.waitForTimeout(1_500);

test("an opaque artifact loads its library from a CDN only when the host opens LIBRARY_CDNS", async ({
  page,
  context,
}) => {
  const hits = await routeCdn(context);
  const open = await referenceHost.launch(page, {
    config: presets.artifact({ egress: LIBRARY_CDNS }),
    content: PAGE,
  });
  const openFrame = await open.frame();
  await expect.poll(() => libraryOf(openFrame)).toBe("loaded");
  expect(hits.cdn).toBe(1);

  const elsewhere = await referenceHost.launch(page, {
    config: presets.artifact({ egress: LIBRARY_CDNS }),
    content: OTHER,
  });
  const elsewhereFrame = await elsewhere.frame();
  await expect(elsewhereFrame.locator("#artifact")).toBeAttached();
  await settle(elsewhereFrame);
  expect(await libraryOf(elsewhereFrame), "an origin that isn't a library CDN").toBe("none");
  expect(hits.elsewhere).toBe(0);

  const closed = await referenceHost.launch(page, { config: presets.artifact(), content: PAGE });
  const closedFrame = await closed.frame();
  await expect(closedFrame.locator("#artifact")).toBeAttached();
  await settle(closedFrame);
  expect(await libraryOf(closedFrame), "the default: egress closed").toBe("none");
  expect(hits.cdn).toBe(1);
});

test("a served artifact page loads its library from a CDN only under a config that opens LIBRARY_CDNS", async ({
  page,
  context,
}) => {
  const served = await harness();
  const hits = await routeCdn(context);
  const shown = async (preset: string, scope: string): Promise<Frame> => {
    const instance: InstanceRef = {
      scope,
      document: { kind: "artifact", id: "cdn", version: "1", preset },
    };
    const display = await mount(
      page,
      served.hostOrigin,
      served.configs[preset] as PortholeConfig,
      await served.porthole.issue(instance, { viewer: "probe" }),
      instance,
    );
    expect(await outcomeOf(display.read)).toEqual({ state: "loaded" });
    return display.frame();
  };
  const open = await shown("artifactCdn", "cdn-open");
  await expect.poll(() => libraryOf(open)).toBe("loaded");
  expect(hits.cdn).toBe(1);
  const closed = await shown("artifact", "cdn-closed");
  await expect(closed.locator("#artifact")).toBeAttached();
  await settle(closed);
  expect(await libraryOf(closed), "the default: egress closed").toBe("none");
  expect(hits.cdn).toBe(1);
});

/** The libraries' own CDNs, scripts only (P078). */
const OWN_CDNS = ["https://cdn.tailwindcss.com", "https://code.jquery.com", "https://cdn.plot.ly"];

/** Routes the libraries' own CDNs; records `<host> <path>` for each request that reached one. */
async function routeOwnCdns(context: BrowserContext): Promise<string[]> {
  const reached: string[] = [];
  for (const host of OWN_CDNS) {
    await context.route(`${host}/**`, (route) => {
      const url = new URL(route.request().url());
      reached.push(`${url.host} ${url.pathname}`);
      return route.fulfill({
        contentType: url.pathname.endsWith(".js") ? "text/javascript" : "text/plain",
        body: url.pathname.endsWith(".js")
          ? "document.documentElement.dataset.libraries = String(Number(document.documentElement.dataset.libraries ?? 0) + 1);"
          : "x",
        headers: { "access-control-allow-origin": "*" },
      });
    });
  }
  return reached;
}

/** From each of the libraries' CDNs: a script, a stylesheet, an image and a fetch. */
const OWN_CDN_PAGE = `<!doctype html><html><head><title>Libraries</title>
${OWN_CDNS.map((host) => `<link rel="stylesheet" href="${host}/style.css"><script src="${host}/lib.js"></script>`).join("\n")}
</head><body><main id="artifact">${OWN_CDNS.map((host) => `<img src="${host}/pixel.gif" alt="">`).join("")}</main>
<script>
  Promise.allSettled(${JSON.stringify(OWN_CDNS)}.map((host) => fetch(host + "/data.json"))).then(
    (all) => (document.body.dataset.fetched = String(all.filter((each) => each.status === "fulfilled").length)),
  );
</script></body></html>`;

const reachedOwnCdns = (reached: readonly string[]) =>
  [...reached].sort((a, b) => a.localeCompare(b));

test("the libraries' own CDNs serve scripts and nothing else: a stylesheet, an image and a fetch never reach them (P078)", async ({
  page,
  context,
}) => {
  const reached = await routeOwnCdns(context);
  const scripts = OWN_CDNS.map((host) => `${new URL(host).host} /lib.js`).sort((a, b) =>
    a.localeCompare(b),
  );
  // Opaque.
  const open = await referenceHost.launch(page, {
    config: presets.artifact({ egress: LIBRARY_CDNS }),
    content: OWN_CDN_PAGE,
  });
  const frame = await open.frame();
  await expect.poll(() => frame.evaluate(() => document.body.dataset.fetched ?? "")).toBe("0");
  await expect
    .poll(() => frame.evaluate(() => document.documentElement.dataset.libraries ?? "0"))
    .toBe(String(OWN_CDNS.length));
  await settle(frame);
  expect(reachedOwnCdns(reached)).toEqual(scripts);

  // Served (domain mode), under the harness's config that opens LIBRARY_CDNS.
  reached.length = 0;
  const served = await harness();
  served.pages.set("libraries@1", OWN_CDN_PAGE);
  const instance: InstanceRef = {
    scope: "own-cdns",
    document: { kind: "artifact", id: "libraries", version: "1", preset: "artifactCdn" },
  };
  const display = await mount(
    page,
    served.hostOrigin,
    served.configs.artifactCdn as PortholeConfig,
    await served.porthole.issue(instance, { viewer: "probe" }),
    instance,
  );
  expect(await outcomeOf(display.read)).toEqual({ state: "loaded" });
  const shown = await display.frame();
  await expect.poll(() => shown.evaluate(() => document.body.dataset.fetched ?? "")).toBe("0");
  await expect
    .poll(() => shown.evaluate(() => document.documentElement.dataset.libraries ?? "0"))
    .toBe(String(OWN_CDNS.length));
  await settle(shown);
  expect(reachedOwnCdns(reached)).toEqual(scripts);
});

const ANY_SITE = "https://any-site.example";
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** Routes a stranger's https site; records each path that reached it. */
async function routeAnySite(context: BrowserContext): Promise<string[]> {
  const reached: string[] = [];
  await context.route(`${ANY_SITE}/**`, (route) => {
    const url = new URL(route.request().url());
    reached.push(url.pathname);
    const type = url.pathname.endsWith(".gif")
      ? "image/gif"
      : url.pathname.endsWith(".css")
        ? "text/css"
        : url.pathname.endsWith(".js")
          ? "text/javascript"
          : "application/json";
    return route.fulfill({
      contentType: type,
      body: type === "image/gif" ? PIXEL : type === "text/javascript" ? LIBRARY : "{}",
      headers: { "access-control-allow-origin": "*" },
    });
  });
  return reached;
}

const HOTLINKED = `<!doctype html><html><head><title>Report</title>
<link rel="stylesheet" href="${ANY_SITE}/style.css">
<script src="${ANY_SITE}/script.js"></script></head><body>
<main id="artifact"><img id="hotlinked" src="${ANY_SITE}/chart.gif" alt="chart"></main>
<script>
  fetch(${JSON.stringify(`${ANY_SITE}/data.json`)}).then(() => (document.body.dataset.fetch = "sent"), () => (document.body.dataset.fetch = "blocked"));
  const image = document.getElementById("hotlinked");
  const done = () => (document.body.dataset.image = image.naturalWidth > 0 ? "loaded" : "blocked");
  if (image.complete) done(); else { image.onload = done; image.onerror = done; }
</script></body></html>`;

test("images from any https site, when the host opts in: they load; scripts, styles and data from it never (P059)", async ({
  page,
  context,
}) => {
  const reached = await routeAnySite(context);
  const open = await referenceHost.launch(page, {
    config: presets.artifact({ egress: { anyHttps: ["img", "media"] } }),
    content: HOTLINKED,
  });
  const frame = await open.frame();
  await expect.poll(() => frame.evaluate(() => document.body.dataset.image ?? "")).toBe("loaded");
  await expect.poll(() => frame.evaluate(() => document.body.dataset.fetch ?? "")).toBe("blocked");
  await settle(frame);
  expect(reached).toEqual(["/chart.gif"]);
  expect(await libraryOf(frame), "the script never ran").toBe("none");

  // Without the opt-in, not even the image.
  const closedReached = reached.length;
  const closed = await referenceHost.launch(page, {
    config: presets.artifact(),
    content: HOTLINKED,
  });
  const closedFrame = await closed.frame();
  await expect
    .poll(() => closedFrame.evaluate(() => document.body.dataset.image ?? ""))
    .toBe("blocked");
  await settle(closedFrame);
  expect(reached).toHaveLength(closedReached);
});
