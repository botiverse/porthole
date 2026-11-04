import { expect, test, type Frame, type Page } from "@playwright/test";
import { presets, type FindResult } from "../src/index.ts";
import { referenceHost, type ReferenceDisplay } from "./reference-host.ts";

/**
 * Find in page (P131) in real frames, on Chromium, WebKit and Firefox: the host's query found and
 * highlighted in the shell's own layer, the current match moved and brought into view, found again
 * as the content changes, the find shortcut taken only where the host draws its own bar, and a
 * hostile page that says the shortcut was pressed while the person types beside it.
 */

const config = () => presets.artifact({ capabilities: { find: {} }, layout: { kind: "fill" } });

/** Thirty lines of 40 px, "revenue" in eight places the person can see and two they can't. */
const lines = Array.from({ length: 30 }, (_, i) => {
  const line =
    i % 5 === 0 ? `<p id="p${i}">Line ${i}: revenue grew</p>` : `<p>Line ${i}: costs held</p>`;
  return i === 12
    ? `${line}<div id="box"><p>one</p><p>two</p><p>three</p><p id="inner">inner Revenue</p></div>`
    : line;
}).join("\n");
const PAGE = `<style>body{margin:0;font:16px/40px sans-serif}p{margin:0;height:40px}#box{height:80px;overflow:auto}</style>
${lines}
<div style="display: none">hidden revenue</div>
<script>window.word = "revenue";</script>
<p id="last">last REVENUE</p>`;

const events = async (display: ReferenceDisplay) => display.events();
const requested = async (display: ReferenceDisplay): Promise<number> =>
  (await events(display)).filter((event) => event.type === "findRequested").length;
const updates = async (display: ReferenceDisplay): Promise<FindResult[]> =>
  (await events(display)).flatMap((event) => (event.type === "findUpdated" ? [event.detail] : []));

/** The pixels over `selector` in the frame, as the person sees them (the shell's layer included). */
async function look(page: Page, frame: Frame, selector: string): Promise<Buffer> {
  const box = await frame.locator(selector).boundingBox();
  if (box === null) {
    throw new Error(`${selector} isn't on screen`);
  }
  return page.screenshot({ clip: box, animations: "disabled" });
}

/** Whether `selector` lies wholly within the frame's viewport, and within `within` if given. */
const inView = (frame: Frame, selector: string, within?: string) =>
  frame.evaluate(
    ([where, box]) => {
      const rect = document.querySelector(where)?.getBoundingClientRect();
      if (rect === undefined) {
        return false;
      }
      const inWindow = rect.top >= 0 && rect.bottom <= document.documentElement.clientHeight;
      if (box === undefined) {
        return inWindow;
      }
      const outer = document.querySelector(box)?.getBoundingClientRect();
      return (
        inWindow && outer !== undefined && rect.top >= outer.top && rect.bottom <= outer.bottom
      );
    },
    [selector, within] as const,
  );

test("find: every match the person can see highlighted in the shell's closed layer; next and previous move the current one into view; an empty query clears (P131)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: config(),
    heightPx: 300,
    content: PAGE,
  });
  const frame = await display.frame();
  await expect(frame.locator("#last")).toBeAttached();
  const before = await look(page, frame, "#p0");

  const found = await display.find("query", "revenue");
  // Not the hidden line, not the script's: eight, the first current.
  expect(found).toMatchObject({ total: 8, active: 1 });
  expect(found).not.toHaveProperty("capped");
  expect(
    await frame.evaluate(() => {
      const layer = document.querySelector("[data-porthole-find]");
      return layer !== null && layer.shadowRoot === null;
    }),
    "the shell's own layer, its shadow root closed",
  ).toBe(true);
  await expect
    .poll(async () => (await look(page, frame, "#p0")).equals(before), {
      message: "the first match is highlighted",
    })
    .toBe(false);

  // Next: line 5, then line 10, out of the first screen, brought into view.
  expect(await display.find("query", "revenue", { direction: "next" })).toMatchObject({
    total: 8,
    active: 2,
  });
  expect(await display.find("query", "revenue", { direction: "next" })).toMatchObject({
    active: 3,
  });
  expect(await inView(frame, "#p10"), "line 10 brought into view").toBe(true);
  // The one in a box that scrolls: the box scrolls to it, and the frame to the box.
  expect(await display.find("query", "revenue", { direction: "next" })).toMatchObject({
    active: 4,
  });
  expect(
    await frame.evaluate(() => document.getElementById("box")?.scrollTop ?? 0),
  ).toBeGreaterThan(0);
  expect(await inView(frame, "#inner", "#box"), "the box's line brought into view").toBe(true);
  // Its box, in the frame's viewport, for a host whose frame doesn't scroll itself.
  const current = await display.find("query", "revenue");
  expect(current).toMatchObject({ total: 8, active: 4 });
  const rect = (current as FindResult).rect;
  expect(rect?.height).toBeGreaterThan(0);
  expect((rect?.y ?? -1) >= 0 && (rect?.y ?? 0) + (rect?.height ?? 0) <= 300).toBe(true);

  // Previous, past the first: the last one.
  for (const active of [3, 2, 1, 8]) {
    expect(await display.find("query", "revenue", { direction: "prev" })).toMatchObject({ active });
  }
  expect(await inView(frame, "#last")).toBe(true);
  // Case, where asked.
  expect(await display.find("query", "REVENUE", { caseSensitive: true })).toMatchObject({
    total: 1,
    active: 1,
  });
  expect(await display.find("query", "growth")).toEqual({ total: 0, active: 0 });

  // Cleared: back at the top, the page looks as it did.
  await display.find("query", "revenue");
  expect(await display.find("query", "   ")).toEqual({ total: 0, active: 0 });
  await frame.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(async () => (await look(page, frame, "#p0")).equals(before), {
      message: "no highlight is left",
    })
    .toBe(true);
  await display.find("query", "revenue");
  await display.find("clear");
  await frame.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(async () => (await look(page, frame, "#p0")).equals(before), {
      message: "clear leaves no highlight",
    })
    .toBe(true);
});

