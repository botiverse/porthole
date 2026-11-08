import { readFileSync } from "node:fs";
import { devices, expect, test, type Browser, type Frame, type Page } from "@playwright/test";
import {
  presets,
  type AnchorResult,
  type AnnotationAnchor,
  type AnnotationReport,
} from "../src/index.ts";
import { referenceHost, type ReferenceDisplay } from "./reference-host.ts";

/**
 * Annotations (P053) in real frames, on Chromium, WebKit and Firefox: picking an element and
 * selecting text, marking anchors (and finding them again after the content changed), and a
 * hostile page faking what the frame reports, which the host's checks must hold.
 */

type Selected = Extract<AnnotationReport, { type: "selected" }>;

const reports = async (display: ReferenceDisplay): Promise<AnnotationReport[]> =>
  (await display.events()).flatMap((event) => (event.type === "annotation" ? [event.detail] : []));

const refusals = async (display: ReferenceDisplay): Promise<string[]> =>
  (await display.events()).flatMap((event) =>
    event.type === "refused" ? [`${event.detail.capability}:${event.detail.refusal}`] : [],
  );

/** The first report of `type` after the first `after` reports. */
async function next<T extends AnnotationReport["type"]>(
  display: ReferenceDisplay,
  type: T,
  after = 0,
): Promise<Extract<AnnotationReport, { type: T }>> {
  let found: AnnotationReport | undefined;
  await expect
    .poll(
      async () => {
        found = (await reports(display)).slice(after).find((report) => report.type === type);
        return found !== undefined;
      },
      { timeout: 5_000, message: `a ${type} report` },
    )
    .toBe(true);
  return found as Extract<AnnotationReport, { type: T }>;
}

/** The pixels over `selector` in the frame, as the person sees them (the shell's layer included). */
async function look(page: Page, frame: Frame, selector: string): Promise<Buffer> {
  const box = await frame.locator(selector).boundingBox();
  if (box === null) {
    throw new Error(`${selector} isn't on screen`);
  }
  return page.screenshot({ clip: box, animations: "disabled" });
}

const quoteOf = (anchor: AnnotationAnchor): string => {
  const quote = anchor.selectors.find((each) => each.type === "TextQuoteSelector");
  return quote?.type === "TextQuoteSelector" ? quote.exact : "";
};

/** Selects `text` inside `selector` as a person's drag would leave it. */
const select = (frame: Frame, selector: string, text: string) =>
  frame.evaluate(
    ([where, words]) => {
      const element = document.querySelector(where);
      const walker = document.createTreeWalker(element as Node, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = (node.nodeValue ?? "").indexOf(words);
        if (at !== -1) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + words.length);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(range);
          return true;
        }
      }
      return false;
    },
    [selector, text] as const,
  );

const WIDGET = `<h2 id="title">Quarterly notes</h2>
<p id="p1">Costs <b>fell</b> by 3%.</p>
<button id="more" class="primary wide">Read more</button>
<script>
  document.getElementById("more").addEventListener("click", () => (document.body.dataset.clicked = "yes"));
  document.addEventListener("pointerdown", () => (document.body.dataset.pointer = "yes"));
</script>`;

const annotated = () => presets.inlineWidget({ capabilities: { annotate: {} } });

test("picking an element: the one under the pointer is outlined, a click picks it, and the content never sees that click", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: WIDGET });
  const frame = await display.frame();
  await expect(frame.locator("#more")).toBeVisible();
  const before = await look(page, frame, "#p1");
  expect(await display.annotate("start", { elements: true, text: false })).toBeNull();
  await frame.locator("#p1").hover();
  await expect
    .poll(async () => (await look(page, frame, "#p1")).equals(before), {
      message: "the paragraph under the pointer is outlined",
    })
    .toBe(false);

  await frame.locator("#more").click();
  const picked = await next(display, "selected");
  expect(picked.anchor.kind).toBe("element");
  expect(picked.anchor.label).toBe("button#more.primary.wide Read more");
  expect(picked.anchor.selectors[0]).toEqual({ type: "CssSelector", value: "#more" });
  expect(quoteOf(picked.anchor)).toBe("Read more");
  expect(picked.rect.width).toBeGreaterThan(0);
  expect(await frame.locator("body").getAttribute("data-clicked")).toBeNull();
  expect(await frame.locator("body").getAttribute("data-pointer")).toBeNull();

  // One pick: the next click is the content's own again.
  await frame.locator("#more").click();
  await expect(frame.locator("body")).toHaveAttribute("data-clicked", "yes");
});

test("Escape while selecting text is cancelled, and stays the page's key; with no mode on, a page's own cancel isn't heard (P112)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: annotated(),
    content: `${WIDGET}<script>addEventListener("keydown", (event) => { if (event.key === "Escape") document.body.dataset.escape = "yes"; });</script>`,
  });
  const frame = await display.frame();
  await display.annotate("start", { elements: false, text: true });
  await frame.locator("#more").focus();
  await page.keyboard.press("Escape");
  await next(display, "cancelled");
  await expect(frame.locator("body"), "the page still hears its Escape").toHaveAttribute(
    "data-escape",
    "yes",
  );
  // Stopped: neither the person's Escape nor the page's own word is a cancel the host hears.
  await display.annotate("stop", {});
  const before = (await reports(display)).length;
  await page.keyboard.press("Escape");
  await frame.evaluate(() =>
    parent.postMessage({ jsonrpc: "2.0", method: "porthole/annotate.cancelled", params: {} }, "*"),
  );
  await page.waitForTimeout(500);
  expect((await reports(display)).slice(before), "probe: no cancel heard with no mode on").toEqual(
    [],
  );
});

test("holding a block 500 ms selects it and its release's click never reaches the page; a tap, a moving finger and a mouse are the page's (P112)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: WIDGET });
  const frame = await display.frame();
  await expect(frame.locator("#more")).toBeVisible();
  expect(await display.annotate("start", { elements: "hold", text: true })).toBeNull();
  // A finger on the button: down, held (or moved), up, and the click its release makes. The
  // shell reads the events as the browser dispatches them; the page's realm could send these too,
  // and what comes of them is a report, the page's word as ever.
  const press = (pointerType: string, holdMs: number, moveBy = 0) =>
    frame.evaluate(
      async ([kind, ms, by]) => {
        const target = document.getElementById("more") as HTMLElement;
        const box = target.getBoundingClientRect();
        const at = { clientX: box.left + 10, clientY: box.top + 10 };
        const fire = (type: string, extra = {}) =>
          target.dispatchEvent(
            new PointerEvent(type, {
              pointerType: kind,
              isPrimary: true,
              bubbles: true,
              ...at,
              ...extra,
            }),
          );
        delete document.body.dataset.clicked;
        fire("pointerdown");
        if (by > 0) {
          fire("pointermove", { clientX: at.clientX + by, clientY: at.clientY });
        }
        await new Promise((done) => setTimeout(done, ms));
        fire("pointerup");
        target.click();
        return document.body.dataset.clicked ?? null;
      },
      [pointerType, holdMs, moveBy] as const,
    );
  const before = (await reports(display)).length;
  expect(await press("touch", 700), "probe: the release's click never reached the page").toBeNull();
  const held = await next(display, "selected", before);
  expect(held.anchor.kind).toBe("element");
  expect(held.anchor.label).toBe("button#more.primary.wide Read more");
  // Still holding mode: a tap, a finger that moved, and a mouse held long are the page's.
  const after = (await reports(display)).length;
  expect(await press("touch", 100), "a tap is the page's").toBe("yes");
  expect(await press("touch", 700, 30), "a finger that moved is the page's").toBe("yes");
  expect(await press("mouse", 700), "a mouse is the page's").toBe("yes");
  await page.waitForTimeout(300);
  expect(
    (await reports(display)).slice(after).filter((each) => each.type === "selected"),
    "none of them selects anything",
  ).toEqual([]);
  // And once more: holding mode lasts until the host stops it.
  expect(await press("touch", 700), "probe: the second hold's click is the shell's too").toBeNull();
  await next(display, "selected", after);
});

test("an element without an id is anchored by its path; Escape cancels a pick", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: WIDGET });
  const frame = await display.frame();
  await display.annotate("start", { elements: true, text: false });
  await frame.locator("#p1 b").click();
  const picked = await next(display, "selected");
  expect(picked.anchor.selectors[0]).toEqual({ type: "CssSelector", value: "#p1 > b" });
  expect(quoteOf(picked.anchor)).toBe("fell");

  await display.annotate("start", { elements: true, text: false });
  await frame.locator("#more").focus();
  await page.keyboard.press("Escape");
  await next(display, "cancelled");
  await frame.locator("#more").click();
  await expect(frame.locator("body")).toHaveAttribute("data-clicked", "yes");
});

const WORDLESS = `<p>Before the picture.</p>
<img id="chart" alt="Revenue by month" width="160" height="60" style="display:block;background:#ddd" src="data:,">
<button id="close" aria-label="Close dialog" style="width:40px;height:30px"></button>
<div id="map" title="Map of regions" style="width:120px;height:40px;background:#ccc"></div>`;

test("an element without words is named by its alt, aria-label or title", async ({ page }) => {
  const cases: [string, string][] = [
    ["#chart", "Revenue by month"],
    ["#close", "Close dialog"],
    ["#map", "Map of regions"],
  ];
  for (const [selector, name] of cases) {
    // A fresh display each time, so each pick's report is its own.
    const display = await referenceHost.launch(page, { config: annotated(), content: WORDLESS });
    const frame = await display.frame();
    await display.annotate("start", { elements: true, text: false });
    await frame.locator(selector).click();
    const picked = await next(display, "selected");
    expect(picked.anchor.kind).toBe("element");
    expect(picked.anchor.label).toContain(name);
  }
});

test("selecting text: a settled selection is reported with its anchor and box, and its clearing too", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: WIDGET });
  const frame = await display.frame();
  await display.annotate("start", { elements: false, text: true });
  await frame.locator("#p1").click({ clickCount: 3 });
  const selected = await next(display, "selected");
  expect(selected.anchor.kind).toBe("text");
  expect(quoteOf(selected.anchor).trim()).toBe("Costs fell by 3%.");
  expect(selected.anchor.selectors.map((each) => each.type)).toContain("TextPositionSelector");
  const paragraph = await frame.locator("#p1").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { y: rect.y, height: rect.height };
  });
  expect(Math.abs(selected.rect.y - paragraph.y)).toBeLessThan(paragraph.height);

  const count = (await reports(display)).length;
  await frame.locator("#title").click();
  await next(display, "unselected", count);
});

test("clearSelection takes the page's selection away and tells nothing back; marks and drafts stay, the next selection is told (P115)", async ({
  page,
}) => {
  // A page that patched the Selection's own way out: the host's clear is the shell's, not its.
  const display = await referenceHost.launch(page, {
    config: annotated(),
    content: `${WIDGET}<script>Selection.prototype.removeAllRanges = function () {}; Selection.prototype.empty = function () {};</script>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#more")).toBeVisible();
  const selectedText = () => frame.evaluate(() => String(getSelection()));
  const textReports = async (after: number) =>
    (await reports(display))
      .slice(after)
      .filter((each) => each.type === "selected" || each.type === "unselected");
  // Nothing selected, nothing shown, no mode: nothing happens, nothing is told.
  expect(await display.annotate("clearSelection")).toBeNull();
  expect(await reports(display)).toEqual([]);

  await display.annotate("show", [
    textMark("posted", "Quarterly notes", 2),
    { ...textMark("draft", "Read more"), kind: "draft" },
  ]);
  await next(display, "anchored");
  await display.annotate("start", { elements: false, text: true });
  await frame.locator("#p1").click({ clickCount: 3 });
  const selected = await next(display, "selected");
  expect(quoteOf(selected.anchor).trim()).toBe("Costs fell by 3%.");

  const count = (await reports(display)).length;
  expect(await display.annotate("clearSelection")).toBeNull();
  await expect.poll(selectedText, { message: "probe: the page's selection is gone" }).toBe("");
  // Past the selection's settle (250 ms): neither an `unselected` nor the old selection again.
  await page.waitForTimeout(800);
  expect(await textReports(count), "probe: nothing is told back").toEqual([]);

  // Marks and drafts stay where they are, in the shell's own state.
  for (const id of ["posted", "draft"]) {
    const before = (await reports(display)).length;
    expect(await display.annotate("focus", id)).toBeNull();
    const focused = await next(display, "anchored", before);
    expect(
      focused.results.map((each) => each.state),
      `the ${id} mark is still found`,
    ).toEqual(["attached"]);
  }

  // The same words selected again are told: the shell forgot the one it told before.
  const again = (await reports(display)).length;
  await frame.locator("#p1").click({ clickCount: 3 });
  const reselected = await next(display, "selected", again);
  expect(quoteOf(reselected.anchor).trim()).toBe("Costs fell by 3%.");

  // With the mode stopped, the host still clears what is selected; twice is as once.
  await display.annotate("stop");
  const stopped = (await reports(display)).length;
  expect(await display.annotate("clearSelection")).toBeNull();
  expect(await display.annotate("clearSelection")).toBeNull();
  await expect.poll(selectedText, { message: "probe: cleared with no mode on" }).toBe("");
  await page.waitForTimeout(500);
  expect(await textReports(stopped)).toEqual([]);
});

test("picking and selecting together: a click picks an element, a drag selects text", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: WIDGET });
  const frame = await display.frame();
  await display.annotate("start");
  const box = await frame.locator("#title").boundingBox();
  if (box === null) {
    throw new Error("no title");
  }
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const dragged = await next(display, "selected");
  expect(dragged.anchor.kind).toBe("text");
  expect("Quarterly notes").toContain(quoteOf(dragged.anchor).trim());

  const count = (await reports(display)).length;
  await frame.locator("#more").click();
  const picked = await next(display, "selected", count);
  expect(picked.anchor.kind).toBe("element");
  expect(await frame.locator("body").getAttribute("data-clicked")).toBeNull();
});

const LONG_PAGE = `<!doctype html><html><head><title>Report</title></head><body>
<h1 id="top">Report</h1>
<div style="height: 1600px">spacer</div>
<p id="far">The far paragraph says hello to everyone.</p>
</body></html>`;

test("marks: drawn over their anchors, one brought into view, an unfound one orphaned, all cleared", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: LONG_PAGE,
  });
  const frame = await display.frame();
  await expect(frame.locator("#far")).toBeAttached();
  const marks = [
    {
      id: "far",
      anchor: {
        kind: "element",
        selectors: [{ type: "CssSelector", value: "#far" }],
        label: "p#far",
      },
    },
    {
      id: "hello",
      anchor: {
        kind: "text",
        selectors: [{ type: "TextQuoteSelector", exact: "says hello" }],
        label: "says hello",
      },
    },
    {
      id: "gone",
      anchor: {
        kind: "text",
        selectors: [{ type: "TextQuoteSelector", exact: "a sentence that isn't there" }],
        label: "gone",
      },
    },
  ];
  expect(await display.annotate("show", marks)).toBeNull();
  const shown = await next(display, "anchored");
  const byId = new Map<string, AnchorResult>(shown.results.map((each) => [each.id, each]));
  expect(byId.get("far")?.state, "probe: the far mark is drawn over its anchor").toBe("attached");
  expect(byId.get("hello")?.state, "probe: the text mark is drawn over its anchor").toBe(
    "attached",
  );
  expect(byId.get("gone"), "probe: the unfound mark is orphaned").toEqual({
    id: "gone",
    state: "orphaned",
  });
  // Below the frame's viewport: on its bottom edge, of no height (the host clamps every box to
  // the frame, P104).
  const viewport = await frame.evaluate(() => window.innerHeight);
  expect(byId.get("far")?.rect?.y, "probe: a box below the frame is on its bottom edge").toBe(
    viewport,
  );
  expect(byId.get("far")?.rect?.height, "probe: a box below the frame is of no height").toBe(0);

  const count = (await reports(display)).length;
  expect(await display.annotate("focus", "far")).toBeNull();
  const focused = await next(display, "anchored", count);
  expect(focused.results, "probe: focus reports the one mark brought into view").toHaveLength(1);
  const rect = focused.results[0]?.rect;
  expect(rect?.y, "probe: the focused mark's top is in the viewport").toBeGreaterThanOrEqual(0);
  expect(
    (rect?.y ?? 0) + (rect?.height ?? 0),
    "probe: the focused mark's bottom is in the viewport",
  ).toBeLessThanOrEqual(viewport);
  expect(
    await frame.evaluate(() => window.scrollY),
    "probe: the frame scrolled to the focused mark",
  ).toBeGreaterThan(0);

  const marked = await look(page, frame, "#far");
  expect(await display.annotate("clear")).toBeNull();
  await expect
    .poll(async () => (await look(page, frame, "#far")).equals(marked), {
      message: "probe: the marks are gone",
    })
    .toBe(false);
  expect(await display.annotate("focus", "far"), "probe: no mark is left to focus").toMatch(
    /no mark/u,
  );
});

const VERSION_1 = `<!doctype html><html><head><title>Notes</title></head><body>
<h2 id="revenue">Revenue grew 12%</h2>
<p id="costs">Costs fell by 3% this quarter.</p>
<p>We hired two people.</p>
<p>The   outlook   is steady.</p>
</body></html>`;

const VERSION_2 = `<!doctype html><html><head><title>Notes</title></head><body>
<p>A new opening paragraph that moves everything below it down the page.</p>
<h2 id="revenue">Revenue grew 14%</h2>
<p>Costs fell by 3% this quarter, again.</p>
<p>The outlook is steady.</p>
</body></html>`;

test("re-anchoring after an edit: a revised page keeps the anchors it can, and says which it lost", async ({
  page,
}) => {
  const config = presets.artifact({ capabilities: { annotate: {} } });
  const first = await referenceHost.launch(page, { config, content: VERSION_1 });
  const frame = await first.frame();
  await expect(frame.locator("#costs")).toBeAttached();

  // The anchors, made the way a person makes them on the first version.
  await first.annotate("start", { elements: true, text: false });
  await frame.locator("#revenue").click();
  const revenue = (await next(first, "selected")).anchor;
  await first.annotate("start", { elements: false, text: true });
  const anchors: Record<string, AnnotationAnchor> = { revenue };
  for (const [id, where, words] of [
    ["costs", "#costs", "fell by 3%"],
    ["hired", "body", "We hired two people."],
    ["outlook", "body", "outlook   is steady"],
  ] as const) {
    const count = (await reports(first)).length;
    expect(await select(frame, where, words)).toBe(true);
    anchors[id] = (await next(first, "selected", count)).anchor;
  }
  const before = await frame
    .locator("#costs")
    .evaluate((element) => element.getBoundingClientRect().y);

  // The second version, with the same marks.
  const second = await referenceHost.launch(page, { config, content: VERSION_2 });
  await expect((await second.frame()).locator("#revenue")).toBeAttached();
  await second.annotate(
    "show",
    Object.entries(anchors).map(([id, anchor]) => ({ id, anchor })),
  );
  const results = new Map(
    (await next(second, "anchored")).results.map((each) => [each.id, each] as const),
  );
  expect(results.get("revenue")?.state, "by its id, though its words changed").toBe("attached");
  expect(results.get("costs")?.state, "its words, elsewhere").toBe("attached");
  expect(results.get("outlook")?.state, "its words, spaced differently").toBe("attached");
  expect(results.get("hired"), "deleted").toEqual({ id: "hired", state: "orphaned" });
  // Where they are now: the costs sentence moved down, under the new opening.
  const now = await (
    await second.frame()
  )
    .locator("p")
    .nth(1)
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { y: rect.y, height: rect.height };
    });
  const costs = results.get("costs")?.rect;
  expect(Math.abs((costs?.y ?? 0) - now.y)).toBeLessThan(now.height);
  expect(costs?.y ?? 0).toBeGreaterThan(before);
  expect(costs?.y ?? 0).toBeGreaterThan(results.get("revenue")?.rect?.y ?? 0);
});

test("live updates: a mark whose content goes away is reported orphaned, and only the change is told", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: annotated(),
    content: `<p id="a">alpha beta</p><p id="b">gamma delta</p><button id="drop">drop</button>
<script>document.getElementById("drop").addEventListener("click", () => document.getElementById("b").remove());</script>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#drop")).toBeVisible();
  const mark = (id: string, exact: string) => ({
    id,
    anchor: { kind: "text", selectors: [{ type: "TextQuoteSelector", exact }], label: exact },
  });
  await display.annotate("show", [mark("a", "alpha beta"), mark("b", "gamma delta")]);
  const shown = await next(display, "anchored");
  expect(shown.results.map((each) => each.state)).toEqual(["attached", "attached"]);
  const count = (await reports(display)).length;
  await frame.locator("#drop").click();
  const changed = await next(display, "anchored", count);
  expect(changed.results.find((each) => each.id === "b")?.state).toBe("orphaned");
  expect(changed.results.find((each) => each.id === "a")?.state).toBe("attached");
});

test("a hostile page fakes reports: the host takes none it didn't ask for, nothing malformed, and not a flood", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: WIDGET });
  const frame = await display.frame();
  await expect(frame.locator("#more")).toBeVisible();
  const fake = (method: string, params: unknown) =>
    frame.evaluate(
      ([each, given]) =>
        parent.postMessage(
          { jsonrpc: "2.0", method: `porthole/annotate.${each}`, params: given },
          "*",
        ),
      [method, params] as const,
    );
  const anchor: AnnotationAnchor = {
    kind: "text",
    selectors: [{ type: "TextQuoteSelector", exact: "Wire the money now" }],
    label: "Wire the money now",
  };
  const rect = { x: 0, y: 0, width: 10, height: 10 };

  // Not asked for: no selection, no cancel, no results.
  await fake("selected", { anchor, rect });
  await fake("cancelled", {});
  await fake("anchored", { results: [{ id: "x", state: "attached", rect }] });
  await page.waitForTimeout(500);
  expect(await reports(display), "probe: the host took a report it didn't ask for").toEqual([]);

  // Asked for text: what's malformed, too large, of the wrong kind, or about no mark is dropped.
  await display.annotate("start", { elements: false, text: true });
  await fake("selected", { anchor: { ...anchor, label: "x".repeat(121) }, rect });
  await fake("selected", {
    anchor: { ...anchor, selectors: [{ type: "TextQuoteSelector", exact: "x".repeat(5_000) }] },
    rect,
  });
  await fake("selected", { anchor, rect: { ...rect, width: -1 } });
  await fake("selected", {
    anchor: { ...anchor, kind: "element", selectors: [{ type: "CssSelector", value: "#x" }] },
    rect,
  });
  await fake("anchored", { results: [{ id: "not-a-mark", state: "attached", rect }] });
  await fake("granted", { permission: "admin" });
  // The three malformed ones are refused once the host has handled them: waited for, not
  // counted once after a fixed wait (P098). What was dropped stays dropped.
  await expect
    .poll(async () => (await refusals(display)).filter((each) => each === "annotate:invalid"), {
      message: "probe: the three malformed reports were refused",
    })
    .toHaveLength(3);
  await page.waitForTimeout(500);
  expect(await reports(display), "probe: the host took a malformed or unasked report").toEqual([]);
  expect(
    (await refusals(display)).filter((each) => each === "annotate:invalid"),
    "probe: the three malformed reports were refused",
  ).toHaveLength(3);

  // A well-formed fake, asked for, gets through: rebuilt from known fields, a UI hint only.
  await fake("selected", { anchor: { ...anchor, extra: "<img onerror>" }, rect, admin: true });
  const taken = await next(display, "selected");
  expect(taken, "probe: the report was rebuilt from known fields only").toEqual({
    type: "selected",
    anchor,
    rect,
  });

  // A flood is cut at the rate limit.
  await frame.evaluate(
    ([given, box]) => {
      for (let i = 0; i < 200; i += 1) {
        parent.postMessage(
          {
            jsonrpc: "2.0",
            method: "porthole/annotate.selected",
            params: { anchor: given, rect: box },
          },
          "*",
        );
      }
    },
    [anchor, rect] as const,
  );
  await expect
    .poll(
      async () =>
        (await refusals(display)).filter((each) => each === "annotate:rate-limited").length,
      { message: "probe: the flood was cut at the rate limit" },
    )
    .toBeGreaterThan(0);
  expect(
    (await reports(display)).length,
    "probe: the host took a flood of reports",
  ).toBeLessThanOrEqual(120);
});

