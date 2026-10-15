import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { embedderCsp, presets, type AnnotationMark } from "../src/index.ts";
import type { AppState, FrameSpec, ViewsSpec } from "./react/app.tsx";

/**
 * The React binding in a real browser (M4): what the first host's widget frame does today, each
 * proven here: streaming through props, a remembered height per display, a cap on frames running
 * with "run again", theme flips, navigation recovery, running again on a new generation, and the
 * default, replaceable confirmation dialog.
 */

interface App {
  renderViews(spec: ViewsSpec): void;
  render(state: AppState): void;
  log(): { display: string; event: string; detail?: unknown }[];
  answerCustom(accepted: boolean): void;
  restyle(value: string): void;
  restyleLater(value: string): void;
}

/** Samples the wrapper of `id`'s height every frame for 60 frames, from its first. */
async function sampleHeights(page: Page, id: string): Promise<void> {
  await page.evaluate((each) => {
    const seen: number[] = [];
    (window as unknown as { seen: number[] }).seen = seen;
    const sample = () => {
      const element = document.querySelector(`[data-porthole-display="${each}"]`);
      if (element !== null) {
        seen.push(element.getBoundingClientRect().height);
      }
      if (seen.length < 60) {
        requestAnimationFrame(sample);
      }
    };
    requestAnimationFrame(sample);
  }, id);
}

async function lowestSampled(page: Page): Promise<number> {
  await page.waitForFunction(() => (window as unknown as { seen: number[] }).seen.length >= 60);
  return Math.min(...(await page.evaluate(() => (window as unknown as { seen: number[] }).seen)));
}

const textVariable = (inside: FrameLocator) =>
  inside
    .locator("html")
    .evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--color-text-primary").trim(),
    );

