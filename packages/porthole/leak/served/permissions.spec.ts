import { expect, test, type Page } from "@playwright/test";
import { presets, type UrlPermission } from "../../src/index.ts";
import { harness } from "./harness.ts";
import { app, mount, outcomeOf, type Mounted } from "./porthole-host.ts";

/**
 * Features a url-mode frame may be delegated (P049): none by default; clipboard writes and full
 * screen when the host opts in. Measured on Chromium, WebKit and Firefox, in whatever document the
 * frame holds on the app's origin (WebKit stays on the entry page: it keeps no cookie in a frame,
 * P025; the delegation is the frame's, not the document's). Full screen follows the delegation on
 * all three; clipboard writes only on Chromium.
 */

interface Measured {
  readonly fullscreenEnabled: boolean;
  readonly clipboard: string;
  readonly fullscreen: string;
}

async function measure(page: Page, shown: Mounted): Promise<Measured> {
  const frame = await shown.frame();
  const fullscreenEnabled = await frame.evaluate(() => document.fullscreenEnabled);
  // Buttons whose handlers try each feature, clicked with real input (a user activation).
  await frame.evaluate(() => {
    const results: Record<string, string> = {};
    (window as unknown as { measured: Record<string, string> }).measured = results;
    const button = (id: string, run: () => Promise<unknown>) => {
      const each = document.createElement("button");
      each.id = id;
      each.textContent = id;
      each.style.cssText = "display:block;width:120px;height:40px";
      each.addEventListener("click", () => {
        results[id] = "pending";
        run().then(
          () => (results[id] = "ok"),
          (error: unknown) =>
            (results[id] = error instanceof Error ? `${error.name}: ${error.message}` : "error"),
        );
      });
      document.body.prepend(each);
    };
    button("clipboard", () => navigator.clipboard.writeText("porthole"));
    button("fullscreen", async () => {
      await document.documentElement.requestFullscreen();
      await document.exitFullscreen();
    });
  });
  const results: Record<string, string> = {};
  for (const id of ["clipboard", "fullscreen"]) {
    await frame.locator(`#${id}`).click();
    await expect
      .poll(
        () =>
          frame.evaluate(
            (each) =>
              (window as unknown as { measured: Record<string, string> }).measured[each] ??
              "unclicked",
            id,
          ),
        { timeout: 5_000 },
      )
      .not.toMatch(/^(pending|unclicked)$/u);
    results[id] = await frame.evaluate(
      (each) => (window as unknown as { measured: Record<string, string> }).measured[each] ?? "",
      id,
    );
  }
  return {
    fullscreenEnabled,
    clipboard: results.clipboard ?? "",
    fullscreen: results.fullscreen ?? "",
  };
}

async function framed(page: Page, scope: string, permissions?: readonly UrlPermission[]) {
  const served = await harness();
  const config = presets.url({
    contentOrigins: [served.contentSource],
    ...(permissions === undefined ? {} : { permissions }),
  });
  const instance = app(scope);
  const shown = await mount(
    page,
    served.hostOrigin,
    config,
    await served.porthole.issue(instance, { viewer: "probe" }),
    instance,
  );
  await outcomeOf(shown.read);
  return shown;
}

test("a url-mode frame gets no clipboard writes or full screen unless the host delegates them", async ({
  page,
  context,
  browserName,
}) => {
  // The person has granted clipboard writes (where the engine has the permission), so what stands
  // between a frame and the clipboard is the delegation alone.
  await context.grantPermissions(["clipboard-write"]).catch(() => undefined);
  const closed = await measure(page, await framed(page, "permissions-default"));
  const open = await measure(
    page,
    await framed(page, "permissions-open", ["clipboard-write", "fullscreen"]),
  );
  test.info().annotations.push({
    type: "measured",
    description: JSON.stringify({ browserName, closed, open }),
  });
  const seen = JSON.stringify({ closed, open });
  expect(closed.fullscreenEnabled, `probe: full screen, by default: ${seen}`).toBe(false);
  expect(closed.fullscreen, `probe: full screen, by default: ${seen}`).not.toBe("ok");
  expect(open.fullscreenEnabled, `full screen, delegated: ${seen}`).toBe(true);
  expect(open.clipboard, `clipboard, delegated: ${seen}`).toBe("ok");
  // Measured (P049): only Chromium enforces the clipboard-write policy feature. WebKit and Firefox
  // let any frame write the clipboard in a click, delegated or not: there the host's choice
  // changes nothing, and default-off is no wall.
  if (browserName === "chromium") {
    expect(closed.clipboard, `probe: clipboard, by default: ${seen}`).toMatch(/^NotAllowedError/u);
  } else {
    expect(closed.clipboard, `clipboard, by default: ${seen}`).toBe("ok");
  }
});
