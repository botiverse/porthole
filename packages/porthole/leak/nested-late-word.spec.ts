import { expect, test, type Frame, type Page } from "@playwright/test";
import { presets } from "../src/index.ts";
import {
  LATE_WORD_MOVED_ON,
  LATE_WORD_PATCHED_CLOCK,
  LATE_WORD_PATCHED_FOCUS,
} from "./controls.ts";
import { referenceHost, type ReferenceDisplay } from "./reference-host.ts";

/**
 * A `focusMark` a page takes late because it is busy, not because the shell parked it (P137). The
 * name is for the config's `nested*` match, so `chromium-oopif` runs it: this is the one case that
 * needs a frame on a thread of its own, as in a person's browser. These frames aren't nested.
 *
 * On a shared thread the host's page freezes with the frame, so a real click can only come after
 * the word: the first case shows the harm on `chromium-oopif` alone, and passes on the others. The
 * next moves the focus in the task that sends the word, which every engine can show, and it is the
 * probe of the controls (`marker-busy`, `marker-clock`).
 */

const busy = (ms: number, first = "") =>
  `<p id="p1" style="font-size: 18px">Costs <b>fell</b> by three percent.</p>
<input id="field">
<script>
  // Busy on the host's own word, with no change to the DOM: nothing parks what comes next.
  addEventListener("message", (event) => {
    if (event.data !== null && typeof event.data === "object" && event.data.method === "porthole/annotate.track") {
      ${first}
      const end = performance.now() + ${ms};
      while (performance.now() < end) {}
      document.body.dataset.worked = "yes";
    }
  });
</script>`;

const MARK = {
  id: "fell",
  anchor: {
    kind: "text",
    selectors: [{ type: "TextQuoteSelector", exact: "fell" }],
    label: "fell",
  },
  count: 1,
};