async function open(page: Page, state: AppState): Promise<void> {
  if (!page.url().includes("/leak/react/")) {
    // The page frames its url-mode app on this server under another name (another site).
    const port = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:8797").port;
    await page.goto(
      `/leak/react/?csp=${encodeURIComponent(embedderCsp([presets.url({ contentOrigins: [`http://localhost:${port}`] })]))}`,
    );
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
  // The frame element and its window, kept: a frame made again would have the right colors too.
  await page.evaluate(() => {
    const element = document.querySelector<HTMLIFrameElement>("[data-porthole-display='t'] iframe");
    (window as unknown as { first: unknown }).first = [element, element?.contentWindow];
  });
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "t", content, scheme: "dark" })],
  });
  await expect(inside.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await inside.locator("html").evaluate(() => (window as unknown as { kept?: string }).kept),
  ).toBe("yes");
  expect(
    await page.evaluate(() => {
      const [element, view] = (window as unknown as { first: [HTMLIFrameElement, Window] }).first;
      return element.isConnected && element.contentWindow === view;
    }),
  ).toBe(true);
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
  // To about:blank, which no embedding page's frame-src governs: every engine replaces the
  // frame's document (a blocked navigation keeps it on Firefox, measured).
  await open(page, {
    provider: "default",
    frames: [
      frame({
        displayId: "nav",
        content:
          '<p>here</p><script>setTimeout(() => (location.href = "about:blank"), 100)</script>',
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

test("a url-mode frame shows without a handshake, and says it loaded", async ({ page }) => {
  await open(page, { provider: "default", frames: [frame({ displayId: "u", config: "url" })] });
  await expect(frameOf(page, "u").locator("#app")).toHaveText("A running app.");
  await expect(wrapper(page, "u").locator("[data-porthole-ready]")).toHaveAttribute(
    "data-porthole-ready",
    "true",
  );
  // It fills the box the host gave it (an app reports no size).
  expect(
    Math.round(
      (await page.locator('[data-porthole-display="u"] iframe').boundingBox())?.height ?? 0,
    ),
  ).toBe(400);
  await expect
    .poll(() => events(page, "u", "outcome"))
    .toEqual([{ display: "u", event: "outcome", detail: { state: "loaded" } }]);
});

test("url mode's sandbox: popups only when the host opts in; never top navigation", async ({
  page,
}) => {
  const popups: string[] = [];
  page.on("popup", (popup) => popups.push(popup.url()));
  await open(page, { provider: "default", frames: [frame({ displayId: "u1", config: "url" })] });
  const before = page.url();
  const closed = frameOf(page, "u1");
  await closed.locator("#popup").click();
  await expect(closed.locator("body")).toHaveAttribute("data-popup", "false");
  await closed.locator("#top").click();
  await expect(closed.locator("body")).toHaveAttribute("data-top", "refused");
  await open(page, {
    provider: "default",
    frames: [
      frame({ displayId: "u1", config: "url" }),
      frame({ displayId: "u2", config: "urlPopups" }),
    ],
  });
  const open2 = frameOf(page, "u2");
  await expect(open2.locator("#app")).toHaveText("A running app.");
  const opening = page.waitForEvent("popup");
  await open2.locator("#popup").click();
  await opening;
  await open2.locator("#top").click();
  await expect(open2.locator("body")).toHaveAttribute("data-top", "refused");
  expect(page.url()).toBe(before);
  expect(popups).toHaveLength(1);
});

test("heights follow a display renamed while it runs, and other ids it had", async ({ page }) => {
  const tall = '<div style="height: 300px">tall</div>';
  await open(page, {
    provider: "default",
    frames: [frame({ key: "seg", displayId: "call-9", content: tall })],
  });
  await expect
    .poll(async () => Math.round((await wrapper(page, "call-9").boundingBox())?.height ?? 0))
    .toBe(300);
  await open(page, {
    provider: "default",
    frames: [frame({ key: "seg", displayId: "dsp-9", content: tall })],
  });
  await expect(wrapper(page, "dsp-9")).toBeVisible();
  // Mounted again under its new id (another key): it starts at its height.
  await open(page, { provider: "default", frames: [] });
  await sampleHeights(page, "dsp-9");
  await open(page, {
    provider: "default",
    frames: [frame({ key: "final", displayId: "dsp-9", content: tall })],
  });
  expect(await lowestSampled(page)).toBeGreaterThanOrEqual(299);
  // A host that knows the old id passes it: the height is found under it.
  await open(page, { provider: "default", frames: [] });
  await sampleHeights(page, "dsp-10");
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "dsp-10", aliases: ["call-9"], content: tall })],
  });
  expect(await lowestSampled(page)).toBeGreaterThanOrEqual(299);
});

test("a theme flip reads the host's values after a host that restyles on its next frame has", async ({
  page,
}) => {
  await open(page, { provider: "default", frames: [] });
  await page.evaluate(() => (window as unknown as { app: App }).app.restyle("rgb(10, 20, 30)"));
  const content = "<p>t</p>";
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "th", content, scheme: "light" })],
  });
  const inside = frameOf(page, "th");
  await expect.poll(() => textVariable(inside)).toBe("rgb(10, 20, 30)");
  // The flip and the host's restyle on its next frame, as a host's theme provider does it.
  await page.evaluate(
    ([state]) => {
      const app = (window as unknown as { app: App }).app;
      app.render(state);
      app.restyleLater("rgb(200, 210, 220)");
    },
    [
      { provider: "default", frames: [frame({ displayId: "th", content, scheme: "dark" })] },
    ] as const,
  );
  await expect.poll(() => textVariable(inside)).toBe("rgb(200, 210, 220)");
  await expect(inside.locator("html")).toHaveAttribute("data-theme", "dark");
  // Values that change without a flip: a new themeKey reads them again.
  await page.evaluate(() => (window as unknown as { app: App }).app.restyle("rgb(1, 2, 3)"));
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "th", content, scheme: "dark", themeKey: 1 })],
  });
  await expect.poll(() => textVariable(inside)).toBe("rgb(1, 2, 3)");
});

