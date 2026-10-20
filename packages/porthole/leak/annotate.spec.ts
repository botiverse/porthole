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
  // Below the frame's viewport: on its bottom edge, of no height (the host clamps every box to
  // the frame, P104).
  const viewport = await frame.evaluate(() => window.innerHeight);
  expect(byId.get("far")?.rect?.y).toBe(viewport);
  expect(byId.get("far")?.rect?.height).toBe(0);

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
  // The three malformed ones are refused once the host has handled them: waited for, not
  // counted once after a fixed wait (P098). What was dropped stays dropped.
  await expect
    .poll(async () => (await refusals(display)).filter((each) => each === "annotate:invalid"))
    .toHaveLength(3);
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
  const labels: string[] = [];
  const text = (node: Node): string =>
    node.nodeName === "#text"
      ? (node.nodeValue ?? "")
      : (node.children ?? []).map((child) => text(child)).join("");
  const walk = (node: Node) => {
    const attributes = node.attributes ?? [];
    const classAt = attributes.indexOf("class");
    if (classAt !== -1 && /\bmarker\b/u.test(attributes[classAt + 1] ?? "")) {
      labels.push(text(node));
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

/** Where on the page a text anchor's marker is: just past the end of `selector`, raised. */
async function textMarkerPoint(frame: Frame, selector: string) {
  const box = await frame.locator(selector).boundingBox();
  if (box === null) {
    throw new Error(`${selector} isn't on screen`);
  }
  return { x: box.x + box.width + 10, y: box.y };
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
    await expect.poll(() => markerLabels(page, frame)).toEqual(["", "3", "99+"]);
  }

  // A click on the text's marker: reported with its box; nothing of the content's hears it.
  const fell = await textMarkerPoint(frame, "#p1 b");
  await page.mouse.click(fell.x, fell.y);
  const activated = await next(display, "activated");
  expect(activated.id).toBe("fell");
  // Its box is the marker's, in the frame's viewport: around where it was clicked.
  const frameBox = await (await frame.frameElement()).boundingBox();
  const left = activated.rect.x + (frameBox?.x ?? 0);
  const top = activated.rect.y + (frameBox?.y ?? 0);
  expect(left).toBeLessThanOrEqual(fell.x);
  expect(left + activated.rect.width).toBeGreaterThanOrEqual(fell.x);
  expect(top).toBeLessThanOrEqual(fell.y);
  expect(top + activated.rect.height).toBeGreaterThanOrEqual(fell.y);
  for (const attribute of [
    "data-pointerdown",
    "data-pointerup",
    "data-mousedown",
    "data-mouseup",
    "data-click",
    "data-after",
  ]) {
    expect(await frame.locator("body").getAttribute(attribute), attribute).toBeNull();
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
  expect(wide.id).toBe("more");
  count = (await reports(display)).length;
  // The title spans the frame: its marker is kept inside it.
  await page.mouse.click(title.x + title.width - 10, title.y);
  const bare = await next(display, "activated", count);
  expect(bare.id).toBe("title");
  expect(bare.rect.width).toBeLessThan(activated.rect.width);
  expect(activated.rect.width).toBeLessThan(wide.rect.width);
  expect(await frame.locator("body").getAttribute("data-click")).toBeNull();

  // A mark without a count: its anchor is marked, but no marker takes the click there.
  expect((await look(page, frame, "#p2")).equals(plainBefore)).toBe(false);
  count = (await reports(display)).length;
  const plain = await textMarkerPoint(frame, "#plain");
  await page.mouse.click(plain.x, plain.y);
  await expect(frame.locator("body")).toHaveAttribute("data-after2", "yes");
  await page.waitForTimeout(400);
  expect((await reports(display)).slice(count).filter((each) => each.type === "activated")).toEqual(
    [],
  );

  // While the person picks an element, markers step aside: the click picks what lies under one.
  await display.annotate("start", { elements: true, text: false });
  count = (await reports(display)).length;
  await page.mouse.click(fell.x, fell.y);
  const picked = await next(display, "selected", count);
  expect(picked.anchor.kind).toBe("element");
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
  // load an engine may hold a step back past the shell's 150 ms, and then that pause settled).
  const gaps = await frame.evaluate(async () => {
    const times: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      window.scrollBy(0, 50);
      times.push(performance.now());
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return times.slice(1).map((time, i) => time - (times[i] ?? time));
  });
  const anchoredSince = async (after: number) =>
    (await reports(display))
      .slice(after)
      .filter(
        (each): each is Extract<AnnotationReport, { type: "anchored" }> => each.type === "anchored",
      );
  await expect
    .poll(async () => {
      const last = (await anchoredSince(count)).at(-1);
      const top = last?.results.find((each) => each.id === "top")?.rect?.y;
      return top === undefined ? null : Math.round((before.get("top")?.y ?? 0) - top);
    })
    .toBe(400);
  await page.waitForTimeout(600);
  const run = await anchoredSince(count);
  // At most one per settle, and one a second (P104): pauses within a second of the last report
  // are told together.
  expect(run.length).toBeGreaterThanOrEqual(1);
  expect(
    run.length,
    `at most one per settle (steps ${gaps.map(Math.round).join(", ")} ms apart)`,
  ).toBeLessThanOrEqual(1 + gaps.filter((gap) => gap >= 130).length);
  for (const report of run) {
    expect(report.results.map((each) => each.id).sort()).toEqual(["far", "near", "top"]);
  }
  const viewport = await frame.evaluate(() => window.innerHeight);
  for (const each of run.at(-1)?.results ?? []) {
    expect(each.state).toBe("attached");
    if (each.id === "far") {
      // It was below the viewport (told on its bottom edge, of no height), and is now in it.
      expect(before.get("far")).toMatchObject({ y: viewport, height: 0 });
      expect(each.rect?.height).toBeGreaterThan(0);
      expect((each.rect?.y ?? 0) + (each.rect?.height ?? 0)).toBeLessThanOrEqual(viewport);
    } else {
      expect((before.get(each.id)?.y ?? 0) - (each.rect?.y ?? 0)).toBeCloseTo(400, 0);
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
    expect(await anchoredSince(told)).toEqual([]);
  }
  await frame.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(async () => {
      const last = (await anchoredSince(told)).at(-1);
      return last?.results.find((each) => each.id === "top")?.rect?.y;
    })
    .toBeCloseTo(before.get("top")?.y ?? 0, 0);
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
  expect(await reports(display)).toEqual([]);

  await display.annotate("show", [textMark("fell", "fell", 3), textMark("plain", "Nothing")]);
  await next(display, "anchored");
  const count = (await reports(display)).length;
  // An id it doesn't show, one shown without a marker: dropped. Malformed: refused as invalid.
  await fake({ id: "admin", rect });
  await fake({ id: "plain", rect });
  await fake({ id: "fell" });
  await fake({ id: "fell", rect: { ...rect, width: -1 } });
  await expect
    .poll(async () => (await refusals(display)).filter((each) => each === "annotate:invalid"))
    .toHaveLength(2);
  await page.waitForTimeout(400);
  expect((await reports(display)).slice(count)).toEqual([]);

  // A well-formed fake for a mark with a marker gets through, rebuilt: a UI hint only.
  await fake({ id: "fell", rect, delete: true });
  expect(await next(display, "activated", count)).toEqual({ type: "activated", id: "fell", rect });

  // Content's own synthetic click on the shell's layer reports nothing.
  const after = (await reports(display)).length;
  await frame.evaluate(() => {
    const layer = document.querySelector("[data-porthole-annotations]");
    const box = document.querySelector("#p1 b")?.getBoundingClientRect();
    layer?.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: (box?.right ?? 0) + 10,
        clientY: (box?.top ?? 0) + 2,
      }),
    );
  });
  await page.waitForTimeout(400);
  expect((await reports(display)).length).toBe(after);
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
  const at = await textMarkerPoint(frame, "#p1 b");
  const activations = async () =>
    (await reports(display)).filter((each) => each.type === "activated").length;

  // A selection stays as it was.
  expect(await select(frame, "#p2", "words to select")).toBe(true);
  await page.mouse.click(at.x, at.y);
  await expect.poll(activations).toBe(1);
  expect(await frame.evaluate(() => String(getSelection()))).toBe("words to select");

  // Focus stays where it was.
  await frame.locator("#field").focus();
  await page.mouse.click(at.x, at.y);
  await expect.poll(activations).toBe(2);
  expect(await frame.evaluate(() => document.activeElement?.id)).toBe("field");

  // A double click is two clicks to the host and nothing to the content; a right or middle
  // click is nothing to either.
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(activations).toBe(4);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await page.mouse.click(at.x, at.y, { button: "middle" });
  await page.mouse.move(at.x + 4, at.y + 2, { steps: 4 });
  await page.waitForTimeout(400);
  expect(await activations()).toBe(4);
  expect(await frame.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([]);
  expect(await frame.evaluate(() => document.activeElement?.id)).toBe("field");
});

