import { expect, test, type Page } from "@playwright/test";
import { compile, presets, resolveTheme, type PortholeConfig } from "../src/index.ts";

/**
 * The compiled shell, in a real frame on each engine: the frame is an opaque origin, and the
 * shell wires exactly what its config declares (the agreement test's claims, observed in a
 * browser rather than read from strings).
 */

interface Harness {
  received: { origin: string; data: { method?: string; params?: Record<string, unknown> } }[];
  mount(html: string, sandbox: string, hostContext: unknown): void;
  send(message: Record<string, unknown>): void;
}

async function mount(page: Page, config: PortholeConfig): Promise<void> {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const compiled = compile(config);
  const hostContext = {
    theme: "dark",
    styles: { variables: { ...resolveTheme(config.theme, "dark"), "--not-declared": "#123456" } },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
  };
  await page.evaluate(
    ([html, sandbox, context]) =>
      (window as unknown as { harness: Harness }).harness.mount(html, sandbox, context),
    [
      compiled.shellDocument({ origins: [origin], title: "Probe" }),
      compiled.sandbox,
      hostContext,
    ] as const,
  );
  // The shell asks to initialize, the host answers, and the shell says it is ready.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { harness: Harness }).harness.received.some(
          (message) => message.data.method === "ui/notifications/initialized",
        ),
      ),
    )
    .toBe(true);
}

const send = (page: Page, message: Record<string, unknown>) =>
  page.evaluate((each) => (window as unknown as { harness: Harness }).harness.send(each), message);

test("the shell runs in an opaque origin, never the host's", async ({ page }) => {
  await mount(page, presets.inlineWidget());
  const frame = page.frameLocator("iframe");
  expect(await frame.locator("body").evaluate(() => window.origin)).toBe("null");
  expect(
    await frame.locator("body").evaluate(() => {
      try {
        return window.parent.document.title;
      } catch {
        return "blocked";
      }
    }),
  ).toBe("blocked");
  const origins = await page.evaluate(() =>
    (window as unknown as { harness: Harness }).harness.received.map((message) => message.origin),
  );
  expect(new Set(origins)).toEqual(new Set(["null"]));
});

test("the shell defines a global only for each declared capability", async ({ page }) => {
  await mount(page, presets.inlineWidget({ capabilities: { sendPrompt: {} } }));
  const frame = page.frameLocator("iframe");
  expect(
    await frame.locator("body").evaluate(() => ({
      sendPrompt: typeof (window as unknown as Record<string, unknown>).sendPrompt,
      openLink: typeof (window as unknown as Record<string, unknown>).openLink,
      rtc: typeof (window as unknown as Record<string, unknown>).RTCPeerConnection,
    })),
  ).toEqual({ sendPrompt: "function", openLink: "undefined", rtc: "undefined" });
});

test("the shell applies the declared theme variables and drops any other", async ({ page }) => {
  await mount(page, presets.inlineWidget());
  const root = page.frameLocator("iframe").locator("html");
  await expect
    .poll(() => root.evaluate((element) => element.getAttribute("data-theme")))
    .toBe("dark");
  expect(
    await root.evaluate((element) => ({
      accent: getComputedStyle(element).getPropertyValue("--color-accent").trim(),
      stray: getComputedStyle(element).getPropertyValue("--not-declared").trim(),
    })),
  ).toEqual({ accent: "#3987e5", stray: "" });
});

test("the shell draws streamed content inert, then runs the whole once", async ({ page }) => {
  await mount(page, presets.inlineWidget());
  const partial =
    '<div id="a" onclick="document.body.dataset.handler = 1">A</div><script>document.body.dataset.ran = (Number(document.body.dataset.ran) || 0) + 1</script>';
  await send(page, {
    method: "ui/notifications/tool-input-partial",
    params: { arguments: { html: partial } },
  });
  const body = page.frameLocator("iframe").locator("body");
  await expect(body.locator("#a")).toHaveText("A");
  expect(await body.evaluate((element) => element.dataset.ran ?? null)).toBeNull();
  expect(await body.locator("#a").getAttribute("onclick")).toBeNull();
  await send(page, {
    method: "ui/notifications/tool-input",
    params: { arguments: { html: partial } },
  });
  await expect(body).toHaveAttribute("data-ran", "1");
  await send(page, {
    method: "ui/notifications/tool-input",
    params: { arguments: { html: partial } },
  });
  await page.waitForTimeout(200);
  await expect(body).toHaveAttribute("data-ran", "1");
});