test("the default dialog's yes runs the effect inside its own click: a window opens", async ({
  page,
  browserName,
}) => {
  const target = `${new URL(page.url() === "about:blank" ? "http://127.0.0.1:8797" : page.url()).origin}/leak/host/app.html`;
  const content = `<a id="l" href="${target}">open</a>`;
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "o", config: "prompt", content })],
  });
  await frameOf(page, "o").locator("#l").click();
  const dialog = page.locator("dialog[data-porthole-confirm=openLink]");
  await expect(dialog.locator("[data-porthole-accept]")).toHaveAttribute("data-armed", "true");
  const opening = page.waitForEvent("popup");
  await dialog.locator("[data-porthole-accept]").click();
  await opening;
  await expect
    .poll(() => events(page, "o", "openLink"))
    .toEqual([{ display: "o", event: "openLink", detail: { url: target, opened: true } }]);
  // Measured: a yes that comes later, out of any click (no proceed), opens no window on some engines.
  await open(page, {
    provider: "late",
    frames: [frame({ displayId: "o2", config: "prompt", content })],
  });
  await frameOf(page, "o2").locator("#l").click();
  await expect
    .poll(async () => (await events(page, "o2", "openLink")).length, { timeout: 5_000 })
    .toBe(1);
  const late = (await events(page, "o2", "openLink"))[0]?.detail as { opened: boolean };
  test.info().annotations.push({
    type: "measured",
    description: `${browserName}: a yes given 1.5 s later, without proceed, ${late.opened ? "still opens" : "opens no"} window`,
  });
});

/** What is on the clipboard: pasted into a text area on the host's page. */
async function pasted(page: Page): Promise<string> {
  await page.evaluate(() => {
    let area = document.getElementById("paste-oracle") as HTMLTextAreaElement | null;
    if (area === null) {
      area = document.createElement("textarea");
      area.id = "paste-oracle";
      document.body.prepend(area);
    }
    area.value = "";
  });
  await page.locator("#paste-oracle").click();
  await page.keyboard.press("ControlOrMeta+V");
  await page.waitForTimeout(200);
  return page.evaluate(
    () => (document.getElementById("paste-oracle") as HTMLTextAreaElement).value,
  );
}

const LONG_COPY = Array.from(
  { length: 8 },
  (_, line) => `line ${line + 1}: ${"x".repeat(60)}`,
).join("\n");

const COPY = `<button id="short">Copy the command</button><button id="long">Copy the log</button>
<script>
  document.getElementById("short").addEventListener("click", () => copyText("npm test -- --run"));
  document.getElementById("long").addEventListener("click", () => copyText(${JSON.stringify(LONG_COPY)}));
</script>`;

test("the default copy toast: a copy button's text goes on the clipboard, and the person sees it, clipped", async ({
  page,
}) => {
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "copy", title: "Build steps", config: "copy", content: COPY })],
  });
  const inside = frameOf(page, "copy");
  await inside.locator("#short").click();
  const toast = page.locator("[data-porthole-toast]");
  await expect(toast).toHaveAttribute("data-porthole-copied", "true");
  await expect(toast.locator("[data-porthole-copied-text]")).toHaveText("npm test -- --run");
  await expect(toast.locator("[data-porthole-source]")).toHaveText("from “Build steps”");
  expect(await pasted(page)).toBe("npm test -- --run");

  await inside.locator("#long").click();
  await expect(toast.locator("[data-porthole-copied-text]")).toContainText("line 4");
  await expect(toast.locator("[data-porthole-copied-text]")).not.toContainText("line 5");
  await expect(toast.locator("[data-porthole-length]")).toHaveText(
    `${LONG_COPY.length.toLocaleString("en-US")} characters in all`,
  );
  expect(await pasted(page)).toBe(LONG_COPY);
});

