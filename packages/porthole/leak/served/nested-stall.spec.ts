import { expect, test } from "@playwright/test";
import { button, composer, composerText, show, valueOf } from "./nested-pages.ts";

/**
 * A nested page that holds the thread it shares with its shell (P111, after its review), end to
 * end, with real input. Whether the race shows depends on how an engine orders the input queued
 * behind the stall (on the headless shell, whose frames share the host's thread, it did without
 * the host's stall check; elsewhere Playwright's input waits it out), so this case is no control's
 * probe: `shell-stall`'s is the host's rule itself, in nested.spec.ts. Untraced, as those cases.
 */

test.use({ trace: "off" });

test.describe("a nested page (P111)", () => {
  test.setTimeout(90_000);

  test("a page that stalls its shell from its own click handler gets neither the keyboard nor comments.open after the person went back to the host (P111, after its review)", async ({
    page,
  }) => {
    // The person's press on the page's button runs a handler that holds the thread for 1.5 s
    // (where the page shares it with its shell, WebKit and Firefox, the shell sees its activation
    // only after), then takes the keyboard and asks for the composer 300 ms on. Meanwhile the
    // person went back to the host's composer, and types once the page lets go.
    const shown = await show(
      page,
      `window.onGo = () => {
        const until = performance.now() + 1500;
        while (performance.now() < until) {}
        setTimeout(() => { field.focus(); say("took"); open(); }, 300);
      };`,
    );
    await page.mouse.click(composer.x, composer.y);
    const pressed = page.mouse.click(button(shown).x, button(shown).y);
    await page.waitForTimeout(200);
    await Promise.all([pressed, page.mouse.click(composer.x, composer.y)]);
    await expect
      .poll(() => shown.said.some((each) => each.type === "comments"), { timeout: 10_000 })
      .toBe(true);
    await page.waitForTimeout(800);
    await page.keyboard.type("abcdef", { delay: 60 });
    await page.waitForTimeout(300);
    expect(await composerText(page), "probe: the composer kept the person's words").toBe("abcdef");
    expect(valueOf(shown), "probe: the page got none").toBe("");
    expect(
      shown.said.find((each) => each.type === "comments")?.ok,
      "probe: comments.open was refused",
    ).toBe(false);
  });
});