test("an MCP Apps view, where the host declares annotate, is annotated the same way", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.mcpApp({ capabilities: { annotate: {} } }),
    document: `<!doctype html><html><head><title>View</title></head><body>
<h3 id="view-title">A view</h3>
<script>
  // A view's own handshake, as the App SDK makes it.
  addEventListener("message", (event) => {
    if (event.data && event.data.id === "init-1") {
      parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
      parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 160 } }, "*");
    }
  });
  parent.postMessage({ jsonrpc: "2.0", id: "init-1", method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "v", version: "1" }, appCapabilities: {} } }, "*");
</script></body></html>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#view-title")).toBeVisible();
  await expect
    .poll(async () => (await display.events()).some((event) => event.type === "initialized"))
    .toBe(true);
  await expect.poll(async () => (await display.box()).height).toBeGreaterThan(100);
  await display.annotate("start", { elements: true, text: false });
  await frame.locator("#view-title").click();
  const picked: Selected = await next(display, "selected");
  expect(picked.anchor.selectors[0]).toEqual({ type: "CssSelector", value: "#view-title" });
});

test("focus right after show waits for anchoring to settle: no orphaned report for a mark that is there", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: LONG_PAGE,
  });
  const frame = await display.frame();
  await expect(frame.locator("#far")).toBeAttached();
  const marks = [
    {
      id: "far",
      anchor: {
        kind: "element",
        selectors: [{ type: "CssSelector", value: "#far" }],
        label: "p#far",
      },
    },
  ];
  // Back to back, as a viewer opening a comment's link does.
  await page.evaluate(
    ([given]) => {
      const reference = (
        window as unknown as {
          reference: { annotate(id: number, operation: string, argument?: unknown): string | null };
        }
      ).reference;
      reference.annotate(0, "show", given);
      reference.annotate(0, "focus", "far");
    },
    [marks] as const,
  );
  await expect
    .poll(async () => (await reports(display)).filter((each) => each.type === "anchored").length)
    .toBe(2);
  const anchored = (await reports(display)).filter(
    (each): each is Extract<AnnotationReport, { type: "anchored" }> => each.type === "anchored",
  );
  for (const report of anchored) {
    expect(
      report.results.every((each) => each.state === "attached"),
      JSON.stringify(report),
    ).toBe(true);
  }
  // The focus is told last, where the mark is once scrolled into view.
  const viewport = await frame.evaluate(() => window.innerHeight);
  const rect = anchored.at(-1)?.results[0]?.rect;
  expect(rect?.y).toBeGreaterThanOrEqual(0);
  expect((rect?.y ?? 0) + (rect?.height ?? 0)).toBeLessThanOrEqual(viewport);
  expect(await frame.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test("marks shown before the content arrives are reported once it has, not orphaned first", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated() });
  await display.annotate("show", [
    {
      id: "fell",
      anchor: {
        kind: "text",
        selectors: [{ type: "TextQuoteSelector", exact: "fell" }],
        label: "fell",
      },
    },
  ]);
  await page.waitForTimeout(800);
  expect(await reports(display)).toEqual([]);
  await display.setContent(WIDGET);
  const anchored = await next(display, "anchored");
  expect(anchored.results).toEqual([
    expect.objectContaining({ id: "fell", state: "attached" }) as unknown as AnchorResult,
  ]);
});

// Markers (P104): a mark with a count gets a bubble with its number, which a person can click.

const MARKED = `<h2 id="title" style="margin: 40px 0 24px">Quarterly notes</h2>
<p id="p1" style="font-size: 18px">Costs <b>fell</b><span id="after"> by three percent this quarter, again and again.</span></p>
<p id="p2" style="font-size: 18px"><i id="plain">Nothing</i><span id="after2"> else is marked on this line.</span></p>
<button id="more" style="margin: 24px 60px">Read more</button>
<script>
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
    window.addEventListener(type, () => (document.body.dataset[type] = "yes"), true);
  }
  document.getElementById("after").addEventListener("click", () => (document.body.dataset.after = "yes"));
  document.getElementById("after2").addEventListener("click", () => (document.body.dataset.after2 = "yes"));