test("when the host's page couldn't write, the toast shows the text and the person's own Copy writes it", async ({
  page,
}) => {
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "copy", title: "Build steps", config: "copy", content: COPY })],
  });
  await page.evaluate(() => {
    const clipboard = navigator.clipboard as Clipboard & { writeText: Clipboard["writeText"] };
    const writeText = clipboard.writeText.bind(clipboard);
    const execCommand = document.execCommand.bind(document);
    clipboard.writeText = () => Promise.reject(new Error("not now"));
    document.execCommand = () => false;
    (window as unknown as { restore: () => void }).restore = () => {
      clipboard.writeText = writeText;
      document.execCommand = execCommand;
    };
  });
  await frameOf(page, "copy").locator("#short").click();
  const toast = page.locator("[data-porthole-toast]");
  await expect(toast).toHaveAttribute("data-porthole-copied", "false");
  await expect(toast.locator("[data-porthole-copied-text]")).toHaveText("npm test -- --run");
  await page.evaluate(() => (window as unknown as { restore: () => void }).restore());
  await toast.locator("[data-porthole-copy]").click();
  await expect(toast).toHaveAttribute("data-porthole-copied", "true");
  expect(await pasted(page)).toBe("npm test -- --run");
});

const NOTES = `<!doctype html><html><head><title>Notes</title></head><body>
<h2 id="revenue">Revenue grew 12%</h2><p>Costs fell by 3%.</p></body></html>`;

test("annotations through props: picking reports to onAnnotation; marks and focus follow their props", async ({
  page,
}) => {
  const notes = (more: Partial<FrameSpec>) =>
    frame({ displayId: "notes", title: "Notes", config: "notes", content: NOTES, ...more });
  await open(page, {
    provider: "default",
    frames: [notes({ annotating: { elements: true, text: false } })],
  });
  const inside = frameOf(page, "notes");
  await expect(inside.locator("#revenue")).toBeVisible();
  await expect
    .poll(async () => {
      await inside.locator("#revenue").click();
      return (await events(page, "notes", "annotation")).length;
    })
    .toBeGreaterThan(0);
  const [picked] = (await events(page, "notes", "annotation")).map(
    (entry) => entry.detail as { type: string; anchor: AnnotationMark["anchor"] },
  );
  expect(picked?.type).toBe("selected");
  const anchor = picked?.anchor as AnnotationMark["anchor"];
  await open(page, {
    provider: "default",
    frames: [
      notes({ annotating: null, annotations: [{ id: "c1", anchor }], focusedAnnotation: "c1" }),
    ],
  });
  await expect
    .poll(async () =>
      (await events(page, "notes", "annotation")).some(
        (entry) =>
          (entry.detail as { type: string; results?: { id: string; state: string }[] }).type ===
            "anchored" &&
          (entry.detail as { results: { id: string; state: string }[] }).results.some(
            (result) => result.id === "c1" && result.state === "attached",
          ),
      ),
    )
    .toBe(true);
});

test("a host's inline objects (config, instance, hostInfo, locator) don't start a running frame again", async ({
  page,
}) => {
  const state = (content: string): AppState => ({
    provider: "default",
    frames: [frame({ displayId: "inline", inline: true, content, partial: true })],
  });
  await open(page, state("<p id='v'>one</p>"));
  const inside = frameOf(page, "inline");
  await expect(inside.locator("#v")).toHaveText("one");
  for (let round = 0; round < 3; round += 1) {
    await open(page, state("<p id='v'>one</p>"));
  }
  await open(page, state("<p id='v'>one</p><p id='w'>two</p>"));
  await expect(inside.locator("#w")).toHaveText("two");
  await page.waitForTimeout(300);
  expect(await events(page, "inline", "initialized")).toHaveLength(1);
});

test("the content's errors go to onContentError, the host's to onHostError, each with its source on onError", async ({
  page,
  browserName,
}) => {
  await open(page, {
    provider: "default",
    frames: [
      frame({
        displayId: "broken",
        content: '<p>x</p><script>throw new Error("widget broke")</script>',
      }),
      frame({ displayId: "unserved", config: "unserved", content: "<p>y</p>" }),
    ],
  });
  await expect
    .poll(async () => (await events(page, "broken", "content-error")).length)
    .toBeGreaterThan(0);
  // Measured (P055): WebKit mutes an opaque frame's script errors to "Script error.".
  expect(String((await events(page, "broken", "content-error"))[0]?.detail)).toContain(
    browserName === "webkit" ? "Script error." : "widget broke",
  );
  expect(await events(page, "broken", "host-error")).toEqual([]);
  expect((await events(page, "broken", "error"))[0]?.detail).toMatchObject({ source: "content" });

  await expect
    .poll(async () => (await events(page, "unserved", "host-error")).length)
    .toBeGreaterThan(0);
  expect((await events(page, "unserved", "host-error"))[0]?.detail).toMatchObject({
    kind: "mount",
    message: expect.stringContaining("callTool") as unknown as string,
  });
  expect(await events(page, "unserved", "content-error")).toEqual([]);
  expect((await events(page, "unserved", "error"))[0]?.detail).toMatchObject({ source: "host" });
});