/** The page up, its mark found and drawn, the host's button on screen beside the frame. */
async function shown(page: Page, content: string) {
  const display = await referenceHost.launch(page, {
    config: presets.inlineWidget({ capabilities: { annotate: {} } }),
    content,
  });
  const frame = await display.frame();
  await expect(frame.locator("#field")).toBeVisible();
  await display.annotate("show", [MARK]);
  await expect
    .poll(
      async () =>
        (await display.events()).some(
          (event) => event.type === "annotation" && event.detail.type === "anchored",
        ),
      { message: "the frame found the mark" },
    )
    .toBe(true);
  await frame.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(0))),
      ),
  );
  const button = await page.evaluate(() => {
    const next = document.createElement("button");
    next.id = "next";
    next.textContent = "Next";
    next.style.cssText = "position:fixed;right:8px;bottom:8px;width:96px;height:32px;z-index:1";
    // A press gives a button no focus of its own on every engine; a host's own would have it.
    next.addEventListener("click", () => next.focus({ preventScroll: true }));
    document.body.append(next);
    const box = next.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  return { display, frame, button };
}

/** What holds the focus on the host's page: an element's id, or its tag. */
const hostActive = (page: Page) =>
  page.evaluate(() => document.activeElement?.id || document.activeElement?.localName);

/** Whether the page's focus is on the shell's layer: on one of its markers, to the page. */
const onLayer = (frame: Frame) =>
  frame.evaluate(
    () => document.activeElement === document.querySelector("[data-porthole-annotations]"),
  );

/** A host's card closes as P134's does: its field had the focus, and goes, leaving the `<body>`. */
async function closeCard(page: Page) {
  await page.evaluate(() => {
    const card = document.createElement("textarea");
    card.id = "card";
    document.body.append(card);
    card.focus();
  });
  await expect.poll(() => hostActive(page), { message: "the card has the focus" }).toBe("card");
  await page.evaluate(() => document.getElementById("card")?.remove());
  await expect.poll(() => hostActive(page), { message: "the focus is on the body" }).toBe("body");
}

/** Past the page's work, and past the word it took after it. */
async function pastWork(page: Page, frame: Frame) {
  await expect(frame.locator("body")).toHaveAttribute("data-worked", "yes");
  await page.waitForTimeout(300);
}

/** The keyboard is where the person left it, and no marker took it. */
async function stayed(page: Page, frame: Frame) {
  expect(await onLayer(frame), "probe: the late word didn't land").toBe(false);
  expect(await hostActive(page), "probe: the keyboard stayed on the host's button").toBe("next");
}

test("a focusMark a busy page takes late doesn't pull the keyboard off the button the person clicked meanwhile (P137)", async ({
  page,
}) => {
  const { display, frame, button } = await shown(page, busy(1_000));
  await closeCard(page);
  await display.untrackAndFocusMark("fell");
  await page.waitForTimeout(200);
  await page.mouse.click(button.x, button.y);
  expect(await hostActive(page), "the click took the focus").toBe("next");
  await pastWork(page, frame);
  // The host's page alone: on one thread the word comes first, and the click takes the focus on.
  expect(await hostActive(page), "probe: the keyboard stayed on the host's button").toBe("next");
});

test(LATE_WORD_MOVED_ON, async ({ page }) => {
  const { display, frame } = await shown(page, busy(400));
  await closeCard(page);
  await display.untrackAndFocusMark("fell", { moveTo: "next" });
  await pastWork(page, frame);
  await stayed(page, frame);
});

test(LATE_WORD_PATCHED_CLOCK, async ({ page }) => {
  const { display, frame } = await shown(
    page,
    busy(400, "const stopped = Date.now(); Date.now = () => stopped;"),
  );
  await closeCard(page);
  await display.untrackAndFocusMark("fell", { moveTo: "next" });
  await pastWork(page, frame);
  await stayed(page, frame);
});

test(LATE_WORD_PATCHED_FOCUS, async ({ page }) => {
  const { display, frame } = await shown(
    page,
    busy(400, "Document.prototype.hasFocus = () => true;"),
  );
  await closeCard(page);
  await display.untrackAndFocusMark("fell", { moveTo: "next" });
  await pastWork(page, frame);
  await stayed(page, frame);
});

test("a focusMark a busy page takes late lands if the focus is in the frame by then (P137)", async ({
  page,
}) => {
  const { display, frame } = await shown(page, busy(400));
  await display.focus();
  await expect
    .poll(() => frame.evaluate(() => document.hasFocus()), { message: "the host's move landed" })
    .toBe(true);
  await display.untrackAndFocusMark("fell");
  await pastWork(page, frame);
  expect(await onLayer(frame), "probe: it landed on the marker").toBe(true);
  expect(await hostActive(page), "probe: the frame holds the host's page's focus").toBe("iframe");
});

/** A host's close, at once from its `<body>`, a number of times over. */
async function closesLand(page: Page, display: ReferenceDisplay, frame: Frame) {
  for (let close = 0; close < 5; close += 1) {
    await closeCard(page);
    await display.annotate("focusMark", "fell");
    await expect
      .poll(() => hostActive(page), { message: `probe: close ${close} reached the marker` })
      .toBe("iframe");
    expect(await onLayer(frame), `probe: close ${close} is on the marker`).toBe(true);
  }
}

test("a focusMark on a calm page lands from the host's body, close after close (P134, P137)", async ({
  page,
}) => {
  const { display, frame } = await shown(page, busy(0));
  await closesLand(page, display, frame);
});

// Raft's `backToMark`: the first word dropped, 150 ms on the frame's own `focus()` and a second.
// Shorter than that fallback, and longer than a word stays fresh: on either kind of thread the
// first word comes late with the focus on the body, and the second comes with the frame focused.
test("a second focusMark after the host's move into the frame lands, the first having come too late (P135, P137)", async ({
  page,
}) => {
  const { display, frame } = await shown(page, busy(130));
  await closeCard(page);
  await display.untrackAndFocusMark("fell", { fallback: 150 });
  await expect(frame.locator("body")).toHaveAttribute("data-worked", "yes");
  await expect
    .poll(() => onLayer(frame), { message: "probe: the second word landed on the marker" })
    .toBe(true);
  expect(await hostActive(page), "probe: the frame holds the host's page's focus").toBe("iframe");
});