</script>`;

const elementMark = (id: string, css: string, count?: number) => ({
  id,
  anchor: { kind: "element", selectors: [{ type: "CssSelector", value: css }], label: css },
  ...(count === undefined ? {} : { count }),
});
const textMark = (id: string, exact: string, count?: number) => ({
  id,
  anchor: { kind: "text", selectors: [{ type: "TextQuoteSelector", exact }], label: exact },
  ...(count === undefined ? {} : { count }),
});

/** The markers' labels in the shell's closed layer, as Chromium's inspector sees them. */
async function markerLabels(page: Page, frame: Frame): Promise<string[]> {
  return (await layerNodes(page, frame, "marker")).map((each) => each.text);
}

/**
 * The nodes of the shell's closed layer whose class has `name` (`marker`, `mark`), with their
 * class and words, as Chromium's inspector sees them.
 */
async function layerNodes(
  page: Page,
  frame: Frame,
  name: string,
): Promise<{ className: string; text: string; tag: string; name: string | null }[]> {
  interface Node {
    nodeName: string;
    nodeValue?: string;
    attributes?: string[];
    children?: Node[];
    shadowRoots?: Node[];
    contentDocument?: Node;
  }
  let session;
  try {
    session = await page.context().newCDPSession(frame);
  } catch {
    session = await page.context().newCDPSession(page);
  }
  const { root } = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as {
    root: Node;
  };
  const labels: { className: string; text: string; tag: string; name: string | null }[] = [];
  const named = new RegExp(`(^|\\s)${name}(\\s|$)`, "u");
  const text = (node: Node): string =>
    node.nodeName === "#text"
      ? (node.nodeValue ?? "")
      : (node.children ?? []).map((child) => text(child)).join("");
  const walk = (node: Node) => {
    const attributes = node.attributes ?? [];
    const classAt = attributes.indexOf("class");
    const className = classAt === -1 ? "" : (attributes[classAt + 1] ?? "");
    if (named.test(className)) {
      const nameAt = attributes.indexOf("aria-label");
      labels.push({
        className,
        text: text(node),
        tag: node.nodeName,
        name: nameAt === -1 ? null : (attributes[nameAt + 1] ?? null),
      });
    }
    for (const child of [
      ...(node.children ?? []),
      ...(node.shadowRoots ?? []),
      ...(node.contentDocument ? [node.contentDocument] : []),
    ]) {
      walk(child);
    }
  };
  walk(root);
  await session.detach();
  return labels;
}

/**
 * Where the markers are on the line of `selector`'s last words (P105: beside that line, in its
 * gutter, at the frame's edge or past its last word), in the frame's viewport: the runs of points
 * along the line's middle where the shell's layer takes the pointer, which only a marker does. A
 * posted text mark's marker is on its paragraph's last line (P133): name the paragraph.
 */
async function markersOnLine(frame: Frame, selector: string) {
  return frame.evaluate((where) => {
    const element = document.querySelector(where);
    const layer = document.querySelector("[data-porthole-annotations]");
    if (element === null || layer === null) {
      return { y: 0, runs: [] };
    }
    const range = document.createRange();
    range.selectNodeContents(element);
    const last = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0)
      .at(-1);
    if (last === undefined) {
      return { y: 0, runs: [] };
    }
    const y = last.top + last.height / 2;
    const runs: { left: number; right: number }[] = [];
    let start = -1;
    for (let x = 0; x <= document.documentElement.clientWidth; x += 1) {
      const on = document.elementFromPoint(x, y) === layer;
      if (on && start < 0) {
        start = x;
      } else if (!on && start >= 0) {
        runs.push({ left: start, right: x - 1 });
        start = -1;
      }
    }
    if (start >= 0) {
      runs.push({ left: start, right: document.documentElement.clientWidth });
    }
    return { y, runs };
  }, selector);
}

/** The `nth` marker on the line of `selector`'s last words, as a point on the page. */
async function textMarkerPoint(frame: Frame, selector: string, nth = 0) {
  const { y, runs } = await markersOnLine(frame, selector);
  const run = runs[nth];
  if (run === undefined) {
    throw new Error(`no marker ${nth} on the line of ${selector}`);
  }
  const box = await (await frame.frameElement()).boundingBox();
  return { x: (box?.x ?? 0) + (run.left + run.right) / 2, y: (box?.y ?? 0) + y };
}

test("markers: a mark with a count gets a numbered bubble; its click is reported and never reaches the content", async ({
  page,
  browserName,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: MARKED });
  const frame = await display.frame();
  await expect(frame.locator("#more")).toBeVisible();
  const plainBefore = await look(page, frame, "#p2");
  await display.annotate("show", [
    elementMark("title", "#title", 0),
    textMark("fell", "fell", 3),
    elementMark("more", "#more", 120),
    textMark("plain", "Nothing"),
  ]);
  const shown = await next(display, "anchored");
  expect(shown.results.map((each) => each.state)).toEqual([
    "attached",
    "attached",
    "attached",
    "attached",
  ]);
  if (browserName === "chromium") {
    // The number, "99+" past 99, the bubble alone for 0; a mark without a count has none.
    await expect
      .poll(() => markerLabels(page, frame), {
        message: "probe: each mark with a count has its numbered bubble, the others none",
      })
      .toEqual(["", "3", "99+"]);
  }

  // A click on the text's marker: reported with its box; nothing of the content's hears it.
  const fell = await textMarkerPoint(frame, "#p1");
  await page.mouse.click(fell.x, fell.y);
  const activated = await next(display, "activated");
  expect(activated.id, "probe: the text marker's click is reported for its mark").toBe("fell");
  // Its box is the marker's, in the frame's viewport: around where it was clicked.
  const frameBox = await (await frame.frameElement()).boundingBox();
  const left = activated.rect.x + (frameBox?.x ?? 0);
  const top = activated.rect.y + (frameBox?.y ?? 0);
  expect(left, "probe: the reported box is around the click").toBeLessThanOrEqual(fell.x);
  expect(
    left + activated.rect.width,
    "probe: the reported box is around the click",
  ).toBeGreaterThanOrEqual(fell.x);
  expect(top, "probe: the reported box is around the click").toBeLessThanOrEqual(fell.y);
  expect(
    top + activated.rect.height,
    "probe: the reported box is around the click",
  ).toBeGreaterThanOrEqual(fell.y);
  for (const attribute of [
    "data-pointerdown",
    "data-pointerup",
    "data-mousedown",
    "data-mouseup",
    "data-click",
    "data-after",
  ]) {
    expect(await frame.locator("body").getAttribute(attribute), `probe: ${attribute}`).toBeNull();
  }

  // The element's marker sits on its top right corner; the numbers make each wider.
  const more = await frame.locator("#more").boundingBox();
  const title = await frame.locator("#title").boundingBox();
  if (more === null || title === null) {
    throw new Error("no button or title");
  }
  let count = (await reports(display)).length;
  await page.mouse.click(more.x + more.width, more.y);
  const wide = await next(display, "activated", count);
  expect(wide.id, "probe: the element marker's click is reported for its mark").toBe("more");
  count = (await reports(display)).length;
  // The title spans the frame: its marker is kept inside it.
  await page.mouse.click(title.x + title.width - 10, title.y);
  const bare = await next(display, "activated", count);
  expect(bare.id, "probe: the bare marker's click is reported for its mark").toBe("title");
  expect(bare.rect.width, "probe: a bubble with a number is wider than one without").toBeLessThan(
    activated.rect.width,
  );
  expect(activated.rect.width, "probe: a longer number makes a wider bubble").toBeLessThan(
    wide.rect.width,
  );
  expect(
    await frame.locator("body").getAttribute("data-click"),
    "probe: no marker's click reached the content",
  ).toBeNull();

  // A mark without a count: its anchor is marked, but no marker is on its line, and a click past
  // its words is the content's.
  expect((await look(page, frame, "#p2")).equals(plainBefore)).toBe(false);
  expect(
    (await markersOnLine(frame, "#plain")).runs,
    "probe: a mark without a count has no marker",
  ).toEqual([]);
  count = (await reports(display)).length;
  const words = await frame.locator("#plain").boundingBox();
  if (words === null) {
    throw new Error("no plain words");
  }
  await page.mouse.click(words.x + words.width + 10, words.y + words.height / 2);
  await expect(frame.locator("body")).toHaveAttribute("data-after2", "yes");
  await page.waitForTimeout(400);
  expect(
    (await reports(display)).slice(count).filter((each) => each.type === "activated"),
    "probe: a mark without a count has no marker to click",
  ).toEqual([]);

  // While the person picks an element, markers step aside: the click picks what lies under one
  // (the button, under the left half of the marker on its corner).
  await display.annotate("start", { elements: true, text: false });
  count = (await reports(display)).length;
  await page.mouse.click(more.x + more.width - 3, more.y + 3);
  const picked = await next(display, "selected", count);
  expect(picked.anchor.label, "probe: the click picked what lies under the marker").toContain(
    "button#more",
  );
});

const SCROLLING = `<!doctype html><html><head><title>Long</title></head><body style="margin: 0">
<div id="pinned" style="position: fixed; top: 0; right: 0; padding: 4px">Pinned note</div>
<div style="height: 450px">spacer</div>
<h1 id="top" style="margin: 40px 8px">Report</h1>
<p id="near" style="margin: 8px">The near paragraph.</p>
<div style="height: 300px">spacer</div>
<p id="far" style="margin: 8px">The far paragraph says hello to everyone.</p>
<div style="height: 1200px">spacer</div>
</body></html>`;

test("following: once a scroll settles, one report with only the marks that moved", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: SCROLLING,
  });
  const frame = await display.frame();
  await expect(frame.locator("#far")).toBeAttached();
  await display.annotate("show", [
    elementMark("top", "#top", 1),
    textMark("near", "near paragraph", 2),
    textMark("pinned", "Pinned note", 1),
    elementMark("far", "#far"),
  ]);
  const shown = await next(display, "anchored");
  const before = new Map(shown.results.map((each) => [each.id, each.rect]));
  await page.waitForTimeout(400);
  const count = (await reports(display)).length;
  expect(count, "nothing more until something moves").toBe(1);

  // A run of scrolls, as a wheel gives them: a report once it has settled, with the marks that
  // moved, the pinned one never. One for the run unless the run itself paused (measured: under
  // load an engine may hold a step back past the shell's 150 ms, and then that pause settled), by
  // the scroll events as the shell hears them: on a starved machine (one CPU, P105) the steps are
  // 30 ms apart but their events bunch, a late frame between them.
  const gaps = await frame.evaluate(async () => {
    const heard: number[] = [];
    const note = () => heard.push(performance.now());
    window.addEventListener("scroll", note, true);
    for (let i = 0; i < 8; i += 1) {
      window.scrollBy(0, 50);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    window.removeEventListener("scroll", note, true);
    return heard.slice(1).map((time, i) => time - (heard[i] ?? time));
  });
  const anchoredSince = async (after: number) =>
    (await reports(display))
      .slice(after)
      .filter(
        (each): each is Extract<AnnotationReport, { type: "anchored" }> => each.type === "anchored",
      );
  await expect
    .poll(
      async () => {
        const last = (await anchoredSince(count)).at(-1);
        const top = last?.results.find((each) => each.id === "top")?.rect?.y;
        return top === undefined ? null : Math.round((before.get("top")?.y ?? 0) - top);
      },
      { message: "probe: once the scroll settles, a report tells the marks that moved" },
    )
    .toBe(400);
  await page.waitForTimeout(600);
  const run = await anchoredSince(count);
  // At most one per settle, and one a second (P104): pauses within a second of the last report
  // are told together.
  expect(run.length, "probe: a settled scroll is reported").toBeGreaterThanOrEqual(1);
  expect(
    run.length,
    `probe: at most one per settle (scroll events ${gaps.map(Math.round).join(", ")} ms apart)`,
  ).toBeLessThanOrEqual(1 + gaps.filter((gap) => gap >= 130).length);
  for (const report of run) {
    expect(
      report.results.map((each) => each.id).sort(),
      "probe: only the marks that moved are reported, the pinned one never",
    ).toEqual(["far", "near", "top"]);
  }
  const viewport = await frame.evaluate(() => window.innerHeight);
  for (const each of run.at(-1)?.results ?? []) {
    expect(each.state, "probe: a moved mark is reported attached").toBe("attached");
    if (each.id === "far") {
      // It was below the viewport (told on its bottom edge, of no height), and is now in it.
      expect(
        before.get("far"),
        "probe: a box below the frame was told on its bottom edge, of no height",
      ).toMatchObject({ y: viewport, height: 0 });
      expect(each.rect?.height, "probe: the far mark is now in the viewport").toBeGreaterThan(0);
      expect(
        (each.rect?.y ?? 0) + (each.rect?.height ?? 0),
        "probe: the far mark is now in the viewport",
      ).toBeLessThanOrEqual(viewport);
    } else {
      expect(
        (before.get(each.id)?.y ?? 0) - (each.rect?.y ?? 0),
        "probe: a moved mark's box moved with the scroll",
      ).toBeCloseTo(400, 0);
    }
  }

  // Down and back in the next frame: nothing moved since the host was last told, so nothing is.
  const told = (await reports(display)).length;
  const apart = await frame.evaluate(
    () =>
      new Promise<number>((resolve) => {
        window.scrollBy(0, 120);
        const start = performance.now();
        requestAnimationFrame(() => {
          window.scrollBy(0, -120);
          resolve(performance.now() - start);
        });
      }),
  );
  await page.waitForTimeout(600);
  if (apart < 130) {
    expect(await anchoredSince(told), "probe: nothing moved, so nothing is reported").toEqual([]);
  }
  await frame.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(
      async () => {
        const last = (await anchoredSince(told)).at(-1);
        return last?.results.find((each) => each.id === "top")?.rect?.y;
      },
      { message: "probe: scrolled back, the moved marks are reported where they were" },
    )
    .toBeCloseTo(before.get("top")?.y ?? 0, 0);
});

test("following: a host that gives no counts hears no follow-up after a scroll, as before markers", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: SCROLLING,
  });
  const frame = await display.frame();
  await expect(frame.locator("#far")).toBeAttached();
  await display.annotate("show", [elementMark("top", "#top"), textMark("near", "near paragraph")]);
  await next(display, "anchored");
  const count = (await reports(display)).length;
  // Both marks move with the scroll; once it has settled, and past the follow-ups' second, the
  // host has heard nothing more.
  const scrolled = await frame.evaluate(() => {
    window.scrollBy(0, 200);
    return window.scrollY;
  });
  expect(scrolled, "the page scrolled").toBe(200);
  // Long enough for a settle and a follow-up on a slow machine too.
  await page.waitForTimeout(2_500);
  expect(
    (await reports(display)).slice(count),
    "probe: marks without counts are told nothing after a scroll",
  ).toEqual([]);
});

test("a hostile page fakes a marker's click: the host takes it only for a mark it shows with a marker", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: MARKED });
  const frame = await display.frame();
  await expect(frame.locator("#more")).toBeVisible();
  const fake = (params: unknown) =>
    frame.evaluate(
      (given) =>
        parent.postMessage(
          { jsonrpc: "2.0", method: "porthole/annotate.activated", params: given },
          "*",
        ),
      params,
    );
  const rect = { x: 0, y: 0, width: 10, height: 10 };

  // No marks: nothing taken.
  await fake({ id: "fell", rect });
  await page.waitForTimeout(400);
  expect(await reports(display), "probe: the host took a marker's click with no marks").toEqual([]);

  await display.annotate("show", [textMark("fell", "fell", 3), textMark("plain", "Nothing")]);
  await next(display, "anchored");
  const count = (await reports(display)).length;
  // An id it doesn't show, one shown without a marker: dropped. Malformed: refused as invalid.
  await fake({ id: "admin", rect });
  await fake({ id: "plain", rect });
  await fake({ id: "fell" });
  await fake({ id: "fell", rect: { ...rect, width: -1 } });
  await expect
    .poll(async () => (await refusals(display)).filter((each) => each === "annotate:invalid"), {
      message: "probe: the two malformed clicks were refused",
    })
    .toHaveLength(2);
  await page.waitForTimeout(400);
  expect(
    (await reports(display)).slice(count),
    "probe: the host took a click for a mark it doesn't show with a marker",
  ).toEqual([]);

  // A well-formed fake for a mark with a marker gets through, rebuilt: a UI hint only.
  await fake({ id: "fell", rect, delete: true });
  expect(
    await next(display, "activated", count),
    "probe: the click was rebuilt from known fields only",
  ).toEqual({ type: "activated", id: "fell", rect });

  // Content's own synthetic click on the shell's layer, where the marker is, reports nothing.
  const after = (await reports(display)).length;
  const line = await markersOnLine(frame, "#p1");
  const marker = line.runs[0];
  expect(marker, "the marker is on its line").toBeDefined();
  await frame.evaluate(
    ([x, y]) => {
      const layer = document.querySelector("[data-porthole-annotations]");
      layer?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
    },
    [((marker?.left ?? 0) + (marker?.right ?? 0)) / 2, line.y] as const,
  );
  await page.waitForTimeout(400);
  expect((await reports(display)).length, "probe: the host took content's own click").toBe(after);
});

// Drafts (P107): a person's unsubmitted comments, drawn apart from posted ones: a dashed line and a
// hollow marker with no number. Activation, anchoring and following work as for posted marks.

const asDraft = <T extends object>(mark: T): T & { kind: "draft" } => ({ ...mark, kind: "draft" });

const DRAFTED = `<h2 id="title" style="margin: 40px 0 24px">Quarterly notes</h2>
<p id="p1" style="font-size: 18px">Costs <b>fell</b><span id="after"> by three percent this quarter, again and again.</span></p>
<p id="p2" style="font-size: 18px">Sales <i>rose</i><span id="after2"> by two percent this quarter, again and again.</span></p>
<button id="more" style="margin: 24px 60px">Read more</button>
<script>
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
    window.addEventListener(type, () => (document.body.dataset[type] = "yes"), true);
  }
  // What the page reads of each show: every mark's fields, as they arrive in its window.
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data && data.method === "porthole/annotate.show") {
      document.body.dataset.shown = JSON.stringify(data.params.marks.map((mark) => ({ id: mark.id, keys: Object.keys(mark).sort(), kind: mark.kind, count: mark.count })));
    }
  });
</script>`;

/** The pixels of the whole frame, as the person sees them, the pointer away from it. */
async function lookAtFrame(page: Page, frame: Frame): Promise<Buffer> {
  const box = await (await frame.frameElement()).boundingBox();
  if (box === null) {
    throw new Error("no frame");
  }
  await page.mouse.move(0, 0);
  return page.screenshot({ clip: box, animations: "disabled" });
}

/** Shows `marks`, then waits for the frame to draw them: their report, and two frames after it. */
async function showAndDraw(display: ReferenceDisplay, frame: Frame, marks: unknown[]) {
  const before = (await reports(display)).length;
  await display.annotate("show", marks);
  await next(display, "anchored", before);
  await frame.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(0))),
      ),
  );
}

test("drafts (P107): a dashed line and a hollow marker with no number, apart from posted marks; their clicks are reported the same", async ({
  page,
  browserName,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: DRAFTED });
  const frame = await display.frame();
  await expect(frame.locator("#more")).toBeVisible();
  const bare = await lookAtFrame(page, frame);

  // The same anchors, posted (a bubble alone, count 0, so neither has a number) and then drafts:
  // the frame looks different each way, and the words' own line differs too.
  await showAndDraw(display, frame, [textMark("fell", "fell", 0), elementMark("more", "#more", 0)]);
  const posted = await lookAtFrame(page, frame);
  const postedWords = await look(page, frame, "#p1 b");
  // A draft given a count shows no number (the host drops it; the shell would draw none anyway).
  await showAndDraw(display, frame, [
    asDraft(textMark("fell", "fell", 7)),
    asDraft(elementMark("more", "#more")),
  ]);
  const drafted = await lookAtFrame(page, frame);
  const draftedWords = await look(page, frame, "#p1 b");
  expect(drafted.equals(bare), "probe: drafts are drawn").toBe(false);
  expect(drafted.equals(posted), "probe: drafts are drawn apart from posted marks").toBe(false);
  expect(draftedWords.equals(postedWords), "probe: a draft's line is not a posted one's").toBe(
    false,
  );
  if (browserName === "chromium") {
    await expect
      .poll(async () => (await layerNodes(page, frame, "marker")).map((each) => each.text), {
        message: "probe: a draft's marker has no number, even given a count",
      })
      .toEqual(["", ""]);
    for (const each of await layerNodes(page, frame, "marker")) {
      expect(each.className, "probe: each draft's marker is drawn as a draft's").toMatch(
        /(^|\s)draft(\s|$)/u,
      );
    }
    const lines = await layerNodes(page, frame, "mark");
    expect(lines.length, "both drafts are marked").toBeGreaterThanOrEqual(2);
    for (const each of lines) {
      expect(each.className, "probe: each draft's line is drawn as a draft's").toMatch(
        /(^|\s)draft(\s|$)/u,
      );
    }
  }

  // A draft and a posted mark together: each drawn its own way, each click reported for its id.
  await showAndDraw(display, frame, [
    asDraft(textMark("fell", "fell")),
    textMark("rose", "rose", 3),
    asDraft(elementMark("more", "#more")),
  ]);
  if (browserName === "chromium") {
    const markers = await layerNodes(page, frame, "marker");
    // In the layer's order (a kept marker stays where it was): as kinds and numbers.
    expect(
      markers
        .map(
          (each) =>
            `${/(^|\s)draft(\s|$)/u.test(each.className) ? "draft" : "posted"}:${each.text}`,
        )
        .sort(),
      "probe: posted marks are drawn as before, beside drafts",
    ).toEqual(["draft:", "draft:", "posted:3"]);
  }
  let count = (await reports(display)).length;
  const fell = await textMarkerPoint(frame, "#p1 b");
  await page.mouse.click(fell.x, fell.y);
  const activated = await next(display, "activated", count);
  expect(activated.id, "probe: a draft's marker click is reported for its id").toBe("fell");
  const frameBox = await (await frame.frameElement()).boundingBox();
  const left = activated.rect.x + (frameBox?.x ?? 0);
  expect(left, "probe: the reported box is the draft's marker").toBeLessThanOrEqual(fell.x);
  expect(
    left + activated.rect.width,
    "probe: the reported box is the draft's marker",
  ).toBeGreaterThanOrEqual(fell.x);
  count = (await reports(display)).length;
  const rose = await textMarkerPoint(frame, "#p2");
  await page.mouse.click(rose.x, rose.y);
  expect(
    (await next(display, "activated", count)).id,
    "probe: a posted marker's click beside drafts is reported for its id",
  ).toBe("rose");
  const more = await frame.locator("#more").boundingBox();
  if (more === null) {
    throw new Error("no button");
  }
  count = (await reports(display)).length;
  await page.mouse.click(more.x + more.width, more.y);
  expect(
    (await next(display, "activated", count)).id,
    "probe: a draft element's marker click is reported for its id",
  ).toBe("more");
  for (const attribute of [
    "data-pointerdown",
    "data-pointerup",
    "data-mousedown",
    "data-mouseup",
    "data-click",
  ]) {
    expect(
      await frame.locator("body").getAttribute(attribute),
      `probe: no draft's or posted marker's press reached the content (${attribute})`,
    ).toBeNull();
  }
});

test("what the page reads of a draft (P107): that it is one, never its count; a posted mark as before", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: DRAFTED });
  const frame = await display.frame();
  await expect(frame.locator("#more")).toBeVisible();
  await display.annotate("show", [
    asDraft(textMark("d1", "fell", 5)),
    textMark("p1", "rose", 2),
    { ...textMark("p2", "again", 1), kind: "posted" },
    elementMark("p3", "#more"),
  ]);
  await next(display, "anchored");
  await expect
    .poll(
      async () => JSON.parse((await frame.locator("body").getAttribute("data-shown")) ?? "null"),
      { message: "probe: a draft carries its kind and no count; posted marks no kind" },
    )
    .toEqual([
      { id: "d1", keys: ["anchor", "id", "kind"], kind: "draft" },
      { id: "p1", keys: ["anchor", "count", "id"], count: 2 },
      { id: "p2", keys: ["anchor", "count", "id"], count: 1 },
      { id: "p3", keys: ["anchor", "id"] },
    ]);
});

test("the shell's own checks on a raw show (P107): a draft draws no number, a kind it doesn't know is no mark", async ({
  page,
  browserName,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: DRAFTED });
  const frame = await display.frame();
  await expect(frame.locator("#more")).toBeVisible();
  // The host knows the ids (it takes reports for its own marks only).
  await showAndDraw(display, frame, [
    asDraft(textMark("d1", "fell")),
    textMark("u1", "rose", 4),
    elementMark("p1", "#more", 2),
  ]);
  // Past `checkMarks`, as a host's own transport or an older host could send it: a draft with a
  // count, a mark of a kind the shell doesn't know. Posted from the host's page, as the host is.
  const before = (await reports(display)).length;
  await (
    await frame.frameElement()
  ).evaluate(
    (element, marks) =>
      (element as HTMLIFrameElement).contentWindow?.postMessage(
        { jsonrpc: "2.0", method: "porthole/annotate.show", params: { marks } },
        "*",
      ),
    [
      { ...asDraft(textMark("d1", "fell")), count: 7 },
      { ...textMark("u1", "rose", 4), kind: "note" },
      elementMark("p1", "#more", 2),
    ],
  );
  const shown = await next(display, "anchored", before);
  expect(
    shown.results.map((each) => each.id).sort(),
    "probe: the shell drops a mark of a kind it doesn't know",
  ).toEqual(["d1", "p1"]);
  await frame.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(0))),
      ),
  );
  expect(
    (await markersOnLine(frame, "#p2 i")).runs,
    "probe: a mark of a kind the shell doesn't know has no marker",
  ).toEqual([]);
  if (browserName === "chromium") {
    expect(
      (await layerNodes(page, frame, "marker")).map((each) => each.text).sort(),
      "probe: the shell draws no number for a draft given a count",
    ).toEqual(["", "2"]);
  }
  // On every engine, by its size: a draft's marker is as wide as a bubble without a number.
  const count = (await reports(display)).length;
  const fell = await textMarkerPoint(frame, "#p1 b");
  await page.mouse.click(fell.x, fell.y);
  const activated = await next(display, "activated", count);
  expect(activated.id, "the draft's marker click is reported").toBe("d1");
  expect(
    activated.rect.width,
    "probe: the shell draws no number for a draft given a count",
  ).toBeLessThan(28);
});

test("following: drafts alone have markers, so a settled scroll is followed (P107)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: SCROLLING,
  });
  const frame = await display.frame();
  await expect(frame.locator("#far")).toBeAttached();
  await display.annotate("show", [
    asDraft(elementMark("top", "#top")),
    asDraft(textMark("near", "near paragraph")),
  ]);
  const shown = await next(display, "anchored");
  const before = new Map(shown.results.map((each) => [each.id, each.rect]));
  const count = (await reports(display)).length;
  await frame.evaluate(() => window.scrollBy(0, 200));
  await expect
    .poll(
      async () => {
        const last = (await reports(display))
          .slice(count)
          .filter(
            (each): each is Extract<AnnotationReport, { type: "anchored" }> =>
              each.type === "anchored",
          )
          .at(-1);
        const top = last?.results.find((each) => each.id === "top")?.rect?.y;
        return top === undefined ? null : Math.round((before.get("top")?.y ?? 0) - top);
      },
      { message: "probe: a draft is followed once the scroll settles", timeout: 5_000 },
    )
    .toBe(200);
});

test("following: a change of the content that moves a mark, but loses none, reports the moved marks once quiet", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: annotated(),
    content: `<p id="a">alpha beta</p><p id="b">gamma delta</p>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#b")).toBeVisible();
  await display.annotate("show", [textMark("a", "alpha beta"), textMark("b", "gamma delta", 1)]);
  const shown = await next(display, "anchored");
  const count = (await reports(display)).length;
  // A line inserted between them: b moves down, a stays.
  await frame.evaluate(() => {
    const line = document.createElement("p");
    line.textContent = "an inserted line";
    document.getElementById("b")?.before(line);
  });
  const moved = await next(display, "anchored", count);
  expect(moved.results.map((each) => each.id)).toEqual(["b"]);
  expect(moved.results[0]?.rect?.y ?? 0).toBeGreaterThan(
    shown.results.find((each) => each.id === "b")?.rect?.y ?? 0,
  );
});

