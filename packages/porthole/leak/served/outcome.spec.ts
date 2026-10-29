import { expect, test } from "@playwright/test";
import { presets, type PortholeConfig } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { keepsFramedCookies } from "../../src/conformance/cookies.ts";
import { harness } from "./harness.ts";
import { storedFiles } from "./files.ts";
import { pageOf, unique } from "./nested-pages.ts";
import { app, mount, outcomeOf, type DisplayRecord } from "./porthole-host.ts";

/**
 * A served display's load outcome (P040), through Porthole's own `createHost` and `/server`: what a
 * host subscribes to so it can show its own fallback ("Open in a new tab") without pages of its
 * own. Each case on Chromium, WebKit and Firefox.
 */

test("a framed app is loaded where the engine keeps its cookie; blocked (cookies) where it doesn't", async ({
  page,
}) => {
  const served = await harness();
  const instance = app("outcome-framed");
  const location = await served.porthole.issue(instance, { viewer: "probe" });
  expect(location.reports).toBe(true);
  const { read } = await mount(
    page,
    served.hostOrigin,
    served.configs.url as PortholeConfig,
    location,
    instance,
  );
  const outcome = await outcomeOf(read);
  // Where the browser keeps no cookie in a cross-site frame (P025), the entry page finds that
  // out. Which browsers those are is measured by a probe of the browser's own, not by its name
  // (P098: Playwright's WebKit keeps none on Linux, keeps them on macOS).
  const kept = await keepsFramedCookies(page, "http:");
  expect(outcome).toEqual(
    kept ? { state: "loaded" } : { state: "blocked", reason: "cookies", status: 401 },
  );
  // The frame's first load says it shows; a blocked entry page can say so before its load ends.
  await expect
    .poll(async () => (await read()).initialized, {
      message: "the frame shows (url mode has no handshake)",
    })
    .toBe(true);
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
  const { read } = await mount(
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
  const { read } = await mount(
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
  const { read } = await mount(
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
  const { read } = await mount(
    page,
    served.hostOrigin,
    config,
    await served.porthole.issue(instance, { viewer: "probe" }),
    instance,
  );
  expect(await outcomeOf(read)).toEqual({ state: "loaded" });
  const { read: foreign } = await mount(
    page,
    served.foreignOrigin,
    config,
    await served.porthole.issue(instance, { viewer: "probe" }),
    instance,
  );
  expect(await outcomeOf(foreign)).toEqual({ state: "blocked", reason: "framing" });
});

test("a locator that fails is the host's: blocked (locate) and a host error, never a content error", async ({
  page,
}) => {
  const served = await harness();
  const instance: InstanceRef = {
    scope: "outcome-locate",
    document: { kind: "shell", preset: "inlineWidget" },
  };
  const { read } = await mount(
    page,
    served.hostOrigin,
    served.configs.inlineWidget as PortholeConfig,
    null,
    instance,
  );
  expect(await outcomeOf(read)).toEqual({ state: "blocked", reason: "locate" });
  const record = await read();
  expect(record.hostErrors).toEqual([{ message: "The host's backend is down", kind: "locate" }]);
  expect(record.contentErrors).toEqual([]);
  expect(record.errors).toEqual(["host: The host's backend is down"]);
});

test("what the content throws is a content error, never the host's", async ({ page }) => {
  const served = await harness();
  const instance: InstanceRef = {
    scope: "outcome-throws",
    document: { kind: "shell", preset: "inlineWidget" },
  };
  const { read } = await mount(
    page,
    served.hostOrigin,
    served.configs.inlineWidget as PortholeConfig,
    await served.porthole.issue(instance, { viewer: "probe" }),
    instance,
    { content: '<p>x</p><script>throw new Error("widget broke")</script>' },
  );
  await expect.poll(async () => (await read()).contentErrors.length).toBeGreaterThan(0);
  const record = await read();
  expect(record.contentErrors[0]).toContain("widget broke");
  expect(record.hostErrors).toEqual([]);
  expect(record.errors[0]).toMatch(/^content: .*widget broke/u);
});

/**
 * Who may say how loading went (P124): a frame status draws the host's own fallback, in Porthole's
 * wording ("open this in a new tab to sign in", "you no longer have access"), with a link. Content
 * that says one, to its parent or to the host's window, at once and again later, is told nothing
 * and shown nothing: the display's only outcome is `loaded`, and the host hears a `frame-status`
 * host error, once.
 */
const FORGE = `
  const forged = (to, reason) => to.postMessage({ jsonrpc: "2.0", method: "porthole/notifications/frame-status", params: { state: "blocked", reason, status: 401, code: "phish" } }, "*");
  const forge = () => {
    forged(parent, "sign-in");
    forged(top, "denied");
    parent.postMessage({ jsonrpc: "2.0", method: "porthole/notifications/frame-status", params: { state: "entering" } }, "*");
  };
  forge();
  setTimeout(forge, 300);
`;

const UNTRUSTED = {
  kind: "frame-status",
  message:
    "A frame status (porthole/notifications/frame-status) came from the frame's content, not from a page of Porthole's server: not taken (P124)",
};

/** The display's record once the content's forged words have reached the host (taken or not). */
async function forgedHeard(read: () => Promise<DisplayRecord>): Promise<DisplayRecord> {
  await expect
    .poll(
      async () => {
        const record = await read();
        // It finished its handshake, and the forger's word arrived: refused, or (a control) taken.
        return (
          record.initialized &&
          (record.hostErrors.length > 0 || record.outcomes.some((each) => each.state !== "loaded"))
        );
      },
      { message: "the forged frame status reached the host" },
    )
    .toBe(true);
  // The later copies too.
  await new Promise((resolve) => setTimeout(resolve, 600));
  return read();
}

function untold(record: DisplayRecord): void {
  expect(record.outcomes, "probe: the content's frame status drew nothing: loaded only").toEqual([
    { state: "loaded" },
  ]);
  expect(record.hostErrors, "probe: the host heard it, once, as a frame-status host error").toEqual(
    [UNTRUSTED],
  );
  expect(record.contentErrors).toEqual([]);
}

test("a served shell's content that says it is blocked is told nothing and shown nothing (P124)", async ({
  page,
}) => {
  const served = await harness();
  const instance: InstanceRef = {
    scope: "outcome-forge-shell",
    document: { kind: "shell", preset: "inlineWidget" },
  };
  const { read } = await mount(
    page,
    served.hostOrigin,
    served.configs.inlineWidget as PortholeConfig,
    await served.porthole.issue(instance, { viewer: "probe" }),
    instance,
    { content: `<p>forger</p><script>${FORGE}</script>` },
  );
  untold(await forgedHeard(read));
});

test("a served artifact page that says it is blocked as it loads is told nothing and shown nothing (P124)", async ({
  page,
}) => {
  const served = await harness();
  served.pages.set(
    "forger@1",
    `<!doctype html><html><head><title>Forger</title><script>${FORGE}</script></head><body><main>a page</main></body></html>`,
  );
  const instance: InstanceRef = {
    scope: "outcome-forge-page",
    document: { kind: "artifact", id: "forger", version: "1" },
  };
  const { read } = await mount(
    page,
    served.hostOrigin,
    served.configs.artifact as PortholeConfig,
    await served.porthole.issue(instance, { viewer: "probe" }),
    instance,
  );
  untold(await forgedHeard(read));
});

test("an opaque widget that says it is blocked is told nothing and shown nothing (P124)", async ({
  page,
}) => {
  const served = await harness();
  const { read } = await mount(
    page,
    served.hostOrigin,
    presets.inlineWidget(),
    null,
    { scope: "outcome-forge-opaque", document: { kind: "shell", preset: "inlineWidget" } },
    { content: `<p>forger</p><script>${FORGE}</script>` },
  );
  untold(await forgedHeard(read));
});

test("a nested page that says it is blocked, through its shell or past it, is told nothing and shown nothing (P124)", async ({
  page,
}) => {
  const served = await harness();
  const scope = unique("outcome-forge-nested");
  const id = unique("forger");
  served.fileSets.set(`${id}@1`, storedFiles({ "index.html": pageOf(FORGE) }));
  const instance: InstanceRef = {
    scope,
    document: { kind: "artifact", id, version: "1", preset: "artifactNested" },
  };
  const { read } = await mount(
    page,
    served.hostOrigin,
    served.configs.artifactNested as PortholeConfig,
    await served.porthole.issue(instance, { viewer: "probe" }),
    instance,
    {
      runtime: {
        key: scope,
        scope,
        artifact: id,
        declaration: { capabilities: {}, runtime: "1" },
        viewer: { level: "interact", id: "ada", name: "Ada" },
      },
    },
  );
  untold(await forgedHeard(read));
});