/** Content that reads data and shows why it couldn't (P080). */
const READS = `<p id="why">waiting</p>
<script>
  readData("app://issues").then(
    () => (document.getElementById("why").textContent = "read"),
    (error) => (document.getElementById("why").textContent = error.code + ": " + error.message),
  );
</script>`;

test("consent as a Refused, the frame's or the provider's: no data handlers, the content told why, nothing started again (P080)", async ({
  page,
}) => {
  const state = (): AppState => ({
    provider: "default",
    consent: "refused",
    frames: [
      frame({ displayId: "own", config: "live", consent: "refused", content: READS }),
      frame({ displayId: "provider's", config: "live", content: READS }),
    ],
  });
  await open(page, state());
  for (const id of ["own", "provider's"]) {
    await expect(frameOf(page, id).locator("#why")).toHaveText(
      "not_allowed: Live data shows on the dashboard.",
    );
    expect(await events(page, id, "host-error")).toEqual([]);
    expect(await events(page, id, "refused")).toEqual([
      { display: id, event: "refused", detail: "readData:denied" },
    ]);
  }
  // A new Refused on every render, the same by value: no frame starts again.
  for (let round = 0; round < 3; round += 1) {
    await open(page, state());
  }
  await page.waitForTimeout(300);
  expect(await events(page, "own", "initialized")).toHaveLength(1);
  expect(await events(page, "provider's", "initialized")).toHaveLength(1);
});

const TALL = `<!doctype html><html><head><title>Tall</title></head><body>
<h1 id="top">Top</h1><div style="height: 2000px">a long page</div><p id="end">End</p></body></html>`;

test("fill: an artifact fills its box and scrolls inside, without the host's CSS", async ({
  page,
}) => {
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "full", config: "artifact", content: TALL, fill: true })],
  });
  const inside = frameOf(page, "full");
  await expect(inside.locator("#end")).toBeAttached();
  await page.waitForTimeout(500);
  const box = await page.locator('[data-porthole-display="full"] iframe').boundingBox();
  expect(Math.round(box?.height ?? 0)).toBe(300);
  const scrolls = await inside
    .locator("html")
    .evaluate(
      () =>
        document.scrollingElement !== null &&
        document.scrollingElement.scrollHeight > window.innerHeight,
    );
  expect(scrolls).toBe(true);
  // Without fill, the same page grows to its config's cap instead.
  await open(page, {
    provider: "default",
    frames: [frame({ displayId: "grown", config: "artifact", content: TALL })],
  });
  await expect
    .poll(async () =>
      Math.round(
        (await page.locator('[data-porthole-display="grown"] iframe').boundingBox())?.height ?? 0,
      ),
    )
    .toBe(720);
});

test("a mounting frame hears no theme event; a flip, exactly one (#3)", async ({ page }) => {
  const content = `<p id="t">themed</p><script>window.flips = []; addEventListener("porthole:theme", (event) => window.flips.push(event.detail.theme));</script>`;
  const state = (scheme: "light" | "dark", themeKey?: number): AppState => ({
    provider: "default",
    frames: [
      frame({
        displayId: "themed",
        content,
        scheme,
        ...(themeKey === undefined ? {} : { themeKey }),
      }),
    ],
  });
  await open(page, state("light", 1));
  const inside = frameOf(page, "themed");
  await expect(inside.locator("#t")).toHaveText("themed");
  const flips = () =>
    inside.locator("html").evaluate(() => (window as unknown as { flips: string[] }).flips);
  await page.waitForTimeout(400);
  expect(await flips(), "no event at mount").toEqual([]);
  await open(page, state("light", 1));
  await page.waitForTimeout(300);
  expect(await flips(), "no event for a render that changes nothing").toEqual([]);
  await open(page, state("dark", 1));
  await expect.poll(flips).toEqual(["dark"]);
});

