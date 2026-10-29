import { expect, test } from "@playwright/test";
import { runtimeCalls } from "./porthole-host.ts";
import {
  STOPPED,
  composer,
  composerText,
  field,
  fightOver,
  hostActive,
  seen,
  show,
  tell,
  valueOf,
} from "./nested-pages.ts";

/**
 * A nested page that takes the keyboard while the person types in the host's composer, and takes
 * it back on its own blur (P120, after the audit of P111's guard, NG-1), with real input. The
 * person's next key can reach the page before its shell next looks, and turns the shell's
 * activation on as a press would: the host asks the shell to look as it hears the move, and where
 * it sees the pointer over its frames a key with the pointer elsewhere is no press. Whether a key
 * lands first is a race (on the headless shell, 5 of 12 runs without the pointer rule), so this case
 * is no control's probe: `nested-fight`'s is in nested.spec.ts, and `pointer-rule`'s is
 * `shell-host-input`'s there. Untraced, as those cases.
 */

test.use({ trace: "off" });

test.describe("a nested page (P111)", () => {
  test.setTimeout(90_000);

  test("a page that starts taking the keyboard back on its own blur while the person types in the host's composer gets none of the rest, opens no composer, and is stopped (P120)", async ({
    page,
  }) => {
    // The page takes the keyboard on a message, as the person types on, and takes it back
    // whenever it loses it; the first key it gets asks for the host's composer.
    const shown = await show(
      page,
      `addEventListener("message", (event) => {
         if (event.data && event.data.test === "arm") {
           field.addEventListener("blur", () => field.focus());
           addEventListener("blur", () => field.focus());
           field.addEventListener("keydown", open, { once: true });
           field.focus();
           say("armed");
         }
       });`,
    );
    // The person has used the page (the pointer over it) before going to the host's composer.
    await page.mouse.move(field(shown).x, field(shown).y + 150, { steps: 5 });
    await page.mouse.click(composer.x, composer.y);
    await page.keyboard.type("public ", { delay: 70 });
    await tell(page, { test: "arm" });
    const secret = "SECRET-draft-do-not-leak-0123456789";
    await page.keyboard.type(secret, { delay: 70 });
    await fightOver(page);
    const typed = await composerText(page);
    const leaked = valueOf(shown);
    const { taken, errors } = await seen(page);
    if (leaked !== "") {
      // A key reached the page: its ask for the composer has had its answer, or the display was
      // stopped (its page gone, the ask with it).
      await expect
        .poll(
          async () =>
            shown.said.some((each) => each.type === "comments") ||
            (await seen(page)).errors.includes(STOPPED),
        )
        .toBe(true);
    }
    const outcome = `the page read ${JSON.stringify(leaked)}, the composer has ${JSON.stringify(typed)}, ${taken.length} taken back, stopped: ${errors.includes(STOPPED)}`;
    expect(
      leaked.length,
      `probe: the page read a few keys at most (${outcome})`,
    ).toBeLessThanOrEqual(3);
    expect(
      `public ${secret}`.length - typed.length,
      `probe: the composer kept the person's words but a few keys (${outcome})`,
    ).toBeLessThanOrEqual(3);
    expect(
      errors.includes(STOPPED) || (await hostActive(page)) === "host-composer",
      `probe: the page doesn't keep the keyboard: focus is back in the composer, or the display was stopped (${outcome})`,
    ).toBe(true);
    expect(
      taken.length < 3 || errors.includes(STOPPED),
      `probe: a page that kept taking the keyboard was stopped (${outcome})`,
    ).toBe(true);
    expect(
      (await runtimeCalls(page, shown.key)).filter((each) => each.capability === "comments"),
      "probe: the page's ask for the composer, on a key the person meant for the host, reached no handler",
    ).toEqual([]);
  });
});
