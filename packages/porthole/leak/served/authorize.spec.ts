import { expect, test, type Frame, type Page } from "@playwright/test";
import type { PortholeConfig } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { keepsFramedCookies } from "../../src/conformance/cookies.ts";
import { harness } from "./harness.ts";
import { app, mount, outcomeOf, outcomesOf } from "./porthole-host.ts";

/**
 * The host's check on every request (P050): a subject the host revokes is denied from its next
 * request on, whatever ticket or cookie it holds, and a display is told (blocked: denied, with the
 * host's code). Each case on Chromium, WebKit and Firefox.
 */

const artifact = (scope: string): InstanceRef => ({
  scope,
  document: { kind: "artifact", id: "page", version: "1" },
});

const DENIED = { state: "blocked", reason: "denied", status: 403, code: "revoked" };

/** A fetch from inside the frame, as the app's own code makes it. */
const fetchStatus = (frame: Frame | Page, path: string): Promise<number> =>
  frame.evaluate(
    (each) => fetch(each, { cache: "no-store" }).then((response) => response.status),
    path,
  );

/** The frame (or tab) reloads itself, as an app does. */
const reloadItself = (frame: Frame): Promise<void> =>
  frame.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });

test("a revoked subject's ticket opens nothing: a page and an app are denied, and the host is told", async ({
  page,
}, info) => {
  const served = await harness();
  const subject = `ticket-${info.project.name}`;
  const pageLocation = await served.porthole.issue(artifact("deny-ticket-page"), {
    viewer: "probe",
    subject,
  });
  const appLocation = await served.porthole.issue(app("deny-ticket-app"), {
    viewer: "probe",
    subject,
  });
  served.revoked.add(subject);
  const shown = await mount(
    page,
    served.hostOrigin,
    served.configs.artifact as PortholeConfig,
    pageLocation,
    artifact("deny-ticket-page"),
  );
  expect(await outcomeOf(shown.read), "probe: the revoked page's display was told denied").toEqual(
    DENIED,
  );
  const entered = await mount(
    page,
    served.hostOrigin,
    served.configs.url as PortholeConfig,
    appLocation,
    app("deny-ticket-app"),
  );
  expect(await outcomeOf(entered.read), "probe: the revoked app's display was told denied").toEqual(
    DENIED,
  );
  const frame = await entered.frame();
  await expect(frame.locator("main"), "probe: the frame shows the revoked refusal").toHaveAttribute(
    "data-porthole-code",
    "revoked",
  );
  expect(
    await frame.locator("html").getAttribute("data-app"),
    "probe: the revoked app ran",
  ).toBeNull();
});

test("a framed app mid-session: its next request after revocation is denied, and its next load tells the host", async ({
  page,
  browserName,
}) => {
  // Measured, not assumed from the engine's name (P098: Playwright's WebKit keeps none on Linux,
  // keeps them on macOS). Only WebKit was ever measured keeping none: elsewhere a probe that says
  // so is broken, and the case fails rather than skip (after the review of P098).
  const kept = await keepsFramedCookies(page, "http:");
  if (browserName !== "webkit") {
    expect(kept, "the cookie probe: Chromium and Firefox keep a framed cookie").toBe(true);
  }
  test.skip(
    !kept,
    "this browser keeps no cookie in a cross-site frame (P025): a framed app never has a session there (blocked: cookies); the ticket and tab cases cover it",
  );
  const served = await harness();
  const subject = `mid-session-${browserName}`;
  const instance = app("revoke-mid-session");
  const location = await served.porthole.issue(instance, { viewer: "probe", subject });
  const shown = await mount(
    page,
    served.hostOrigin,
    served.configs.url as PortholeConfig,
    location,
    instance,
  );
  expect(await outcomeOf(shown.read)).toEqual({ state: "loaded" });
  const frame = await shown.frame();
  await expect(frame.locator("html")).toHaveAttribute("data-app", "ready");
  expect(await fetchStatus(frame, "/api")).toBe(200);

  served.revoked.add(subject);
  expect(await fetchStatus(frame, "/api"), "probe: the very next request").toBe(403);
  await reloadItself(frame);
  expect(await outcomesOf(shown.read, 2), "probe: the next load told the host denied").toEqual([
    { state: "loaded" },
    DENIED,
  ]);
  const after = await shown.frame();
  await expect(after.locator("main"), "probe: the frame shows the denied refusal").toHaveAttribute(
    "data-porthole-reason",
    "denied",
  );
  expect(
    await after.locator("html").getAttribute("data-app"),
    "probe: the revoked app ran",
  ).toBeNull();
});

test("a framed page mid-session: its next load after revocation is denied where the engine keeps its cookie", async ({
  page,
  browserName,
}) => {
  const served = await harness();
  const subject = `page-session-${browserName}`;
  const instance = artifact("revoke-page-session");
  const location = await served.porthole.issue(instance, { viewer: "probe", subject });
  const shown = await mount(
    page,
    served.hostOrigin,
    served.configs.artifact as PortholeConfig,
    location,
    instance,
  );
  expect(await outcomeOf(shown.read)).toEqual({ state: "loaded" });
  served.revoked.add(subject);
  await reloadItself(await shown.frame());
  // A frame that speaks for itself and navigates is mounted again (its navigation recovery), at
  // a location the host gives again: each mounting tells its own outcome. Every one after the
  // first is the refusal. A browser that keeps no cookie in a cross-site frame (P025, measured:
  // P098) had no session to revoke on its reload.
  const refusal = (await keepsFramedCookies(page, "http:"))
    ? DENIED
    : { state: "blocked", reason: "session", status: 401 };
  await expect
    .poll(async () => (await shown.read()).outcomes.at(-1), {
      timeout: 10_000,
      message: "probe: the load after revocation was refused",
    })
    .toEqual(refusal);
  const [first, ...rest] = (await shown.read()).outcomes;
  expect(first).toEqual({ state: "loaded" });
  expect(rest.length, "probe: a load after revocation told the host").toBeGreaterThan(0);
  for (const each of rest) {
    expect(each, "probe: a load after revocation was not refused").toEqual(refusal);
  }
});

test("in a tab of its own, a revoked app and page are denied from the next request on", async ({
  page,
  browserName,
}) => {
  const served = await harness();
  const subject = `tab-${browserName}`;
  const appLocation = await served.porthole.issue(app("revoke-tab-app"), {
    viewer: "probe",
    subject,
  });
  await page.goto(appLocation.url);
  await expect(page.locator("html")).toHaveAttribute("data-app", "ready");
  expect(await fetchStatus(page, "/api")).toBe(200);
  const pageLocation = await served.porthole.issue(artifact("revoke-tab-page"), {
    viewer: "probe",
    subject,
  });
  const tab = await page.context().newPage();
  await tab.goto(pageLocation.url);
  await expect(tab.locator("#artifact")).toHaveText("version 1");
  await tab.reload();
  await expect(tab.locator("#artifact"), "the cookie serves a reload").toHaveText("version 1");

  served.revoked.add(subject);
  expect(await fetchStatus(page, "/api"), "probe: the very next request").toBe(403);
  await page.reload();
  await expect(
    page.locator("main"),
    "probe: the app's tab shows the revoked refusal",
  ).toHaveAttribute("data-porthole-code", "revoked");
  await tab.reload();
  await expect(
    tab.locator("main"),
    "probe: the page's tab shows the denied refusal",
  ).toHaveAttribute("data-porthole-reason", "denied");
  await expect(tab.locator("#artifact"), "probe: the revoked page was served").toHaveCount(0);
});