// ─── The host kit's client side (P072) ───────────────────────────────────

async function views(page: Page, spec: ViewsSpec): Promise<void> {
  await open(page, { frames: [], provider: "none" });
  await page.evaluate((next) => (window as unknown as { app: App }).app.renderViews(next), spec);
}

test("a view by kind: opaque with its content while frames aren't served; a url kind waits for them", async ({
  page,
}) => {
  await views(page, {
    served: false,
    frames: "ok",
    views: [
      { id: "w", display: "widget", content: '<p id="x">opaque</p>' },
      { id: "p", display: "preview" },
    ],
  });
  await expect(page.locator('[data-view="w"] iframe').contentFrame().locator("#x")).toHaveText(
    "opaque",
  );
  await expect(page.locator('[data-view="p"] [data-porthole-fallback]')).toContainText(
    "This can't be shown now",
  );
});

test("a view served: located through the client; its fallback, worded, when the server refuses", async ({
  page,
}) => {
  await views(page, { served: true, frames: "ok", views: [{ id: "p", display: "preview" }] });
  await expect(
    page.locator('[data-view="p"] iframe').contentFrame().locator("html"),
  ).toHaveAttribute("data-app", "ready");
  await views(page, { served: true, frames: "fail", views: [{ id: "q", display: "preview" }] });
  await expect(page.locator('[data-view="q"] [data-porthole-fallback]')).toContainText(
    "This couldn't be shown",
  );
});

test("the provider's scheme flip and new themeKey re-theme every frame in place, opaque, served and url (#9)", async ({
  page,
}) => {
  const rerender = (next: ViewsSpec) =>
    page.evaluate((each) => (window as unknown as { app: App }).app.renderViews(each), next);
  /** Each frame element and its window, kept to compare; and a mark inside each frame's page. */
  const mark = async () => {
    await page.evaluate(() => {
      const frames = [...document.querySelectorAll("iframe")];
      (window as unknown as { marked: unknown }).marked = frames.map((each) => [
        each,
        each.contentWindow,
      ]);
    });
    for (const inner of page.frames().filter((each) => each !== page.mainFrame())) {
      await inner.evaluate(() => {
        (window as unknown as { kept?: string }).kept = "yes";
      });
    }
  };
  const same = async () => {
    const kept = await page.evaluate(() => {
      const marked = (window as unknown as { marked: [HTMLIFrameElement, Window | null][] }).marked;
      return (
        marked.length > 0 &&
        marked.every(([each, view]) => each.isConnected && each.contentWindow === view) &&
        document.querySelectorAll("iframe").length === marked.length
      );
    });
    const inside = await Promise.all(
      page
        .frames()
        .filter((each) => each !== page.mainFrame())
        .map((each) => each.evaluate(() => (window as unknown as { kept?: string }).kept)),
    );
    return kept && inside.length > 0 && inside.every((each) => each === "yes");
  };
  for (const served of [false, true]) {
    const spec = (scheme: "light" | "dark", themeKey: number): ViewsSpec => ({
      served,
      frames: "ok",
      scheme,
      themeKey,
      views: served
        ? [
            { id: "s", display: "widget" },
            { id: "p", display: "preview" },
          ]
        : [{ id: "o", display: "widget", content: '<p id="x">opaque</p>' }],
    });
    await views(page, spec("light", 0));
    if (served) {
      await expect(
        page.locator('[data-view="p"] iframe').contentFrame().locator("html"),
      ).toHaveAttribute("data-app", "ready");
      await expect(page.locator('[data-view="s"] [data-porthole-ready="true"]')).toBeAttached();
    } else {
      await expect(page.locator('[data-view="o"] iframe').contentFrame().locator("#x")).toHaveText(
        "opaque",
      );
    }
    await mark();
    expect(await same()).toBe(true);
    await rerender(spec("dark", 0));
    // Re-themed: the shell's own document says dark, opaque or served.
    await expect(
      page
        .locator(`[data-view="${served ? "s" : "o"}"] iframe`)
        .contentFrame()
        .locator("html"),
    ).toHaveAttribute("data-theme", "dark");
    await page.waitForTimeout(300);
    expect(await same(), `${served ? "served" : "opaque"}: the same frames after a flip`).toBe(
      true,
    );
    await rerender(spec("dark", 1));
    await page.waitForTimeout(300);
    expect(await same(), `${served ? "served" : "opaque"}: the same frames after a themeKey`).toBe(
      true,
    );
  }
});