test("a marker's press, of any kind, moves nothing of the content's: no handler, no focus, no selection", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: annotated(),
    content: `<p id="p1" style="font-size: 18px">Costs <b>fell</b><span id="after"> by three percent this quarter.</span></p>
<p id="p2">Some words to select here.</p>
<input id="field" value="typed">
<script>
  const seen = [];
  window.seen = seen;
  const layer = () => document.querySelector("[data-porthole-annotations]");
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "pointerover", "pointermove", "mouseover", "mousemove", "pointerenter", "mouseenter"]) {
    window.addEventListener(type, (event) => {
      if (event.target === layer()) {
        seen.push(type);
      }
    }, true);
    document.getElementById("after").addEventListener(type, () => seen.push("after:" + type));
  }
</script>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#field")).toBeVisible();
  await display.annotate("show", [textMark("fell", "fell", 3)]);
  await next(display, "anchored");
  const at = await textMarkerPoint(frame, "#p1");
  const activations = async () =>
    (await reports(display)).filter((each) => each.type === "activated").length;

  // A selection stays as it was, after a click and after a drag that starts on the marker
  // (without the press cancelled, WebKit selects from there; measured, P105: the markers'
  // user-select keeps Chromium's and Firefox's).
  expect(await select(frame, "#p2", "words to select")).toBe(true);
  await page.mouse.click(at.x, at.y);
  await expect.poll(activations).toBe(1);
  expect(
    await frame.evaluate(() => String(getSelection())),
    "probe: the selection stays as it was",
  ).toBe("words to select");
  const words = await frame.locator("#p2").boundingBox();
  if (words === null) {
    throw new Error("no words");
  }
  // Up off the marker's line, round the paragraph's left edge, down to the next line and along
  // it over its words: never over #after, wherever on its line the marker is.
  const frameBox = await (await frame.frameElement()).boundingBox();
  const left = (frameBox?.x ?? 0) + 2;
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x, at.y - 20, { steps: 1 });
  await page.mouse.move(left, at.y - 20, { steps: 4 });
  await page.mouse.move(left, words.y + words.height / 2, { steps: 4 });
  await page.mouse.move(words.x + words.width / 3, words.y + words.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect(
    await frame.evaluate(() => String(getSelection())),
    "probe: the selection stays as it was",
  ).toBe("words to select");

  // Focus stays where it was.
  await frame.locator("#field").focus();
  await page.mouse.click(at.x, at.y);
  await expect.poll(activations).toBe(2);
  expect(
    await frame.evaluate(() => document.activeElement?.id),
    "probe: focus stays where it was",
  ).toBe("field");

  // A double click is two clicks to the host and nothing to the content; a right or middle
  // click is nothing to either.
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(activations).toBe(4);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await page.mouse.click(at.x, at.y, { button: "middle" });
  await page.mouse.move(at.x + 4, at.y + 2, { steps: 4 });
  await page.waitForTimeout(400);
  expect(await activations()).toBe(4);
  expect(
    await frame.evaluate(() => (window as unknown as { seen: string[] }).seen),
    "probe: no handler of the content's heard a marker's press",
  ).toEqual([]);
  expect(
    await frame.evaluate(() => document.activeElement?.id),
    "probe: focus stays where it was",
  ).toBe("field");
});

test("a page that patches the event's built-ins neither hears a marker's press nor stops its report (P105)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: annotated(),
    content: `<p id="p1" style="font-size: 18px">Costs <b>fell</b><span id="after"> by three percent this quarter.</span></p>
<script>
  // What the review of P104 did (R1, R2): a stop that stops nothing, and a pointer said to be far off.
  Event.prototype.stopImmediatePropagation = function () {};
  for (const name of ["clientX", "clientY"]) {
    Object.defineProperty(MouseEvent.prototype, name, { configurable: true, get() { return -1e6; } });
  }
  window.heard = [];
  const layer = () => document.querySelector("[data-porthole-annotations]");
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
    window.addEventListener(type, (event) => {
      if (event.target === layer()) {
        window.heard.push(type);
      }
    }, true);
  }
</script>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#after")).toBeVisible();
  await display.annotate("show", [textMark("fell", "fell", 3)]);
  await next(display, "anchored");
  const at = await textMarkerPoint(frame, "#p1");
  const count = (await reports(display)).length;
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(
      async () =>
        (await reports(display)).slice(count).find((each) => each.type === "activated")?.id,
      { message: "probe: the marker's click is reported, the pointer read as it was" },
    )
    .toBe("fell");
  expect(
    await frame.evaluate(() => (window as unknown as { heard: string[] }).heard),
    "probe: no handler of the content's heard the marker's press",
  ).toEqual([]);
});