test("an honest scroll session, long, leaves room for a marker's click: follow-ups at most one a second", async ({
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
  const followed = (await reports(display)).filter((each) => each.type === "anchored").length;
  expect(followed).toBeLessThanOrEqual(45);
  expect(await refusals(display)).toEqual([]);

  const count = (await reports(display)).length;
  // Its marker: just past the end of the words, where the host was last told they are.
  const words = await frame.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("near") as Node);
    const rect = range.getBoundingClientRect();
    return { right: rect.right, top: rect.top };
  });
  await page.mouse.click(box.x + words.right + 10, box.y + words.top);
  expect((await next(display, "activated", count)).id).toBe("near");
  expect(await refusals(display)).toEqual([]);
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
  expect(covering.rect).toEqual({ x: 0, y: 0, width: size.width, height: size.height });
  count = (await reports(display)).length;
  await fake({ x: 9_000_000, y: 9_000_000, width: 40, height: 18 });
  const outside = await next(display, "activated", count);
  expect(outside.rect).toEqual({ x: size.width, y: size.height, width: 0, height: 0 });
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
  expect((await next(display, "selected", count)).rect).toEqual({
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
  expect((await next(display, "anchored", count)).results).toEqual([
    { id: "fell", state: "attached", rect: { x: 10, y: 0, width: 20, height: size.height } },
  ]);
});
