import { Script } from "node:vm";
import { afterEach, describe, expect, test } from "vitest";
import {
  annotateMode,
  checkMarks,
  parseAnchor,
  parseRect,
  parseReport,
} from "../src/annotate/validate.ts";
import { ANNOTATION_LIMITS, type AnnotationAnchor } from "../src/annotate/types.ts";
import { createBridge, type BridgeEvent } from "../src/bridge/bridge.ts";
import {
  compile,
  createHost,
  presets,
  type AnnotationReport,
  type DisplayHandle,
  type PlatformHost,
} from "../src/index.ts";
import { ANNOTATE_RUNTIME } from "../src/shell/annotate.ts";
import { SHELL_RUNTIME } from "../src/shell/runtime.ts";

/** Annotations (P053): what the host takes from a frame, and what the shell is given. */

const element: AnnotationAnchor = {
  kind: "element",
  selectors: [
    { type: "CssSelector", value: "#revenue" },
    { type: "TextQuoteSelector", exact: "Revenue grew 12%", prefix: "Q3. ", suffix: " on" },
    { type: "TextPositionSelector", start: 40, end: 56 },
  ],
  label: "h2#revenue Revenue grew 12%",
};
const text: AnnotationAnchor = {
  kind: "text",
  selectors: [
    { type: "TextQuoteSelector", exact: "grew 12%" },
    { type: "TextPositionSelector", start: 48, end: 56 },
  ],
  label: "grew 12%",
};

