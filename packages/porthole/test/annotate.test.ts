import { runInNewContext, Script } from "node:vm";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  annotateMode,
  checkMarks,
  clampRect,
  followsSelection,
  hasMarker,
  inViewport,
  parseAnchor,
  parsePlace,
  parseRect,
  parseReport,
  parseScroll,
} from "../src/annotate/validate.ts";
import { ANNOTATION_LIMITS, type AnnotationAnchor } from "../src/annotate/types.ts";
import { createBridge, type BridgeEvent } from "../src/bridge/bridge.ts";
import { unseen, withoutUnseen } from "../src/bridge/unseen.ts";
import {
  compile,
  createHost,
  presets,
  type AnnotationReport,
  type DisplayHandle,
  type PlatformHost,
} from "../src/index.ts";
import {
  ANCHOR_CONTEXT,
  ANNOTATE_RUNTIME,
  MARKER_HIT,
  MARKER_NAME,
  PAGE_HASH,
  WORD_LATE,
} from "../src/shell/annotate.ts";
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

  test("a label is shown text: what the person couldn't see is taken out of it, never out of the words found again (P105)", () => {
    // A wordless element named by an alt the page never shows: a bidi override, zero-width
    // characters, a tag character, a soft hyphen and a control.
    const label = "img#chart ‮htnoM‬ by​ mo⁠nth\u{E0041}­\u0007";
    const picked = parseAnchor({ ...element, label });
    expect(picked?.label).toBe("img#chart htnoM by month");
    expect(picked?.selectors).toEqual(element.selectors);
    // No exceptions: an emoji's joiners and selectors go too (its faces stay), and so does a
    // joiner between letters a script shapes, whose surroundings a page can fake.
    expect(parseAnchor({ ...text, label: "family 👨‍👩‍👧, 1️⃣, می‌خواهم" })?.label).toBe(
      "family 👨👩👧, 1⃣, میخواهم",
    );
    // The review of P105: "rm -rf" in joiners, each beside a Mongolian free variation selector,
    // which a strip with the emoji and shaping exceptions kept (48 of them).
    const bits = Array.from(new TextEncoder().encode("rm -rf")).flatMap((byte) =>
      Array.from(byte.toString(2).padStart(8, "0")),
    );
    let payload = "img.chart \u180B";
    for (const bit of bits) {
      payload += (bit === "1" ? "\u200D" : "\u200C") + "\u180B";
    }
    payload = payload.slice(0, ANNOTATION_LIMITS.label);
    const cleaned = parseAnchor({ ...element, label: payload })?.label ?? "";
    expect(cleaned).toBe("img.chart ");
    expect(unseen(cleaned)).toBe(false);
    // A text anchor's words keep what they have, so the text is found again where it is.
    const soft = { type: "TextQuoteSelector" as const, exact: "co­operate" };
    expect(parseAnchor({ kind: "text", selectors: [soft], label: "co­operate" })).toEqual({
      kind: "text",
      selectors: [soft],
      label: "cooperate",
    });
    // The host's own marks go to the frame checked the same way.
    expect(checkMarks([{ id: "m1", anchor: { ...element, label } }])[0]?.anchor.label).toBe(
      "img#chart htnoM by month",
    );
  });

  test("a label's strip is closed: nothing unseen is left, whatever the label holds (P105)", () => {
    // The review's pool: letters, spaces, every kind of invisible character, the parts of emoji,
    // shaped letters and their joiners, Mongolian selectors, lone surrogates, controls.
    const pool = [
      "a",
      "Z",
      " ",
      "\u200B",
      "\u200C",
      "\u200D",
      "\u202E",
      "\u2066",
      "\u00AD",
      "\uFEFF",
      "\uFE0F",
      "\uFE0E",
      "\u20E3",
      "1",
      "#",
      "\u{1F600}",
      "\u{1F469}",
      "\u{1F3FD}",
      "\u{E0041}",
      "\u{E0100}",
      "\u{F0000}",
      "\uD800",
      "\uDC00",
      "\u0000",
      "\u0007",
      "\n",
      "\t",
      "م",
      "ی",
      "क",
      "्",
      "\u034F",
      "\u115F",
      "\u17B4",
      "\u180B",
      "\u2060",
      "\u061C",
      "\u200E",
    ];
    let seed = 105;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 20_000; i += 1) {
      let label = "";
      for (let n = 1 + Math.floor(random() * 12); n > 0; n -= 1) {
        label += pool[Math.floor(random() * pool.length)];
      }
      const out = withoutUnseen(label);
      expect(unseen(out), JSON.stringify(label)).toBe(false);
      expect(out.length).toBeLessThanOrEqual(label.length);
    }
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
    // Above the limit, clamped to it (P116): one thread's thousand replies don't refuse the list.
    expect(
      checkMarks([
        { id: "c1", anchor: text, count: ANNOTATION_LIMITS.count + 1 },
        { id: "c2", anchor: element, count: 1_000_000 },
        { id: "c3", anchor: element, count: 3 },
      ]),
    ).toEqual([
      { id: "c1", anchor: text, count: ANNOTATION_LIMITS.count },
      { id: "c2", anchor: element, count: ANNOTATION_LIMITS.count },
      { id: "c3", anchor: element, count: 3 },
    ]);
    for (const count of [-1, 1.5, ANNOTATION_LIMITS.count + 0.5, Number.NaN, Infinity, "3", null]) {
      expect(
        () => checkMarks([{ id: "c1", anchor: text, count: count as number }]),
        String(count),
      ).toThrow(/count/u);
    }
    expect(annotateMode(undefined)).toEqual({ elements: true, text: true });
    expect(annotateMode({ text: false })).toEqual({ elements: true, text: false });
    expect(() => annotateMode({ elements: false, text: false })).toThrow(/elements, text/u);
    // Whether the host follows what is selected (P140): there only where it is true.
    expect(annotateMode({ keepSelection: true })).toStrictEqual({
      elements: true,
      text: true,
      keepSelection: true,
    });
    expect(annotateMode({ keepSelection: false })).toStrictEqual({ elements: true, text: true });
    for (const bad of ["true", 1, {}]) {
      expect(() => annotateMode({ keepSelection: bad as never }), JSON.stringify(bad)).toThrow(
        /keepSelection/u,
      );
    }
  });

  test("a mark's kind (P107): a draft is sent without its count, a posted mark as before, any other kind refused", () => {
    // A draft keeps its kind and loses its count: its marker shows no number, so the page isn't
    // told one.
    expect(checkMarks([{ id: "d1", anchor: text, kind: "draft", count: 4 }])).toEqual([
      { id: "d1", anchor: text, kind: "draft" },
    ]);
    expect(checkMarks([{ id: "d1", anchor: element, kind: "draft" }])).toEqual([
      { id: "d1", anchor: element, kind: "draft" },
    ]);
    // Posted, said or not, goes as 0.10.0 sent it: no kind key.
    expect(checkMarks([{ id: "c1", anchor: text, kind: "posted", count: 2 }])).toEqual([
      { id: "c1", anchor: text, count: 2 },
    ]);
    expect(Object.keys(checkMarks([{ id: "c1", anchor: text, kind: "posted" }])[0] ?? {})).toEqual([
      "id",
      "anchor",
    ]);
    // A draft's count is still checked: a bad one is the host's bug, thrown as for a posted mark.
    expect(() => checkMarks([{ id: "d1", anchor: text, kind: "draft", count: -1 }])).toThrow(
      /count/u,
    );
    for (const kind of ["Draft", "note", "", "draft ", 1, null, true, {}]) {
      expect(
        () => checkMarks([{ id: "d1", anchor: text, kind: kind as "draft" }]),
        JSON.stringify(kind),
      ).toThrow(/kind/u);
    }
    expect(hasMarker({ id: "d1", anchor: text, kind: "draft" })).toBe(true);
    expect(hasMarker({ id: "c1", anchor: text, count: 0 })).toBe(true);
    expect(hasMarker({ id: "c1", anchor: text, kind: "posted" })).toBe(false);
  });
});

