import { expect, test, type Frame, type Page } from "@playwright/test";
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
  expect(byId.get("far")?.state).toBe("attached");
  expect(byId.get("hello")?.state).toBe("attached");
  expect(byId.get("gone")).toEqual({ id: "gone", state: "orphaned" });
  const viewport = await frame.evaluate(() => window.innerHeight);
  expect(byId.get("far")?.rect?.y).toBeGreaterThan(viewport);

  const count = (await reports(display)).length;
  expect(await display.annotate("focus", "far")).toBeNull();
  const focused = await next(display, "anchored", count);
  expect(focused.results).toHaveLength(1);
  const rect = focused.results[0]?.rect;
  expect(rect?.y).toBeGreaterThanOrEqual(0);
  expect((rect?.y ?? 0) + (rect?.height ?? 0)).toBeLessThanOrEqual(viewport);
  expect(await frame.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  const marked = await look(page, frame, "#far");
  expect(await display.annotate("clear")).toBeNull();
  await expect
    .poll(async () => (await look(page, frame, "#far")).equals(marked), {
      message: "the marks are gone",
    })
    .toBe(false);
  expect(await display.annotate("focus", "far")).toMatch(/no mark/u);
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
  expect(await reports(display)).toEqual([]);

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
  await page.waitForTimeout(500);
  expect(await reports(display)).toEqual([]);
  expect((await refusals(display)).filter((each) => each === "annotate:invalid")).toHaveLength(3);

  // A well-formed fake, asked for, gets through: rebuilt from known fields, a UI hint only.
  await fake("selected", { anchor: { ...anchor, extra: "<img onerror>" }, rect, admin: true });
  const taken = await next(display, "selected");
  expect(taken).toEqual({ type: "selected", anchor, rect });

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
    )
    .toBeGreaterThan(0);
  expect((await reports(display)).length).toBeLessThanOrEqual(120);
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
