import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import type { AppState, FrameSpec } from "./react/app.tsx";

/**
 * The React binding in a real browser (M4): what the first host's widget frame does today, each
 * proven here: streaming through props, a remembered height per display, a cap on frames running
 * with "run again", theme flips, navigation recovery, running again on a new generation, and the
 * default, replaceable confirmation dialog.
 */

interface App {
  render(state: AppState): void;
  log(): { display: string; event: string; detail?: unknown }[];
  answerCustom(accepted: boolean): void;
}

async function open(page: Page, state: AppState): Promise<void> {
  if (!page.url().includes("/leak/react/")) {
    await page.goto("/leak/react/");
    await page.waitForFunction(() => "app" in window);
  }
  await page.evaluate((next) => (window as unknown as { app: App }).app.render(next), state);
}

const frameOf = (page: Page, id: string): FrameLocator =>
  page.locator(`[data-porthole-display="${id}"] iframe`).contentFrame();

const wrapper = (page: Page, id: string) => page.locator(`[data-porthole-display="${id}"]`);

const events = (page: Page, display: string, event: string) =>
  page.evaluate(
    ([each, name]) =>
      (window as unknown as { app: App }).app
        .log()
        .filter((entry) => entry.display === each && entry.event === name),
    [display, event] as const,
  );

const frame = (spec: Partial<FrameSpec> & { displayId: string }): FrameSpec => ({
  title: spec.displayId,
  config: "widget",
  eager: true,
  ...spec,
});

const PROMPT = `<button id="ask">Ask</button><p id="status"></p>
<script>
  document.getElementById("ask").addEventListener("click", () =>
    sendPrompt("Explain why signups doubled in March").then(
      (sent) => (document.getElementById("status").textContent = String(sent)),
      (error) => (document.getElementById("status").textContent = "refused: " + error.message),
    ));
</script>`;

test("content streams through props: drafts inert in the same frame, the whole run once", async ({
  page,
}) => {
  const partial =
    '<div class="row" id="r1">one</div><script>document.body.dataset.ran = "draft"</script>';
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "s", content: partial, partial: true })],
  });
  const inside = frameOf(page, "s");
  await expect(inside.locator("#r1")).toHaveText("one");
  await page
    .locator('[data-porthole-display="s"] iframe')
    .evaluate((element) => element.setAttribute("data-mark", "draft"));
  const more = `${partial}<div class="row" id="r2">two</div>`;
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "s", content: more, partial: true })],
  });
  await expect(inside.locator("#r2")).toHaveText("two");
  expect(await inside.locator("body").getAttribute("data-ran")).toBeNull();
  const whole = `${more}<script>document.body.dataset.ran = String((Number(document.body.dataset.ran) || 0) + 1)</script>`;
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "s", content: whole, partial: false })],
  });
  await expect(inside.locator("body")).toHaveAttribute("data-ran", "1");
  await expect(page.locator('[data-porthole-display="s"] iframe')).toHaveAttribute(
    "data-mark",
    "draft",
  );
});

test("a display keeps its frame when the host renames it (a streamed display's id settles)", async ({
  page,
}) => {
  const code =
    '<p id="x">x</p><button id="ask">Ask</button><p id="status"></p><script>document.body.dataset.ran = String((Number(document.body.dataset.ran) || 0) + 1); document.getElementById("ask").addEventListener("click", () => sendPrompt("hi").then((sent) => (document.getElementById("status").textContent = String(sent))));</script>';
  const draft = frame({
    key: "segment",
    displayId: "call-1",
    title: "Draft",
    config: "prompt",
    content: '<p id="x">x</p>',
    partial: true,
  });
  await open(page, { provider: "default", frames: [draft] });
  await expect(frameOf(page, "call-1").locator("#x")).toHaveText("x");
  await page
    .locator('[data-porthole-display="call-1"] iframe')
    .evaluate((element) => element.setAttribute("data-mark", "draft"));
  // Same React key, the display's own id and title now, and the whole content: the same frame
  // runs it, once; its confirmations name it as the host now does.
  await open(page, {
    provider: "default",
    frames: [{ ...draft, displayId: "dsp-1", title: "Signups", content: code, partial: false }],
  });
  const inside = frameOf(page, "dsp-1");
  await expect(inside.locator("body")).toHaveAttribute("data-ran", "1");
  await expect(page.locator('[data-porthole-display="dsp-1"] iframe')).toHaveAttribute(
    "data-mark",
    "draft",
  );
  await inside.locator("#ask").click();
  await expect(page.locator("dialog[data-porthole-confirm] [data-porthole-source]")).toHaveText(
    "From “Signups”",
  );
  await page.keyboard.press("Escape");
});