test("renderConfirm: the app's own dialog asks; its yes runs the call from its click", async ({
  page,
}) => {
  await views(page, {
    served: false,
    frames: "ok",
    renderConfirm: true,
    views: [{ id: "w", display: "widget", content: PROMPT }],
  });
  await page.locator('[data-view="w"] iframe').contentFrame().locator("#ask").click();
  await expect(page.locator("#app-dialog")).toContainText("sendPrompt from w");
  await page.click("#app-yes");
  await expect(page.locator('[data-view="w"] iframe').contentFrame().locator("#status")).toHaveText(
    "true",
  );
  expect(await events(page, "provider", "sendPrompt")).toHaveLength(1);
});

/** PROMPT, and a record of everything the frame's page could read of the host's naming. */
const RECORDING = `${PROMPT}<script>
  window.seen = [];
  addEventListener("message", (event) => {
    try { window.seen.push(JSON.stringify(event.data)); } catch (_) { window.seen.push("?"); }
  });
</script>`;

test("renderConfirm names the instance the host gave, served or opaque; an opaque frame never gets it (P076, P077)", async ({
  page,
}) => {
  for (const served of [true, false]) {
    await views(page, {
      served,
      frames: "ok",
      renderConfirm: true,
      views: [{ id: "w", display: "widget", content: RECORDING }],
    });
    const element = page.locator('[data-view="w"] iframe');
    const inside = element.contentFrame();
    await inside.locator("#ask").click();
    await expect(page.locator("#app-dialog")).toContainText("sendPrompt from w");
    await expect(page.locator("#app-instance")).toHaveText("shell on w-k9q2");
    await page.click("#app-no");
    await expect(inside.locator("#status")).toHaveText("false");
    if (!served) {
      // Host-side only: not in the frame's attributes, its document, its address or name, nor in
      // any message the frame's page heard.
      const attributes = await element.evaluate((iframe) =>
        [...iframe.attributes].map((each) => `${each.name}=${each.value}`).join(" "),
      );
      expect(attributes).not.toContain("k9q2");
      const read = await inside
        .locator("html")
        .evaluate(
          () =>
            `${document.documentElement.outerHTML} ${location.href} ${window.name} ${JSON.stringify((window as unknown as { seen: string[] }).seen)}`,
        );
      expect(read).toContain("sendPrompt");
      expect(read).not.toContain("k9q2");
    }
  }
});

test("renderConfirm's redirect: the call doesn't go, and it never mutes the display (P074)", async ({
  page,
}) => {
  await views(page, {
    served: false,
    frames: "ok",
    renderConfirm: true,
    views: [{ id: "w", display: "widget", content: PROMPT }],
  });
  const inside = page.locator('[data-view="w"] iframe').contentFrame();
  // More times than the mute's limit: each is asked, none mutes.
  for (let round = 0; round < 4; round += 1) {
    await inside.locator("#ask").click();
    await expect(page.locator("#app-dialog")).toBeVisible();
    await page.click("#app-edit");
    // The call didn't go: sendPrompt answers false, as for a no.
    await expect(inside.locator("#status")).toHaveText("false");
    await inside.locator("#status").evaluate((element) => (element.textContent = ""));
  }
  expect(await events(page, "provider", "sendPrompt")).toHaveLength(0);
});
