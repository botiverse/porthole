import { expect, test, type Page } from "@playwright/test";
import { presets, type PortholeConfig } from "../../src/index.ts";
import type { FrameOutcome } from "../../src/host/types.ts";
import type { FrameLocation, InstanceRef } from "../../src/isolation/types.ts";
import { harness } from "./harness.ts";

/**
 * A served display's load outcome (P040), through Porthole's own `createHost` and `/server`: what a
 * host subscribes to so it can show its own fallback ("Open in a new tab") without pages of its
 * own. Each case on Chromium, WebKit and Firefox.
 */

interface Record {
  readonly outcomes: FrameOutcome[];
  readonly initialized: boolean;
  readonly errors: string[];
}

interface PortholeHostPage {
  records: Record[];
  mount(config: PortholeConfig, location: FrameLocation, instance: InstanceRef): number;
}

const app = (scope: string): InstanceRef => ({
  scope,
  document: { kind: "external", url: "http://app.test/" },
});

async function mount(
  page: Page,
  origin: string,
  config: PortholeConfig,
  location: FrameLocation,
  instance: InstanceRef,
): Promise<() => Promise<Record>> {
  if (!page.url().startsWith(`${origin}/porthole-host`)) {
    await page.goto(`${origin}/porthole-host`);
    await page.waitForFunction(() => "portholeHost" in window);
  }
  const index = await page.evaluate(
    ([each, where, what]) =>
      (window as unknown as { portholeHost: PortholeHostPage }).portholeHost.mount(
        each,
        where,
        what,
      ),
    [config, location, instance] as const,
  );
  return () =>
    page.evaluate(
      (each) =>
        (window as unknown as { portholeHost: PortholeHostPage }).portholeHost.records[
          each
        ] as Record,
      index,
    );
}

const outcomeOf = async (read: () => Promise<Record>, timeout = 10_000): Promise<FrameOutcome> => {
  await expect.poll(async () => (await read()).outcomes.length, { timeout }).toBe(1);
  return (await read()).outcomes[0] as FrameOutcome;
};

test("a framed app is loaded where the engine keeps its cookie; blocked (cookies) where it doesn't", async ({
  page,
  browserName,
}) => {
  const served = await harness();
  const instance = app("outcome-framed");
  const location = await served.porthole.issue(instance, { viewer: "probe" });
  expect(location.reports).toBe(true);
  const read = await mount(
    page,
    served.hostOrigin,
    served.configs.url as PortholeConfig,
    location,
    instance,
  );
  const outcome = await outcomeOf(read);
  // Measured (P025): WebKit keeps no cookie in a cross-site frame; the entry page finds that out.
  expect(outcome).toEqual(
    browserName === "webkit"
      ? { state: "blocked", reason: "cookies", status: 401 }
      : { state: "loaded" },
  );
  expect((await read()).initialized, "the frame shows (url mode has no handshake)").toBe(true);
  if (outcome.state === "loaded") {
    const frame = page.frameLocator("#displays iframe").first();
    await expect(frame.locator("html")).toHaveAttribute("data-app", "ready");
  }
});

test("a page whose server doesn't let this host frame it never runs: blocked (framing)", async ({
  page,
}) => {
  const served = await harness();
  const instance = app("outcome-framing");
  const location = await served.porthole.issue(instance, { viewer: "probe" });
  // The foreign origin isn't one of the server's host origins: frame-ancestors refuses it.
  const read = await mount(
    page,
    served.foreignOrigin,
    served.configs.url as PortholeConfig,
    location,
    instance,
  );
  expect(await outcomeOf(read)).toEqual({ state: "blocked", reason: "framing" });
});

test("a used ticket opens nothing: blocked (session), told by the server's own page", async ({
  page,
}) => {
  const served = await harness();
  const instance = app("outcome-session");
  const location = await served.porthole.issue(instance, { viewer: "probe" });
  await served.porthole.handle(
    new Request(location.url, { headers: { "sec-fetch-dest": "document" } }),
  );
  const read = await mount(
    page,
    served.hostOrigin,
    served.configs.url as PortholeConfig,
    location,
    instance,
  );
  expect(await outcomeOf(read)).toEqual({ state: "blocked", reason: "session", status: 403 });
});

test("a load that never settles is a timeout", async ({ page }) => {
  const served = await harness();
  const config = presets.url({
    contentOrigins: [served.contentSource],
    limits: { loadTimeoutMs: 1_500 },
  });
  const origin = served.porthole.originFor("outcome-hang");
  const read = await mount(
    page,
    served.hostOrigin,
    config,
    { url: `${origin}/__hang`, origin, reports: true },
    app("outcome-hang"),
  );
  expect(await outcomeOf(read, 5_000)).toEqual({ state: "timeout" });
});

test("a served shell is loaded when it finishes its handshake; from a host it doesn't allow, blocked (framing)", async ({
  page,
}) => {
  const served = await harness();
  const instance: InstanceRef = {
    scope: "outcome-shell",
    document: { kind: "shell", preset: "inlineWidget" },
  };
  const config = served.configs.inlineWidget as PortholeConfig;
  const read = await mount(
    page,
    served.hostOrigin,
    config,
    await served.porthole.issue(instance, { viewer: "probe" }),
    instance,
  );
  expect(await outcomeOf(read)).toEqual({ state: "loaded" });
  const foreign = await mount(
    page,
    served.foreignOrigin,
    config,
    await served.porthole.issue(instance, { viewer: "probe" }),
    instance,
  );
  expect(await outcomeOf(foreign)).toEqual({ state: "blocked", reason: "framing" });
});