test("a hostile page's marker click with no gesture is dropped; one on the person's own press is the host's view to guard (P105)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const display = await referenceHost.launch(page, {
    config: annotated(),
    content: `<p id="p1" style="font-size: 18px">Costs <b>fell</b> by three percent.</p>
<button id="own" style="margin: 30px">Press me</button>
<script>
  const fake = (rect) => parent.postMessage({ jsonrpc: "2.0", method: "porthole/annotate.activated", params: { id: "fell", rect } }, "*");
  // By itself, some seconds after the marks arrive: no one did anything.
  addEventListener("message", (event) => {
    if (event.data && event.data.method === "porthole/annotate.show" && !window.timed) {
      window.timed = true;
      setTimeout(() => {
        fake({ x: 0, y: 0, width: 10, height: 10 });
        window.faked = true;
      }, 6500);
    }
  });
  // On the person's own press in the content, under their pointer (the review's R4).
  document.getElementById("own").addEventListener("pointerdown", (event) => fake({ x: event.clientX - 1, y: event.clientY - 1, width: 2, height: 2 }));
</script>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#own")).toBeVisible();
  await display.annotate("show", [textMark("fell", "fell", 3)]);
  await next(display, "anchored");
  // Nothing asks anything of either page meanwhile: a test's own evaluate is a gesture to the
  // browser (measured), and transient activation lasts 5 s on all three engines.
  await page.waitForTimeout(7_500);
  expect(
    await frame.evaluate(() => (window as unknown as { faked?: boolean }).faked),
    "the page posted its click by itself",
  ).toBe(true);
  expect(
    (await reports(display)).filter((each) => each.type === "activated"),
    "probe: the host took a marker's click no gesture came with",
  ).toEqual([]);

  // Within the person's own press in the content, it passes: the host's view must take no press
  // for 500 ms after it opens, and ignore one that began before (THREAT_MODEL §6).
  const own = await frame.locator("#own").boundingBox();
  if (own === null) {
    throw new Error("no button");
  }
  await page.mouse.move(own.x + own.width / 2, own.y + own.height / 2);
  await page.mouse.down();
  await next(display, "activated");
  await page.mouse.up();
});

test("a tap on a marker is reported on every engine, and the content hears none of it (P105)", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(90_000);
  // A touch screen on each engine, and the phone each mobile engine emulates (Firefox has none).
  const phones: Record<string, (typeof devices)[string]> = {
    webkit: devices["iPhone 13"],
    chromium: devices["Pixel 5"],
  };
  const phone = phones[browserName];
  const kinds: [string, Parameters<typeof browser.newContext>[0]][] = [
    ["touch", { hasTouch: true }],
  ];
  if (phone !== undefined) {
    const { defaultBrowserType: _engine, ...options } = phone;
    kinds.push([browserName === "webkit" ? "iPhone 13" : "Pixel 5", options]);
  }
  for (const [kind, options] of kinds) {
    const context = await browser.newContext(options);
    try {
      const page = await context.newPage();
      const display = await referenceHost.launch(page, {
        config: annotated(),
        widthPx: 360,
        content: `<p id="p1" style="font-size: 18px">Costs <b>fell</b><span id="after"> by three percent.</span></p>
<script>
  window.heard = [];
  const layer = () => document.querySelector("[data-porthole-annotations]");
  for (const type of ["touchstart", "touchend", "pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
    window.addEventListener(type, (event) => {
      if (event.target === layer()) {
        window.heard.push(type);
      }
    }, true);
  }
</script>`,
      });
      const frame = await display.frame();
      await expect(frame.locator("#after")).toBeVisible();
      await display.annotate("show", [textMark("fell", "fell", 3)]);
      await next(display, "anchored");
      const at = await textMarkerPoint(frame, "#p1");
      // Nothing asks either page anything for 6 s (an evaluate is a gesture): the tap's own
      // activation is what the host takes it by.
      await page.waitForTimeout(6_000);
      await page.touchscreen.tap(at.x, at.y);
      await expect
        .poll(
          async () => (await reports(display)).filter((each) => each.type === "activated").length,
          { message: `probe: a tap on the marker is reported (${kind})` },
        )
        .toBe(1);
      expect(
        await frame.evaluate(() => (window as unknown as { heard: string[] }).heard),
        `probe: no handler of the content's heard the tap (${kind})`,
      ).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

/** A touch screen on each engine, and the phone each mobile engine emulates (Firefox has none). */
const touchContexts = (browserName: string): [string, Parameters<Browser["newContext"]>[0]][] => {
  const phones: Record<string, (typeof devices)[string]> = {
    webkit: devices["iPhone 13"],
    chromium: devices["Pixel 5"],
  };
  const kinds: [string, Parameters<Browser["newContext"]>[0]][] = [["touch", { hasTouch: true }]];
  const phone = phones[browserName];
  if (phone !== undefined) {
    const { defaultBrowserType: _engine, ...options } = phone;
    kinds.push([browserName === "webkit" ? "iPhone 13" : "Pixel 5", options]);
  }
  return kinds;
};

/** The frame's own presses and clicks: on the shell's layer, and the page's clicks elsewhere. */
const HEARING = `<script>
  window.heard = [];
  window.clicks = [];
  const layer = () => document.querySelector("[data-porthole-annotations]");
  for (const type of ["touchstart", "touchend", "pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
    window.addEventListener(type, (event) => {
      if (event.target === layer()) {
        window.heard.push(type);
      }
    }, true);
  }
  // The page's own clickable area (WebKit makes a tap a click only on an element with a listener).
  document.getElementById("page").addEventListener("click", (event) => window.clicks.push(Math.round(event.clientY)));
</script>`;

const heardOf = (frame: Frame) =>
  frame.evaluate(() => {
    const own = window as unknown as { heard: string[]; clicks: number[] };
    return { heard: own.heard, clicks: own.clicks.length };
  });

/** The `activated` reports after the first `after`, by id. */
const activatedSince = async (display: ReferenceDisplay, after: number) =>
  (await reports(display))
    .slice(after)
    .flatMap((each) => (each.type === "activated" ? [each.id] : []));

test("on touch, a marker takes a tap a few px off its bubble (44 by 44), after the page scrolled itself; a tap past that is the page's (P119)", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  for (const [kind, options] of touchContexts(browserName)) {
    const context = await browser.newContext(options);
    try {
      const page = await context.newPage();
      const display = await referenceHost.launch(page, {
        config: presets.artifact({ capabilities: { annotate: {} } }),
        widthPx: 360,
        heightPx: 600,
        content: `<div id="page" style="padding: 900px 20px 1200px"><p id="p1" style="font-size: 18px; margin: 0">Costs <b>fell</b><span id="after"> by three percent.</span></p></div>${HEARING}`,
      });
      const frame = await display.frame();
      await expect(frame.locator("#after")).toBeAttached();
      await display.annotate("show", [textMark("fell", "fell", 1)]);
      await next(display, "anchored");
      // Raft's QA (porthole#42): the page scrolls itself, the markers follow, and settle.
      await frame.evaluate(() => window.scrollBy(0, 700));
      await page.waitForTimeout(2_500);
      const offset = (await (await frame.frameElement()).boundingBox()) ?? { x: 0, y: 0 };
      const tap = (x: number, y: number) => page.touchscreen.tap(offset.x + x, offset.y + y);
      // At its middle: its own box comes back with the report.
      const middle = await textMarkerPoint(frame, "#p1");
      let count = (await reports(display)).length;
      await page.touchscreen.tap(middle.x, middle.y);
      await expect
        .poll(() => activatedSince(display, count), {
          message: `probe: a tap on the scrolled marker is reported (${kind})`,
        })
        .toEqual(["fell"]);
      const own = (await reports(display))
        .slice(count)
        .find((each) => each.type === "activated")?.rect;
      if (own === undefined) {
        throw new Error("no box");
      }
      expect(own.height, "the bubble is as it was: 18 px").toBe(18);
      expect(own.width, "the bubble is as it was: narrower than 44 px").toBeLessThan(44);
      const x = own.x + own.width / 2;
      // 11 px below its bottom edge, 11 above its top, 4 px left of it: inside 44 by 44.
      for (const [where, px, py] of [
        ["below", x, own.y + own.height + 11],
        ["above", x, own.y - 11],
        ["beside", own.x - 4, own.y + own.height / 2],
      ] as const) {
        count = (await reports(display)).length;
        await tap(px, py);
        await expect
          .poll(() => activatedSince(display, count), {
            message: `probe: a tap ${where} the bubble, within 44 px, is the marker's (${kind})`,
          })
          .toEqual(["fell"]);
      }
      expect(await heardOf(frame), `probe: the content heard none of it (${kind})`).toEqual({
        heard: [],
        clicks: 0,
      });
      // Well past it (30 px below the bubble, 8 past the 44 px box): the page's tap, as before.
      count = (await reports(display)).length;
      await tap(x, own.y + own.height + 30);
      await expect
        .poll(async () => (await heardOf(frame)).clicks, {
          message: `probe: a tap past the 44 px box is the page's (${kind})`,
        })
        .toBe(1);
      await page.waitForTimeout(300);
      expect(await activatedSince(display, count), `no marker took it (${kind})`).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test("on touch, where two markers' 44 px boxes overlap, a tap is the nearest bubble's (P119)", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(90_000);
  for (const [kind, options] of touchContexts(browserName)) {
    const context = await browser.newContext(options);
    try {
      const page = await context.newPage();
      // Two blocks 30 px tall, one on the other: their markers, on their top right corners, are
      // 30 px apart, 12 px between their bubbles, and each one's 44 px box reaches the other's.
      const display = await referenceHost.launch(page, {
        config: annotated(),
        widthPx: 360,
        content: `<div id="page" style="padding: 60px 20px"><div id="one" style="height: 30px; width: 200px">One</div><div id="two" style="height: 30px; width: 200px">Two</div></div>${HEARING}`,
      });
      const frame = await display.frame();
      await expect(frame.locator("#two")).toBeVisible();
      await display.annotate("show", [
        elementMark("one", "#one", 1),
        elementMark("two", "#two", 1),
      ]);
      await next(display, "anchored");
      const offset = (await (await frame.frameElement()).boundingBox()) ?? { x: 0, y: 0 };
      const tap = (x: number, y: number) => page.touchscreen.tap(offset.x + x, offset.y + y);
      // Each bubble's box, from its own tap at its corner's point.
      const corner = await frame.evaluate(() =>
        ["one", "two"].map((id) => {
          const box = (document.getElementById(id) as HTMLElement).getBoundingClientRect();
          return { x: box.right, y: box.top };
        }),
      );
      const boxes: { x: number; y: number; width: number; height: number }[] = [];
      for (const [i, id] of ["one", "two"].entries()) {
        const count = (await reports(display)).length;
        await tap(corner[i]?.x ?? 0, corner[i]?.y ?? 0);
        await expect
          .poll(() => activatedSince(display, count), {
            message: `probe: a tap on marker ${id}'s bubble is reported (${kind})`,
          })
          .toEqual([id]);
        const rect = (await reports(display))
          .slice(count)
          .find((each) => each.type === "activated")?.rect;
        if (rect === undefined) {
          throw new Error("no box");
        }
        boxes.push(rect);
      }
      const [upper, lower] = boxes as [(typeof boxes)[0], (typeof boxes)[0]];
      expect(lower.y - upper.y, "the bubbles are 30 px apart").toBeCloseTo(30, 0);
      const x = upper.x + upper.width / 2;
      const between = (upper.y + upper.height + lower.y) / 2;
      // 3 px off the middle between them, outside both bubbles, inside both 44 px boxes.
      for (const [y, id] of [
        [between - 3, "one"],
        [between + 3, "two"],
      ] as const) {
        const count = (await reports(display)).length;
        await tap(x, y);
        await expect
          .poll(() => activatedSince(display, count), {
            message: `probe: the tap is the nearest bubble's, ${id} (${kind})`,
          })
          .toEqual([id]);
      }
      expect(await heardOf(frame), `probe: the content heard none of it (${kind})`).toEqual({
        heard: [],
        clicks: 0,
      });
    } finally {
      await context.close();
    }
  }
});

/**
 * Where a posted marker's bubble is drawn inside `clip` (page px): the middle of the pixels of its
 * fill (#fde68a), read from a screenshot on a blank page of the same context, or null.
 */
async function drawnBubble(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<{ x: number; y: number } | null> {
  const png = await page.screenshot({ clip, scale: "css", animations: "disabled" });
  const blank = await page.context().newPage();
  try {
    return await blank.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d") as CanvasRenderingContext2D;
      context.drawImage(image, 0, 0);
      const { data: pixels } = context.getImageData(0, 0, image.width, image.height);
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const i = (y * image.width + x) * 4;
          const near =
            Math.abs((pixels[i] ?? 0) - 253) +
            Math.abs((pixels[i + 1] ?? 0) - 230) +
            Math.abs((pixels[i + 2] ?? 0) - 138);
          if (near < 24) {
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      }
      return left > right ? null : { x: (left + right + 1) / 2, y: (top + bottom + 1) / 2 };
    }, png.toString("base64"));
  } finally {
    await blank.close();
  }
}

test("a paragraph's marker pinned at the frame's top once its start scrolled away takes a mouse click and a tap where it is drawn (P119, porthole#42)", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  for (const [kind, options] of [
    ["mouse", {}] as [string, Parameters<typeof browser.newContext>[0]],
    ...touchContexts(browserName),
  ]) {
    const context = await browser.newContext(options);
    try {
      const page = await context.newPage();
      const words =
        "The roadmap for next year is short: ship the mobile app, finish the billing rewrite. ";
      const display = await referenceHost.launch(page, {
        config: presets.artifact({ capabilities: { annotate: {} } }),
        widthPx: 360,
        heightPx: 600,
        content: `<div id="page" style="padding: 300px 20px 1200px"><p id="long" style="font-size: 16px; margin: 0">${words.repeat(12)}</p></div>${HEARING}`,
      });
      const frame = await display.frame();
      await expect(frame.locator("#long")).toBeAttached();
      await display.annotate("show", [elementMark("long", "#long", 1)]);
      await next(display, "anchored");
      // The page scrolls itself: the paragraph's start 150 px above the frame's top.
      await frame.evaluate(() => {
        const top = (document.getElementById("long") as HTMLElement).getBoundingClientRect().top;
        window.scrollBy(0, top + 150);
      });
      await page.waitForTimeout(2_500);
      expect(
        await frame.evaluate(() =>
          Math.round((document.getElementById("long") as HTMLElement).getBoundingClientRect().top),
        ),
        "the paragraph starts above the frame",
      ).toBeLessThan(-100);
      // Where the bubble is drawn, as the person sees it: its fill's pixels in the frame's top
      // 40 px (no pointer has been over it yet). Not where the layer takes the pointer.
      const offset = (await (await frame.frameElement()).boundingBox()) ?? { x: 0, y: 0 };
      const drawn = await drawnBubble(page, { x: offset.x, y: offset.y, width: 360, height: 40 });
      expect(drawn, `a bubble is drawn at the frame's top (${kind})`).not.toBeNull();
      const at = { x: offset.x + (drawn?.x ?? 0), y: offset.y + (drawn?.y ?? 0) };
      const count = (await reports(display)).length;
      if (kind === "mouse") {
        await page.mouse.click(at.x, at.y);
      } else {
        await page.touchscreen.tap(at.x, at.y);
      }
      await expect
        .poll(() => activatedSince(display, count), {
          message: `probe: the pinned marker's ${kind === "mouse" ? "click" : "tap"} is reported (${kind})`,
        })
        .toEqual(["long"]);
      const rect = (await reports(display))
        .slice(count)
        .find((each) => each.type === "activated")?.rect;
      expect(rect?.y, `the reported bubble is the one drawn at the top (${kind})`).toBeLessThan(4);
      expect(await heardOf(frame), `probe: the content heard none of it (${kind})`).toEqual({
        heard: [],
        clicks: 0,
      });
    } finally {
      await context.close();
    }
  }
});

test("a mouse is as before: a click just off a marker's bubble is the page's, also on a touch screen after a finger (P119)", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  for (const [kind, options] of [
    ["mouse", {}],
    ["touch screen", { hasTouch: true }],
  ] as const) {
    const context = await browser.newContext(options);
    try {
      const page = await context.newPage();
      const display = await referenceHost.launch(page, {
        config: annotated(),
        widthPx: 360,
        content: `<div id="page" style="padding: 80px 20px"><p id="p1" style="font-size: 18px; margin: 0">Costs <b>fell</b><span id="after"> by three percent.</span></p></div>${HEARING}`,
      });
      const frame = await display.frame();
      await expect(frame.locator("#after")).toBeVisible();
      await display.annotate("show", [textMark("fell", "fell", 1)]);
      await next(display, "anchored");
      const offset = (await (await frame.frameElement()).boundingBox()) ?? { x: 0, y: 0 };
      if (kind === "touch screen") {
        // A finger first, on the page: the markers take 44 px boxes, until the mouse moves.
        await page.touchscreen.tap(offset.x + 10, offset.y + 10);
        await expect.poll(async () => (await heardOf(frame)).clicks).toBe(1);
      }
      const middle = await textMarkerPoint(frame, "#p1");
      let count = (await reports(display)).length;
      await page.mouse.click(middle.x, middle.y);
      await expect.poll(() => activatedSince(display, count)).toEqual(["fell"]);
      const own = (await reports(display))
        .slice(count)
        .find((each) => each.type === "activated")?.rect;
      if (own === undefined) {
        throw new Error("no box");
      }
      const clicks = (await heardOf(frame)).clicks;
      count = (await reports(display)).length;
      // 11 px below the bubble, and 4 px beside it.
      await page.mouse.click(offset.x + own.x + own.width / 2, offset.y + own.y + own.height + 11);
      await page.mouse.click(offset.x + own.x - 4, offset.y + own.y + own.height / 2);
      await expect
        .poll(async () => (await heardOf(frame)).clicks, {
          message: `probe: a mouse click just off the bubble is the page's (${kind})`,
        })
        .toBe(clicks + 2);
      await page.waitForTimeout(300);
      expect(
        await activatedSince(display, count),
        `probe: no marker took a mouse click off its bubble (${kind})`,
      ).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

// The page #36 was judged on (P105): 16 px text, line height 1.6, a 640 px column or a phone's
// full width with 20 px padding; anchors ending mid-line, at a line's end, at a wrapped line's
// start, two on one line, in a card, in a table's cell; elements.
const PLACED = (column: string) => `<!doctype html><html><head><title>Notes</title><style>
body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2328; background: #fff; }
main { ${column} }
h2 { font-size: 22px; line-height: 1.3; margin: 0 0 12px; }
p { margin: 0 0 14px; }
.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0 0 14px; }
.card { border: 1px solid #d0d7de; border-radius: 8px; padding: 10px 12px; }
table { border-collapse: collapse; width: 100%; margin: 0 0 14px; }
td, th { border-bottom: 1px solid #d0d7de; padding: 4px 8px; text-align: left; }
</style></head><body><main>
<h2 id="title">Quarterly review</h2>
<p id="p1">Revenue grew 12% over the last quarter, mostly from the two new regions, while costs stayed flat even though we hired two engineers and one designer before the summer began.</p>
<p id="p2">The roadmap for next year is short: ship the mobile app, finish the billing rewrite, move the reports to the new storage, and hire one more person for support before the busy season.</p>
<div class="cards"><div class="card" id="c1">Churn fell to 2.1% this quarter, the lowest in two years.</div><div class="card" id="c2">Support tickets rose by a third after the launch.</div></div>
<table><tr><th>Region</th><th>Revenue</th><th>Growth</th></tr><tr><td>North</td><td id="north">$1.2M</td><td>+14%</td></tr><tr><td>South</td><td>$0.8M</td><td>+9%</td></tr></table>
<p id="p3">Next steps are listed in the plan, with owners and dates for each of them.</p>
</main></body></html>`;

/** Phrases by where they end as the page is laid out: at a line's end, at a wrapped line's start, two on one line. */
const phrasesOf = (frame: Frame) =>
  frame.evaluate(() => {
    const words = (id: string) => {
      const node = document.getElementById(id)?.firstChild as Text;
      const text = node.nodeValue ?? "";
      return {
        text,
        all: Array.from(text.matchAll(/\S+/gu), (match) => {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          return {
            start: match.index,
            end: match.index + match[0].length,
            top: Math.round(range.getBoundingClientRect().top),
          };
        }),
      };
    };
    const breakAfter = (list: { top: number }[]) =>
      list.findIndex((each, i) => list[i + 1] !== undefined && list[i + 1]?.top !== each.top);
    const p1 = words("p1");
    const p2 = words("p2");
    const end1 = breakAfter(p1.all);
    const end2 = breakAfter(p2.all);
    const second = p2.all.filter((each) => each.top === p2.all[end2 + 1]?.top);
    const slice = (of: typeof p1, from: number, to: number) =>
      of.text.slice(of.all[from]?.start, of.all[to]?.end);
    return {
      lineEnd: slice(p1, end1 - 1, end1),
      wrapped: slice(p2, end2, end2 + 1),
      firstOfTwo: p2.text.slice(second[2]?.start, second[3]?.end),
      secondOfTwo: p2.text.slice(second[5]?.start, second[6]?.end),
    };
  });

/** The words any marker covers: every word's glyph boxes against the points the layer takes (2 px). */
const coveredWords = (frame: Frame) =>
  frame.evaluate(() => {
    const layer = document.querySelector("[data-porthole-annotations]");
    const on = new Set<string>();
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        if (document.elementFromPoint(x, y) === layer) {
          on.add(`${x},${y}`);
        }
      }
    }
    const covered: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      for (const match of (node.nodeValue ?? "").matchAll(/\S+/gu)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        for (const box of Array.from(range.getClientRects())) {
          let hit = false;
          for (let y = Math.ceil(box.top / 2) * 2; y < box.bottom && !hit; y += 2) {
            for (let x = Math.ceil(box.left / 2) * 2; x < box.right && !hit; x += 2) {
              hit = on.has(`${x},${y}`);
            }
          }
          if (hit) {
            covered.push(match[0]);
          }
        }
      }
    }
    return { markerPoints: on.size, covered };
  });

test("text markers cover no word: on a column page, and on a phone's lines with one marker each (P105, #36)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [kind, column, width, height] of [
    ["column", "max-width: 640px; margin: 0 auto; padding: 24px 20px;", 1000, 640],
    ["phone", "padding: 20px;", 390, 820],
  ] as const) {
    const display = await referenceHost.launch(page, {
      config: presets.artifact({ capabilities: { annotate: {} } }),
      content: PLACED(column),
      widthPx: width,
      heightPx: height,
    });
    const frame = await display.frame();
    await expect(frame.locator("#p3")).toBeVisible();
    const at = await phrasesOf(frame);
    const count = (await reports(display)).length;
    await display.annotate("show", [
      textMark("mid", "Revenue grew 12%", 3),
      textMark("card", "lowest in two years", 4),
      textMark("cell", "$1.2M", 7),
      elementMark("title", "#title", 0),
      elementMark("c2", "#c2", 2),
      // Posted, each goes to its paragraph's end (P133), where on a phone two or three can't all
      // fit beside a full last line: the column only (P105). A draft stays by its words: at the
      // start of a line, with the rest of it beside them, and a marker just past them covers those.
      ...(kind === "column"
        ? [
            textMark("hire", "one designer", 99),
            textMark("end", at.lineEnd, 1),
            textMark("wrap", at.wrapped, 12),
            textMark("two-a", at.firstOfTwo, 2),
            textMark("two-b", at.secondOfTwo, 5),
            asDraft(textMark("next", "Next steps")),
          ]
        : []),
    ]);
    await next(display, "anchored", count);
    await page.waitForTimeout(400);
    const { markerPoints, covered } = await coveredWords(frame);
    expect(markerPoints, `the markers are drawn (${kind})`).toBeGreaterThan(0);
    expect(covered, `probe: no marker covers a word (${kind})`).toEqual([]);
  }
});

test("a posted comment's marker sits at its paragraph's end, past the last word, a nested block's words not its own; a draft's stays by its words (P133)", async ({
  page,
}) => {
  const words = "All of these words wrap the paragraph on to its next lines. ".repeat(6);
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    widthPx: 420,
    heightPx: 640,
    content: `<!doctype html><html><head><title>Ends</title></head><body style="margin: 20px; font-size: 16px">
<p id="para">Alpha <b id="word">beta</b> gamma. ${words}<br>The end.</p>
<ul><li id="item">An <b id="inner">item</b> with more.<ul><li id="nested">Its nested words.</li></ul></li></ul>
</body></html>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#nested")).toBeVisible();
  await showAndDraw(display, frame, [
    textMark("second", "gamma", 2),
    textMark("first", "beta", 3),
    textMark("inner", "item", 1),
  ]);
  /** How far right the words of `selector`'s last line reach. */
  const wordsEnd = (selector: string) =>
    frame.evaluate((where) => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(where) as Node);
      const last = Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0)
        .at(-1);
      return last?.right ?? 0;
    }, selector);
  // On the paragraph's last line, just past its words, in the order their own words end; none is
  // left on the words' own line.
  const end = await markersOnLine(frame, "#para");
  expect(end.runs, "probe: both markers are on the paragraph's last line").toHaveLength(2);
  const right = await wordsEnd("#para");
  expect(end.runs[0]?.left, "probe: past the paragraph's last word").toBeGreaterThanOrEqual(right);
  expect(end.runs[0]?.left, "probe: just past it, not in the gutter").toBeLessThan(right + 14);
  expect(
    (await markersOnLine(frame, "#word")).runs,
    "probe: nothing stays on the words' own line",
  ).toEqual([]);
  const count = (await reports(display)).length;
  const { x, y } = await textMarkerPoint(frame, "#para");
  await page.mouse.click(x, y);
  expect(
    (await next(display, "activated", count)).id,
    "probe: those on one paragraph's end go in the order their words end",
  ).toBe("first");
  // A list item's words end where its nested list starts: that list is its own paragraph.
  expect(
    (await markersOnLine(frame, "#inner")).runs,
    "probe: the item's marker is on the item's own last line",
  ).toHaveLength(1);
  expect(
    (await markersOnLine(frame, "#nested")).runs,
    "probe: not on a nested block's words",
  ).toEqual([]);

  // A draft stays beside the words being written on, a posted mark on the same words moves.
  await showAndDraw(display, frame, [
    asDraft(textMark("draft", "beta")),
    textMark("posted", "gamma", 2),
  ]);
  expect(
    (await markersOnLine(frame, "#word")).runs,
    "probe: a draft's marker stays on its words' line",
  ).toHaveLength(1);
  expect(
    (await markersOnLine(frame, "#para")).runs,
    "probe: the posted one's is at the paragraph's end",
  ).toHaveLength(1);
});

/** A page of two short paragraphs and a field, hearing what reaches it of a key on the layer. */
const KEYED = `<p id="p1" style="font-size: 18px">Costs <b>fell</b> by three percent.</p>
<p id="p2" style="font-size: 18px">Sales <i>rose</i> by two percent.</p>
<input id="field" value="typed">
<script>
  window.heard = [];
  const layer = () => document.querySelector("[data-porthole-annotations]");
  for (const type of ["keydown", "keypress", "keyup", "click"]) {
    window.addEventListener(type, (event) => {
      if (event.target === layer() && (type === "click" || event.key === "Enter" || event.key === " ")) {
        window.heard.push(type);
      }
    }, true);
  }
</script>`;

/** Whether the page's focus is on the shell's layer: on one of its markers, to the page. */
const onLayer = (frame: Frame) =>
  frame.evaluate(
    () => document.activeElement === document.querySelector("[data-porthole-annotations]"),
  );

test("a marker is a button the keyboard reaches: Tab in reading order, Enter and Space report it once, the content hears neither, and it steps aside while elements are picked (P133)", async ({
  page,
  browserName,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: KEYED });
  const frame = await display.frame();
  await expect(frame.locator("#field")).toBeVisible();
  // Shown out of the page's order: the keyboard goes by the page, not by the host's list.
  await showAndDraw(display, frame, [textMark("rose", "rose", 2), textMark("fell", "fell", 1)]);
  expect(
    await frame.locator("[data-porthole-annotations]").getAttribute("aria-hidden"),
    "probe: the layer isn't hidden from assistive technology",
  ).toBeNull();
  if (browserName === "chromium") {
    expect(
      (await layerNodes(page, frame, "marker")).map(({ tag, name }) => ({ tag, name })),
      "probe: each marker is a button named for what it is, in the page's order",
    ).toEqual([
      { tag: "BUTTON", name: '1 comment on "fell"' },
      { tag: "BUTTON", name: '2 comments on "rose"' },
    ]);
  }
  await frame.locator("#field").focus();

  await page.keyboard.press("Tab");
  await expect.poll(() => onLayer(frame), { message: "probe: Tab reaches a marker" }).toBe(true);
  let count = (await reports(display)).length;
  await page.keyboard.press("Enter");
  const first = await next(display, "activated", count);
  expect(first.id, "probe: Enter reports the page's first marker").toBe("fell");
  expect(first.rect.width, "probe: with the marker's box").toBeGreaterThan(0);

  await page.keyboard.press("Tab");
  count = (await reports(display)).length;
  await page.keyboard.press("Space");
  const second = await next(display, "activated", count);
  expect(second.id, "probe: Tab goes on to the next, Space reports it").toBe("rose");
  expect(second.rect.y, "probe: the next marker's box").toBeGreaterThan(first.rect.y);

  // Held down, a key clicks once: each repeat would spend the bridge's rate.
  count = (await reports(display)).length;
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await next(display, "activated", count);
  await page.waitForTimeout(300);
  expect(
    (await reports(display)).slice(count).filter((each) => each.type === "activated"),
    "probe: a key held down clicks once",
  ).toHaveLength(1);

  await expect(frame.locator("#field"), "typing goes nowhere near the field").toHaveValue("typed");
  expect(
    await frame.evaluate(() => (window as unknown as { heard: string[] }).heard),
    "probe: the content heard no key that clicks a marker, and no click",
  ).toEqual([]);

  // Picking elements, markers step aside: the key on one reports nothing, and Tab passes them.
  await display.annotate("start", { elements: true, text: false });
  await frame.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(0))),
      ),
  );
  count = (await reports(display)).length;
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect(
    (await reports(display)).slice(count).filter((each) => each.type === "activated"),
    "probe: no marker reports while elements are picked",
  ).toEqual([]);
});

test("a marker out of view brings itself into view as the keyboard reaches it, and keeps the focus as the page scrolls and redraws (P133)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    heightPx: 500,
    content: `<!doctype html><html><head><title>Long</title></head><body style="margin: 8px">
<input id="field"><p id="near">The near words.</p>
<div style="height: 2000px">spacer</div>
<p id="far">The far words.</p>
<div style="height: 1500px">spacer</div>
</body></html>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#far")).toBeAttached();
  await showAndDraw(display, frame, [textMark("near", "near", 1), textMark("far", "far", 2)]);
  await frame.locator("#field").focus();
  // Key by key until the far marker has it: on Firefox under the controls two presses in a row
  // sometimes didn't get there. Why isn't known.
  await expect
    .poll(
      async () => {
        await page.keyboard.press("Tab");
        return frame.evaluate(() => Math.round(window.scrollY));
      },
      { message: "probe: the document scrolled to the marker", intervals: [250], timeout: 10_000 },
    )
    .toBeGreaterThan(1_500);
  await expect
    .poll(async () => (await markersOnLine(frame, "#far")).runs.length, {
      message: "probe: the marker is drawn on its line, the layer not scrolled away from it",
    })
    .toBe(1);
  expect(await onLayer(frame), "probe: it has the focus").toBe(true);
  // Redraws, of a scroll and of a change of the content, leave it there.
  await frame.evaluate(() => window.scrollBy(0, 40));
  await frame.evaluate(() => document.body.append(document.createElement("div")));
  await page.waitForTimeout(600);
  expect(await onLayer(frame), "probe: a redraw leaves the focus on the marker").toBe(true);
  const count = (await reports(display)).length;
  await page.keyboard.press("Enter");
  expect(
    (await next(display, "activated", count)).id,
    "probe: the key is still the same marker's",
  ).toBe("far");
});

