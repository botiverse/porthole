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
