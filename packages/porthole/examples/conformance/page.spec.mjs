// The example app's own page, as a person uses it: signed in, its page shown served on its own
// origin, and "Open in a new tab" opening the clean address.
import { expect, test } from "@playwright/test";

const port = Number(process.env.PORTHOLE_EXAMPLE_PORT ?? 8796);
const app = `http://localhost:${port}`;

test("the viewer shows the page on its own origin, and opens it in a new tab", async ({
  page,
  context,
}) => {
  await page.goto(`${app}/login?next=/`);
  await Promise.all([page.waitForURL(`${app}/`), page.click("#sign-in")]);
  const frame = page.frameLocator("#frame iframe");
  await expect(frame.locator("h1")).toHaveText("Hello from an agent");
  const element = await page.locator("#frame iframe").elementHandle();
  const origin = await (await element?.contentFrame())?.evaluate(() => location.origin);
  expect(origin).toBe(`http://a-hello.content.localhost:${port}`);
  const [tab] = await Promise.all([context.waitForEvent("page"), page.click("#open-tab")]);
  await tab.waitForURL(`http://a-hello.content.localhost:${port}/`);
  await expect(tab.locator("h1")).toHaveText("Hello from an agent");
  await expect(page.locator("#problem")).toHaveText("");
});