test("each display's height is remembered: mounting again starts at its last height", async ({
  page,
}) => {
  const tall = '<div style="height: 300px">tall</div>';
  await open(page, { provider: "default", frames: [frame({ displayId: "h", content: tall })] });
  await expect
    .poll(async () => Math.round((await wrapper(page, "h").boundingBox())?.height ?? 0))
    .toBe(300);
  await open(page, { provider: "default", frames: [] });
  // Sample the new wrapper's height from its first frame on: it never starts shorter.
  await page.evaluate(() => {
    const seen: number[] = [];
    (window as unknown as { seen: number[] }).seen = seen;
    const sample = () => {
      const element = document.querySelector('[data-porthole-display="h"]');
      if (element !== null) {
        seen.push(element.getBoundingClientRect().height);
      }
      if (seen.length < 60) {
        requestAnimationFrame(sample);
      }
    };
    requestAnimationFrame(sample);
  });
  await open(page, { provider: "default", frames: [frame({ displayId: "h", content: tall })] });
  await page.waitForFunction(() => (window as unknown as { seen: number[] }).seen.length >= 60);
  const seen = await page.evaluate(() => (window as unknown as { seen: number[] }).seen);
  expect(Math.min(...seen)).toBeGreaterThanOrEqual(299);
});

test("at most the config's number of frames run; one stopped keeps its height and runs again", async ({
  page,
}) => {
  const content = '<div id="c" style="height: 150px">capped</div>';
  const frames = ["c1", "c2", "c3", "c4", "c5"].map((displayId) =>
    frame({ displayId, config: "capped", content }),
  );
  // Three run and report their heights; then two more come, and the oldest two stop.
  await open(page, { provider: "default", frames: frames.slice(0, 3) });
  for (const id of ["c1", "c2", "c3"]) {
    await expect(frameOf(page, id).locator("#c")).toHaveText("capped");
  }
  await expect
    .poll(async () => (await wrapper(page, "c1").boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(150);
  await open(page, { provider: "default", frames });
  await expect(page.locator("[data-porthole-display] iframe")).toHaveCount(3);
  await expect(wrapper(page, "c1")).toHaveAttribute("data-porthole-state", "stopped");
  await expect(wrapper(page, "c2")).toHaveAttribute("data-porthole-state", "stopped");
  await expect(wrapper(page, "c5")).toHaveAttribute("data-porthole-state", "running");
  // c1 holds the height it had; run it again, and the oldest running stops.
  expect((await wrapper(page, "c1").boundingBox())?.height).toBeGreaterThanOrEqual(150);
  await wrapper(page, "c1").locator("[data-porthole-run]").click();
  await expect(wrapper(page, "c1")).toHaveAttribute("data-porthole-state", "running");
  await expect(frameOf(page, "c1").locator("#c")).toHaveText("capped");
  await expect(page.locator("[data-porthole-display] iframe")).toHaveCount(3);
  await expect(wrapper(page, "c3")).toHaveAttribute("data-porthole-state", "stopped");
});

test("a frame waits until it nears the screen", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "far", eager: false, gapPx: 4_000, content: "<p>far</p>" })],
  });
  await expect(wrapper(page, "far")).toHaveAttribute("data-porthole-state", "waiting");
  await expect(page.locator("iframe")).toHaveCount(0);
  await wrapper(page, "far").scrollIntoViewIfNeeded();
  await expect(frameOf(page, "far").locator("p")).toHaveText("far");
});

test("a theme flip reaches the running frame in place", async ({ page }) => {
  const content = '<p>t</p><script>window.kept = "yes"</script>';
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "t", content, scheme: "light" })],
  });
  const inside = frameOf(page, "t");
  await expect(inside.locator("p")).toHaveText("t");
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "t", content, scheme: "dark" })],
  });
  await expect(inside.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await inside.locator("html").evaluate(() => (window as unknown as { kept?: string }).kept),
  ).toBe("yes");
});