test("focusMark puts the focus on that mark's marker and tells nothing; no such marker, a moved page or picking, and it does nothing (P134)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: KEYED });
  const frame = await display.frame();
  await expect(frame.locator("#field")).toBeVisible();
  await showAndDraw(display, frame, [
    textMark("fell", "fell", 1),
    textMark("rose", "rose", 2),
    textMark("bare", "two percent"),
    textMark("gone", "not on this page", 3),
  ]);

  // As a host's card closes on Escape: its field goes, focus with it, and then the host asks.
  await page.evaluate(() => {
    const card = document.createElement("textarea");
    card.id = "card";
    document.body.append(card);
    card.focus();
  });
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.getElementById("card")?.remove());
  const told = (await reports(display)).length;
  expect(
    await display.annotate("focusMark", "rose"),
    "probe: a shown marker is no fault",
  ).toBeNull();
  await expect
    .poll(() => onLayer(frame), { message: "probe: the focus is on a marker" })
    .toBe(true);
  expect(
    await page.evaluate(() => document.activeElement?.localName),
    "probe: the frame is what the host's page reads as focused",
  ).toBe("iframe");
  await page.waitForTimeout(300);
  // By content: a control's follow-up may come first, and `anchored` isn't this call's.
  expect(
    (await reports(display)).slice(told).filter((report) => report.type !== "anchored"),
    "probe: the move tells the host nothing",
  ).toEqual([]);
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await reports(display))
          .slice(told)
          .some((report) => report.type === "activated" && report.id === "rose"),
      { message: "probe: it is the marker asked for" },
    )
    .toBe(true);

  // From here the page's field holds the focus, and each of these must leave it there.
  await frame.locator("#field").focus();
  const leftAlone = async (id: string, why: string) => {
    expect(await display.annotate("focusMark", id), `probe: no fault: ${why}`).toBeNull();
    await page.waitForTimeout(300);
    expect(
      await frame.evaluate(() => document.activeElement?.id),
      `probe: the focus stays where it was: ${why}`,
    ).toBe("field");
  };
  await leftAlone("nope", "no mark has this id");
  await leftAlone("bare", "a mark without a marker");
  await leftAlone("gone", "a mark whose words were never found");
  await frame.evaluate(() => document.getElementById("p2")?.remove());
  await expect
    .poll(
      async () =>
        (await reports(display)).some(
          (report) =>
            report.type === "anchored" &&
            report.results.some((each) => each.id === "rose" && each.state === "orphaned"),
        ),
      { message: "probe: the page took the marked words away" },
    )
    .toBe(true);
  await leftAlone("rose", "the page took the marker's words away");
  await display.annotate("start", { elements: true, text: false });
  await leftAlone("fell", "markers step aside while elements are picked");
});

test("focusMark right after a show, with the focus in the frame, waits for the marker, and the focus brings it into view (P134, P135)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    heightPx: 500,
    content: `<!doctype html><html><head><title>Long</title></head><body style="margin: 8px">
<p id="near">The near words.</p>
<div style="height: 2000px">spacer</div>
<p id="far">The far words.</p>
<div style="height: 1500px">spacer</div>
</body></html>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#far")).toBeAttached();
  await display.showAndFocusMark([textMark("near", "near", 1), textMark("far", "far", 2)], "far", {
    focus: true,
  });
  await expect
    .poll(() => onLayer(frame), { message: "probe: the marker got the focus once it was drawn" })
    .toBe(true);
  await expect
    .poll(() => frame.evaluate(() => Math.round(window.scrollY)), {
      message: "probe: the document scrolled to the marker",
    })
    .toBeGreaterThan(1_500);
});

/** What holds the focus on the host's page: an element's id, or its tag. */
const hostActive = (page: Page) =>
  page.evaluate(() => document.activeElement?.id || document.activeElement?.localName);

/** The person moves on: the focus goes to a button of the host's own, beside the frame. */
async function moveOn(page: Page) {
  await page.evaluate(() => {
    const button = document.getElementById("next") ?? document.createElement("button");
    button.id = "next";
    button.textContent = "Next";
    document.body.append(button);
    button.focus({ preventScroll: true });
  });
  await expect
    .poll(() => hostActive(page), { message: "the host's button has the focus" })
    .toBe("next");
}

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

/**
 * Past the moment a focusMark parked by a `show` of `id` lands or is dropped: the shell does that in
 * the task that reports the mark, so the report (by what it says), then a task of the frame's.
 */
async function pastLanding(page: Page, display: ReferenceDisplay, frame: Frame, id: string) {
  await expect
    .poll(
      async () =>
        (await reports(display)).some(
          (report) => report.type === "anchored" && report.results.some((one) => one.id === id),
        ),
      { message: `the frame found ${id}` },
    )
    .toBe(true);
  await frame.evaluate(() => 0);
  await page.waitForTimeout(300);
}

test("document.hasFocus() in a frame says where a host's moves leave the focus, on each engine: what a parked focusMark reads (P135)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: KEYED });
  const frame = await display.frame();
  await expect(frame.locator("#field")).toBeVisible();
  await showAndDraw(display, frame, [textMark("fell", "fell", 1)]);
  const inFrame = (message: string, expected: boolean) =>
    expect
      .poll(() => frame.evaluate(() => document.hasFocus()), { message: `probe: ${message}` })
      .toBe(expected);

  await closeCard(page);
  await inFrame("a host's card closed: the focus on its body isn't in the frame", false);
  await display.focus();
  await inFrame("the host's own move puts it in the frame", true);
  await frame.locator("#field").focus();
  await inFrame("the page's own field is in the frame", true);
  await moveOn(page);
  await inFrame("a host's button isn't", false);
  await display.focus();
  await inFrame("the host's move brings it back to a frame that had it", true);
  await closeCard(page);
  await inFrame("from the frame, a card that opens and closes leaves it out again", false);
  await display.annotate("focusMark", "fell");
  await expect
    .poll(() => onLayer(frame), { message: "probe: an unparked call lands from the body" })
    .toBe(true);
  await inFrame("a marker the host moved to is in the frame", true);
});

test("a parked focusMark doesn't land once the person has moved on to the host's button (P135)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: KEYED });
  const frame = await display.frame();
  await expect(frame.locator("#field")).toBeVisible();
  await showAndDraw(display, frame, [textMark("fell", "fell", 1)]);

  // On the host's button before the frame took the word: parked while the show's marks are found.
  await moveOn(page);
  await display.showAndFocusMark(
    [textMark("fell", "fell", 1), textMark("rose", "rose", 2)],
    "rose",
  );
  await pastLanding(page, display, frame, "rose");
  expect(await onLayer(frame), "probe: the parked mark didn't land").toBe(false);
  expect(await hostActive(page), "probe: the keyboard stayed on the host's button").toBe("next");
});

test("a focusMark parked with the focus in the frame doesn't land once the person moves on while it waits (P135)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: KEYED });
  const frame = await display.frame();
  await expect(frame.locator("#field")).toBeVisible();
  await showAndDraw(display, frame, [textMark("fell", "fell", 1)]);

  // On a page that keeps changing, so the word waits: what counts is where the focus is as it
  // would land, not as it came.
  await frame.locator("#field").focus();
  await expect
    .poll(() => frame.evaluate(() => document.hasFocus()), { message: "the frame has the focus" })
    .toBe(true);
  // The first change now, not at the first tick: the observer runs before this evaluation answers,
  // so the word is sure to find the page changing. And the page notes a landing as it happens: if
  // the word lands before the person moves on, the move can take the marker's focus with it, and
  // a look at the end would see nothing.
  await frame.evaluate(() => {
    document.addEventListener("focusin", (event) => {
      if (event.target === document.querySelector("[data-porthole-annotations]")) {
        document.body.dataset.landed = "yes";
      }
    });
    const until = Date.now() + 700;
    document.body.append(document.createElement("i"));
    const changing = setInterval(() => {
      document.body.append(document.createElement("i"));
      if (Date.now() > until) {
        clearInterval(changing);
        document.body.dataset.calm = "yes";
      }
    }, 40);
  });
  await display.annotate("focusMark", "fell");
  await frame.evaluate(() => 0);
  await moveOn(page);
  await expect(frame.locator("body")).toHaveAttribute("data-calm", "yes");
  await page.waitForTimeout(500);
  expect(
    await frame.locator("body").getAttribute("data-landed"),
    "probe: moved on while it waited, it didn't land",
  ).toBeNull();
  expect(await onLayer(frame), "probe: and the marker doesn't hold the page's focus").toBe(false);
  expect(await hostActive(page), "probe: the keyboard stayed on the host's button").toBe("next");
});

test("a parked focusMark with the focus on the host's body is dropped; after the host's own move into the frame a second one, parked too, lands on the marker (P135)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: KEYED });
  const frame = await display.frame();
  await expect(frame.locator("#field")).toBeVisible();
  await showAndDraw(display, frame, [textMark("fell", "fell", 1)]);

  await closeCard(page);
  await display.showAndFocusMark(
    [textMark("fell", "fell", 1), textMark("rose", "rose", 2)],
    "rose",
  );
  await pastLanding(page, display, frame, "rose");
  expect(await onLayer(frame), "probe: no focus in the frame, no grab").toBe(false);
  expect(await hostActive(page), "probe: the focus stayed on the body").toBe("body");

  await display.showAndFocusMark(
    [
      textMark("fell", "fell", 1),
      textMark("rose", "rose", 2),
      textMark("again", "three percent", 3),
    ],
    "rose",
    { focus: true },
  );
  await pastLanding(page, display, frame, "again");
  await expect
    .poll(() => onLayer(frame), { message: "probe: the second, parked too, landed on a marker" })
    .toBe(true);
  expect(await hostActive(page), "probe: the frame holds the host's page's focus").toBe("iframe");
  const told = (await reports(display)).length;
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await reports(display))
          .slice(told)
          .some((report) => report.type === "activated" && report.id === "rose"),
      { message: "probe: it is the marker asked for" },
    )
    .toBe(true);
});

test("a page that patched hasFocus to say yes gets no landing the platform's own answer refuses (P135)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: annotated(),
    content: `${KEYED}<script>Document.prototype.hasFocus = () => true;</script>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#field")).toBeVisible();
  await showAndDraw(display, frame, [textMark("fell", "fell", 1)]);
  await moveOn(page);
  expect(await frame.evaluate(() => document.hasFocus()), "the page's own hasFocus says yes").toBe(
    true,
  );
  await display.showAndFocusMark(
    [textMark("fell", "fell", 1), textMark("rose", "rose", 2)],
    "rose",
  );
  await pastLanding(page, display, frame, "rose");
  expect(await onLayer(frame), "probe: the page's word didn't land the mark").toBe(false);
  expect(await hostActive(page), "probe: the keyboard stayed on the host's button").toBe("next");
});

test("a page that patched focus isn't handed the marker the host's focusMark moves to (P134)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: annotated(),
    content: `${KEYED}<script>
  window.reached = [];
  const own = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (...args) {
    window.reached.push(this.localName);
    return own.apply(this, args);
  };
</script>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#field")).toBeVisible();
  await showAndDraw(display, frame, [textMark("fell", "fell", 1)]);
  await display.annotate("focusMark", "fell");
  await expect.poll(() => onLayer(frame), { message: "the focus is on the marker" }).toBe(true);
  expect(
    await frame.evaluate(() => (window as unknown as { reached: string[] }).reached),
    "probe: the page's own focus never saw the marker",
  ).toEqual([]);
});

test("a marker's name is the words it is on, in quotes, with no element's tag; what the host stores keeps it (P134)", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the closed layer is read through Chromium's inspector");
  const display = await referenceHost.launch(page, { config: annotated(), content: KEYED });
  const frame = await display.frame();
  await expect(frame.locator("#p1")).toBeVisible();
  await display.annotate("start", { elements: true, text: false });
  await frame.locator("#p1").click();
  const picked = await next(display, "selected");
  await display.annotate("stop");
  expect(picked.anchor.label, "probe: the anchor the host stores is as it was").toBe(
    "p#p1 Costs fell by three percent.",
  );
  await showAndDraw(display, frame, [
    { id: "para", anchor: picked.anchor, count: 1 },
    elementMark("wordless", "#field", 2),
    { id: "draft", anchor: textMark("x", "rose").anchor, kind: "draft" },
  ]);
  expect(
    (await layerNodes(page, frame, "marker"))
      .map(({ name }) => String(name))
      .toSorted((a, b) => a.localeCompare(b)),
    "probe: each marker is named for its words, an element's tag left out",
  ).toEqual([
    '1 comment on "Costs fell by three percent."',
    "2 comments",
    'Draft comment on "rose"',
  ]);
});

/** ADOPTING.md's guardPresses, as it is written there: the duty's reference code (P105). */
const GUARD = (() => {
  const doc = readFileSync(new URL("../../../docs/ADOPTING.md", import.meta.url), "utf8");
  const at = doc.indexOf("function guardPresses(");
  const code = doc.slice(at, doc.indexOf("```", at));
  return code.replace(/^ {2}/gmu, "");
})();