describe("the host's checks on what a frame reports", () => {
  test("anchors in the shell's own shapes pass, rebuilt from known fields only", () => {
    expect(parseAnchor(element)).toEqual(element);
    expect(parseAnchor(text)).toEqual(text);
    expect(
      parseAnchor({
        ...text,
        extra: "<script>",
        selectors: [{ type: "TextQuoteSelector", exact: "x", prefix: "", injected: 1 }],
      }),
    ).toEqual({
      kind: "text",
      selectors: [{ type: "TextQuoteSelector", exact: "x" }],
      label: "grew 12%",
    });
  });

  test("anything malformed or too large is dropped whole", () => {
    const quote = (exact: string, more: Record<string, unknown> = {}) => ({
      kind: "text",
      selectors: [{ type: "TextQuoteSelector", exact, ...more }],
      label: "x",
    });
    for (const bad of [
      null,
      "anchor",
      { ...text, kind: "page" },
      { ...text, selectors: [] },
      { ...text, selectors: "#x" },
      { ...element, selectors: [...element.selectors, { type: "CssSelector", value: "p" }] },
      { ...text, selectors: [text.selectors[0], text.selectors[0]] },
      { ...text, label: "x".repeat(ANNOTATION_LIMITS.label + 1) },
      { ...text, label: 7 },
      quote(""),
      quote("x".repeat(ANNOTATION_LIMITS.exact + 1)),
      quote("x", { prefix: "p".repeat(ANNOTATION_LIMITS.context + 1) }),
      {
        kind: "element",
        selectors: [{ type: "CssSelector", value: "x".repeat(1_001) }],
        label: "",
      },
      {
        kind: "element",
        selectors: [{ type: "TextPositionSelector", start: 0, end: 1 }],
        label: "",
      },
      { kind: "text", selectors: [{ type: "CssSelector", value: "p" }], label: "" },
      {
        kind: "element",
        selectors: [{ type: "TextPositionSelector", start: 5, end: 2 }],
        label: "",
      },
      { kind: "element", selectors: [{ type: "XPathSelector", value: "/html" }], label: "" },
      {
        ...element,
        selectors: [{ type: "TextPositionSelector", start: 1.5, end: 3 }, element.selectors[0]],
      },
      {
        ...element,
        selectors: [{ type: "TextPositionSelector", start: -1, end: 3 }, element.selectors[0]],
      },
    ]) {
      expect(parseAnchor(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("a box is four finite numbers, its sizes not negative", () => {
    expect(parseRect({ x: -4, y: 10.5, width: 100, height: 20 })).toEqual({
      x: -4,
      y: 10.5,
      width: 100,
      height: 20,
    });
    for (const bad of [
      { x: 0, y: 0, width: -1, height: 1 },
      { x: Number.NaN, y: 0, width: 1, height: 1 },
      { x: 1e9, y: 0, width: 1, height: 1 },
      { x: "0", y: 0, width: 1, height: 1 },
      [0, 0, 1, 1],
    ]) {
      expect(parseRect(bad)).toBeNull();
    }
  });

  test("reports: a selection needs an anchor and a box; results say attached or orphaned", () => {
    const rect = { x: 0, y: 0, width: 1, height: 1 };
    expect(parseReport({ type: "selected", anchor: text, rect })).toEqual({
      type: "selected",
      anchor: text,
      rect,
    });
    expect(parseReport({ type: "selected", anchor: text })).toBeNull();
    expect(parseReport({ type: "unselected", junk: 1 })).toEqual({ type: "unselected" });
    expect(
      parseReport({
        type: "anchored",
        results: [
          { id: "a", state: "attached", rect },
          { id: "b", state: "orphaned", rect },
        ],
      }),
    ).toEqual({
      type: "anchored",
      results: [
        { id: "a", state: "attached", rect },
        { id: "b", state: "orphaned" },
      ],
    });
    expect(parseReport({ type: "activated", id: "c1", rect, extra: true })).toEqual({
      type: "activated",
      id: "c1",
      rect,
    });
    for (const bad of [
      { type: "activated", id: "c1" },
      { type: "activated", id: "", rect },
      { type: "activated", id: "x".repeat(ANNOTATION_LIMITS.id + 1), rect },
      { type: "activated", id: 7, rect },
      { type: "activated", id: "c1", rect: { ...rect, height: -1 } },
      { type: "anchored", results: [{ id: "a", state: "lost" }] },
      { type: "anchored", results: [{ id: "", state: "orphaned" }] },
      {
        type: "anchored",
        results: Array.from({ length: 501 }, (_, i) => ({ id: `m${i}`, state: "orphaned" })),
      },
      { type: "permission", granted: true },
    ]) {
      expect(parseReport(bad)).toBeNull();
    }
  });

  test("the host's own marks and modes are checked before they go to the frame", () => {
    expect(checkMarks([{ id: "c1", anchor: element }])).toEqual([{ id: "c1", anchor: element }]);
    expect(() =>
      checkMarks([
        { id: "c1", anchor: element },
        { id: "c1", anchor: text },
      ]),
    ).toThrow(/unique/u);
    expect(() => checkMarks([{ id: "c1", anchor: { ...text, kind: "page" } as never }])).toThrow(
      /anchor/u,
    );
    // A marker's count (P104): a whole number from 0 to the limit, kept; absent, no key.
    expect(checkMarks([{ id: "c1", anchor: element, count: 0 }])).toEqual([
      { id: "c1", anchor: element, count: 0 },
    ]);
    expect(checkMarks([{ id: "c1", anchor: text, count: ANNOTATION_LIMITS.count }])).toEqual([
      { id: "c1", anchor: text, count: ANNOTATION_LIMITS.count },
    ]);
    expect(Object.keys(checkMarks([{ id: "c1", anchor: text }])[0] ?? {})).toEqual([
      "id",
      "anchor",
    ]);
    for (const count of [-1, 1.5, ANNOTATION_LIMITS.count + 1, Number.NaN, Infinity, "3", null]) {
      expect(
        () => checkMarks([{ id: "c1", anchor: text, count: count as number }]),
        String(count),
      ).toThrow(/count/u);
    }
    expect(annotateMode(undefined)).toEqual({ elements: true, text: true });
    expect(annotateMode({ text: false })).toEqual({ elements: true, text: false });
    expect(() => annotateMode({ elements: false, text: false })).toThrow(/elements, text/u);
  });
});

describe("a marker's click (P104), on createHost over a stand-in platform", () => {
  const mounted: DisplayHandle[] = [];
  afterEach(() => {
    for (const display of mounted.splice(0)) {
      display.destroy();
    }
  });
  const mount = () => {
    const listeners = new Set<(message: unknown) => void>();
    const platform: PlatformHost = {
      name: "stand-in",
      createSurface: () => ({
        transport: {
          send: () => {},
          listen: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          close: () => listeners.clear(),
        },
        element: null,
        setHeight: () => {},
        setColorScheme: () => {},
        userActivation: () => undefined,
        onNavigated: () => () => {},
        onLoad: () => () => {},
        destroy: () => {},
      }),
    };
    const container = {
      ownerDocument: {
        defaultView: { location: { origin: "https://app.example" }, navigator: { language: "en" } },
      },
      getBoundingClientRect: () => ({ width: 600 }),
    } as unknown as HTMLElement;
    const display = createHost(presets.artifact({ capabilities: { annotate: {} } }), {
      platform,
    }).mount(container, { displayId: "d1", title: "Notes", scheme: "light" });
    mounted.push(display);
    const reports: AnnotationReport[] = [];
    const refused: string[] = [];
    display.on("annotation", (report) => reports.push(report));
    display.on("refused", (detail) => refused.push(detail.refusal));
    const activate = async (params: unknown) => {
      for (const listener of listeners) {
        listener({ jsonrpc: "2.0", method: "porthole/annotate.activated", params });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { display, reports, refused, activate };
  };
  const rect = { x: 10, y: 20, width: 30, height: 18 };

  test("is taken only for a mark the host shows with a marker", async () => {
    const t = mount();
    t.display.annotations.show([
      { id: "c1", anchor: text, count: 2 },
      { id: "c2", anchor: element },
    ]);
    await t.activate({ id: "nope", rect });
    await t.activate({ id: "c2", rect });
    expect(t.reports).toEqual([]);
    await t.activate({ id: "c1", rect, admin: true });
    expect(t.reports).toEqual([{ type: "activated", id: "c1", rect }]);
    // Malformed: refused as invalid, never delivered.
    await t.activate({ id: "c1" });
    expect(t.refused).toEqual(["invalid"]);
    // Once cleared, no mark is shown: its id is no longer taken.
    t.display.annotations.clear();
    await t.activate({ id: "c1", rect });
    expect(t.reports).toHaveLength(1);
  });
});

describe("the bridge carries reports and copies", () => {
  const events: BridgeEvent[] = [];
  let now = 0;
  const copied: string[] = [];
  const bridge = createBridge({
    config: presets.inlineWidget({ capabilities: { annotate: {}, copyText: {} } }),
    display: { id: "d", title: "Report" },
    handlers: {
      copyText: ({ text: words }) => {
        copied.push(words);
        return true;
      },
    },
    userActivation: () => true,
    onEvent: (event) => events.push(event),
    now: () => now,
  });

  test("a checked report becomes an event; a malformed one a refusal", async () => {
    expect((await bridge.call("annotate", { type: "cancelled" })).ok).toBe(true);
    expect(events.at(-1)).toEqual({ type: "annotation", report: { type: "cancelled" } });
    expect((await bridge.call("annotate", { type: "selected", anchor: text })).ok).toBe(false);
    expect(events.at(-1)).toEqual({ type: "refused", capability: "annotate", refusal: "invalid" });
  });

  test("reports are rate limited: a frame can't flood the host", async () => {
    now = 120_000;
    const outcomes = [];
    for (let i = 0; i < 121; i += 1) {
      outcomes.push((await bridge.call("annotate", { type: "unselected" })).ok);
    }
    expect(outcomes.filter((ok) => !ok)).toHaveLength(1);
  });

  test("copyText takes 1 to 20,000 characters, with a click, at most 30 a minute", async () => {
    now = 240_000;
    expect(await bridge.call("copyText", { text: "npm test" })).toEqual({ ok: true, value: true });
    expect(copied).toEqual(["npm test"]);
    expect((await bridge.call("copyText", { text: "" })).ok).toBe(false);
    expect((await bridge.call("copyText", { text: "x".repeat(20_001) })).ok).toBe(false);
    expect((await bridge.call("copyText", { text: 42 })).ok).toBe(false);
    expect(
      await bridge.call("copyText", { text: "no click" }, { userActivated: false }),
    ).toMatchObject({ ok: false, refusal: "no-user-activation" });
    let refused = 0;
    for (let i = 0; i < 40; i += 1) {
      refused += (await bridge.call("copyText", { text: "again" })).ok ? 0 : 1;
    }
    expect(refused).toBeGreaterThan(0);
  });
});

describe("the shell", () => {
  test("carries the annotation runtime only where annotate is declared", () => {
    const plain = compile(presets.inlineWidget()).shellDocument({ origins: ["https://a.example"] });
    const annotated = compile(presets.artifact({ capabilities: { annotate: {} } })).shellDocument({
      origins: ["https://a.example"],
    });
    expect(plain).not.toContain("porthole/annotate");
    expect(plain).not.toContain("__ANNOTATE__");
    expect(annotated).toContain('"porthole/annotate.selected"');
    expect(annotated).not.toContain("__ANNOTATE__");
  });

  test("with the annotation runtime in, is still a plain script", () => {
    expect(
      () =>
        new Script(
          SHELL_RUNTIME.replace("__ANNOTATE__", ANNOTATE_RUNTIME).replace("__PLAN__", "{}"),
        ),
    ).not.toThrow();
  });

  test("keeps content off the clipboard, and defines copyText only where declared", () => {
    expect(SHELL_RUNTIME).toContain("lock(Clipboard.prototype, name, noClipboard)");
    expect(SHELL_RUNTIME).toContain('["inserthtml", "copy", "cut", "paste"]');
    const copy = compile(presets.inlineWidget({ capabilities: { copyText: {} } }));
    expect(copy.shell?.globals).toContain("copyText");
    expect(compile(presets.inlineWidget()).shell?.globals).not.toContain("copyText");
    expect(copy.guide(["widget"])).toContain(
      "the clipboard are closed (copy buttons call copyText)",
    );
    expect(compile(presets.inlineWidget()).guide(["widget"])).toContain(
      "full screen and the clipboard are closed.",
    );
  });
});