test("the default dialog: the whole text and the display's title, Cancel focused, no early yes", async ({
  page,
}) => {
  await open(page, {
    provider: "default",
    frames: [
      frame({ displayId: "p", title: "Ask about March", config: "prompt", content: PROMPT }),
    ],
  });
  const inside = frameOf(page, "p");
  await inside.locator("#ask").click();
  const dialog = page.locator("dialog[data-porthole-confirm=sendPrompt]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-porthole-detail]")).toHaveText(
    "Explain why signups doubled in March",
  );
  await expect(dialog.locator("[data-porthole-source]")).toHaveText("From “Ask about March”");
  await expect(dialog.locator("[data-porthole-cancel]")).toBeFocused();
  // A press the moment it opens (a click meant for the content) does nothing.
  await dialog.locator("[data-porthole-accept]").click();
  await expect(dialog).toBeVisible();
  // Escape cancels: nothing goes.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(inside.locator("#status")).toHaveText("false");
  expect(await events(page, "p", "sendPrompt")).toEqual([]);
  // A yes, once it is armed, sends it.
  await inside.locator("#ask").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-porthole-accept]")).toHaveAttribute("data-armed", "true");
  await dialog.locator("[data-porthole-accept]").click();
  await expect(inside.locator("#status")).toHaveText("true");
  expect(await events(page, "p", "sendPrompt")).toEqual([
    { display: "p", event: "sendPrompt", detail: "Explain why signups doubled in March" },
  ]);
});

test("a host's own confirm replaces the dialog", async ({ page }) => {
  await open(page, {
    provider: "custom",
    frames: [frame({ displayId: "q", config: "prompt", content: PROMPT })],
  });
  const inside = frameOf(page, "q");
  await inside.locator("#ask").click();
  await expect.poll(async () => (await events(page, "q", "custom-confirm")).length).toBe(1);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { app: App }).app.answerCustom(true));
  await expect(inside.locator("#status")).toHaveText("true");
  expect(await events(page, "q", "sendPrompt")).toHaveLength(1);
});

test("without a provider frames still run, and calls that need a person are refused", async ({
  page,
}) => {
  await open(page, {
    provider: "none",
    frames: [frame({ displayId: "n", config: "prompt", content: PROMPT })],
  });
  const inside = frameOf(page, "n");
  await inside.locator("#ask").click();
  await expect(inside.locator("#status")).toHaveText("false");
  expect(await events(page, "n", "refused")).toEqual([
    { display: "n", event: "refused", detail: "sendPrompt:no-confirm" },
  ]);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("content that navigates its frame away is started again, the host told; past a few, stopped", async ({
  page,
}) => {
  await open(page, {
    provider: "default",
    frames: [
      frame({
        displayId: "nav",
        content:
          '<p>here</p><script>setTimeout(() => (location.href = "https://example.invalid/?d=x"), 100)</script>',
      }),
    ],
  });
  await expect
    .poll(async () => (await events(page, "nav", "navigated")).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(4);
  await expect
    .poll(async () => (await events(page, "nav", "error")).length)
    .toBeGreaterThanOrEqual(1);
});

test("a new generation runs the content again from the start", async ({ page }) => {
  const content =
    '<p id="n"></p><script>document.getElementById("n").textContent = String(Math.random())</script>';
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "g", content, generation: 1 })],
  });
  const first = await frameOf(page, "g").locator("#n").textContent();
  expect(first).not.toBe("");
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "g", content, generation: 2 })],
  });
  await expect.poll(() => frameOf(page, "g").locator("#n").textContent()).not.toBe(first);
});

test("a whole page shows through the artifact config", async ({ page }) => {
  await open(page, {
    provider: "default",
    frames: [
      frame({
        displayId: "a",
        config: "artifact",
        content:
          "<!doctype html><html><head><title>Report</title></head><body><h1>Report</h1></body></html>",
      }),
    ],
  });
  await expect(frameOf(page, "a").locator("h1")).toHaveText("Report");
});