test("find: a change of the content is found again and told as an update; a message from the page itself is no query (P131)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: config(),
    heightPx: 300,
    content: PAGE,
  });
  const frame = await display.frame();
  await expect(frame.locator("#last")).toBeAttached();
  expect(await display.find("query", "revenue")).toMatchObject({ total: 8, active: 1 });
  await frame.evaluate(() => {
    for (let i = 0; i < 2; i += 1) {
      const line = document.createElement("p");
      line.textContent = "more revenue";
      document.body.append(line);
    }
  });
  await expect
    .poll(async () => (await updates(display)).at(-1), { message: "an update with the new count" })
    .toEqual({ total: 10, active: 1 });

  // The shell takes a query only from its parent: one the page posts to its own window does
  // nothing (no answer goes to the host, no highlight changes).
  const told = (await updates(display)).length;
  await frame.evaluate(() =>
    window.postMessage(
      { jsonrpc: "2.0", id: "x", method: "porthole/find.query", params: { query: "costs" } },
      "*",
    ),
  );
  await page.waitForTimeout(1_500);
  expect(await display.find("query", "revenue")).toMatchObject({ total: 10, active: 1 });
  expect((await updates(display)).length).toBe(told);
});

test("the find shortcut: the browser's own find until the host takes it, then the host's; a page that takes the key keeps it (P131)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: config(),
    heightPx: 300,
    content: `<p>Notes on revenue</p><input id="field" aria-label="Field">
<script>
  // After the shell's listener (the window's, added later): what it did to the key.
  addEventListener("keydown", (event) => {
    if (event.key === "f" || event.key === "F") {
      document.body.dataset.prevented = String(event.defaultPrevented);
    }
  });
</script>`,
  });
  const frame = await display.frame();
  const body = frame.locator("body");
  // Whose shortcut it is, as the shell reads it: Cmd on Apple's platforms, Ctrl elsewhere.
  const apple = await frame.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform));
  const modifier = apple ? "Meta" : "Control";
  const press = async (key: string) => {
    await frame.evaluate(() => document.body.removeAttribute("data-prevented"));
    await frame.locator("#field").click();
    await page.keyboard.press(`${modifier}+${key}`);
  };

  await press("f");
  await expect(body).toHaveAttribute("data-prevented", "false");
  await page.waitForTimeout(500);
  expect(await requested(display), "not the host's until it takes it").toBe(0);

  expect(await display.find("takeShortcut", true)).toBeNull();
  await press("f");
  await expect.poll(() => requested(display), { message: "the host hears the shortcut" }).toBe(1);
  await expect(body).toHaveAttribute("data-prevented", "true");
  // Another key with the same modifier is the page's.
  await press("g");
  await page.waitForTimeout(500);
  expect(await requested(display)).toBe(1);

  // Let go: the browser's own find again.
  await display.find("takeShortcut", false);
  await press("f");
  await expect(body).toHaveAttribute("data-prevented", "false");
  await page.waitForTimeout(500);
  expect(await requested(display)).toBe(1);

  // A page with a find of its own takes the key first (its listener calls preventDefault).
  await display.find("takeShortcut", true);
  await frame.evaluate(() =>
    document.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
      }
    }),
  );
  await press("f");
  await expect(body).toHaveAttribute("data-prevented", "true");
  await page.waitForTimeout(500);
  expect(await requested(display), "the page's own find keeps its key").toBe(1);
});

test("a hostile page says the find shortcut was pressed while the person types in the host's composer: the host's find bar stays shut (P131)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const display = await referenceHost.launch(page, {
    config: config(),
    heightPx: 300,
    content: `<p>Notes</p><input id="field" aria-label="Field">
<script>
  // Every 200 ms, the shortcut's word, whatever the person does.
  setInterval(() => {
    parent.postMessage({ jsonrpc: "2.0", method: "porthole/find.requested", params: {} }, "*");
    window.said = (window.said || 0) + 1;
  }, 200);
</script>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#field")).toBeVisible();
  await display.find("takeShortcut", true);
  // The host's composer, beside the frame: the person types there.
  await page.evaluate(() => {
    const composer = document.createElement("textarea");
    composer.id = "composer";
    document.body.prepend(composer);
  });
  await page.locator("#composer").click();
  const said = await frame.evaluate(() => (window as unknown as { said?: number }).said ?? 0);
  await page.keyboard.type("the quarterly numbers look", { delay: 60 });
  await page.waitForTimeout(500);
  expect(
    (await frame.evaluate(() => (window as unknown as { said?: number }).said ?? 0)) - said,
    "the page said it again and again meanwhile",
  ).toBeGreaterThan(5);
  expect(
    await requested(display),
    "probe: the host took the page's word for the shortcut while the person typed beside it",
  ).toBe(0);
  await expect(page.locator("#composer")).toBeFocused();

  // With the person in the frame, the page's word is taken: a hint the host only opens its bar on.
  await frame.locator("#field").click();
  await expect
    .poll(() => requested(display), { message: "taken with the person in the frame" })
    .toBeGreaterThan(0);
});