describe("a marker's click (P104), on createHost over a stand-in platform", () => {
  const mounted: DisplayHandle[] = [];
  afterEach(() => {
    for (const display of mounted.splice(0)) {
      display.destroy();
    }
  });
  const mount = (
    given: {
      userActivation?: () => boolean | undefined;
      viewport?: () => unknown;
    } = {},
  ) => {
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
        userActivation: given.userActivation ?? (() => undefined),
        // A platform of the host's own may answer anything here (P105).
        viewport: (given.viewport ?? (() => ({ width: 600, height: 400 }))) as () => {
          width: number;
          height: number;
        },
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
    // What a listener threw, as the transport's loop would see it: nothing, ever (P105).
    const thrown: unknown[] = [];
    const activate = async (params: unknown) => {
      for (const listener of listeners) {
        try {
          listener({ jsonrpc: "2.0", method: "porthole/annotate.activated", params });
        } catch (error) {
          thrown.push(error);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { display, reports, refused, thrown, activate };
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
    // Its box is held to the frame's viewport (600 by 400): the page places nothing outside.
    await t.activate({ id: "c1", rect: { x: -5_000, y: 390, width: 1_000_000, height: 50 } });
    expect(t.reports.at(-1)).toEqual({
      type: "activated",
      id: "c1",
      rect: { x: 0, y: 390, width: 600, height: 10 },
    });
    // Once cleared, no mark is shown: its id is no longer taken.
    t.display.annotations.clear();
    await t.activate({ id: "c1", rect });
    expect(t.reports).toHaveLength(2);
  });

  test("is taken for a draft's marker, with or without a count (P107)", async () => {
    const t = mount();
    t.display.annotations.show([
      { id: "d1", anchor: text, kind: "draft" },
      { id: "d2", anchor: element, kind: "draft", count: 3 },
      { id: "c1", anchor: text, kind: "posted" },
    ]);
    await t.activate({ id: "d1", rect });
    await t.activate({ id: "d2", rect });
    // Posted without a count: no marker, as before.
    await t.activate({ id: "c1", rect });
    expect(t.reports).toEqual([
      { type: "activated", id: "d1", rect },
      { type: "activated", id: "d2", rect },
    ]);
  });

  test("is taken with or without a gesture: no proof of a click is asked (0.16.0, P149)", async () => {
    const marks = [{ id: "c1", anchor: text, count: 2 }];
    // Whatever the host's page says of its activation (none, a platform that fails to say, one,
    // one that can't tell), the click is a report like any other: checked, for a mark the host
    // shows a marker for, within its rate.
    const says = [
      () => false,
      () => {
        throw new Error("can't tell");
      },
      () => true,
      () => undefined,
    ];
    for (const userActivation of says) {
      const t = mount({ userActivation });
      t.display.annotations.show(marks);
      await t.activate({ id: "c1", rect });
      expect(t.reports).toEqual([{ type: "activated", id: "c1", rect }]);
      expect(t.thrown).toEqual([]);
      // Still only for a mark it shows a marker for.
      await t.activate({ id: "c2", rect });
      expect(t.reports).toHaveLength(1);
    }
  });

  test("a platform's viewport() that answers no size or throws: nothing at the corner, nothing thrown (P105)", async () => {
    const corner = { x: 0, y: 0, width: 0, height: 0 };
    for (const viewport of [
      () => null,
      () => "600x400",
      () => ({ width: "600", height: "400" }),
      () => {
        throw new Error("measure failed");
      },
      () => ({
        get width(): number {
          throw new Error("measure failed");
        },
        height: 400,
      }),
    ]) {
      const t = mount({ viewport });
      t.display.annotations.show([{ id: "c1", anchor: text, count: 2 }]);
      await t.activate({ id: "c1", rect });
      expect(t.thrown).toEqual([]);
      expect(t.reports).toEqual([{ type: "activated", id: "c1", rect: corner }]);
    }
  });
});

describe("clearSelection (P115) and focusMark (P134), on createHost over a stand-in platform", () => {
  const mounted: DisplayHandle[] = [];
  afterEach(() => {
    for (const display of mounted.splice(0)) {
      display.destroy();
    }
  });
  /** A display whose frames' messages from the host are kept, each frame's handshake by hand. */
  const mount = (annotate: boolean) => {
    const sent: { method: string; params: unknown }[] = [];
    let listeners = new Set<(message: unknown) => void>();
    const platform: PlatformHost = {
      name: "stand-in",
      createSurface: () => {
        listeners = new Set();
        const own = listeners;
        return {
          transport: {
            send: (message) => {
              const { method, params } = message as { method?: unknown; params?: unknown };
              if (typeof method === "string") {
                sent.push({ method, params });
              }
            },
            listen: (listener) => {
              own.add(listener);
              return () => own.delete(listener);
            },
            close: () => own.clear(),
          },
          element: null,
          setHeight: () => {},
          setColorScheme: () => {},
          userActivation: () => undefined,
          viewport: () => ({ width: 600, height: 400 }),
          onNavigated: () => () => {},
          onLoad: () => () => {},
          destroy: () => {},
        };
      },
    };
    const container = {
      ownerDocument: {
        defaultView: { location: { origin: "https://app.example" }, navigator: { language: "en" } },
      },
      getBoundingClientRect: () => ({ width: 600 }),
    } as unknown as HTMLElement;
    const config = annotate
      ? presets.artifact({ capabilities: { annotate: {} } })
      : presets.artifact();
    const display = createHost(config, { platform }).mount(container, {
      displayId: "d1",
      title: "Notes",
      scheme: "light",
    });
    mounted.push(display);
    const handshake = () => {
      for (const listener of listeners) {
        listener({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      }
    };
    const annotateSent = () =>
      sent
        .filter((each) => each.method.startsWith("porthole/annotate."))
        .map((each) => each.method);
    return { display, sent, handshake, annotateSent };
  };

  test("goes to the frame as it is, with no params, and is kept for no later frame", () => {
    const t = mount(true);
    t.handshake();
    t.display.annotations.show([{ id: "c1", anchor: text, count: 1 }]);
    t.display.annotations.start({ elements: false, text: true });
    t.display.annotations.clearSelection();
    expect(t.sent.at(-1)).toEqual({ method: "porthole/annotate.clearSelection", params: {} });
    // The host's own state is untouched: marks and the mode go to the next frame, the clear doesn't.
    const before = t.sent.length;
    t.display.reload();
    t.handshake();
    expect(t.sent.slice(before).map((each) => each.method)).toEqual(
      expect.arrayContaining(["porthole/annotate.show", "porthole/annotate.start"]),
    );
    expect(t.sent.slice(before).map((each) => each.method)).not.toContain(
      "porthole/annotate.clearSelection",
    );
  });

  test("before the frame's handshake it is nothing; without annotate declared it throws", () => {
    const early = mount(true);
    expect(() => early.display.annotations.clearSelection()).not.toThrow();
    expect(early.annotateSent()).toEqual([]);
    const plain = mount(false);
    plain.handshake();
    expect(() => plain.display.annotations.clearSelection()).toThrow(
      /clearSelection: the config doesn't declare annotate/u,
    );
    expect(plain.annotateSent()).toEqual([]);
  });

  test("focusMark sends a shown marker's id and when it was sent, nothing else, and is kept for no later frame (P137)", () => {
    const t = mount(true);
    t.handshake();
    t.display.annotations.show([
      { id: "c1", anchor: text, count: 1 },
      { id: "d1", anchor: element, kind: "draft" },
    ]);
    const earliest = Date.now();
    t.display.annotations.focusMark("c1");
    const latest = Date.now();
    expect(t.sent.at(-1)).toEqual({
      method: "porthole/annotate.focusMark",
      params: { id: "c1", at: expect.any(Number) },
    });
    const { at } = t.sent.at(-1)!.params as { at: number };
    expect(at).toBeGreaterThanOrEqual(earliest);
    expect(at).toBeLessThanOrEqual(latest);
    t.display.annotations.focusMark("d1");
    expect(t.sent.at(-1)).toEqual({
      method: "porthole/annotate.focusMark",
      params: { id: "d1", at: expect.any(Number) },
    });
    const before = t.sent.length;
    t.display.reload();
    t.handshake();
    expect(t.sent.slice(before).map((each) => each.method)).toContain("porthole/annotate.show");
    expect(t.sent.slice(before).map((each) => each.method)).not.toContain(
      "porthole/annotate.focusMark",
    );
  });

  test("focusMark is nothing, and no fault, without a marker to go to; without annotate declared it throws", () => {
    const t = mount(true);
    t.handshake();
    t.display.annotations.show([
      { id: "c1", anchor: text, count: 1 },
      { id: "bare", anchor: text },
    ]);
    const sent = t.annotateSent().length;
    expect(() => t.display.annotations.focusMark("nope")).not.toThrow();
    expect(() => t.display.annotations.focusMark("bare")).not.toThrow();
    t.display.annotations.clear();
    expect(() => t.display.annotations.focusMark("c1")).not.toThrow();
    expect(t.annotateSent().slice(sent)).toEqual(["porthole/annotate.clear"]);
    const plain = mount(false);
    plain.handshake();
    expect(() => plain.display.annotations.focusMark("c1")).toThrow(
      /focusMark: the config doesn't declare annotate/u,
    );
  });
});

describe("places in the document (P132): a result's documentRect and the report's scroll", () => {
  const rect = { x: 10, y: 0, width: 200, height: 0 };
  const documentRect = { x: 10, y: 1_480, width: 200, height: 22 };
  const scroll = { x: 0, y: 900 };

  test("a scroll is two finite numbers within the coordinate limit, either negative", () => {
    expect(parseScroll({ x: 0, y: 900, extra: true })).toEqual({ x: 0, y: 900 });
    expect(parseScroll({ x: -3, y: -40.5 }), "an engine's overscroll").toEqual({ x: -3, y: -40.5 });
    for (const bad of [
      null,
      [0, 900],
      { x: 0 },
      { x: "0", y: 0 },
      { x: 0, y: Number.NaN },
      { x: 0, y: Infinity },
      { x: 0, y: ANNOTATION_LIMITS.coordinate + 1 },
    ]) {
      expect(parseScroll(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("anchored and tracked keep both, rebuilt from known fields; an older shell's, without them, as before", () => {
    expect(
      parseReport({
        type: "anchored",
        results: [
          { id: "a", state: "attached", rect, documentRect: { ...documentRect, z: 1 }, order: 0 },
          { id: "b", state: "orphaned", documentRect },
        ],
        scroll: { ...scroll, extra: true },
      }),
    ).toEqual({
      type: "anchored",
      results: [
        { id: "a", state: "attached", rect, documentRect, order: 0 },
        { id: "b", state: "orphaned" },
      ],
      scroll,
    });
    expect(parseReport({ type: "tracked", id: "a", rect, documentRect, scroll })).toEqual({
      type: "tracked",
      id: "a",
      rect,
      documentRect,
      scroll,
    });
    // An older shell's: no field appears that it didn't send.
    expect(
      parseReport({ type: "anchored", results: [{ id: "a", state: "attached", rect }] }),
    ).toStrictEqual({ type: "anchored", results: [{ id: "a", state: "attached", rect }] });
    expect(parseReport({ type: "tracked", id: "a", rect })).toStrictEqual({
      type: "tracked",
      id: "a",
      rect,
    });
  });

  test("a malformed one drops the whole report, never repaired", () => {
    for (const bad of [
      { ...documentRect, height: -1 },
      { ...documentRect, y: Number.NaN },
      { ...documentRect, y: 1e9 },
      [10, 1_480, 200, 22],
      null,
    ]) {
      expect(
        parseReport({
          type: "anchored",
          results: [{ id: "a", state: "attached", rect, documentRect: bad }],
          scroll,
        }),
        JSON.stringify(bad),
      ).toBeNull();
      expect(parseReport({ type: "tracked", id: "a", rect, documentRect: bad, scroll })).toBeNull();
    }
    for (const bad of [{ x: 0 }, { x: 0, y: "900" }, null, 900]) {
      expect(
        parseReport({
          type: "anchored",
          results: [{ id: "a", state: "attached", rect, documentRect }],
          scroll: bad,
        }),
        JSON.stringify(bad),
      ).toBeNull();
      expect(parseReport({ type: "tracked", id: "a", rect, documentRect, scroll: bad })).toBeNull();
    }
  });

  describe("the last line (P133): lastLineDocumentRect, with the scroll", () => {
    const lastLineDocumentRect = { x: 10, y: 1_500, width: 120, height: 22 };

    test("selected, anchored and tracked keep it, rebuilt from known fields; a selection takes the scroll too", () => {
      expect(
        parseReport({
          type: "selected",
          anchor: text,
          rect,
          lastLineDocumentRect: { ...lastLineDocumentRect, z: 1 },
          scroll: { ...scroll, extra: true },
        }),
      ).toEqual({ type: "selected", anchor: text, rect, lastLineDocumentRect, scroll });
      expect(
        parseReport({
          type: "anchored",
          results: [
            { id: "a", state: "attached", rect, documentRect, lastLineDocumentRect },
            { id: "b", state: "orphaned", lastLineDocumentRect },
          ],
          scroll,
        }),
      ).toEqual({
        type: "anchored",
        results: [
          { id: "a", state: "attached", rect, documentRect, lastLineDocumentRect },
          { id: "b", state: "orphaned" },
        ],
        scroll,
      });
      expect(
        parseReport({ type: "tracked", id: "a", rect, documentRect, lastLineDocumentRect, scroll }),
      ).toEqual({ type: "tracked", id: "a", rect, documentRect, lastLineDocumentRect, scroll });
    });

    test("an older shell's selection, without them, as before: no field appears", () => {
      expect(parseReport({ type: "selected", anchor: text, rect })).toStrictEqual({
        type: "selected",
        anchor: text,
        rect,
      });
    });

    test("a last line comes with its scroll, so ADOPTING's sample can't throw on a report that passes (P137)", () => {
      expect(
        parseReport({ type: "selected", anchor: text, rect, lastLineDocumentRect }),
      ).toBeNull();
      expect(parseReport({ type: "selected", anchor: text, rect, scroll })).toBeNull();
      expect(
        parseReport({ type: "tracked", id: "a", rect, documentRect, lastLineDocumentRect }),
      ).toBeNull();
      expect(
        parseReport({
          type: "anchored",
          results: [{ id: "a", state: "attached", rect, documentRect, lastLineDocumentRect }],
        }),
      ).toBeNull();

      // ADOPTING's "After the last line": `report.scroll` read wherever `line` is set.
      const placed = parseReport({
        type: "selected",
        anchor: text,
        rect,
        lastLineDocumentRect,
        scroll,
      });
      if (placed?.type !== "selected" || placed.lastLineDocumentRect === undefined) {
        throw new Error("the pair passes");
      }
      const line = placed.lastLineDocumentRect;
      expect(line.x + line.width - placed.scroll!.x).toBe(
        lastLineDocumentRect.x + lastLineDocumentRect.width - scroll.x,
      );
    });

    test("what older shells send still passes: the scroll without a last line is theirs (P137)", () => {
      // 0.14.9: `rect` alone.
      expect(parseReport({ type: "tracked", id: "a", rect })).toStrictEqual({
        type: "tracked",
        id: "a",
        rect,
      });
      // 0.14.10 (P132): a document's place and its scroll, no last line, and on no `selected`.
      expect(parseReport({ type: "tracked", id: "a", rect, documentRect, scroll })).toStrictEqual({
        type: "tracked",
        id: "a",
        rect,
        documentRect,
        scroll,
      });
      expect(
        parseReport({
          type: "anchored",
          results: [{ id: "a", state: "attached", rect, documentRect }],
          scroll,
        }),
      ).toStrictEqual({
        type: "anchored",
        results: [{ id: "a", state: "attached", rect, documentRect }],
        scroll,
      });
      expect(parseReport({ type: "selected", anchor: text, rect })).toStrictEqual({
        type: "selected",
        anchor: text,
        rect,
      });
      // An orphan has no last line to read: the field goes, not the report.
      expect(
        parseReport({
          type: "anchored",
          results: [{ id: "a", state: "orphaned", lastLineDocumentRect }],
        }),
      ).toStrictEqual({ type: "anchored", results: [{ id: "a", state: "orphaned" }] });
    });

    test("a malformed one, or a selection's malformed scroll, drops the whole report", () => {
      for (const bad of [
        { ...lastLineDocumentRect, height: -1 },
        { ...lastLineDocumentRect, y: Number.NaN },
        { ...lastLineDocumentRect, y: 1e9 },
        [10, 1_500, 120, 22],
        null,
      ]) {
        const each = { lastLineDocumentRect: bad };
        expect(
          parseReport({ type: "selected", anchor: text, rect, ...each }),
          JSON.stringify(bad),
        ).toBeNull();
        expect(
          parseReport({
            type: "anchored",
            results: [{ id: "a", state: "attached", rect, ...each }],
          }),
        ).toBeNull();
        expect(parseReport({ type: "tracked", id: "a", rect, ...each })).toBeNull();
      }
      for (const bad of [{ x: 0 }, { x: 0, y: "900" }, null, 900]) {
        expect(
          parseReport({ type: "selected", anchor: text, rect, lastLineDocumentRect, scroll: bad }),
          JSON.stringify(bad),
        ).toBeNull();
      }
    });
  });

  describe("the point picked (P150): an element pick's pointDocument, with the scroll", () => {
    const lastLineDocumentRect = { x: 0, y: 900, width: 600, height: 2_400 };
    const pointDocument = { x: 240.5, y: 1_730 };
    const pick = { type: "selected", anchor: element, rect, lastLineDocumentRect, scroll };

    test("an element pick keeps it, rebuilt from known fields, unclamped; one without it as before", () => {
      expect(parseReport({ ...pick, pointDocument: { ...pointDocument, z: 1 } })).toStrictEqual({
        ...pick,
        pointDocument,
      });
      const far = { x: -40, y: ANNOTATION_LIMITS.coordinate };
      expect(parseReport({ ...pick, pointDocument: far })).toStrictEqual({
        ...pick,
        pointDocument: far,
      });
      expect(parseReport(pick)).toStrictEqual(pick);
    });

    test("a malformed one drops the whole report, as a malformed box does", () => {
      for (const bad of [
        { x: 240, y: Number.NaN },
        { x: Infinity, y: 1_730 },
        { x: "240", y: 1_730 },
        { x: 240 },
        { x: 240, y: ANNOTATION_LIMITS.coordinate + 1 },
        { x: -1e9, y: 1_730 },
        [240, 1_730],
        "240,1730",
        null,
      ]) {
        expect(parseReport({ ...pick, pointDocument: bad }), JSON.stringify(bad)).toBeNull();
      }
    });

    test("never without its scroll (as P137), and never on a text selection", () => {
      expect(parseReport({ type: "selected", anchor: element, rect, pointDocument })).toBeNull();
      expect(
        parseReport({
          type: "selected",
          anchor: text,
          rect,
          lastLineDocumentRect,
          scroll,
          pointDocument,
        }),
      ).toBeNull();
      expect(parseReport({ type: "selected", anchor: text, rect, pointDocument })).toBeNull();
    });
  });

  describe("on createHost over a stand-in platform", () => {
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
          viewport: () => ({ width: 600, height: 400 }),
          onNavigated: () => () => {},
          onLoad: () => () => {},
          destroy: () => {},
        }),
      };
      const container = {
        ownerDocument: {
          defaultView: {
            location: { origin: "https://app.example" },
            navigator: { language: "en" },
          },
        },
        getBoundingClientRect: () => ({ width: 600 }),
      } as unknown as HTMLElement;
      const display = createHost(presets.artifact({ capabilities: { annotate: {} } }), {
        platform,
      }).mount(container, { displayId: "d1", title: "Notes", scheme: "light" });
      mounted.push(display);
      const reports: AnnotationReport[] = [];
      display.on("annotation", (report) => reports.push(report));
      const say = async (method: string, params: unknown) => {
        for (const listener of listeners) {
          listener({ jsonrpc: "2.0", method: `porthole/annotate.${method}`, params });
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
      return { display, reports, say };
    };

    test("a selection's box is clamped to the viewport (P104); its last line isn't, and the scroll is kept (P133)", async () => {
      const t = mount();
      t.display.annotations.start({ elements: false, text: true });
      await t.say("selected", {
        anchor: text,
        rect: { x: 8, y: 2_100, width: 300, height: 66 },
        lastLineDocumentRect: { x: 8, y: 3_044, width: 120, height: 22 },
        scroll: { x: 0, y: 900 },
      });
      expect(t.reports).toEqual([
        {
          type: "selected",
          anchor: text,
          rect: { x: 8, y: 400, width: 300, height: 0 },
          lastLineDocumentRect: { x: 8, y: 3_044, width: 120, height: 22 },
          scroll: { x: 0, y: 900 },
        },
      ]);
    });

    test("an element pick's box is clamped; the point it was picked at isn't, and is the host's to clip (P150)", async () => {
      const t = mount();
      t.display.annotations.start({ elements: true, text: false });
      await t.say("selected", {
        anchor: element,
        rect: { x: 0, y: -900, width: 600, height: 3_000 },
        lastLineDocumentRect: { x: 0, y: 0, width: 600, height: 3_000 },
        scroll: { x: 0, y: 900 },
        pointDocument: { x: 320, y: 4_200 },
      });
      expect(t.reports).toEqual([
        {
          type: "selected",
          anchor: element,
          rect: { x: 0, y: 0, width: 600, height: 400 },
          lastLineDocumentRect: { x: 0, y: 0, width: 600, height: 3_000 },
          scroll: { x: 0, y: 900 },
          pointDocument: { x: 320, y: 4_200 },
        },
      ]);
    });

    test("an anchor's context comes as the host checked it: cleaned, and a malformed one drops the report (P152)", async () => {
      const t = mount();
      t.display.annotations.start({ elements: true, text: true });
      await t.say("selected", {
        anchor: { ...text, context: { headings: ["Report", "\u202ERevenue\u202C"], region: "Q3" } },
        rect,
      });
      await t.say("selected", {
        anchor: { ...element, context: { headings: ["x".repeat(ANNOTATION_LIMITS.heading + 1)] } },
        rect,
      });
      expect(t.reports).toEqual([
        {
          type: "selected",
          anchor: { ...text, context: { headings: ["Report", "Revenue"], region: "Q3" } },
          rect,
        },
      ]);
    });

    test("each box in the viewport is clamped to it (P104); the document's are not, and the scroll is kept", async () => {
      const t = mount();
      t.display.annotations.show([
        { id: "near", anchor: text },
        { id: "far", anchor: element },
      ]);
      // A mark in the frame and one below it, as a shell reads them 900 px down the document.
      await t.say("anchored", {
        results: [
          {
            id: "near",
            state: "attached",
            rect: { x: 8, y: 120, width: 300, height: 20 },
            documentRect: { x: 8, y: 1_020, width: 300, height: 20 },
            order: 0,
          },
          {
            id: "far",
            state: "attached",
            rect: { x: 8, y: 2_100, width: 300, height: 40 },
            documentRect: { x: 8, y: 3_000, width: 300, height: 40 },
            order: 1,
          },
          { id: "not-shown", state: "attached", rect, documentRect },
        ],
        scroll,
      });
      expect(t.reports).toEqual([
        {
          type: "anchored",
          results: [
            {
              id: "near",
              state: "attached",
              rect: { x: 8, y: 120, width: 300, height: 20 },
              documentRect: { x: 8, y: 1_020, width: 300, height: 20 },
              order: 0,
            },
            {
              id: "far",
              state: "attached",
              rect: { x: 8, y: 400, width: 300, height: 0 },
              documentRect: { x: 8, y: 3_000, width: 300, height: 40 },
              order: 1,
            },
          ],
          scroll,
        },
      ]);
      // The followed mark's, as the document scrolls: its box clamped, its place and the scroll
      // as the shell read them, wherever the mark is.
      t.display.annotations.track("far");
      await t.say("tracked", {
        id: "far",
        rect: { x: 8, y: 1_600, width: 300, height: 40 },
        documentRect: { x: 8, y: 3_000, width: 300, height: 40 },
        scroll: { x: 0, y: 1_400 },
      });
      expect(t.reports.at(-1)).toEqual({
        type: "tracked",
        id: "far",
        rect: { x: 8, y: 400, width: 300, height: 0 },
        documentRect: { x: 8, y: 3_000, width: 300, height: 40 },
        scroll: { x: 0, y: 1_400 },
      });
      // An older shell's reports reach the host as they did.
      await t.say("anchored", {
        results: [
          { id: "near", state: "attached", rect: { x: 8, y: 120, width: 300, height: 20 } },
        ],
      });
      expect(t.reports.at(-1)).toStrictEqual({
        type: "anchored",
        results: [
          { id: "near", state: "attached", rect: { x: 8, y: 120, width: 300, height: 20 } },
        ],
      });
    });
  });
});

describe("a reported box, clamped to the frame's viewport (P104)", () => {
  const viewport = { width: 600, height: 400 };
  test("inside, it is as it was; overlapping, the part inside", () => {
    const inside = { x: 10, y: 20, width: 30, height: 18 };
    expect(clampRect(inside, viewport)).toEqual(inside);
    expect(clampRect({ x: 0, y: 0, width: 600, height: 400 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 600,
      height: 400,
    });
    expect(clampRect({ x: -20, y: 390, width: 50, height: 30 }, viewport)).toEqual({
      x: 0,
      y: 390,
      width: 30,
      height: 10,
    });
    expect(clampRect({ x: -1e7, y: -1e7, width: 2e7, height: 2e7 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 600,
      height: 400,
    });
  });

  test("wholly outside, a box of no size on the nearest edge", () => {
    expect(clampRect({ x: -5_000, y: 50, width: 10, height: 10 }, viewport)).toEqual({
      x: 0,
      y: 50,
      width: 0,
      height: 10,
    });
    expect(clampRect({ x: 9_000_000, y: 9_000_000, width: 10, height: 10 }, viewport)).toEqual({
      x: 600,
      y: 400,
      width: 0,
      height: 0,
    });
    expect(clampRect({ x: 100, y: -300, width: 10, height: 10 }, viewport)).toEqual({
      x: 100,
      y: 0,
      width: 10,
      height: 0,
    });
  });

  test("where the viewport isn't known (null too), or isn't a size, nothing at the corner", () => {
    expect(clampRect({ x: 10, y: 20, width: 30, height: 18 }, null)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    const rect = { x: 10, y: 20, width: 30, height: 18 };
    const nothing = { x: 0, y: 0, width: 0, height: 0 };
    expect(clampRect(rect, undefined)).toEqual(nothing);
    expect(clampRect(rect, { width: Number.NaN, height: Infinity })).toEqual(nothing);
    expect(clampRect(rect, { width: -5, height: -5 })).toEqual(nothing);
  });

  test("every result is finite, inside, and not negative, for any box parseRect takes", () => {
    const values = [-1e7, -1, -0.5, 0, 0.25, 1, 299.5, 400, 600, 601, 1e7];
    for (const x of values) {
      for (const y of values) {
        for (const size of [0, 0.5, 10, 1e7]) {
          const out = clampRect({ x, y, width: size, height: size }, viewport);
          for (const value of [out.x, out.y, out.width, out.height]) {
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
          }
          expect(out.x + out.width).toBeLessThanOrEqual(600);
          expect(out.y + out.height).toBeLessThanOrEqual(400);
          expect(parseRect(out)).toEqual(out);
        }
      }
    }
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

  test("clears a selection with the DOM's own removeAllRanges, taken before content runs (P115)", () => {
    expect(ANNOTATE_RUNTIME).toContain('clearSelection: "porthole/annotate.clearSelection"');
    const taken = ANNOTATE_RUNTIME.indexOf(
      "const removeAllRanges = Selection.prototype.removeAllRanges;",
    );
    expect(taken).toBeGreaterThan(-1);
    const handled = ANNOTATE_RUNTIME.indexOf("case M.clearSelection:");
    expect(handled).toBeGreaterThan(taken);
    const handler = ANNOTATE_RUNTIME.slice(handled, ANNOTATE_RUNTIME.indexOf("break;", handled));
    expect(handler).toContain("removeAllRanges.call(selection)");
    // Nothing told back from it.
    expect(handler).not.toContain("tell(");
  });

  test("focuses a marker with the DOM's own focus, taken before content runs, and tells nothing (P134)", () => {
    expect(ANNOTATE_RUNTIME).toContain('focusMark: "porthole/annotate.focusMark"');
    const taken = ANNOTATE_RUNTIME.indexOf("const focusElement = HTMLElement.prototype.focus;");
    expect(taken).toBeGreaterThan(-1);
    const moved = ANNOTATE_RUNTIME.indexOf("const focusMark = (id, late) => {");
    expect(moved).toBeGreaterThan(taken);
    const body = ANNOTATE_RUNTIME.slice(moved, ANNOTATE_RUNTIME.indexOf("      };", moved));
    expect(body).toContain("callOf(focusElement, markers[i].element");
    expect(body).not.toContain("tell(");
    expect(body).not.toContain("report(");
  });

  test("a parked focusMark, and one taken late, land only by the kept hasFocus; a fresh one reads no focus (P135, P137)", () => {
    const taken = ANNOTATE_RUNTIME.indexOf("const hasFocus = Document.prototype.hasFocus;");
    expect(taken).toBeGreaterThan(-1);
    const parked = ANNOTATE_RUNTIME.indexOf("if (pendingMarker !== null) {");
    expect(parked).toBeGreaterThan(taken);
    const landing = ANNOTATE_RUNTIME.slice(parked, ANNOTATE_RUNTIME.indexOf("}, wait);", parked));
    expect(landing).toContain("if (focusIsHere()) {\n              focusMark(id, false);");
    // One read, through the kept function; focusMark asks it only of a word that came late.
    expect(ANNOTATE_RUNTIME).toContain(
      "const focusIsHere = () => callOf(hasFocus, document, []) === true;",
    );
    expect(ANNOTATE_RUNTIME.split("hasFocus,")).toHaveLength(2);
    expect(ANNOTATE_RUNTIME).not.toContain("document.hasFocus");
    const moved = ANNOTATE_RUNTIME.indexOf("const focusMark = (id, late) => {");
    const body = ANNOTATE_RUNTIME.slice(moved, ANNOTATE_RUNTIME.indexOf("      };", moved));
    expect(body).toContain("if (late && !focusIsHere()) {");
    expect(body.split("focusIsHere")).toHaveLength(2);
    expect(body).not.toContain("activeElement");
  });

  test("a focusMark's age comes from the host's stamp and the clock kept before content runs (P137)", () => {
    const taken = ANNOTATE_RUNTIME.indexOf("const wallClock = Date.now;");
    expect(taken).toBeGreaterThan(-1);
    expect(ANNOTATE_RUNTIME.indexOf("window.addEventListener")).toBeGreaterThan(taken);
    expect(ANNOTATE_RUNTIME).toContain(`const wordLate = ${WORD_LATE};`);
    expect(ANNOTATE_RUNTIME).toContain(
      "focusMark(String(params.id), wordLate(params.at, callOf(wallClock, undefined, [])));",
    );

    const late = runInNewContext(WORD_LATE) as (at: unknown, now: number) => boolean;
    const now = 1_800_000_000_000;
    expect(late(now, now), "just sent").toBe(false);
    expect(late(now - 99, now), "within the bound").toBe(false);
    expect(late(now - 100, now), "at the bound").toBe(true);
    expect(late(now - 1_500, now), "a busy page's").toBe(true);
    expect(late(now + 5, now), "two processes' reads, a little apart").toBe(false);
    expect(late(now + 100, now), "the clock set back").toBe(true);
    for (const stamp of [undefined, null, "1800000000000", {}, Number.NaN, Infinity, -Infinity]) {
      expect(late(stamp, now), `no usable stamp: ${JSON.stringify(stamp)}`).toBe(true);
    }
  });

  test("a marker's name is what it is and its words, quoted, without an element's tag (P134)", () => {
    type Named = { anchor: AnnotationAnchor; count: number | null; draft: boolean };
    const name = runInNewContext(MARKER_NAME) as (mark: Named) => string;
    const posted = (anchor: AnnotationAnchor, count: number | null = 1) => ({
      anchor,
      count,
      draft: false,
    });
    expect(ANNOTATE_RUNTIME).toContain(`const nameOf = ${MARKER_NAME};`);
    // An element with text: its quote, whatever its tag, id and classes.
    expect(name(posted(element))).toBe('1 comment on "Revenue grew 12%"');
    expect(name(posted(element, 3))).toBe('3 comments on "Revenue grew 12%"');
    expect(name(posted(element, 0))).toBe('Comment on "Revenue grew 12%"');
    expect(name({ anchor: element, count: null, draft: true })).toBe(
      'Draft comment on "Revenue grew 12%"',
    );
    // Words spaced as the page has them, cut where the label cuts an element's.
    const spaced = {
      ...element,
      selectors: [{ type: "TextQuoteSelector" as const, exact: "a  b\n" }],
    };
    expect(name(posted(spaced))).toBe('1 comment on "a b"');
    const cut = {
      ...element,
      selectors: [{ type: "TextQuoteSelector" as const, exact: "x".repeat(300) }],
    };
    expect(name(posted(cut))).toBe(`1 comment on "${"x".repeat(40)}…"`);
    const exactly = {
      ...element,
      selectors: [{ type: "TextQuoteSelector" as const, exact: "x".repeat(40) }],
    };
    expect(name(posted(exactly))).toBe(`1 comment on "${"x".repeat(40)}"`);
    // No text of its own: what follows the tag in the label, an `alt`'s words; a bare tag is none.
    const css = [{ type: "CssSelector" as const, value: "#chart" }];
    const pictured = {
      kind: "element" as const,
      selectors: css,
      label: "img#chart Sales by month",
    };
    expect(name(posted(pictured))).toBe('1 comment on "Sales by month"');
    expect(name(posted({ ...pictured, label: "div.chart" }))).toBe("1 comment");
    // A text anchor's label is its words: nothing is taken off it.
    expect(name(posted(text))).toBe('1 comment on "grew 12%"');
    expect(name(posted({ ...text, label: "" }))).toBe("1 comment");
    // What the host stores is untouched: its label keeps the tag.
    expect(parseAnchor(element)?.label).toBe("h2#revenue Revenue grew 12%");
  });

  test("a press is a marker's on its bubble, and on touch within 44 by 44 around it, the nearest (P119)", () => {
    type Box = { x: number; y: number; width: number; height: number };
    const rule = runInNewContext(MARKER_HIT) as (
      count: number,
      boxAt: (i: number) => Box,
      x: number,
      y: number,
      touch: boolean,
    ) => number;
    const hit = (boxes: Box[], x: number, y: number, touch: boolean) =>
      rule(boxes.length, (i) => boxes[i] as Box, x, y, touch);
    // A "1" bubble: 34 by 18 at (100, 100), its middle at (117, 109).
    const one = { x: 100, y: 100, width: 34, height: 18 };
    expect(hit([one], 117, 109, false)).toBe(0);
    // 11 px below its edge: a mouse misses it, a finger has it (44 tall: 13 px above and below).
    expect(hit([one], 117, 129, false)).toBe(-1);
    expect(hit([one], 117, 129, true)).toBe(0);
    expect(hit([one], 117, 87, true)).toBe(0);
    expect(hit([one], 117, 131, true), "22 px from its middle: the edge").toBe(0);
    expect(hit([one], 117, 132, true), "past 22 px from its middle").toBe(-1);
    // 5 px either side of 34 (44 wide), not 6.
    expect(hit([one], 95, 109, true)).toBe(0);
    expect(hit([one], 94, 109, true)).toBe(-1);
    // A bubble wider than 44 takes its own width, 13 px above and below.
    const wide = { x: 0, y: 0, width: 60, height: 18 };
    expect(hit([wide], 59, 31, true)).toBe(0);
    expect(hit([wide], 61, 9, true)).toBe(-1);
    // Two 30 px apart, overlapping 44 px boxes: the nearest middle.
    const two = { x: 100, y: 130, width: 34, height: 18 };
    expect(hit([one, two], 117, 121, true)).toBe(0);
    expect(hit([one, two], 117, 127, true)).toBe(1);
    expect(hit([one, two], 117, 127, false)).toBe(-1);
    // On a bubble, that bubble, even nearer another's middle: a wide one beside a small one,
    // the topmost (last) of two that overlap, as before.
    const small = { x: 62, y: 0, width: 18, height: 18 };
    expect(hit([wide, small], 58, 9, true)).toBe(0);
    expect(hit([wide, { ...wide, x: 10 }], 30, 9, false)).toBe(1);
    // Spliced as it is.
    expect(ANNOTATE_RUNTIME).toContain(`const markerHit = ${MARKER_HIT};`);
    expect(ANNOTATE_RUNTIME).toContain(".touch>.marker::before{");
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

describe("the followed selection (P138): track({ selection: true }) and selectionTracked", () => {
  const rect = { x: 8, y: 120, width: 300, height: 40 };
  const documentRect = { x: 8, y: 1_020, width: 300, height: 40 };
  const lastLineDocumentRect = { x: 8, y: 1_042, width: 120, height: 18 };
  const scroll = { x: 0, y: 900 };
  const attached = { state: "attached", rect, documentRect, scroll, inView: true };

  test("a report is where it is, or that it is gone, rebuilt from known fields: geometry only", () => {
    expect(
      parseReport({
        type: "selectionTracked",
        ...attached,
        lastLineDocumentRect,
        // What a page may add rides nowhere: no anchor, no words.
        anchor: text,
        label: "Revenue grew 12%",
        id: "c1",
      }),
    ).toStrictEqual({
      type: "selectionTracked",
      state: "attached",
      rect,
      documentRect,
      lastLineDocumentRect,
      scroll,
      inView: true,
    });
    expect(parseReport({ type: "selectionTracked", ...attached, inView: false })).toStrictEqual({
      type: "selectionTracked",
      state: "attached",
      rect,
      documentRect,
      scroll,
      inView: false,
    });
    expect(
      parseReport({ type: "selectionTracked", state: "orphaned", rect, anchor: text }),
    ).toStrictEqual({ type: "selectionTracked", state: "orphaned" });
  });

  test("anything malformed or missing drops the report: every box but the last line, the scroll, and inView are its", () => {
    const { rect: _rect, ...noRect } = attached;
    const { documentRect: _place, ...noPlace } = attached;
    const { scroll: _scroll, ...noScroll } = attached;
    const { inView: _inView, ...noInView } = attached;
    for (const bad of [
      noRect,
      noPlace,
      noScroll,
      noInView,
      { ...attached, inView: "yes" },
      { ...attached, inView: 1 },
      { ...attached, state: "gone" },
      { ...attached, state: undefined },
      { ...attached, rect: { ...rect, width: -1 } },
      { ...attached, documentRect: { ...documentRect, y: Number.NaN } },
      { ...attached, scroll: { x: 0 } },
      { ...attached, lastLineDocumentRect: { ...lastLineDocumentRect, height: Infinity } },
    ]) {
      expect(parseReport({ type: "selectionTracked", ...bad }), JSON.stringify(bad)).toBeNull();
    }
  });

  test("in view: any of the box inside the viewport, before the clamp; an unknown viewport has nothing in it", () => {
    const viewport = { width: 600, height: 400 };
    expect(inViewport(rect, viewport)).toBe(true);
    expect(inViewport({ x: 8, y: 390, width: 300, height: 40 }, viewport), "half in").toBe(true);
    expect(inViewport({ x: 8, y: -39, width: 300, height: 40 }, viewport), "1 px in").toBe(true);
    expect(inViewport({ x: 8, y: -40, width: 300, height: 40 }, viewport), "on the edge").toBe(
      false,
    );
    expect(inViewport({ x: 8, y: 400, width: 300, height: 40 }, viewport), "below").toBe(false);
    expect(inViewport({ x: 600, y: 10, width: 30, height: 40 }, viewport), "right").toBe(false);
    expect(inViewport({ x: 20, y: 10, width: 0, height: 40 }, viewport), "no width").toBe(true);
    for (const unknown of [undefined, null, { width: Number.NaN, height: 400 }]) {
      expect(inViewport(rect, unknown), JSON.stringify(unknown)).toBe(false);
    }
  });

  test("only { selection: true } names the selection", () => {
    expect(followsSelection({ selection: true })).toBe(true);
    for (const other of ["c1", null, undefined, {}, { selection: "true" }, { selection: 1 }]) {
      expect(followsSelection(other as never), JSON.stringify(other)).toBe(false);
    }
    const inherited = Object.create({ selection: true }) as { selection: true };
    expect(followsSelection(inherited), "its own field only").toBe(false);
  });

  describe("on createHost over a stand-in platform", () => {
    const mounted: DisplayHandle[] = [];
    afterEach(() => {
      for (const display of mounted.splice(0)) {
        display.destroy();
      }
    });
    const mount = () => {
      const sent: { method: string; params: unknown }[] = [];
      let listeners = new Set<(message: unknown) => void>();
      const platform: PlatformHost = {
        name: "stand-in",
        createSurface: () => {
          listeners = new Set();
          const own = listeners;
          return {
            transport: {
              send: (message) => {
                const { method, params } = message as { method?: unknown; params?: unknown };
                if (typeof method === "string") {
                  sent.push({ method, params });
                }
              },
              listen: (listener) => {
                own.add(listener);
                return () => own.delete(listener);
              },
              close: () => own.clear(),
            },
            element: null,
            setHeight: () => {},
            setColorScheme: () => {},
            userActivation: () => undefined,
            viewport: () => ({ width: 600, height: 400 }),
            onNavigated: () => () => {},
            onLoad: () => () => {},
            destroy: () => {},
          };
        },
      };
      const container = {
        ownerDocument: {
          defaultView: {
            location: { origin: "https://app.example" },
            navigator: { language: "en" },
          },
        },
        getBoundingClientRect: () => ({ width: 600 }),
      } as unknown as HTMLElement;
      const display = createHost(presets.artifact({ capabilities: { annotate: {} } }), {
        platform,
      }).mount(container, { displayId: "d1", title: "Notes", scheme: "light" });
      mounted.push(display);
      const reports: AnnotationReport[] = [];
      display.on("annotation", (report) => reports.push(report));
      const handshake = () => {
        for (const listener of listeners) {
          listener({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
        }
      };
      const say = async (method: string, params: unknown) => {
        for (const listener of listeners) {
          listener({ jsonrpc: "2.0", method: `porthole/annotate.${method}`, params });
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
      const refused: string[] = [];
      display.on("refused", (detail) => refused.push(detail.refusal));
      const tracks = () =>
        sent.filter((each) => each.method === "porthole/annotate.track").map((each) => each.params);
      const starts = () =>
        sent.filter((each) => each.method === "porthole/annotate.start").map((each) => each.params);
      const followed = () => reports.filter((each) => each.type === "selectionTracked");
      return { display, sent, reports, refused, handshake, say, tracks, starts, followed };
    };

    test("asks under id null, which an older shell reads as following nothing; a mark's id or null ends it", () => {
      const t = mount();
      t.handshake();
      t.display.annotations.show([{ id: "c1", anchor: text, count: 1 }]);
      t.display.annotations.track("c1");
      t.display.annotations.track({ selection: true });
      t.display.annotations.track("c1");
      t.display.annotations.track({ selection: true });
      t.display.annotations.track(null);
      expect(t.tracks()).toEqual([
        { id: "c1" },
        { id: null, selection: true },
        { id: "c1" },
        { id: null, selection: true },
        { id: null },
      ]);
      // Not a mark: another object is no selection, and no mark either.
      expect(() => t.display.annotations.track({ selection: false } as never)).toThrow(/no mark/u);
    });

    test("takes reports only while it follows the selection: its box clamped, in view only where the box reaches the viewport", async () => {
      const t = mount();
      t.handshake();
      await t.say("selectionTracked", attached);
      expect(t.followed(), "not asked: none taken").toEqual([]);

      t.display.annotations.track({ selection: true });
      await t.say("selectionTracked", { ...attached, lastLineDocumentRect });
      // Below the frame: its box on the bottom edge, and out of view whatever the page says.
      await t.say("selectionTracked", {
        ...attached,
        rect: { x: 8, y: 2_100, width: 300, height: 40 },
        documentRect: { x: 8, y: 3_000, width: 300, height: 40 },
      });
      await t.say("selectionTracked", { ...attached, inView: false });
      await t.say("selectionTracked", { state: "orphaned" });
      expect(t.followed()).toEqual([
        {
          type: "selectionTracked",
          state: "attached",
          rect,
          documentRect,
          lastLineDocumentRect,
          scroll,
          inView: true,
        },
        {
          type: "selectionTracked",
          state: "attached",
          rect: { x: 8, y: 400, width: 300, height: 0 },
          documentRect: { x: 8, y: 3_000, width: 300, height: 40 },
          scroll,
          inView: false,
        },
        { type: "selectionTracked", state: "attached", rect, documentRect, scroll, inView: false },
        { type: "selectionTracked", state: "orphaned" },
      ]);

      // A show leaves it; a mark followed, null, or clear ends it.
      t.display.annotations.show([{ id: "c1", anchor: text, count: 1 }]);
      await t.say("selectionTracked", attached);
      expect(t.followed()).toHaveLength(5);
      for (const end of [
        () => t.display.annotations.track("c1"),
        () => t.display.annotations.track(null),
        () => t.display.annotations.clear(),
      ]) {
        t.display.annotations.track({ selection: true });
        end();
        await t.say("selectionTracked", attached);
        expect(t.followed()).toHaveLength(5);
      }
      // Following the selection, a mark's box isn't taken.
      t.display.annotations.show([{ id: "c1", anchor: text, count: 1 }]);
      t.display.annotations.track({ selection: true });
      await t.say("tracked", { id: "c1", rect });
      expect(t.reports.filter((each) => each.type === "tracked")).toEqual([]);
    });

    test("not following the selection, a selectionTracked is dropped unread: a malformed one is no refusal, as 0.14.14 had it (P140)", async () => {
      const t = mount();
      t.handshake();
      for (const bad of [
        { state: "gone" },
        { ...attached, rect: { ...rect, width: -1 } },
        { ...attached, inView: "yes" },
        { ...attached, scroll: { x: 0, y: Infinity } },
        null,
      ]) {
        await t.say("selectionTracked", bad);
      }
      await t.say("selectionTracked", attached);
      expect(t.refused, "probe: no refusal while the host follows no selection").toEqual([]);
      expect(t.followed()).toEqual([]);
      // Ended (a mark's id, null, clear): dropped unread again.
      t.display.annotations.track({ selection: true });
      t.display.annotations.track(null);
      await t.say("selectionTracked", { state: "gone" });
      expect(t.refused).toEqual([]);
      // Following it, the same malformed report is what it was: a refusal.
      t.display.annotations.track({ selection: true });
      await t.say("selectionTracked", { state: "gone" });
      expect(t.refused).toEqual(["invalid"]);
      expect(t.followed()).toEqual([]);
    });

    test("start says keepSelection only where the host asks it, and keeps it for a later frame, past a pick (P140)", async () => {
      const t = mount();
      t.handshake();
      t.display.annotations.start({ elements: true, text: false });
      t.display.annotations.start({ elements: true, text: true, keepSelection: true });
      expect(t.starts()).toEqual([
        { elements: true, text: false },
        { elements: true, text: true, keepSelection: true },
      ]);
      expect(() => t.display.annotations.start({ keepSelection: "yes" } as never)).toThrow(
        /keepSelection/u,
      );
      // The pick ends element picking; text goes on, and a later frame is told to keep it too.
      await t.say("selected", { anchor: element, rect });
      const before = t.sent.length;
      t.display.reload();
      t.handshake();
      expect(
        t.sent.slice(before).filter((each) => each.method === "porthole/annotate.start"),
      ).toEqual([
        {
          method: "porthole/annotate.start",
          params: { elements: false, text: true, keepSelection: true },
        },
      ]);
    });

    test("at most 60 a second, with tracked's (one followed thing at a time)", async () => {
      const t = mount();
      t.handshake();
      t.display.annotations.track({ selection: true });
      for (let i = 0; i < 100; i += 1) {
        await t.say("selectionTracked", attached);
      }
      expect(t.followed().length).toBe(60);
    });

    test("is kept for a frame that runs later, which has no selection to follow", () => {
      const t = mount();
      t.handshake();
      t.display.annotations.track({ selection: true });
      const before = t.sent.length;
      t.display.reload();
      t.handshake();
      expect(
        t.sent.slice(before).filter((each) => each.method === "porthole/annotate.track"),
      ).toEqual([{ method: "porthole/annotate.track", params: { id: null, selection: true } }]);
    });
  });

  describe("in the shell", () => {
    const body = (from: string, to: string) => {
      const start = ANNOTATE_RUNTIME.indexOf(from);
      expect(start, from).toBeGreaterThan(-1);
      return ANNOTATE_RUNTIME.slice(start, ANNOTATE_RUNTIME.indexOf(to, start));
    };

    test("follows the selection only when the host says selection, and a mark's id wins", () => {
      expect(ANNOTATE_RUNTIME).toContain('selectionTracked: "porthole/annotate.selectionTracked"');
      expect(ANNOTATE_RUNTIME).toContain("track(params.id, params.selection === true);");
      const track = body("const track = (id, selection) => {", "\n      };");
      expect(track).toContain("followingSelection = tracking === null && selection === true;");
    });

    test("tells geometry only, and moves no focus, no selection and no key", () => {
      const follow = body("const followHeld = () => {", "\n      // A mark, the selection");
      for (const told of follow.split("tell(").slice(1)) {
        expect(told.startsWith("M.selectionTracked, ")).toBe(true);
        expect(told.slice(0, told.indexOf(");"))).not.toMatch(/anchor|label|exact|quote/u);
      }
      for (const part of [follow, body("const track = (id, selection) => {", "\n      };")]) {
        expect(part).not.toMatch(
          /focus|removeAllRanges|addRange|preventDefault|addEventListener|listenOn/u,
        );
      }
    });

    test("keeps a copy of the selected range with the DOM's own cloneRange, taken before content runs", () => {
      const taken = ANNOTATE_RUNTIME.indexOf("const cloneRange = Range.prototype.cloneRange;");
      expect(taken).toBeGreaterThan(-1);
      expect(ANNOTATE_RUNTIME.indexOf("window.addEventListener")).toBeGreaterThan(taken);
      expect(ANNOTATE_RUNTIME).toContain(
        "holdSelected(anchor, { range: cloneRange.call(range) });",
      );
      // Every selected is held: the pick, the held block, the words.
      expect(ANNOTATE_RUNTIME.split("tell(M.selected,")).toHaveLength(4);
      expect(ANNOTATE_RUNTIME.split("holdSelected(anchor,")).toHaveLength(4);
    });

    test("a pick keeps its outline until the host follows it, the follow's highlight taking over in one draw (Tenny's review)", () => {
      // Both picks, the click's and the held block's, keep the element for a host that will follow
      // it (P140), unless already followed.
      expect(
        ANNOTATE_RUNTIME.split("picked = keeping && !followingSelection ? element : null;"),
      ).toHaveLength(3);
      expect(ANNOTATE_RUNTIME).toContain(
        "const pickShown = () => picked !== null && !followingSelection && picked.isConnected;",
      );
      const track = body("const track = (id, selection) => {", "\n      };");
      expect(track).toContain("const was = heldShown() || pickShown();");
      expect(track).toContain("if (followingSelection) {\n          picked = null;\n        }");
      expect(track).toContain("if (heldShown() || pickShown() || was) {\n          draw();");
    });

    test("without a follow, a pick's outline ends as a selection does: the next pick or selection, clearSelection, a mode, clear, Escape (Tenny's review)", () => {
      // A selection reported after it replaces it.
      expect(ANNOTATE_RUNTIME).toContain(
        "holdSelected(anchor, { range: cloneRange.call(range) });\n        endPick();",
      );
      // The host's words: a mode started or stopped, clear, clearSelection.
      expect(body("const stop = () => {", "\n      };")).toContain("picked = null;");
      expect(body("case M.start:", "break;")).toContain("picked = null;");
      expect(body("case M.clear:", "break;")).toContain("picked = null;");
      expect(body("case M.clearSelection: {", "break;")).toContain("endPick();");
      // Escape, before anything else is decided, and the key left as it was.
      const escape = body('if (event.key !== "Escape") {', "if (mode.elements) {");
      expect(escape).toContain("endPick();");
      expect(escape).not.toMatch(/preventDefault|stopImmediatePropagation|stopPropagation/u);
      // An element taken out of the page isn't drawn, and goes.
      expect(ANNOTATE_RUNTIME).toContain(
        "if (picked !== null && !picked.isConnected) {\n          picked = null;\n        }",
      );
      // No timer keeps or ends it, and unselected doesn't (the pick's own click clears an older
      // selection where text is selected too).
      const ending = body("const endPick = () => {", "\n      };");
      expect(ending).not.toMatch(/setTimeout|later\(/u);
      const unselected = body(
        "if (reported !== null) {\n            reported = null;",
        "tell(M.unselected",
      );
      expect(unselected).not.toContain("endPick");
    });

    test("a host that neither follows the selection nor said it will keeps nothing: no outline after a pick, no selection held (P140)", () => {
      // Kept only while followed, or after a start that said keepSelection.
      expect(ANNOTATE_RUNTIME).toContain("const keeps = () => followingSelection || keeping;");
      const start = body("case M.start:", "break;");
      expect(start).toContain("keeping = params.keepSelection === true;");
      expect(start).toContain("if (!keeps()) {\n              held = null;\n            }");
      // Each selected is held only then, and the pick's outline set only for a host that keeps.
      expect(body("const holdSelected = (anchor, found) => {", "\n      };")).toContain(
        "held = keeps() ? { anchor, found, tried: 0 } : null;",
      );
      expect(ANNOTATE_RUNTIME).not.toContain("picked = element;");
      expect(
        ANNOTATE_RUNTIME.split("picked = ").filter((each) => each.startsWith("element")),
      ).toEqual([]);
      // The following's end lets it go, unless the host keeps it.
      expect(body("const track = (id, selection) => {", "\n      };")).toContain(
        "if (!keeps()) {\n          held = null;\n        }",
      );
      // A stop leaves keepSelection as the last start said (a stop as the composer opens).
      expect(body("const stop = () => {", "\n      };")).not.toContain("keeping");
    });

    test("while the selection is followed, a scroll re-sends no selected; once it ends, as before (P105; Tenny's review)", () => {
      expect(ANNOTATE_RUNTIME).toContain("if (!followingSelection && reportSelection(true)) {");
      expect(ANNOTATE_RUNTIME).toContain(
        'window.addEventListener("scroll", () => {\n        // Not while the host follows the selection (P138, Tenny\'s review).\n        if (followingSelection) {\n          return;\n        }\n        if (reported !== null) {\n          selectionScrolled = true;',
      );
      // A new selection is still told while followed: only the re-send is held back.
      const told = body('document.addEventListener("selectionchange"', "});");
      expect(told).toContain("reportSelection(false)");
      expect(told).not.toContain("followingSelection");
    });

    test("draws it in the layer's outlines, which take no pointer and say nothing to assistive technology", () => {
      expect(ANNOTATE_RUNTIME).toContain(".held{position:absolute;");
      const drawn = body("const lit = heldShown()", "if (hover !== null && hover.isConnected) {");
      expect(drawn).toContain(
        "const lit = heldShown() ? held.found : pickShown() ? { element: picked } : null;",
      );
      expect(drawn).toContain('each.className = lit.range ? "held text" : "held";');
      expect(drawn).toContain("outlines.push(each);");
      expect(drawn).not.toMatch(/tabIndex|button|aria-label|focus/u);
      expect(ANNOTATE_RUNTIME).toContain('boxes.hover.setAttribute("aria-hidden", "true");');
    });
  });
});

describe("where an anchor is in the page (P152): its context, the headings above it and the region around it", () => {
  /** A stand-in element: its tag, attributes and children (a string is a text node's words). */
  interface Stand {
    readonly tag: string;
    readonly attrs: Readonly<Record<string, string>>;
    readonly kids: readonly (Stand | string)[];
    parent: Stand | null;
  }
  const h = (tag: string, attrs: Record<string, string> = {}, ...kids: (Stand | string)[]) => {
    const made: Stand = { tag, attrs, kids, parent: null };
    for (const kid of kids) {
      if (typeof kid !== "string") {
        kid.parent = made;
      }
    }
    return made;
  };
  type Context = { headings?: string[]; region?: string } | null;
  /**
   * `ANCHOR_CONTEXT` over a stand-in DOM, its reads as the runtime wires them: the headings in
   * document order (`h1`–`h6`, `[role~=heading]`), a node before another or holding it, a node
   * inside another (P153), and an
   * element not rendered where it or one around it is `hidden` (what the runtime's `closest`
   * check, or an empty `getClientRects`, sees of a hidden tab panel).
   */
  const contextIn = (body: Stand) => {
    const order: Stand[] = [];
    const walk = (node: Stand) => {
      order.push(node);
      for (const kid of node.kids) {
        if (typeof kid !== "string") {
          walk(kid);
        }
      }
    };
    walk(body);
    const textOf = (node: Stand): string =>
      node.kids.map((kid) => (typeof kid === "string" ? kid : textOf(kid))).join("");
    const factory = runInNewContext(ANCHOR_CONTEXT) as (
      dom: Record<string, unknown>,
    ) => (target: Stand | null) => unknown;
    const contextOf = factory({
      headings: () =>
        order.filter(
          (node) =>
            /^h[1-6]$/u.test(node.tag) || (node.attrs.role ?? "").split(/\s+/u).includes("heading"),
        ),
      before: (node: Stand, target: Stand) => order.indexOf(node) <= order.indexOf(target),
      inside: (node: Stand, target: Stand) => {
        for (let at = node.parent; at !== null; at = at.parent) {
          if (at === target) {
            return true;
          }
        }
        return false;
      },
      name: (node: Stand) => node.tag,
      attr: (node: Stand, name: string) => node.attrs[name] ?? null,
      text: textOf,
      parent: (node: Stand) => node.parent,
      children: (node: Stand) => node.kids.filter((kid) => typeof kid !== "string"),
      byId: (id: string) => order.find((node) => node.attrs.id === id) ?? null,
      shown: (node: Stand) => {
        for (let at: Stand | null = node; at !== null; at = at.parent) {
          if (at.attrs.hidden !== undefined) {
            return false;
          }
        }
        return true;
      },
    });
    // Out of the other realm as plain JSON, as it goes to the host.
    return (target: Stand | null): Context => JSON.parse(JSON.stringify(contextOf(target)));
  };

  test("the outline down to it: h1 > h2 > h3, earlier sections passed over, a heading picked last", () => {
    const target = h("p", {}, "Revenue grew 12% in the north.");
    const picked = h("h3", {}, "By ", h("em", {}, "region"));
    const inHeading = h("span", {}, "Revenue");
    const section = h("section", {}, h("h4", {}, "Inside"), h("p", {}, "Words"));
    const page = h(
      "body",
      {},
      h("h1", {}, "  Quarterly\n report "),
      h("h2", {}, "Intro"),
      h("h3", {}, "Background"),
      h("h2", {}, inHeading, " grew"),
      h("p", {}, "Up."),
      picked,
      target,
      section,
      h("h2", {}, "Costs"),
    );
    const contextOf = contextIn(page);
    // The page's only h1, its title, is left out above deeper headings (P153).
    expect(contextOf(target)).toEqual({
      headings: ["Revenue grew", "By region"],
    });
    expect(contextOf(picked), "a heading picked is the last").toEqual({
      headings: ["Revenue grew", "By region"],
    });
    expect(contextOf(inHeading), "inside a heading: that heading is the last").toEqual({
      headings: ["Revenue grew"],
    });
    // A section picked: the headings before it, down to its own one inside it (P153).
    expect(contextOf(section)).toEqual({
      headings: ["Revenue grew", "By region", "Inside"],
    });
    // Spliced as it is, its built-ins taken before content runs.
    expect(ANNOTATE_RUNTIME).toContain(`const contextOf = (${ANCHOR_CONTEXT})({`);
    const taken = ANNOTATE_RUNTIME.indexOf(
      "const headingsIn = Document.prototype.querySelectorAll;",
    );
    expect(taken).toBeGreaterThan(-1);
    expect(ANNOTATE_RUNTIME.indexOf("window.addEventListener")).toBeGreaterThan(taken);
    for (const each of [
      "const elementById = Document.prototype.getElementById;",
      "const comparePosition = Node.prototype.compareDocumentPosition;",
      "const closestOf = Element.prototype.closest;",
      "const elementRects = Element.prototype.getClientRects;",
      "const styleOf = window.getComputedStyle;",
    ]) {
      expect(ANNOTATE_RUNTIME.indexOf(each), each).toBeGreaterThan(-1);
      expect(ANNOTATE_RUNTIME.indexOf(each), each).toBeLessThan(
        ANNOTATE_RUNTIME.indexOf("window.addEventListener"),
      );
    }
    // Both kinds of anchor carry it.
    expect(ANNOTATE_RUNTIME.split("withContext({ kind: ")).toHaveLength(3);
  });

  test("levels as a screen reader reads them: role=heading with aria-level, a role that unmakes a heading, a skipped level", () => {
    const target = h("p", {}, "Words");
    const page = h(
      "body",
      {},
      h("div", { role: "heading", "aria-level": "1" }, "Dashboard"),
      h("h2", { role: "presentation" }, "Not a heading"),
      h("h4", {}, "Skipped to four"),
      h("div", { role: "heading" }, "Level two by default"),
      h("h2", { "aria-level": "5" }, "Five by aria-level"),
      target,
      // A second level-1 heading: the first isn't the page's only one, and stays (P153).
      h("h1", {}, "Appendix"),
    );
    expect(contextIn(page)(target)).toEqual({
      headings: ["Dashboard", "Level two by default", "Five by aria-level"],
    });
    // An aria-label names a heading over its words.
    const labelled = h("p", {}, "Words");
    const icons = h("body", {}, h("h1", { "aria-label": "Settings" }, "\u2699"), labelled);
    expect(contextIn(icons)(labelled)).toEqual({ headings: ["Settings"] });
  });

  test("a hidden tab's heading is never named; the tab panel it is in is, by its tab", () => {
    const target = h("p", {}, "Revenue grew 12%.");
    const page = h(
      "body",
      {},
      h("h1", {}, "Report"),
      h("h2", {}, "Results"),
      h(
        "div",
        { role: "tablist" },
        h("button", { role: "tab", id: "tab-costs" }, "Costs"),
        h("button", { role: "tab", id: "tab-revenue" }, "Revenue"),
      ),
      h(
        "section",
        { role: "tabpanel", "aria-labelledby": "tab-costs", hidden: "" },
        h("h3", {}, "Costs in detail"),
        h("p", {}, "Costs fell."),
      ),
      h("section", { role: "tabpanel", "aria-labelledby": "tab-revenue" }, target),
    );
    // The page's only h1 left out (P153).
    expect(contextIn(page)(target)).toEqual({
      headings: ["Results"],
      region: "Revenue",
    });
  });

  test("the region: the nearest named container around it, by aria-labelledby, aria-label or a figure's caption", () => {
    const inPanel = h("p", {}, "a");
    const inSection = h("p", {}, "b");
    const inFigure = h("span", {}, "c");
    const inNav = h("a", {}, "d");
    const unnamed = h("p", {}, "e");
    const page = h(
      "body",
      {},
      h("span", { id: "first" }, "Q3"),
      h("span", { id: "second" }, " numbers "),
      h("div", { role: "tabpanel", "aria-labelledby": "first second missing" }, inPanel),
      h(
        "article",
        { "aria-label": "Outer story" },
        h("section", {}, h("div", {}, inSection)),
        h("section", { role: "presentation", "aria-label": "Not a region" }, unnamed),
      ),
      h("figure", {}, h("div", {}, inFigure), h("figcaption", {}, "Revenue by month")),
      h("nav", { "aria-label": "Table of contents" }, inNav),
    );
    const contextOf = contextIn(page);
    expect(contextOf(inPanel)).toEqual({ region: "Q3 numbers" });
    expect(contextOf(inSection), "an unnamed section: the named article around it").toEqual({
      region: "Outer story",
    });
    expect(contextOf(unnamed), "a role that unmakes a section").toEqual({ region: "Outer story" });
    expect(contextOf(inFigure)).toEqual({ region: "Revenue by month" });
    expect(contextOf(inNav)).toEqual({ region: "Table of contents" });
  });

  test("a page with no headings and no named region gives no context; nor does one whose only heading is hidden", () => {
    const target = h("p", {}, "Words");
    expect(contextIn(h("body", {}, h("div", {}, target)))(target)).toBeNull();
    const hidden = h("p", {}, "Words");
    const page = h("body", {}, h("div", { hidden: "" }, h("h2", {}, "Secret tab")), hidden);
    expect(contextIn(page)(hidden)).toBeNull();
    expect(contextIn(page)(null)).toBeNull();
    // Reading the page throws (a page that broke its own DOM): no context, and the pick goes on.
    const broken = (runInNewContext(ANCHOR_CONTEXT) as (dom: unknown) => (t: unknown) => unknown)({
      headings: () => {
        throw new Error("patched");
      },
    });
    expect(broken({})).toBeNull();
  });

  test("capped: 80 characters each with an ellipsis, at most 6 headings (aria-level past 6 is 6), bidi controls and zero-width characters out", () => {
    const target = h("p", {}, "Words");
    const long = "x".repeat(200);
    const page = h(
      "body",
      {},
      h("h1", {}, long),
      h("h2", {}, "Two"),
      h("h3", {}, "Three"),
      h("h4", {}, "Four"),
      h("h5", {}, "Five"),
      h("h6", {}, "Six"),
      h("div", { role: "heading", "aria-level": "9" }, "Nine, read as six"),
      h("section", { "aria-label": `\u202Eevil\u202C\u200B ${"y".repeat(200)}` }, target),
      // Not the page's only h1: the first stays (P153).
      h("h1", {}, "Appendix"),
    );
    const context = contextIn(page)(target);
    expect(context?.headings).toEqual([
      `${"x".repeat(79)}\u2026`,
      "Two",
      "Three",
      "Four",
      "Five",
      "Nine, read as six",
    ]);
    expect(context?.headings).toHaveLength(ANNOTATION_LIMITS.headings);
    expect(context?.region).toBe(`evil ${"y".repeat(74)}\u2026`);
    expect(context?.region).toHaveLength(ANNOTATION_LIMITS.region);
    for (const each of [...(context?.headings ?? []), context?.region ?? ""]) {
      expect(each.length).toBeLessThanOrEqual(ANNOTATION_LIMITS.heading);
      expect(unseen(each)).toBe(false);
    }
    // The shell's caps are the host's.
    expect(ANCHOR_CONTEXT).toContain(`const HEADING = ${ANNOTATION_LIMITS.heading};`);
    expect(ANCHOR_CONTEXT).toContain(`const HEADINGS = ${ANNOTATION_LIMITS.headings};`);
    expect(ANCHOR_CONTEXT).toContain(`const REGION = ${ANNOTATION_LIMITS.region};`);
  });

  test("an element holding its own heading: the outline goes down to it, not to the section before (P153)", () => {
    // A card's header picked: its own h3, not the card before's.
    const ownHeader = h("header", {}, h("h3", {}, "频道，@ 了你"), h("span", {}, "2 new"));
    const feed = h(
      "body",
      {},
      h("h1", {}, "Inbox"),
      h("h2", {}, "Notifications"),
      h("div", { id: "f-row-1" }, h("header", {}, h("h3", {}, "私信")), h("p", {}, "Hi")),
      h("div", { id: "f-row-2" }, ownHeader, h("p", {}, "@you")),
    );
    expect(contextIn(feed)(ownHeader)).toEqual({ headings: ["Notifications", "频道，@ 了你"] });

    // A section with an h3 and h4s picked: its h3, the top one, whatever comes before it inside.
    const section = h(
      "section",
      {},
      h("h5", {}, "Kicker"),
      h("h3", {}, "Costs"),
      h("h4", {}, "Fixed"),
      h("p", {}, "Rent."),
      h("h4", {}, "Variable"),
    );
    const report = h(
      "body",
      {},
      h("h1", {}, "Report"),
      h("h2", {}, "Results"),
      h("section", {}, h("h3", {}, "Revenue"), h("p", {}, "Up.")),
      section,
    );
    expect(contextIn(report)(section)).toEqual({ headings: ["Results", "Costs"] });

    // What is inside the target, read through the compareDocumentPosition taken before content runs.
    expect(ANNOTATE_RUNTIME).toContain(
      "inside: (node, target) => (callOf(comparePosition, target, [node]) & 16) !== 0,",
    );
  });

  test("an element holding several headings at its top level (a list of cards) gets the outline from before it; hidden ones aren't counted (P153)", () => {
    const card = (title: string, attrs: Record<string, string> = {}) =>
      h("article", attrs, h("h3", {}, title), h("h4", {}, `${title}, details`));
    const cards = h("div", {}, card("A"), card("B"), card("C"));
    const page = h("body", {}, h("h1", {}, "Report"), h("h2", {}, "Feed"), cards);
    expect(contextIn(page)(cards), "no one card's heading").toEqual({ headings: ["Feed"] });
    // One card of them picked: its own.
    const one = cards.kids[1] as Stand;
    expect(contextIn(page)(one)).toEqual({ headings: ["Feed", "B"] });

    // Two of the three cards hidden (a filtered list): the one rendered h3 is the list's own.
    const filtered = h(
      "div",
      {},
      card("A", { hidden: "" }),
      card("B"),
      h("div", { hidden: "" }, card("C")),
    );
    const shown = h("body", {}, h("h1", {}, "Report"), h("h2", {}, "Feed"), filtered);
    expect(contextIn(shown)(filtered)).toEqual({ headings: ["Feed", "B"] });
    // Its only heading hidden: none of its own.
    const empty = h("div", {}, h("h3", { hidden: "" }, "Gone"));
    const withEmpty = h("body", {}, h("h1", {}, "Report"), h("h2", {}, "Feed"), empty);
    expect(contextIn(withEmpty)(empty)).toEqual({ headings: ["Feed"] });
  });

  test("the page's only h1 is left out above deeper headings, kept alone; two h1s stay; role=heading with aria-level=1 is an h1; a hidden h1 isn't counted (P153)", () => {
    const target = () => h("p", {}, "Words");
    const deeper = target();
    expect(
      contextIn(h("body", {}, h("h1", {}, "Title"), h("h2", {}, "Section"), deeper))(deeper),
      "dropped above deeper headings",
    ).toEqual({ headings: ["Section"] });

    const alone = target();
    const title = h("h1", {}, "Title");
    const lone = contextIn(h("body", {}, title, alone, h("h2", {}, "Later")));
    expect(lone(alone), "kept where it is the only heading").toEqual({ headings: ["Title"] });
    expect(lone(title), "the h1 picked, alone").toEqual({ headings: ["Title"] });

    const second = target();
    expect(
      contextIn(
        h(
          "body",
          {},
          h("h1", {}, "Part one"),
          h("h2", {}, "Intro"),
          h("h1", {}, "Part two"),
          h("h2", {}, "Details"),
          second,
        ),
      )(second),
      "two h1s: kept",
    ).toEqual({ headings: ["Part two", "Details"] });

    const byRole = target();
    expect(
      contextIn(
        h(
          "body",
          {},
          h("div", { role: "heading", "aria-level": "1" }, "Dashboard"),
          h("h2", {}, "Revenue"),
          byRole,
        ),
      )(byRole),
      "role=heading aria-level=1: the only h1, left out",
    ).toEqual({ headings: ["Revenue"] });
    const both = target();
    expect(
      contextIn(
        h(
          "body",
          {},
          h("h1", {}, "Title"),
          h("div", { role: "heading", "aria-level": "1" }, "Dashboard"),
          h("h2", {}, "Revenue"),
          both,
        ),
      )(both),
      "an h1 and a role=heading aria-level=1: two, kept",
    ).toEqual({ headings: ["Dashboard", "Revenue"] });
    const demoted = target();
    expect(
      contextIn(
        h(
          "body",
          {},
          h("h1", {}, "Title"),
          h("h1", { "aria-level": "2" }, "Read as two"),
          h("h3", {}, "Three"),
          demoted,
        ),
      )(demoted),
      "an h1 with aria-level=2 isn't one",
    ).toEqual({ headings: ["Read as two", "Three"] });

    const hidden = target();
    expect(
      contextIn(
        h(
          "body",
          {},
          h("h1", {}, "Title"),
          h("div", { hidden: "" }, h("h1", {}, "Another tab's title")),
          h("h2", {}, "Section"),
          hidden,
        ),
      )(hidden),
      "a hidden h1 isn't counted",
    ).toEqual({ headings: ["Section"] });
  });

  test("bounded (P153): a target holding more than 1,000 headings has none of its own; a page with more than 1,000 keeps its h1", () => {
    const many = (count: number, tag: string) =>
      Array.from({ length: count }, (_, k) => h(tag, {}, `${tag} ${k}`));
    const holding = (count: number) => h("section", {}, h("h2", {}, "Own"), ...many(count, "h3"));
    const within = holding(999);
    expect(
      contextIn(h("body", {}, h("h2", {}, "Before"), within))(within),
      "1,000 inside: its own",
    ).toEqual({ headings: ["Own"] });
    const past = holding(1000);
    expect(
      contextIn(h("body", {}, h("h2", {}, "Before"), past))(past),
      "1,001 inside: none of its own",
    ).toEqual({ headings: ["Before"] });

    const short = h("p", {}, "Words");
    expect(
      contextIn(
        h("body", {}, h("h1", {}, "Title"), h("h2", {}, "Section"), short, ...many(998, "h6")),
      )(short),
      "1,000 headings: its only h1 counted, and left out",
    ).toEqual({ headings: ["Section"] });
    const long = h("p", {}, "Words");
    expect(
      contextIn(
        h("body", {}, h("h1", {}, "Title"), h("h2", {}, "Section"), long, ...many(999, "h6")),
      )(long),
      "1,001 headings: not known to have one h1, kept",
    ).toEqual({ headings: ["Title", "Section"] });
  });

  describe("the host's check", () => {
    const context = { headings: ["Quarterly report", "Revenue"], region: "Revenue tab" };
    const rect = { x: 10, y: 20, width: 30, height: 18 };

    test("kept on either kind of anchor, rebuilt from known fields; an anchor without one as before", () => {
      expect(parseAnchor({ ...element, context })).toStrictEqual({ ...element, context });
      expect(parseAnchor({ ...text, context: { ...context, extra: "<b>" } })).toStrictEqual({
        ...text,
        context,
      });
      expect(parseAnchor({ ...text, context: { region: "Revenue tab" } })).toStrictEqual({
        ...text,
        context: { region: "Revenue tab" },
      });
      expect(parseAnchor(element)).toStrictEqual(element);
      expect(parseAnchor(element)).not.toHaveProperty("context");
    });

    test("shown text: what a person can't see taken out, spaces squashed, an empty heading or region left out", () => {
      expect(
        parseAnchor({
          ...element,
          context: { headings: ["\u202Eevil\u202C", "a\n\n b", "\u200B", " "], region: "\u2066" },
        }),
      ).toStrictEqual({ ...element, context: { headings: ["evil", "a b"] } });
      expect(parseAnchor({ ...element, context: { headings: [], region: "" } })).toStrictEqual(
        element,
      );
      expect(parseAnchor({ ...element, context: {} })).toStrictEqual(element);
    });

    test("malformed or too large: the anchor is dropped, and the report with it", () => {
      const heading = "x".repeat(ANNOTATION_LIMITS.heading);
      const region = "y".repeat(ANNOTATION_LIMITS.region);
      expect(
        parseAnchor({
          ...element,
          context: {
            headings: Array.from({ length: ANNOTATION_LIMITS.headings }, () => heading),
            region,
          },
        }),
        "at the limits",
      ).not.toBeNull();
      for (const bad of [
        null,
        "Revenue",
        ["Revenue"],
        { headings: "Revenue" },
        { headings: [1] },
        { headings: [null] },
        { headings: [`${heading}x`] },
        { headings: Array.from({ length: ANNOTATION_LIMITS.headings + 1 }, () => "a") },
        { region: 1 },
        { region: `${region}y` },
        { headings: { 0: "a", length: 1 } },
      ]) {
        expect(parseAnchor({ ...element, context: bad }), JSON.stringify(bad)).toBeNull();
        expect(
          parseReport({ type: "selected", anchor: { ...text, context: bad }, rect }),
          JSON.stringify(bad),
        ).toBeNull();
      }
    });

    test("a selected report carries it; a mark sent to the frame doesn't (the frame finds it by its selectors)", () => {
      expect(
        parseReport({ type: "selected", anchor: { ...element, context }, rect }),
      ).toStrictEqual({ type: "selected", anchor: { ...element, context }, rect });
      const [posted, draft] = checkMarks([
        { id: "m1", anchor: { ...element, context }, count: 2 },
        { id: "m2", anchor: { ...text, context }, kind: "draft" },
      ]);
      expect(posted).toStrictEqual({ id: "m1", anchor: element, count: 2 });
      expect(draft).toStrictEqual({ id: "m2", anchor: text, kind: "draft" });
    });
  });
});

describe("where the reader is in the page (P155): its page, the fragment that names an element, the scroll", () => {
  const scroll = { x: 0, y: 1_240 };
  const rect = { x: 10, y: 20, width: 30, height: 18 };

  describe("the host's check (parsePlace)", () => {
    test("kept, rebuilt from known fields; page and hash where present, scroll always", () => {
      expect(parsePlace({ page: "./report.html", hash: "#pricing", scroll })).toStrictEqual({
        page: "./report.html",
        hash: "#pricing",
        scroll,
      });
      expect(parsePlace({ scroll, extra: "<b>", hash: "#a", page: "./" })).toStrictEqual({
        page: "./",
        hash: "#a",
        scroll,
      });
      expect(parsePlace({ scroll })).toStrictEqual({ scroll });
      // As an address serializes them: percent-encoded, a fragment's own `#`, `?` and `/` kept.
      expect(parsePlace({ hash: "#caf%C3%A9", scroll })).toStrictEqual({
        hash: "#caf%C3%A9",
        scroll,
      });
      expect(parsePlace({ hash: "#a/b?c#d", scroll })?.hash).toBe("#a/b?c#d");
      expect(parsePlace({ page: "./docs/%E5%AE%9A%E4%BB%B7.html", scroll })?.page).toBe(
        "./docs/%E5%AE%9A%E4%BB%B7.html",
      );
    });

    test("at the limits taken; past them, or malformed, null (the report goes with it)", () => {
      const page = `./${"p".repeat(ANNOTATION_LIMITS.page - 2)}`;
      const hash = `#${"h".repeat(ANNOTATION_LIMITS.hash - 1)}`;
      expect(parsePlace({ page, hash, scroll }), "at the limits").toStrictEqual({
        page,
        hash,
        scroll,
      });
      for (const bad of [
        null,
        "./report.html#pricing",
        [],
        {},
        { page: "./a.html" },
        { scroll: { x: 0 } },
        { scroll: { x: 0, y: Number.NaN } },
        { scroll, page: `${page}p` },
        { scroll, hash: `${hash}h` },
        { scroll, page: 1 },
        { scroll, hash: null },
        // Not the files' own page: an address, a sealed access, no "./".
        { scroll, page: "https://c.example/__porthole/f/abcdefghijklmnopqrstuvwxyz/report.html" },
        { scroll, page: "report.html" },
        { scroll, page: "/report.html" },
        // A query or a fragment in the page: where a viewer's data would be.
        { scroll, page: "./report.html?viewer=ann" },
        { scroll, page: "./report.html#pricing" },
        // Not as an address serializes it: spaces, quotes, angle brackets, a backtick, non-ASCII,
        // controls, bidi controls.
        { scroll, page: "./my report.html" },
        { scroll, page: "./<b>.html" },
        { scroll, hash: "#" },
        { scroll, hash: "pricing" },
        { scroll, hash: "#pri cing" },
        { scroll, hash: '#"x"' },
        { scroll, hash: "#<b>" },
        { scroll, hash: "#`x`" },
        { scroll, hash: "#定价" },
        { scroll, hash: "#a‮b" },
        { scroll, hash: "#a\nb" },
      ]) {
        expect(parsePlace(bad), JSON.stringify(bad)).toBeNull();
      }
    });

    test("a selected report carries it, rebuilt; a malformed one drops the report; an older shell's, without one, as before", () => {
      const place = { page: "./report.html", hash: "#pricing", scroll };
      expect(
        parseReport({
          type: "selected",
          anchor: element,
          rect,
          scroll,
          lastLineDocumentRect: rect,
          place,
        }),
      ).toStrictEqual({
        type: "selected",
        anchor: element,
        rect,
        lastLineDocumentRect: rect,
        scroll,
        place,
      });
      // Where nothing of it is drawn: no last line nor scroll of the report's own, and the place.
      expect(
        parseReport({ type: "selected", anchor: text, rect, place: { scroll } }),
      ).toStrictEqual({
        type: "selected",
        anchor: text,
        rect,
        place: { scroll },
      });
      expect(parseReport({ type: "selected", anchor: text, rect })).toStrictEqual({
        type: "selected",
        anchor: text,
        rect,
      });
      for (const bad of [
        null,
        "./a.html#b",
        { page: "./a.html" },
        { scroll, hash: "#token=a b" },
      ]) {
        expect(
          parseReport({ type: "selected", anchor: text, rect, place: bad }),
          JSON.stringify(bad),
        ).toBeNull();
      }
    });
  });

  describe("in the shell: the fragment told only where it names an element (PAGE_HASH)", () => {
    /** A stand-in element: its tag, id and name. */
    interface Named {
      readonly tag: string;
      readonly id?: string;
      readonly name?: string;
    }
    /**
     * `PAGE_HASH` over a stand-in document of `elements`, its reads as the runtime wires them:
     * `getElementById`, `getElementsByName` (the HTML elements named so, in order), each one's
     * local name, and `decodeURIComponent`.
     */
    const hashIn = (elements: readonly Named[], dom: Partial<Record<string, unknown>> = {}) => {
      const factory = runInNewContext(PAGE_HASH) as (
        reads: Record<string, unknown>,
      ) => (hash: unknown) => string | null;
      return factory({
        byId: (id: string) => elements.find((each) => each.id === id) ?? null,
        named: (name: string) => elements.filter((each) => each.name === name),
        name: (each: Named) => each.tag,
        decode: (written: string) => decodeURIComponent(written),
        ...dom,
      });
    };
    const page: Named[] = [
      { tag: "section", id: "pricing" },
      { tag: "h2", id: "café" },
      { tag: "a", name: "faq" },
      { tag: "input", name: "q" },
      { tag: "div", id: "a%20b" },
      { tag: "p", id: "x y" },
    ];

    test("an element's id, or an <a name>, as written or percent-decoded: told, as the address says it", () => {
      const hashOf = hashIn(page);
      expect(hashOf("#pricing")).toBe("#pricing");
      expect(hashOf("#faq"), "an <a name>").toBe("#faq");
      expect(hashOf("#caf%C3%A9"), "decoded").toBe("#caf%C3%A9");
      expect(hashOf("#a%20b"), "as written first").toBe("#a%20b");
      expect(hashOf("#x%20y"), "decoded, a space").toBe("#x%20y");
    });

    test("any other fragment is never told: a route, data, a token, a name that isn't an <a>'s, the top", () => {
      const hashOf = hashIn(page);
      for (const hash of [
        "#/orders/8812",
        "#!/inbox",
        "#access_token=eyJhbGciOi.secret&token_type=bearer",
        "#state=%7B%22tab%22%3A2%7D",
        "#q",
        "#Pricing",
        "#top",
        "#TOP",
        "#",
        "",
        "pricing",
        "#%",
        "#%E0%A4%A",
      ]) {
        expect(hashOf(hash), hash).toBeNull();
      }
      // A fragment that won't decode is tried as written only.
      expect(hashIn([{ tag: "div", id: "%E0%A4%A" }])("#%E0%A4%A")).toBe("#%E0%A4%A");
      // Not the address's serialization (a space, a quote, angle brackets, a backtick, non-ASCII),
      // or not a string: never, whatever the page has.
      for (const hash of ["#x y", '#"q"', "#<a>", "#`a`", "#café"]) {
        expect(hashIn([{ tag: "div", id: hash.slice(1) }])(hash), hash).toBeNull();
      }
      for (const hash of [1, null, undefined, {}, ["#pricing"]]) {
        expect(hashIn(page)(hash), JSON.stringify(hash)).toBeNull();
      }
    });

    test("bounded: 256 characters, # included, as the host's limit, never cut; 64 elements named so looked at", () => {
      expect(ANNOTATION_LIMITS.hash).toBe(256);
      const at = "i".repeat(255);
      expect(hashIn([{ tag: "div", id: at }])(`#${at}`)).toBe(`#${at}`);
      expect(hashIn([{ tag: "div", id: `${at}i` }])(`#${at}i`)).toBeNull();
      const inputs = (n: number): Named[] =>
        Array.from({ length: n }, () => ({ tag: "input", name: "faq" }));
      expect(hashIn([...inputs(63), { tag: "a", name: "faq" }])("#faq"), "the 64th").toBe("#faq");
      expect(hashIn([...inputs(64), { tag: "a", name: "faq" }])("#faq"), "the 65th").toBeNull();
    });

    test("a page whose DOM throws, or lies about its list, gets none, and nothing is thrown", () => {
      const thrower = () => {
        throw new Error("patched");
      };
      expect(hashIn(page, { byId: thrower })("#pricing")).toBeNull();
      expect(hashIn(page, { named: thrower })("#faq")).toBeNull();
      expect(hashIn(page, { decode: thrower })("#caf%C3%A9")).toBeNull();
      expect(
        hashIn(page, { named: () => ({ length: Number.POSITIVE_INFINITY }) })("#faq"),
      ).toBeNull();
    });
  });

  describe("in the shell: wired", () => {
    const body = (from: string, to: string) => {
      const start = ANNOTATE_RUNTIME.indexOf(from);
      expect(start, from).toBeGreaterThan(-1);
      return ANNOTATE_RUNTIME.slice(start, ANNOTATE_RUNTIME.indexOf(to, start));
    };

    test("its reads are the DOM's own, taken before content runs", () => {
      const listening = ANNOTATE_RUNTIME.indexOf("window.addEventListener");
      for (const taken of [
        "const elementById = Document.prototype.getElementById;",
        "const elementsByName = Document.prototype.getElementsByName;",
        "const decodeFragment = decodeURIComponent;",
        'const hashOf = getterOf(location, "hash");',
      ]) {
        const at = ANNOTATE_RUNTIME.indexOf(taken);
        expect(at, taken).toBeGreaterThan(-1);
        expect(at, taken).toBeLessThan(listening);
      }
      expect(ANNOTATE_RUNTIME).toContain(`const hashNamed = (${PAGE_HASH})({`);
      const wired = body("const hashNamed = (", "      });");
      expect(wired).toContain("byId: (id) => callOf(elementById, document, [id]),");
      expect(wired).toContain("named: (name) => callOf(elementsByName, document, [name]),");
      expect(wired).toContain("decode: (text) => decodeFragment(text),");
      expect(body("const placeHere = (scroll) => {", "\n      };")).toContain(
        "hashNamed(hashOf === null ? location.hash : callOf(hashOf, location, []))",
      );
    });

    test("the page: its address as it loaded, read once before content runs, without query or fragment, its files' address as ./; none without files", () => {
      const page = body("const pageHere = (() => {", "})();");
      expect(page).toContain("if (filesBase === null) {\n          return null;");
      expect(page).toContain(
        'const page = ownAddresses(before(before(NativeString(location.href), "#"), "?"));',
      );
      expect(page).toContain("page.length <= 2048");
      expect(ANNOTATION_LIMITS.page).toBe(2_048);
      // Read once: the place reads pageHere, never the address again.
      expect(body("const placeHere = (scroll) => {", "\n      };")).not.toContain("location.href");
      // The shell's shapes are the host's: what it sends, parsePlace takes.
      expect(page).toContain("/^\\.\\/[!$-;=@-_a-~]*$/.test(page)");
      expect(PAGE_HASH).toContain("!/^#[!#-;=?-_a-~]+$/.test(hash)");
      const pageShape = /^\.\/[!$-;=@-_a-~]*$/u;
      const hashShape = /^#[!#-;=?-_a-~]+$/u;
      for (let code = 0; code < 0x80; code += 1) {
        const each = String.fromCharCode(code);
        expect(parsePlace({ page: `./${each}`, scroll }) !== null, `page ${code}`).toBe(
          pageShape.test(`./${each}`),
        );
        expect(parsePlace({ hash: `#${each}`, scroll }) !== null, `hash ${code}`).toBe(
          hashShape.test(`#${each}`),
        );
      }
    });

    test("every selected says it, at the report's own scroll; a place request is answered with it and nothing else", () => {
      const placed = body("const placeOf = (found, point) => {", "\n      };");
      expect(placed).toContain("const place = placeHere(scroll);");
      expect(placed).toContain("return { place };");
      expect(placed.split("place }")).toHaveLength(4);
      // Every selected goes through placeOf: the pick, the held block, the words.
      expect(ANNOTATE_RUNTIME.split("tell(M.selected,")).toHaveLength(4);
      expect(ANNOTATE_RUNTIME.split("placeOf(")).toHaveLength(4);
      expect(ANNOTATE_RUNTIME).toContain('place: "porthole/annotate.place"');
      const asked = body("case M.place:", "break;");
      expect(asked).toContain('if (typeof data.id === "string" || typeof data.id === "number") {');
      expect(asked).toContain("answer(data.id, placeHere(scrollOf()));");
      expect(asked).not.toMatch(/tell\(|focus|scrollTo|scrollBy|removeAllRanges|location\./u);
      // Built as literals, never by assignment through a prototype content could fill.
      const built = body("const placeHere = (scroll) => {", "\n      };");
      expect(built).not.toMatch(/\.(page|hash|scroll) =/u);
      // The shell's own listener leaves the request to annotations', where they are declared, and
      // names nothing of theirs.
      expect(ANNOTATE_RUNTIME).toContain("ownRequests[M.place] = true;");
      expect(SHELL_RUNTIME).toContain("const ownRequests = bare(null);");
      expect(SHELL_RUNTIME).toContain("&& ownRequests[data.method] !== true) {");
      expect(SHELL_RUNTIME.indexOf("const ownRequests = bare(null);")).toBeLessThan(
        SHELL_RUNTIME.indexOf("__ANNOTATE__"),
      );
      expect(SHELL_RUNTIME).not.toContain("porthole/annotate");
    });

    test("with it in, the shell is still a plain script", () => {
      expect(
        () =>
          new Script(
            SHELL_RUNTIME.replace("__ANNOTATE__", ANNOTATE_RUNTIME).replace("__PLAN__", "{}"),
          ),
      ).not.toThrow();
    });
  });

  describe("the runtime itself, run over a stand-in window", () => {
    /** The shell's own definitions the annotation runtime uses, as the shell writes them. */
    const shellPart = (start: string, end: string) => {
      const at = SHELL_RUNTIME.indexOf(start);
      expect(at, start).toBeGreaterThan(-1);
      return SHELL_RUNTIME.slice(at, SHELL_RUNTIME.indexOf(end, at) + end.length);
    };
    const prelude = () =>
      [
        "const hostless = false;",
        "const callOf = Reflect.apply;",
        'const declared = (name) => name === "annotate";',
        "const hostWindow = window.parent;",
        "const hostOpener = null;",
        shellPart("  const fromHostWindow =", ";\n"),
        shellPart("  let filesBase =", ";\n"),
        shellPart("  const filesBases =", ";\n"),
        shellPart("  const SEALED =", ";\n"),
        shellPart("  const ownAddresses =", "\n  };\n"),
        shellPart("  const NativeString =", ";\n"),
        shellPart("  const indexIn =", ";\n"),
        shellPart("  const sliceOf =", ";\n"),
        shellPart("  const before =", "\n  };\n"),
        shellPart("  const getterOf =", "\n  };\n"),
        shellPart("  const bare =", ";\n"),
        shellPart("  const ownRequests =", ";\n"),
      ].join("\n");
    const BASE = "https://c.example/__porthole/f/ABCDEFGHIJKLMNOPQRSTUVWX/";
    interface Named {
      readonly tag: string;
      readonly id?: string;
      readonly name?: string;
    }
    /**
     * `ANNOTATE_RUNTIME` run at `address` (a page of files under `BASE`, or none), over a document
     * of `elements` scrolled to (3, 1240): what it posts to its parent, and the host's words to it.
     * Every other built-in it takes is a stand-in that nothing here calls.
     */
    const runAt = (address: string, files: string | null, elements: readonly Named[]) => {
      const posted: unknown[] = [];
      let heard: ((event: unknown) => void)[] = [];
      const stub = () => {
        const made = function () {};
        made.prototype = {};
        return made as unknown as { prototype: Record<string, unknown> };
      };
      const url = new URL(address);
      const location = {};
      Object.defineProperty(location, "href", { get: () => url.href });
      Object.defineProperty(location, "hash", { get: () => url.hash });
      const parent = {
        postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))),
      };
      const Document = stub();
      Document.prototype.getElementById = (id: string) =>
        elements.find((each) => each.id === id) ?? null;
      Document.prototype.getElementsByName = (name: string) =>
        elements.filter((each) => each.name === name);
      const Element = stub();
      Object.defineProperty(Element.prototype, "localName", {
        get(this: Named) {
          return this.tag;
        },
      });
      Element.prototype.getBoundingClientRect = () => ({
        left: -3,
        top: -1_240,
        width: 800,
        height: 5_000,
      });
      const window = {
        parent,
        addEventListener: (type: string, listener: (event: unknown) => void) => {
          if (type === "message") {
            heard.push(listener);
          }
        },
        requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
        getComputedStyle: () => ({}),
        setTimeout,
        clearTimeout,
      };
      const globals: Record<string, unknown> = {
        window,
        parent,
        location,
        document: { documentElement: {}, addEventListener: () => {} },
        Document,
        Element,
        MutationObserver: class {
          observe() {}
        },
        getComputedStyle: window.getComputedStyle,
        setTimeout,
        clearTimeout,
        plan: {
          origins: ["https://host.example"],
          ...(files === null ? {} : { files: { base: files } }),
        },
      };
      // Each DOM interface it takes a built-in of, as a stand-in, as the runtime first names it.
      for (let tries = 0; ; tries += 1) {
        heard = [];
        try {
          runInNewContext(`${prelude()}\n${ANNOTATE_RUNTIME}`, { ...globals });
          break;
        } catch (error) {
          const missing = /^(\w+) is not defined$/u.exec((error as Error).message);
          if (missing === null || tries > 80) {
            throw error;
          }
          globals[missing[1] as string] = stub();
        }
      }
      const say = (data: unknown, origin = "https://host.example", source: unknown = parent) => {
        for (const listener of heard) {
          listener({ source, origin, data });
        }
      };
      const ask = (id: unknown) =>
        say({ jsonrpc: "2.0", id, method: "porthole/annotate.place", params: {} });
      return { posted, say, ask, url };
    };
    const page: Named[] = [
      { tag: "section", id: "pricing" },
      { tag: "a", name: "faq" },
      { tag: "h2", id: "café" },
    ];
    const scrolled = { x: 3, y: 1_240 };

    test("answers a place request with its page (sealed access as ./, no query), the fragment that names an element, and the scroll", () => {
      const t = runAt(`${BASE}report.html?viewer=ann#pricing`, BASE, page);
      t.ask("p1");
      t.ask(7);
      expect(t.posted).toEqual([
        {
          jsonrpc: "2.0",
          id: "p1",
          result: { page: "./report.html", hash: "#pricing", scroll: scrolled },
        },
        {
          jsonrpc: "2.0",
          id: 7,
          result: { page: "./report.html", hash: "#pricing", scroll: scrolled },
        },
      ]);
      for (const [address, place] of [
        [`${BASE}#faq`, { page: "./", hash: "#faq", scroll: scrolled }],
        [
          `${BASE}docs/a.html#caf%C3%A9`,
          { page: "./docs/a.html", hash: "#caf%C3%A9", scroll: scrolled },
        ],
        [`${BASE}report.html#access_token=secret`, { page: "./report.html", scroll: scrolled }],
        [`${BASE}report.html#/orders/8812`, { page: "./report.html", scroll: scrolled }],
        [`${BASE}report.html`, { page: "./report.html", scroll: scrolled }],
      ] as const) {
        const each = runAt(address, BASE, page);
        each.ask("p");
        expect(each.posted, address).toEqual([{ jsonrpc: "2.0", id: "p", result: place }]);
        // What the host takes of it, as it was sent.
        expect(parsePlace((each.posted[0] as { result: unknown }).result), address).toEqual(place);
      }
    });

    test("content without files has no page; the page is the address it loaded at, the fragment the one it has now", () => {
      const inline = runAt("https://c.example/inline#pricing", null, page);
      inline.ask("p");
      expect(inline.posted).toEqual([
        { jsonrpc: "2.0", id: "p", result: { hash: "#pricing", scroll: scrolled } },
      ]);
      const t = runAt(`${BASE}report.html`, BASE, page);
      // The page's scripts move it (history.pushState, a route) and to a section.
      t.url.href = `${BASE}orders/8812?viewer=ann#faq`;
      t.ask("p");
      expect(t.posted).toEqual([
        {
          jsonrpc: "2.0",
          id: "p",
          result: { page: "./report.html", hash: "#faq", scroll: scrolled },
        },
      ]);
    });

    test("only the host's request, from its window and origins, with an id, is answered; nothing else is told", () => {
      const t = runAt(`${BASE}report.html#pricing`, BASE, page);
      t.say({ jsonrpc: "2.0", method: "porthole/annotate.place", params: {} });
      t.say({ jsonrpc: "2.0", id: { a: 1 }, method: "porthole/annotate.place" });
      t.say(
        { jsonrpc: "2.0", id: "x", method: "porthole/annotate.place" },
        "https://other.example",
      );
      t.say(
        { jsonrpc: "2.0", id: "x", method: "porthole/annotate.place" },
        "https://host.example",
        {},
      );
      expect(t.posted).toEqual([]);
    });
  });

  describe("on createHost over a stand-in platform", () => {
    const mounted: DisplayHandle[] = [];
    afterEach(() => {
      vi.useRealTimers();
      for (const display of mounted.splice(0)) {
        display.destroy();
      }
    });
    /** A display whose frames' messages from the host are kept, each frame's handshake by hand. */
    const mount = (annotate = true) => {
      const sent: Record<string, unknown>[] = [];
      let listeners = new Set<(message: unknown) => void>();
      const platform: PlatformHost = {
        name: "stand-in",
        createSurface: () => {
          listeners = new Set();
          const own = listeners;
          return {
            transport: {
              send: (message) => void sent.push(message as Record<string, unknown>),
              listen: (listener) => {
                own.add(listener);
                return () => own.delete(listener);
              },
              close: () => own.clear(),
            },
            element: null,
            setHeight: () => {},
            setColorScheme: () => {},
            userActivation: () => undefined,
            viewport: () => ({ width: 600, height: 400 }),
            onNavigated: () => () => {},
            onLoad: () => () => {},
            destroy: () => {},
          };
        },
      };
      const container = {
        ownerDocument: {
          defaultView: {
            location: { origin: "https://app.example" },
            navigator: { language: "en" },
          },
        },
        getBoundingClientRect: () => ({ width: 600 }),
      } as unknown as HTMLElement;
      const config = annotate
        ? presets.artifact({ capabilities: { annotate: {} } })
        : presets.artifact();
      const display = createHost(config, { platform }).mount(container, {
        displayId: "d1",
        title: "Notes",
        scheme: "light",
      });
      mounted.push(display);
      const say = (message: Record<string, unknown>) => {
        for (const listener of listeners) {
          listener({ jsonrpc: "2.0", ...message });
        }
      };
      const handshake = () => say({ method: "ui/notifications/initialized", params: {} });
      const asked = () => sent.filter((each) => each.method === "porthole/annotate.place");
      const reports: AnnotationReport[] = [];
      display.on("annotation", (report) => reports.push(report));
      return { display, sent, say, handshake, asked, reports };
    };

    test("asks the frame running now, once its handshake is done, and takes its answer, rebuilt", async () => {
      const t = mount();
      expect(await t.display.annotations.place(), "no frame ready").toBe("unsupported");
      expect(t.asked()).toEqual([]);
      t.handshake();
      const now = t.display.annotations.place();
      expect(t.asked()).toEqual([
        { jsonrpc: "2.0", id: expect.any(String), method: "porthole/annotate.place", params: {} },
      ]);
      const id = t.asked()[0]?.id;
      // An answer to another id is no answer.
      t.say({ id: "porthole-place-999", result: { scroll } });
      t.say({ id, result: { page: "./report.html", hash: "#pricing", scroll, extra: "<b>" } });
      expect(await now).toStrictEqual({ page: "./report.html", hash: "#pricing", scroll });
      // A second answer for it changes nothing; each ask has an id of its own.
      t.say({ id, result: { scroll: { x: 0, y: 0 } } });
      const again = t.display.annotations.place();
      expect(t.asked()[1]?.id).not.toBe(id);
      t.say({ id: t.asked()[1]?.id, result: { scroll } });
      expect(await again).toStrictEqual({ scroll });
    });

    test("an older shell's 'isn't offered here', a malformed answer, or none in time: unsupported", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const t = mount();
      t.handshake();
      const older = t.display.annotations.place();
      t.say({
        id: t.asked().at(-1)?.id,
        error: { code: -32601, message: "porthole/annotate.place isn't offered here" },
      });
      expect(await older).toBe("unsupported");
      const leaky = t.display.annotations.place();
      t.say({ id: t.asked().at(-1)?.id, result: { hash: "#token=a b", scroll } });
      expect(await leaky).toBe("unsupported");
      const silent = t.display.annotations.place();
      await vi.advanceTimersByTimeAsync(ANNOTATION_LIMITS.placeTimeoutMs - 1);
      let settled = false;
      void silent.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await silent).toBe("unsupported");
    });

    test("a new run or the display's end while it waits: unsupported, and the late answer is no answer", async () => {
      const t = mount();
      t.handshake();
      const before = t.display.annotations.place();
      const id = t.asked().at(-1)?.id;
      t.display.reload();
      expect(await before).toBe("unsupported");
      t.handshake();
      t.say({ id, result: { scroll } });
      const ended = t.display.annotations.place();
      t.display.destroy();
      expect(await ended).toBe("unsupported");
    });

    test("not kept for a later frame; not a report, so through no gate and no refusal", async () => {
      const t = mount();
      t.handshake();
      void t.display.annotations.place();
      const before = t.sent.length;
      t.display.reload();
      t.handshake();
      expect(
        t.sent.slice(before).filter((each) => each.method === "porthole/annotate.place"),
      ).toEqual([]);
      expect(t.reports).toEqual([]);
    });

    test("without annotate declared: a TypeError, and nothing goes to the frame", async () => {
      const t = mount(false);
      t.handshake();
      await expect(t.display.annotations.place()).rejects.toThrow(
        /place: the config doesn't declare annotate/u,
      );
      expect(t.asked()).toEqual([]);
    });

    test("a selected report's place reaches the host as the shell said it; a malformed one drops the report", async () => {
      const t = mount();
      t.handshake();
      t.display.annotations.start({ elements: false, text: true });
      const place = { page: "./pricing.html", hash: "#plans", scroll };
      t.say({ method: "porthole/annotate.selected", params: { anchor: text, rect, place } });
      t.say({
        method: "porthole/annotate.selected",
        params: { anchor: text, rect, place: { hash: "#plans" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(t.reports).toEqual([{ type: "selected", anchor: text, rect, place }]);
    });
  });
});