test("ADOPTING's guard: a view a report opens takes no press for 500 ms, nor one begun before, then takes them (P105)", async ({
  page,
}) => {
  expect(GUARD, "ADOPTING.md has the guard").toContain("placed");
  // A view opening on the person's press in the content, under the pointer (as the review's R4,
  // R9): a plain button, a menu item that clicks itself when a press ends on it (Radix's, Base
  // UI's), a trigger acting on pointerdown.
  await page.setContent(`<!doctype html><body style="margin:0">
<div id="content" style="position:absolute;left:0;top:0;width:400px;height:300px;background:#eee">content</div>
<div id="view" style="position:absolute;left:150px;top:100px;width:200px;height:120px;background:#fff;display:none">
  <button id="plain" style="display:block;width:200px;height:40px">Resolve</button>
  <div id="item" role="menuitem" style="width:200px;height:40px;background:#fcc">Delete</div>
  <div id="trigger" style="width:200px;height:40px;background:#ccf">More</div>
</div>
<script>
${GUARD}
  window.fired = [];
  const view = document.getElementById("view");
  const guard = guardPresses(view);
  document.getElementById("plain").addEventListener("click", () => fired.push("plain"));
  const item = document.getElementById("item");
  let down = false;
  item.addEventListener("pointerdown", () => (down = true));
  item.addEventListener("pointerup", () => { if (!down) item.click(); down = false; });
  item.addEventListener("click", () => fired.push("item"));
  document.getElementById("trigger").addEventListener("pointerdown", () => fired.push("trigger"));
  window.open = () => { view.style.display = "block"; guard.placed(); };
  document.getElementById("content").addEventListener("pointerdown", () => open());
</script>`);
  const fired = () =>
    page.evaluate(() => (window as unknown as { fired: string[] }).fired.splice(0));
  const close = () =>
    page.evaluate(() => {
      (document.getElementById("view") as HTMLElement).style.display = "none";
    });
  // A press in the content that ends where the menu item opened under it.
  await page.mouse.move(250, 160);
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.up();
  expect(await fired(), "probe: a release on the menu item, within 500 ms").toEqual([]);
  // A double click whose second press lands on the button, or on the trigger.
  for (const [y, what] of [
    [120, "button"],
    [200, "trigger"],
  ] as const) {
    await close();
    await page.mouse.click(250, y);
    await page.mouse.click(250, y);
    expect(await fired(), `probe: a double click's second press, on the ${what}`).toEqual([]);
  }
  // A press begun in the content, held past the 500 ms, released on the menu item.
  await close();
  await page.mouse.move(250, 160);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  expect(await fired(), "probe: a press that began before the view did, ended on it").toEqual([]);
  // Once armed, the person's own press, or key, is taken.
  await page.waitForTimeout(100);
  await page.mouse.click(250, 120);
  expect(await fired(), "a press begun on the view after 500 ms").toEqual(["plain"]);
  await page.focus("#plain");
  await page.keyboard.press("Enter");
  expect(await fired(), "a key on the view after 500 ms").toEqual(["plain"]);
});

test("every found mark's place in the document comes with its box, offscreen ones too; a place that isn't one is no report (P112)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: SCROLLING,
  });
  const frame = await display.frame();
  await expect(frame.locator("#far")).toBeAttached();
  // Shown last first: the places are the document's, not the show's.
  await display.annotate("show", [
    textMark("far", "far paragraph says", 1),
    textMark("near", "The near paragraph.", 2),
    textMark("lost", "words nowhere in it"),
  ]);
  const anchored = await next(display, "anchored");
  const placeOf = (id: string) => anchored.results.find((each) => each.id === id)?.order;
  expect(placeOf("near")).toBe(0);
  expect(placeOf("far"), "the offscreen mark has its place too").toBe(1);
  expect(placeOf("lost"), "an orphan has none").toBeUndefined();
  const before = (await reports(display)).length;
  for (const order of [-1, 1.5, 500, "0"]) {
    await frame.evaluate(
      (place) =>
        parent.postMessage(
          {
            jsonrpc: "2.0",
            method: "porthole/annotate.anchored",
            params: {
              results: [
                {
                  id: "near",
                  state: "attached",
                  rect: { x: 0, y: 0, width: 1, height: 1 },
                  order: place,
                },
              ],
            },
          },
          "*",
        ),
      order,
    );
  }
  await page.waitForTimeout(500);
  expect(
    (await reports(display)).slice(before),
    "probe: a place that isn't a whole number below the most marks is no report",
  ).toEqual([]);
});

test("a followed mark's box comes as it moves, for that mark only, at most 60 a second, clamped to the frame, until the host stops (P112)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: SCROLLING,
  });
  const frame = await display.frame();
  await expect(frame.locator("#far")).toBeAttached();
  await display.annotate("show", [
    textMark("near", "The near paragraph.", 2),
    textMark("far", "far paragraph says", 1),
  ]);
  await next(display, "anchored");
  expect(await display.annotate("track", "nobody"), "only a shown mark is followed").toMatch(
    /no mark/u,
  );
  expect(await display.annotate("track", "near")).toBeNull();
  const tracked = async () =>
    (await reports(display)).filter(
      (each): each is Extract<AnnotationReport, { type: "tracked" }> => each.type === "tracked",
    );
  const start = (await tracked()).length;
  const box = await (await frame.frameElement()).boundingBox();
  if (box === null) {
    throw new Error("no frame");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 10; i += 1) {
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(50);
  }
  await expect.poll(async () => (await tracked()).length - start).toBeGreaterThan(2);
  const moving = (await tracked()).slice(start);
  expect(new Set(moving.map((each) => each.id)), "the followed mark's alone").toEqual(
    new Set(["near"]),
  );
  // A page that claims more: another mark, a box far outside, a flood.
  await frame.evaluate(() => {
    const say = (params: unknown) =>
      parent.postMessage({ jsonrpc: "2.0", method: "porthole/annotate.tracked", params }, "*");
    say({ id: "far", rect: { x: 0, y: 0, width: 10, height: 10 } });
    for (let i = 0; i < 300; i += 1) {
      say({ id: "near", rect: { x: 5_000_000, y: -5_000_000, width: 9_000_000, height: 10 } });
    }
  });
  await page.waitForTimeout(1_200);
  const all = (await tracked()).slice(start);
  expect(
    all.filter((each) => each.id !== "near"),
    "probe: no other mark's box is taken",
  ).toEqual([]);
  expect(
    all.length,
    "probe: at most 60 a second (the page's own, and its flood, together)",
  ).toBeLessThanOrEqual(130);
  for (const each of all) {
    expect(each.rect.x + each.rect.width, "clamped to the frame").toBeLessThanOrEqual(
      box.width + 1,
    );
    expect(each.rect.y, "clamped to the frame").toBeGreaterThanOrEqual(0);
  }
  // Stopped: no more, however it moves.
  expect(await display.annotate("track", null)).toBeNull();
  const stopped = (await tracked()).length;
  for (let i = 0; i < 5; i += 1) {
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(500);
  expect((await tracked()).length, "nothing after track(null)").toBe(stopped);
});

type SelectionTracked = Extract<AnnotationReport, { type: "selectionTracked" }>;

test("a followed selection's place comes as it moves, highlighted, out of view and back, gone and found again, only while the host follows it, at most 60 a second (P138)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: SCROLLING,
  });
  const frame = await display.frame();
  await expect(frame.locator("#near")).toBeVisible();
  const followed = async (after = 0) =>
    (await reports(display))
      .slice(after)
      .filter((each): each is SelectionTracked => each.type === "selectionTracked");
  const forge = (params: unknown, times = 1) =>
    frame.evaluate(
      ([given, count]) => {
        for (let i = 0; i < count; i += 1) {
          parent.postMessage(
            { jsonrpc: "2.0", method: "porthole/annotate.selectionTracked", params: given },
            "*",
          );
        }
      },
      [params, times] as const,
    );
  const fake = {
    state: "attached",
    rect: { x: 0, y: 0, width: 10, height: 10 },
    documentRect: { x: 0, y: 0, width: 10, height: 10 },
    scroll: { x: 0, y: 0 },
    inView: true,
  };

  // The person picks the paragraph: the pick ends, and its outline stays (Tenny's review).
  const unlit = await look(page, frame, "#near");
  await display.annotate("start", { elements: true, text: false });
  await frame.locator("#near").click();
  await next(display, "selected");
  await page.mouse.move(0, 0);
  await expect
    .poll(async () => (await look(page, frame, "#near")).equals(unlit), {
      message: "the picked element keeps its outline before the host follows it",
    })
    .toBe(false);

  // Not followed: a page's own word isn't taken.
  await forge(fake, 3);
  await page.waitForTimeout(300);
  expect(await followed(), "probe: nothing taken while the host follows no selection").toEqual([]);

  // Followed: where it is, at once, in view, and drawn.
  // Counted before asking: the first report may land before `track` returns.
  const first = (await followed()).length;
  expect(await display.annotate("track", { selection: true })).toBeNull();
  await expect.poll(async () => (await followed()).length).toBeGreaterThan(first);
  const at = (await followed()).at(-1);
  expect(at?.state).toBe("attached");
  const place = await frame.evaluate(() => {
    const box = (document.getElementById("near") as HTMLElement).getBoundingClientRect();
    return { y: box.top + scrollY, height: box.height };
  });
  if (at?.state === "attached") {
    expect(at.inView, "in view").toBe(true);
    expect(Math.abs(at.documentRect.y - place.y), "where the page has it").toBeLessThan(1);
    expect(Math.abs(at.rect.height - place.height)).toBeLessThan(1);
  }
  await expect
    .poll(async () => (await look(page, frame, "#near")).equals(unlit), {
      message: "the followed element is highlighted",
    })
    .toBe(false);

  // Out of view and back, as the document scrolls.
  const lastState = async () => {
    const last = (await followed()).at(-1);
    return last === undefined ? null : last.state === "orphaned" ? "orphaned" : last.inView;
  };
  await frame.evaluate(() => window.scrollBy(0, 900));
  await expect.poll(lastState, { message: "out of view" }).toBe(false);
  await frame.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(lastState, { message: "in view again" }).toBe(true);

  // Taken out of the page, then put back (a re-render): gone, then found again by its anchor.
  await frame.evaluate(() => {
    const near = document.getElementById("near") as HTMLElement;
    (window as unknown as { kept: HTMLElement }).kept = near;
    near.remove();
  });
  await expect.poll(lastState, { message: "gone" }).toBe("orphaned");
  await frame.evaluate(() => {
    const again = document.createElement("p");
    again.id = "near";
    again.style.margin = "8px";
    again.textContent = "The near paragraph.";
    (document.getElementById("top") as HTMLElement).after(again);
  });
  await expect.poll(lastState, { message: "found again" }).toBe(true);

  // A page that claims more: a flood, on top of its own scrolling.
  const flooded = (await followed()).length;
  await forge(fake, 300);
  for (let i = 0; i < 5; i += 1) {
    await frame.evaluate(() => window.scrollBy(0, 30));
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(1_200);
  expect(
    (await followed()).length - flooded,
    "probe: at most 60 a second (the shell's own, and the page's flood, together)",
  ).toBeLessThanOrEqual(130);
  for (const each of await followed()) {
    if (each.state === "attached") {
      expect(each.rect.y, "clamped to the frame").toBeGreaterThanOrEqual(0);
    }
  }

  // Ended: the highlight goes, and nothing more is taken, however it moves or what the page says.
  await frame.evaluate(() => window.scrollTo(0, 0));
  expect(await display.annotate("track", null)).toBeNull();
  await page.waitForTimeout(300);
  const stopped = (await followed()).length;
  await forge(fake, 3);
  await frame.evaluate(() => window.scrollBy(0, 40));
  await page.waitForTimeout(500);
  expect((await followed()).length, "probe: nothing taken after track(null)").toBe(stopped);
  await frame.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(async () => (await look(page, frame, "#near")).equals(unlit), {
      message: "the highlight goes with the following",
    })
    .toBe(true);
});

test("a pick keeps its outline until the host follows it, and without a follow it ends as a selection does: Escape, a mode, clearSelection, the next pick, stop (P138)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: WIDGET });
  const frame = await display.frame();
  await expect(frame.locator("#more")).toBeVisible();
  // Nothing drawn: what each looks like before any pick, the pointer outside the frame.
  await page.mouse.move(0, 0);
  const plain = { p1: await look(page, frame, "#p1"), more: await look(page, frame, "#more") };
  const lit = async (which: "p1" | "more") =>
    !(await look(page, frame, `#${which}`)).equals(plain[which]);
  const pick = async (which: "p1" | "more") => {
    const before = (await reports(display)).length;
    await display.annotate("start", { elements: true, text: false });
    await frame.locator(`#${which}`).click();
    await next(display, "selected", before);
    await page.mouse.move(0, 0);
    await expect.poll(() => lit(which), { message: `${which} keeps its outline` }).toBe(true);
  };

  // An older host: no follow comes, and the outline stays a while, on no timer.
  await pick("p1");
  await page.waitForTimeout(1_500);
  expect(await lit("p1"), "still outlined").toBe(true);
  // Escape: the person wants out; the page still hears the key.
  await frame.locator("body").evaluate(() => {
    addEventListener("keydown", (event) => {
      if (event.key === "Escape") document.body.dataset.escape = "yes";
    });
  });
  await frame.locator("#title").evaluate((title) => {
    title.setAttribute("tabindex", "-1");
    (title as HTMLElement).focus();
  });
  await page.keyboard.press("Escape");
  await expect.poll(() => lit("p1"), { message: "Escape ends it" }).toBe(false);
  await expect(frame.locator("body")).toHaveAttribute("data-escape", "yes");

  // A mode started again, or stopped.
  await pick("p1");
  await display.annotate("start", { elements: false, text: true });
  await expect.poll(() => lit("p1"), { message: "a mode started ends it" }).toBe(false);
  await pick("p1");
  await display.annotate("stop", {});
  await expect.poll(() => lit("p1"), { message: "stop ends it" }).toBe(false);
  // The host's clearSelection.
  await pick("p1");
  await display.annotate("clearSelection");
  await expect.poll(() => lit("p1"), { message: "clearSelection ends it" }).toBe(false);
  // The next pick moves it; a selection made after a pick replaces it, with no mode change between.
  await pick("p1");
  await pick("more");
  expect(await lit("p1"), "the last pick's outline is gone").toBe(false);
  const before = (await reports(display)).length;
  await display.annotate("start", { elements: true, text: true });
  await frame.locator("#p1").click();
  await next(display, "selected", before);
  await page.mouse.move(0, 0);
  await expect.poll(() => lit("p1"), { message: "picked with text on too" }).toBe(true);
  expect(await select(frame, "#title", "Quarterly")).toBe(true);
  await expect
    .poll(
      async () =>
        (await reports(display)).slice(before).filter((each) => each.type === "selected").length,
    )
    .toBe(2);
  await expect.poll(() => lit("p1"), { message: "the next selection ends it" }).toBe(false);
  await pick("more");
  // clear.
  await display.annotate("clear");
  await expect.poll(() => lit("more"), { message: "clear ends it" }).toBe(false);

  // A newer host: the follow takes it over, lit all along, and its end ends both.
  await pick("p1");
  expect(await display.annotate("track", { selection: true })).toBeNull();
  await next(display, "selectionTracked");
  expect(await lit("p1"), "lit as the follow takes over").toBe(true);
  await display.annotate("track", null);
  await expect.poll(() => lit("p1"), { message: "the follow's end ends it" }).toBe(false);
});

test("while the selection is followed a scroll re-sends no selected, and once the following ends it does again (P105, P138)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: SCROLLING,
  });
  const frame = await display.frame();
  await expect(frame.locator("#near")).toBeVisible();
  await display.annotate("start", { elements: false, text: true });
  expect(await select(frame, "#near", "near paragraph")).toBe(true);
  await next(display, "selected");
  const of = async (type: AnnotationReport["type"]) =>
    (await reports(display)).filter((each) => each.type === type).length;
  const scroll = async (by: number) => {
    for (let i = 0; i < 4; i += 1) {
      await frame.evaluate((dy) => window.scrollBy(0, dy), by);
      await page.waitForTimeout(50);
    }
  };

  expect(await display.annotate("track", { selection: true })).toBeNull();
  await next(display, "selectionTracked");
  const selected = await of("selected");
  const followed = await of("selectionTracked");
  await scroll(30);
  // Past the settle (150 ms) and the follow-ups' clock (a second).
  await page.waitForTimeout(1_800);
  expect(await of("selectionTracked"), "the follow tells where it went").toBeGreaterThan(followed);
  expect(await of("selected"), "no re-send while followed").toBe(selected);

  await display.annotate("track", null);
  await scroll(30);
  await expect
    .poll(() => of("selected"), { message: "re-sent once the following ended", timeout: 5_000 })
    .toBeGreaterThan(selected);
});

test("following the selection moves no focus and leaves every key to the page; the words stay followed when the page's selection goes (P138)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: `<p id="p1">Costs fell by three percent in the third quarter.</p>
<input id="field">
<script>
  document.body.dataset.keys = "";
  addEventListener("keydown", (event) => (document.body.dataset.keys += event.key + ","));
</script>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#field")).toBeVisible();
  await display.annotate("start", { elements: false, text: true });
  await select(frame, "#p1", "three percent");
  const words = await next(display, "selected");
  expect(quoteOf(words.anchor)).toBe("three percent");
  await frame.locator("#field").focus();
  const before = (await reports(display)).length;

  expect(await display.annotate("track", { selection: true })).toBeNull();
  const first = await next(display, "selectionTracked", before);
  expect(first.state).toBe("attached");
  // The host's page keeps the frame as its focus, the page its field.
  expect(await page.evaluate(() => document.activeElement?.localName)).toBe("iframe");
  expect(await frame.evaluate(() => document.activeElement?.id)).toBe("field");
  await page.keyboard.type("ab");
  await page.keyboard.press("Escape");
  await expect(frame.locator("#field")).toHaveValue("ab");
  await expect(frame.locator("body")).toHaveAttribute("data-keys", "a,b,Escape,");
  // Escape while selecting text is reported as before (P112), and ends nothing by itself.
  await next(display, "cancelled", before);

  // The host takes the page's selection away (P115): the words stay followed, where they are.
  await display.annotate("clearSelection");
  const cleared = (await reports(display)).length;
  await frame.evaluate(() => {
    const p = document.getElementById("p1") as HTMLElement;
    p.style.marginTop = "100px";
  });
  const moved = await next(display, "selectionTracked", cleared);
  expect(moved.state).toBe("attached");
  if (moved.state === "attached" && first.state === "attached") {
    expect(
      Math.round(moved.rect.y - first.rect.y),
      "the words, moved by the layout",
    ).toBeGreaterThan(40);
  }
  await display.annotate("track", null);
  expect(await frame.evaluate(() => document.activeElement?.id)).toBe("field");
});

