import { Script } from "node:vm";
import { afterEach, describe, expect, test } from "vitest";
import {
  annotateMode,
  checkMarks,
  clampRect,
  hasMarker,
  parseAnchor,
  parseRect,
  parseReport,
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

  test("is taken only within a gesture, where the platform can tell (P105)", async () => {
    const marks = [{ id: "c1", anchor: text, count: 2 }];
    // No transient activation on the host's page: a click the page posted by itself.
    const idle = mount({ userActivation: () => false });
    idle.display.annotations.show(marks);
    await idle.activate({ id: "c1", rect });
    expect(idle.reports).toEqual([]);
    expect(idle.refused).toEqual([]);
    // A platform that fails to say is taken as saying no.
    const failing = mount({
      userActivation: () => {
        throw new Error("can't tell");
      },
    });
    failing.display.annotations.show(marks);
    await failing.activate({ id: "c1", rect });
    expect(failing.reports).toEqual([]);
    expect(failing.thrown).toEqual([]);
    // Within one, and where the platform can't tell (as for the gesture gate): taken.
    for (const userActivation of [() => true, () => undefined]) {
      const t = mount({ userActivation });
      t.display.annotations.show(marks);
      await t.activate({ id: "c1", rect });
      expect(t.reports).toEqual([{ type: "activated", id: "c1", rect }]);
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

describe("clearSelection (P115), on createHost over a stand-in platform", () => {
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