test("every attached mark's place in the document comes with the scroll it was read at, offscreen ones too, and the followed mark's as the document scrolls (P132)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: SCROLLING,
  });
  const frame = await display.frame();
  await expect(frame.locator("#far")).toBeAttached();
  // Where each element is in the document, and the frame's height, as the page itself reads them.
  const measured = await frame.evaluate(() => {
    const at = (id: string) => {
      const box = (document.getElementById(id) as HTMLElement).getBoundingClientRect();
      return { y: box.top + scrollY, height: box.height };
    };
    return { top: at("top"), far: at("far"), height: innerHeight };
  });
  expect(measured.far.y, "the far paragraph starts below the frame").toBeGreaterThan(
    measured.height,
  );
  await display.annotate("show", [elementMark("top", "#top"), elementMark("far", "#far")]);
  const shown = await next(display, "anchored");
  expect(shown.scroll, "probe: the scroll the boxes were read at").toEqual({ x: 0, y: 0 });
  const resultOf = (id: string) => shown.results.find((each) => each.id === id);
  expect(
    resultOf("far")?.rect?.height,
    "probe: its box in the viewport, clamped to the frame",
  ).toBe(0);
  for (const [id, want] of [
    ["top", measured.top],
    ["far", measured.far],
  ] as const) {
    const place = resultOf(id)?.documentRect;
    expect(place, `probe: ${id} has its place in the document`).toBeDefined();
    expect(Math.abs((place?.y ?? Number.NaN) - want.y), `${id}: where it is`).toBeLessThan(1);
    expect(Math.abs((place?.height ?? Number.NaN) - want.height), `${id}: its size`).toBeLessThan(
      1,
    );
  }

  // Followed, the far mark tells the scroll as the document moves, its place in it unchanged.
  expect(await display.annotate("track", "far")).toBeNull();
  const start = (await reports(display)).length;
  const lastTracked = async () =>
    (await reports(display))
      .slice(start)
      .filter(
        (each): each is Extract<AnnotationReport, { type: "tracked" }> => each.type === "tracked",
      )
      .at(-1);
  await frame.evaluate(() => window.scrollBy(0, 300));
  await expect
    .poll(
      async () => {
        const y = (await lastTracked())?.scroll?.y;
        return y === undefined ? null : Math.round(y);
      },
      { message: "probe: the followed mark's report tells the scroll" },
    )
    .toBe(300);
  const tracked = await lastTracked();
  expect(
    Math.abs((tracked?.documentRect?.y ?? Number.NaN) - measured.far.y),
    "probe: its place in the document stays where it was",
  ).toBeLessThan(1);
  const seen = await frame.evaluate(
    () => (document.getElementById("far") as HTMLElement).getBoundingClientRect().top,
  );
  expect(
    Math.abs((tracked?.documentRect?.y ?? 0) - (tracked?.scroll?.y ?? 0) - seen),
    "its place less the scroll is where the page draws it",
  ).toBeLessThan(1);

  // The page's word: a place anywhere in its document is taken as it says (never clamped, P132),
  // a malformed one or a malformed scroll is no report.
  const fake = (params: unknown) =>
    frame.evaluate(
      (given) =>
        parent.postMessage(
          { jsonrpc: "2.0", method: "porthole/annotate.anchored", params: given },
          "*",
        ),
      params,
    );
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  const before = (await reports(display)).length;
  const invalid = (await refusals(display)).filter((each) => each === "annotate:invalid").length;
  await fake({
    results: [{ id: "top", state: "attached", rect, documentRect: { ...rect, height: -1 } }],
    scroll: { x: 0, y: 0 },
  });
  await fake({
    results: [{ id: "top", state: "attached", rect, documentRect: rect }],
    scroll: { x: 0, y: "300" },
  });
  await expect
    .poll(
      async () =>
        (await refusals(display)).filter((each) => each === "annotate:invalid").length - invalid,
      { message: "probe: a malformed place or scroll is refused" },
    )
    .toBe(2);
  await fake({
    results: [
      {
        id: "top",
        state: "attached",
        rect,
        documentRect: { x: 0, y: 9_000_000, width: 10, height: 10 },
      },
    ],
    scroll: { x: 0, y: -5_000 },
  });
  // Found by its words: with a control's follow-ups on, the shell's own `anchored` can come first.
  const pageSaid = async () =>
    (await reports(display))
      .slice(before)
      .find(
        (each): each is Extract<AnnotationReport, { type: "anchored" }> =>
          each.type === "anchored" && each.results[0]?.documentRect?.y === 9_000_000,
      );
  await expect.poll(async () => (await pageSaid()) !== undefined).toBe(true);
  const far = (await pageSaid()) as Extract<AnnotationReport, { type: "anchored" }>;
  expect(far.results, "a place far down the document, as the page said").toEqual([
    {
      id: "top",
      state: "attached",
      rect,
      documentRect: { x: 0, y: 9_000_000, width: 10, height: 10 },
    },
  ]);
  expect(far.scroll).toEqual({ x: 0, y: -5_000 });
});

test("a selection's and a mark's last line come in the document's coordinates with the scroll, offscreen ones too; rect stays clamped (P133)", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    widthPx: 480,
    heightPx: 300,
    content: `<!doctype html><html><head><title>Lines</title></head><body style="margin: 0">
<div style="height: 1400px">spacer</div>
<p id="lines" style="margin: 8px; font-size: 16px; white-space: pre-line">The first line of words
the second line of words
the third one ends here</p>
<div id="block" style="margin: 8px; height: 40px">A block</div>
<div style="height: 1200px">spacer</div>
</body></html>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#lines")).toBeAttached();
  const phrase = "line of words\nthe second line of words\nthe third one";
  // Where the phrase's last line is in the document, as the page reads it.
  const measured = await frame.evaluate((exact) => {
    const node = document.getElementById("lines")?.firstChild as Text;
    const at = (node.nodeValue ?? "").indexOf(exact);
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + exact.length);
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0);
    const last = rects.at(-1) as DOMRect;
    return { lines: rects.length, y: last.top + scrollY, right: last.right + scrollX };
  }, phrase);
  expect(measured.lines, "the phrase runs over three lines").toBe(3);
  const near = (box: { x: number; y: number; width: number } | undefined) =>
    box !== undefined &&
    Math.abs(box.y - measured.y) < 1 &&
    Math.abs(box.x + box.width - measured.right) < 1;

  // A selection below the frame: its box on the frame's edge, its last line where it is.
  await display.annotate("start", { elements: false, text: true });
  expect(await select(frame, "#lines", phrase)).toBe(true);
  const selected = await next(display, "selected");
  expect(selected.rect.height, "probe: rect stays clamped to the frame").toBe(0);
  expect(selected.scroll, "probe: the scroll it was read at").toEqual({ x: 0, y: 0 });
  expect(
    near(selected.lastLineDocumentRect),
    "probe: the selection's last line, in the document",
  ).toBe(true);
  // Scrolled to it: told again, the place in the document the same, less the scroll in view.
  let count = (await reports(display)).length;
  await frame.evaluate(() => window.scrollBy(0, 1350));
  const moved = await next(display, "selected", count);
  expect(moved.scroll?.y, "probe: the selection's report tells the scroll").toBe(1350);
  expect(near(moved.lastLineDocumentRect), "probe: its last line stays where it is").toBe(true);
  await display.annotate("stop");
  await frame.evaluate(() => window.scrollTo(0, 0));

  // A mark's: on each result, and on the followed mark's reports; an element's is its box.
  count = (await reports(display)).length;
  await display.annotate("show", [textMark("words", phrase, 1), elementMark("block", "#block")]);
  const shown = await next(display, "anchored", count);
  const resultOf = (id: string) => shown.results.find((each) => each.id === id);
  expect(resultOf("words")?.rect?.height, "probe: a result's rect stays clamped").toBe(0);
  expect(
    near(resultOf("words")?.lastLineDocumentRect),
    "probe: a result's last line, in the document",
  ).toBe(true);
  expect(
    resultOf("block")?.lastLineDocumentRect,
    "probe: an element's last line is its whole box",
  ).toEqual(resultOf("block")?.documentRect);
  expect(await display.annotate("track", "words")).toBeNull();
  count = (await reports(display)).length;
  await frame.evaluate(() => window.scrollBy(0, 300));
  const tracked = await next(display, "tracked", count);
  expect(
    near(tracked.lastLineDocumentRect),
    "probe: the followed mark's last line, in the document",
  ).toBe(true);

  // The page's word: never clamped, a malformed one is no report.
  const fake = (params: unknown) =>
    frame.evaluate(
      (given) =>
        parent.postMessage(
          { jsonrpc: "2.0", method: "porthole/annotate.selected", params: given },
          "*",
        ),
      params,
    );
  await display.annotate("start", { elements: false, text: true });
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  const anchor = textMark("any", "first").anchor;
  const invalid = (await refusals(display)).filter((each) => each === "annotate:invalid").length;
  await fake({ anchor, rect, lastLineDocumentRect: { ...rect, height: -1 } });
  await expect
    .poll(
      async () =>
        (await refusals(display)).filter((each) => each === "annotate:invalid").length - invalid,
      { message: "probe: a malformed last line is refused" },
    )
    .toBe(1);
  count = (await reports(display)).length;
  const far = { x: 0, y: 9_000_000, width: 10, height: 10 };
  await fake({ anchor, rect, lastLineDocumentRect: far, scroll: { x: 0, y: 0 } });
  expect(
    (await next(display, "selected", count)).lastLineDocumentRect,
    "probe: a last line far down the document, as the page said",
  ).toEqual(far);
});

test("an honest scroll session, long, in comment mode, leaves room for a marker's click: follow-ups, the selection's too, at most one a second", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: SCROLLING,
  });
  const frame = await display.frame();
  await expect(frame.locator("#far")).toBeAttached();
  await display.annotate("show", [textMark("near", "The near paragraph.", 2)]);
  await next(display, "anchored");
  // Comment mode, as a host has it: text selection on, and one selection the person made, whose
  // box follows the scroll too (P105).
  await display.annotate("start", { elements: false, text: true });
  expect(await select(frame, "#far", "far paragraph says")).toBe(true);
  await next(display, "selected");
  const box = await (await frame.frameElement()).boundingBox();
  if (box === null) {
    throw new Error("no frame");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // 140 wheel turns, each settled (200 ms apart): more than the bridge's 120 a minute.
  for (let i = 0; i < 140; i += 1) {
    await page.mouse.wheel(0, i % 2 === 0 ? 60 : -60);
    await page.waitForTimeout(200);
  }
  await expect.poll(() => frame.evaluate(() => window.scrollY)).toBe(0);
  await page.waitForTimeout(1_200);
  // Every follow-up, of the marks and of the selection, shares one clock: at most one a second.
  const told = await reports(display);
  const followed =
    told.filter((each) => each.type === "anchored").length +
    told.filter((each) => each.type === "selected").length;
  expect(
    followed,
    "probe: the follow-ups of 28 s of scrolling, the selection's included, are at most one a second",
  ).toBeLessThanOrEqual(45);
  expect(await refusals(display), "probe: nothing the honest page reported was refused").toEqual(
    [],
  );

  const count = (await reports(display)).length;
  // Its marker, beside its line.
  const near = await textMarkerPoint(frame, "#near");
  await page.mouse.click(near.x, near.y);
  await expect
    .poll(
      async () =>
        (await reports(display)).slice(count).find((each) => each.type === "activated")?.id ??
        (await refusals(display)).join(", "),
      { message: "probe: the marker's click after the session is taken" },
    )
    .toBe("near");
  expect(await refusals(display), "probe: the marker's click was not refused").toEqual([]);

  // However fast the machine (a slower one makes fewer settles of a wheel's turns, and a shell
  // without the clock then stays under the count above: CI's WebKit, P105): eight scrolls 300 ms
  // apart, from inside the frame, each a settle of its own, the host page noting when each
  // follow-up arrives. The selection's re-reports, and the marks', each come a second apart.
  await page.evaluate(() => {
    const noted = window as unknown as { followUps: [string, number][] };
    noted.followUps = [];
    window.addEventListener("message", (event) => {
      const method = (event.data as { method?: unknown } | null)?.method;
      if (method === "porthole/annotate.selected" || method === "porthole/annotate.anchored") {
        noted.followUps.push([method, performance.now()]);
      }
    });
  });
  await frame.evaluate(async () => {
    for (let i = 0; i < 8; i += 1) {
      window.scrollBy(0, i % 2 === 0 ? 60 : -60);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  });
  await page.waitForTimeout(2_500);
  const arrivals = await page.evaluate(
    () => (window as unknown as { followUps: [string, number][] }).followUps,
  );
  const gaps = (method: string) => {
    const times = arrivals.filter(([each]) => each === method).map(([, at]) => at);
    return times.slice(1).map((at, i) => Math.round(at - (times[i] ?? at)));
  };
  expect(
    arrivals.filter(([each]) => each === "porthole/annotate.selected").length,
    "the selection was told again as the page scrolled",
  ).toBeGreaterThan(0);
  for (const [method, what] of [
    ["porthole/annotate.selected", "the selection's re-reports"],
    ["porthole/annotate.anchored", "the marks' follow-ups"],
  ] as const) {
    const apart = gaps(method);
    expect(
      Math.min(Infinity, ...apart),
      `probe: ${what} come at least a second apart (${apart.join(", ")} ms)`,
    ).toBeGreaterThanOrEqual(700);
  }
});

test("following: a burst of changes cut short by the anchoring deadline still reports what its last change moved", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: `<p style="font-size: 18px"><span id="t">x</span> <b id="w">target</b> words</p>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#w")).toBeVisible();
  await display.annotate("show", [textMark("w", "target", 1)]);
  await next(display, "anchored");
  await page.waitForTimeout(400);
  const count = (await reports(display)).length;
  // A change every 40 ms for 0.9 s, each moving the mark along its line: the run is cut short at
  // 1 s, under 150 ms after the last change.
  await frame.evaluate(async () => {
    const start = performance.now();
    const span = document.getElementById("t");
    for (let i = 2; performance.now() - start < 900; i += 1) {
      if (span) {
        span.textContent = "x".repeat(i);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  });
  const x = await frame.locator("#w").evaluate((element) => element.getBoundingClientRect().x);
  await expect
    .poll(async () => {
      const last = (await reports(display))
        .slice(count)
        .filter(
          (each): each is Extract<AnnotationReport, { type: "anchored" }> =>
            each.type === "anchored",
        )
        .at(-1);
      return Math.round(last?.results.find((each) => each.id === "w")?.rect?.x ?? -1);
    })
    .toBe(Math.round(x));
});

test("a marker on an element at the frame's top edge is drawn whole, and takes its click there", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, {
    config: presets.artifact({ capabilities: { annotate: {} } }),
    content: `<!doctype html><html><head><title>Edge</title></head><body style="margin: 0">
<h1 id="edge" style="margin: 0; width: 300px">At the edge</h1><p>More below.</p></body></html>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#edge")).toBeVisible();
  await display.annotate("show", [elementMark("edge", "#edge", 4)]);
  await next(display, "anchored");
  const box = await (await frame.frameElement()).boundingBox();
  if (box === null) {
    throw new Error("no frame");
  }
  // Below the half a marker on the corner would show: only a marker kept inside is there.
  await page.mouse.click(box.x + 300, box.y + 15);
  const activated = await next(display, "activated");
  expect(activated.id).toBe("edge");
  expect(activated.rect.y).toBeGreaterThanOrEqual(0);
});

test("a hostile page reports a box outside its frame: the host gets it clamped to the frame's viewport", async ({
  page,
}) => {
  const display = await referenceHost.launch(page, { config: annotated(), content: MARKED });
  const frame = await display.frame();
  await expect(frame.locator("#more")).toBeVisible();
  await display.annotate("show", [textMark("fell", "fell", 3)]);
  await next(display, "anchored");
  const size = await (
    await frame.frameElement()
  ).evaluate((element) => ({
    width: (element as HTMLElement).clientWidth,
    height: (element as HTMLElement).clientHeight,
  }));
  const fake = (rect: unknown) =>
    frame.evaluate(
      (given) =>
        parent.postMessage(
          { jsonrpc: "2.0", method: "porthole/annotate.activated", params: given },
          "*",
        ),
      { id: "fell", rect },
    );
  // Over the whole app, and wholly outside the frame, far right and below.
  let count = (await reports(display)).length;
  await fake({ x: -5_000, y: -5_000, width: 1_000_000, height: 1_000_000 });
  const covering = await next(display, "activated", count);
  expect(covering.rect, "probe: a box over the whole app is clamped to the frame").toEqual({
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
  });
  count = (await reports(display)).length;
  await fake({ x: 9_000_000, y: 9_000_000, width: 40, height: 18 });
  const outside = await next(display, "activated", count);
  expect(outside.rect, "probe: a box outside the frame is clamped to its edge").toEqual({
    x: size.width,
    y: size.height,
    width: 0,
    height: 0,
  });
  // A selection's box and a mark's are held the same way.
  await display.annotate("start", { elements: false, text: true });
  count = (await reports(display)).length;
  await frame.evaluate(() =>
    parent.postMessage(
      {
        jsonrpc: "2.0",
        method: "porthole/annotate.selected",
        params: {
          anchor: {
            kind: "text",
            selectors: [{ type: "TextQuoteSelector", exact: "fell" }],
            label: "fell",
          },
          rect: { x: -100, y: 10, width: 50, height: 20 },
        },
      },
      "*",
    ),
  );
  expect(
    (await next(display, "selected", count)).rect,
    "probe: a selection's box is clamped to the frame",
  ).toEqual({
    x: 0,
    y: 10,
    width: 0,
    height: 20,
  });
  count = (await reports(display)).length;
  await frame.evaluate(() =>
    parent.postMessage(
      {
        jsonrpc: "2.0",
        method: "porthole/annotate.anchored",
        params: {
          results: [
            { id: "fell", state: "attached", rect: { x: 10, y: -50, width: 20, height: 9e6 } },
          ],
        },
      },
      "*",
    ),
  );
  expect(
    (await next(display, "anchored", count)).results,
    "probe: a mark's box is clamped to the frame",
  ).toEqual([
    { id: "fell", state: "attached", rect: { x: 10, y: 0, width: 20, height: size.height } },
  ]);
});
