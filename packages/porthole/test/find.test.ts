import { runInNewContext, Script } from "node:vm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createBridge, type BridgeEvent } from "../src/bridge/bridge.ts";
import {
  FIND_LIMITS,
  compile,
  createHost,
  presets,
  type DisplayHandle,
  type FindResult,
  type PlatformHost,
} from "../src/index.ts";
import {
  blankQuery,
  checkFindQuery,
  parseFindReport,
  parseFindResult,
} from "../src/find/validate.ts";
import { ANNOTATE_RUNTIME } from "../src/shell/annotate.ts";
import { findScopeOf, sameFindScope, type PortholeFrameProps } from "../src/react/frame.tsx";
import {
  FIND_LATEST,
  FIND_MATCH,
  FIND_RUNTIME,
  FIND_SHORTCUT,
  LAYER_STYLE,
} from "../src/shell/find.ts";
import { SHELL_RUNTIME } from "../src/shell/runtime.ts";
import { TEXT_INDEX } from "../src/shell/text.ts";

/** Find in page (P131): the shell's matching and shortcut, what the host sends and takes. */

type Span = { start: number; end: number; kept: unknown };
type Match = (
  text: string,
  query: string,
  caseSensitive: boolean,
  most: number,
  keep: (start: number, end: number) => unknown,
  Pattern: RegExpConstructor,
  exec: (this: RegExp, text: string) => RegExpExecArray | null,
  apply: typeof Reflect.apply,
  list: () => Span[],
  push: (list: Span[], span: Span) => void,
) => { spans: Span[]; capped: boolean };

/**
 * The rule, with the platform's own RegExp, exec and Reflect.apply, as the runtime passes them; its
 * spans in an array here (the runtime passes its prototype-less lists).
 */
const realm = runInNewContext(
  `({ match: ${FIND_MATCH}, Pattern: RegExp, exec: RegExp.prototype.exec, apply: Reflect.apply })`,
) as {
  readonly match: Match;
  readonly Pattern: RegExpConstructor;
  readonly exec: (this: RegExp, text: string) => RegExpExecArray | null;
  readonly apply: typeof Reflect.apply;
};
const match = (
  text: string,
  query: string,
  caseSensitive: boolean,
  most: number,
  keep: (start: number, end: number) => unknown,
) =>
  realm.match(
    text,
    query,
    caseSensitive,
    most,
    keep,
    realm.Pattern,
    realm.exec,
    realm.apply,
    () => [],
    (list, span) => {
      list.push(span);
    },
  );
/** The matches' text and offsets, everything kept, at most `most`. */
const find = (
  text: string,
  query: string,
  options: { caseSensitive?: boolean; most?: number } = {},
) => {
  const found = match(
    text,
    query,
    options.caseSensitive === true,
    options.most ?? FIND_LIMITS.matches,
    () => true,
  );
  return {
    words: found.spans.map((span) => text.slice(span.start, span.end)),
    at: found.spans.map((span) => [span.start, span.end]),
    capped: found.capped,
  };
};

describe("the shell's matching", () => {
  test("is case-insensitive by default, with the text's own offsets", () => {
    const text = "Revenue grew. REVENUE fell; revenue held.";
    expect(find(text, "revenue").words).toEqual(["Revenue", "REVENUE", "revenue"]);
    expect(find(text, "revenue").at).toEqual([
      [0, 7],
      [14, 21],
      [28, 35],
    ]);
    expect(find(text, "Revenue", { caseSensitive: true }).words).toEqual(["Revenue"]);
    // Beyond ASCII: Unicode's simple case folding.
    expect(find("Élan, élan, ÉLAN", "élan").words).toEqual(["Élan", "élan", "ÉLAN"]);
    expect(find("Straße STRASSE", "straße").words).toEqual(["Straße"]);
  });

  test("is loose about spacing, as annotations' squash is: a run of any white space is one", () => {
    const text = "Costs fell\n\t  by 3%. Then rose by  2%.";
    expect(find(text, "fell by 3%").words).toEqual(["fell\n\t  by 3%"]);
    expect(find(text, "  fell   by 3%  ").words).toEqual(["fell\n\t  by 3%"]);
    expect(find(text, "rose by 2%").words).toEqual(["rose by  2%"]);
    // Spacing in the query needs some in the text: words run together are no match.
    expect(find("fellby", "fell by").words).toEqual([]);
  });

  test("takes every other character literally: no pattern syntax reaches the expression", () => {
    const text = "a.b axb (x) [y] {z} a+b aab $1 ^2 c|d e\\f g/h i?j k*l";
    expect(find(text, "a.b").words).toEqual(["a.b"]);
    expect(find(text, "a+b").words).toEqual(["a+b"]);
    for (const literal of ["(x)", "[y]", "{z}", "$1", "^2", "c|d", "e\\f", "g/h", "i?j", "k*l"]) {
      expect(find(text, literal).words, literal).toEqual([literal]);
    }
    expect(find(text, "[").words).toEqual(["["]);
    expect(find(text, "\\").words).toEqual(["\\"]);
    expect(find(text, ".*").words).toEqual([]);
  });

  test("finds no overlapping matches, in order; nothing for no words", () => {
    expect(find("aaaa", "aa").at).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(find("anything", "").words).toEqual([]);
    expect(find("any thing", "  \n\t ").words).toEqual([]);
    expect(blankQuery("  \n")).toBe(true);
    expect(blankQuery(" a ")).toBe(false);
  });

  test("stops at the most it keeps, and says there may be more", () => {
    const text = "ab ".repeat(1_500);
    const all = find(text, "ab");
    expect(all.words).toHaveLength(FIND_LIMITS.matches);
    expect(all.capped).toBe(true);
    // Exactly the most: all of them, not capped.
    expect(find("ab ".repeat(1_000), "ab")).toMatchObject({ capped: false });
    expect(find("ab ".repeat(1_000), "ab").words).toHaveLength(1_000);
    expect(find("ab ab ab", "ab", { most: 2 })).toMatchObject({ capped: true });
  });

  test("counts only what keep keeps, and looks at no more than ten times the most", () => {
    const text = "ab ".repeat(100);
    const odd = match(text, "ab", false, 1_000, (start) => (start % 6 === 0 ? { start } : null));
    expect(odd.spans).toHaveLength(50);
    expect(odd.spans[1]).toEqual({ start: 6, end: 8, kept: { start: 6 } });
    expect(odd.capped).toBe(false);
    // A page of hidden matches (none kept) is looked at only so far.
    let looked = 0;
    const hidden = match("ab ".repeat(500), "ab", false, 10, () => {
      looked += 1;
      return null;
    });
    expect(hidden).toEqual({ spans: [], capped: true });
    expect(looked).toBe(100);
  });

  test("a long query on a long page finishes quickly (the limits)", () => {
    const text = "a".repeat(200_000);
    const query = `${"a".repeat(FIND_LIMITS.query - 2)} b`;
    const began = performance.now();
    expect(find(text, query).words).toEqual([]);
    expect(performance.now() - began).toBeLessThan(5_000);
  });
});

describe("the find shortcut", () => {
  type Rule = (
    apple: boolean,
    key: unknown,
    code: unknown,
    meta: unknown,
    ctrl: unknown,
    alt: unknown,
    shift: unknown,
  ) => boolean;
  const rule = runInNewContext(FIND_SHORTCUT) as Rule;
  test("is Cmd+F on Apple's platforms and Ctrl+F elsewhere, and nothing else", () => {
    expect(rule(true, "f", "KeyF", true, false, false, false)).toBe(true);
    expect(rule(true, "F", "KeyF", true, false, false, false)).toBe(true);
    expect(
      rule(true, "f", "KeyF", false, true, false, false),
      "Ctrl+F on a Mac moves the caret",
    ).toBe(false);
    expect(rule(false, "f", "KeyF", false, true, false, false)).toBe(true);
    expect(rule(false, "f", "KeyF", true, false, false, false), "the Windows key").toBe(false);
    expect(rule(false, "f", "KeyF", true, true, false, false)).toBe(false);
    expect(rule(true, "f", "KeyF", true, false, true, false)).toBe(false);
    expect(rule(true, "f", "KeyF", true, false, false, true)).toBe(false);
    expect(rule(true, "g", "KeyG", true, false, false, false)).toBe(false);
    expect(rule(false, "f", "KeyF", false, false, false, false)).toBe(false);
  });
  test("follows the layout's letter, and F's place where the letters aren't Latin", () => {
    // Cyrillic: the key in F's place types "а".
    expect(rule(true, "а", "KeyF", true, false, false, false)).toBe(true);
    // Dvorak: the key in F's place types "u", and Cmd+U is not find; its own "f" is.
    expect(rule(true, "u", "KeyF", true, false, false, false)).toBe(false);
    expect(rule(true, "f", "KeyY", true, false, false, false)).toBe(true);
  });
});

describe("only the latest query", () => {
  type Latest = {
    ask: (id: string, request: string) => void;
    drop: () => void;
  };
  /** The rule, in a realm of its own, over a clock and a timer queue the test drives. */
  const latestOf = (quiet = 16) => {
    let now = 1_000;
    const timers: (() => void)[] = [];
    const ran: string[] = [];
    const superseded: string[] = [];
    const keep = runInNewContext(`(${FIND_LATEST})`) as (
      later: (run: () => void, wait: number) => void,
      time: () => number,
      quiet: number,
      run: (id: string, request: string) => void,
      superseded: (id: string) => void,
    ) => Latest;
    const latest = keep(
      (run) => void timers.push(run),
      () => now,
      quiet,
      (id, request) => {
        ran.push(`${id}:${request}`);
        // A search on a large page: hundreds of ms.
        now += 300;
      },
      (id) => void superseded.push(id),
    );
    const tick = () => {
      for (const run of timers.splice(0)) {
        run();
      }
    };
    const wait = (ms: number) => {
      now += ms;
    };
    return { latest, ran, superseded, tick, wait, timers };
  };

  test("a query with none before it runs at once, and so does one long after the last", () => {
    const t = latestOf();
    t.latest.ask("1", "r");
    expect(t.ran).toEqual(["1:r"]);
    expect(t.timers).toHaveLength(0);
    t.wait(500);
    t.latest.ask("2", "re");
    expect(t.ran).toEqual(["1:r", "2:re"]);
    expect(t.superseded).toEqual([]);
  });

  test("a burst behind a long search: the latest only, the others answered superseded at once", () => {
    const t = latestOf();
    t.latest.ask("1", "r");
    // 49 more came while the first ran: dispatched just after it ended.
    for (let i = 2; i <= 50; i += 1) {
      t.latest.ask(String(i), `q${i}`);
    }
    expect(t.ran, "none of them run yet").toEqual(["1:r"]);
    expect(t.superseded).toEqual(Array.from({ length: 48 }, (_, i) => String(i + 2)));
    expect(t.timers, "one run is scheduled, not one per query").toHaveLength(1);
    t.tick();
    expect(t.ran).toEqual(["1:r", "50:q50"]);
    // Two searches for fifty queries; every query answered once.
    expect(t.ran.length + t.superseded.length).toBe(50);
  });

  test("a clear drops what waits (answered superseded); nothing runs after it", () => {
    const t = latestOf();
    t.latest.ask("1", "r");
    t.latest.ask("2", "re");
    t.latest.drop();
    expect(t.superseded).toEqual(["2"]);
    t.tick();
    expect(t.ran).toEqual(["1:r"]);
    // Nothing waits: a drop says nothing.
    t.latest.drop();
    expect(t.superseded).toEqual(["2"]);
  });

  test("a query that comes while one waits to run waits too, behind it, never before it", () => {
    const t = latestOf();
    t.latest.ask("1", "r");
    t.latest.ask("2", "re");
    t.wait(100);
    t.latest.ask("3", "rev");
    expect(t.superseded).toEqual(["2"]);
    t.tick();
    expect(t.ran).toEqual(["1:r", "3:rev"]);
    // Within the quiet after the last run: waits for the next task, still the latest only.
    t.latest.ask("4", "reve");
    expect(t.ran).toHaveLength(2);
    t.tick();
    expect(t.ran.at(-1)).toBe("4:reve");
  });

  test("is spliced into the runtime, which reads a request once when it comes and drops what waits on a clear", () => {
    expect(FIND_RUNTIME).toContain(`const keepLatest = ${FIND_LATEST};`);
    // Read when the message comes (P129's read-once): what waits is the values, never the message.
    expect(FIND_RUNTIME).toContain("latest.ask(id, requestOf(params));");
    expect(FIND_RUNTIME).toContain(
      "case M.clear:\n            latest.drop();\n            clear();",
    );
    expect(FIND_RUNTIME).toContain(
      '(id) => answer(id, "error", { code: -32800, message: "superseded by a later query" }),',
    );
    // The kept timers and clock, through callOf.
    expect(FIND_RUNTIME).toMatch(/keepLatest\(\s*later,\s*time,\s*LIMIT\.quiet,/u);
  });
});

describe("the host's checks", () => {
  test("an answer is whole numbers within the limits, its current one among them", () => {
    expect(parseFindResult({ total: 12, active: 3 })).toEqual({ total: 12, active: 3 });
    expect(parseFindResult({ total: 0, active: 0, extra: "<b>" })).toEqual({ total: 0, active: 0 });
    expect(
      parseFindResult({
        total: FIND_LIMITS.matches,
        active: 1,
        capped: true,
        rect: { x: 1, y: 2, width: 3, height: 4 },
      }),
    ).toEqual({
      total: FIND_LIMITS.matches,
      active: 1,
      capped: true,
      rect: { x: 1, y: 2, width: 3, height: 4 },
    });
    // Capped only at the limit: fewer matches were all of them.
    expect(parseFindResult({ total: 2, active: 1, capped: true })).toBeNull();
    expect(parseFindResult({ total: 2, active: 1, capped: false })).toEqual({
      total: 2,
      active: 1,
    });
    // No current match: no box.
    expect(
      parseFindResult({ total: 0, active: 0, rect: { x: 1, y: 2, width: 3, height: 4 } }),
    ).toEqual({ total: 0, active: 0 });
    for (const bad of [
      null,
      "3/12",
      [],
      { total: 3 },
      { total: 3, active: 4 },
      { total: 3, active: 0 },
      { total: 0, active: 1 },
      { total: -1, active: 0 },
      { total: 1.5, active: 1 },
      { total: FIND_LIMITS.matches + 1, active: 1 },
      { total: "3", active: "1" },
      { total: 3, active: 1, capped: "yes" },
      { total: 3, active: 1, rect: { x: 1 } },
      { total: 3, active: 1, rect: { x: 0, y: 0, width: -1, height: 1 } },
    ]) {
      expect(parseFindResult(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("a report is the shortcut or an update, rebuilt from known fields; an update carries no box", () => {
    expect(parseFindReport({ type: "requested", query: "steal" })).toEqual({ type: "requested" });
    expect(
      parseFindReport({
        type: "updated",
        total: 4,
        active: 2,
        rect: { x: 0, y: 0, width: 1, height: 1 },
      }),
    ).toEqual({ type: "updated", total: 4, active: 2 });
    expect(parseFindReport({ type: "updated", total: 4, active: 5 })).toBeNull();
    expect(parseFindReport({ type: "constructor" })).toBeNull();
    expect(parseFindReport(null)).toBeNull();
  });

  test("a query is text within the limit, with these options only", () => {
    expect(checkFindQuery("revenue", undefined)).toEqual({
      query: "revenue",
      direction: "none",
      caseSensitive: false,
    });
    expect(checkFindQuery("Revenue", { direction: "prev", caseSensitive: true })).toEqual({
      query: "Revenue",
      direction: "prev",
      caseSensitive: true,
    });
    expect(checkFindQuery("x".repeat(FIND_LIMITS.query), {}).query).toHaveLength(FIND_LIMITS.query);
    expect(() => checkFindQuery("x".repeat(FIND_LIMITS.query + 1), {})).toThrow(/at most 256/u);
    expect(() => checkFindQuery(42, {})).toThrow(TypeError);
    expect(() => checkFindQuery("x", { direction: "up" as never })).toThrow(/direction/u);
    expect(() => checkFindQuery("x", { caseSensitive: "yes" as never })).toThrow(/caseSensitive/u);
  });
});

describe("the shell", () => {
  const origins = ["https://a.example"];
  test("carries the find runtime only where find is declared", () => {
    const plain = compile(presets.artifact()).shellDocument({ origins });
    const found = compile(presets.artifact({ capabilities: { find: {} } })).shellDocument({
      origins,
    });
    expect(plain).not.toContain("porthole/find.requested");
    expect(plain).not.toContain("__FIND__");
    expect(found).toContain('"porthole/find.requested"');
    expect(found).not.toContain("__FIND__");
    // Beside annotations, each in its own function, the text index in both.
    const both = compile(
      presets.artifact({ capabilities: { annotate: {}, find: {} } }),
    ).shellDocument({
      origins,
    });
    expect(both).toContain('"porthole/annotate.selected"');
    expect(both).toContain('"porthole/find.requested"');
    expect(both.split("const textIndex = () => {")).toHaveLength(3);
  });

  test("with the find and annotation runtimes in, is still a plain script", () => {
    expect(
      () =>
        new Script(
          SHELL_RUNTIME.replace("__ANNOTATE__", ANNOTATE_RUNTIME)
            .replace("__FIND__", () => FIND_RUNTIME)
            .replace("__PLAN__", "{}"),
        ),
    ).not.toThrow();
  });

  test("splices its rules and the text index as they are; annotations keep theirs", () => {
    expect(FIND_RUNTIME).toContain(`const findMatches = ${FIND_MATCH};`);
    expect(FIND_RUNTIME).toContain(`const isShortcut = ${FIND_SHORTCUT};`);
    expect(FIND_RUNTIME).toContain(TEXT_INDEX);
    expect(ANNOTATE_RUNTIME).toContain(TEXT_INDEX);
    // The same layer style as annotations' (P104): one text, in both.
    expect(ANNOTATE_RUNTIME).toContain(`const LAYER_STYLE = "${LAYER_STYLE}";`);
    expect(FIND_RUNTIME).toContain(`const LAYER_STYLE = "${LAYER_STYLE}";`);
    // Never the CSS Custom Highlight API (P053, P104): content reads and rewrites it.
    expect(FIND_RUNTIME).not.toMatch(/CSS\.highlights|new Highlight\(/u);
    // A closed shadow root, as annotations' layer.
    expect(FIND_RUNTIME).toContain('callOf(attachShadow, layer, [{ mode: "closed" }])');
  });

  test("takes the DOM's own functions before content runs, and calls what it took", () => {
    const taken = [
      "const createRange = Document.prototype.createRange;",
      "const createTreeWalker = Document.prototype.createTreeWalker;",
      "const rangeRects = Range.prototype.getClientRects;",
      "const rangeRect = Range.prototype.getBoundingClientRect;",
      "const attachShadow = Element.prototype.attachShadow;",
      "const scrollElement = Element.prototype.scrollBy;",
      "const scrollWindow = window.scrollBy;",
      "const execOf = RegExp.prototype.exec;",
      "const stopFind = preventNavigation;",
    ];
    const handler = FIND_RUNTIME.indexOf('window.addEventListener("message"');
    for (const line of taken) {
      const at = FIND_RUNTIME.indexOf(line);
      expect(at, line).toBeGreaterThan(-1);
      expect(at, line).toBeLessThan(handler);
    }
    expect(FIND_RUNTIME).toContain("callOf(rangeRects, range, [])");
    expect(FIND_RUNTIME).toContain("callOf(stopFind, event, [])");
    // Not the page's own versions of them.
    expect(FIND_RUNTIME).not.toContain(".getClientRects()");
    expect(FIND_RUNTIME).not.toContain(".preventDefault()");
  });

  test("calls only built-ins it took before content ran, through callOf, and inserts through the guarded methods (P129, P130)", () => {
    // As the shell's guards (P129): no live call, apply or bind, no replaceable Array or Object
    // method, no DOM method or accessor reached as a member of an object the page can reach.
    for (const source of [FIND_RUNTIME, TEXT_INDEX, FIND_LATEST]) {
      for (const live of [
        ".call(",
        ".apply(",
        ".bind(",
        ".map(",
        ".concat(",
        ".indexOf(",
        ".includes(",
        ".forEach(",
        ".filter(",
        ".push(",
        "for (const ",
        "Array.from(",
        "Object.assign(",
        "Object.keys(",
        "Math.",
        ".observe(",
        ".nextNode()",
        ".setStart(",
        ".setEnd(",
        ".comparePoint(",
        ".nodeValue.",
        ".overflowY",
        ".className =",
        "style.nonce",
        "event.data",
        "event.origin",
        "event.source",
        "window.parent.postMessage",
      ]) {
        expect(source, live).not.toContain(live);
      }
    }
    // Taken before content runs, and called through callOf.
    for (const used of [
      "callOf(createTreeWalker, document,",
      "callOf(textNextNode, walker, [])",
      "callOf(textMapSet, at,",
      "callOf(createRange, document, [])",
      "callOf(textSetStart, range,",
      "callOf(textSetEnd, range,",
      "callOf(textTypeOf, node, [])",
      "callOf(textBodyOf, document, [])",
    ]) {
      expect(TEXT_INDEX, used).toContain(used);
    }
    for (const used of [
      "callOf(observeIn, contentWatch, [document,",
      'callOf(postIn, parentWindow, [message, "*"])',
      "callOf(timeoutIn, window,",
      "callOf(animationFrameIn, window,",
      'callOf(propertyValueIn, style, ["overflow-y"])',
      "callOf(cssTextTo, style, [text])",
      "callOf(textContentTo, style, [STYLE])",
      "callOf(execOf, BLANK, [words])",
      "callOf(documentElementOf, document, [])",
    ]) {
      expect(FIND_RUNTIME, used).toContain(used);
    }
    // The layer's nodes go in through the shell's guarded methods (P130), taken after step 3
    // wrapped them: the find runtime is spliced after the guard, and calls what it took.
    expect(SHELL_RUNTIME.indexOf("__FIND__")).toBeGreaterThan(
      SHELL_RUNTIME.indexOf('lock(Element.prototype, "attachShadow", function (init) {'),
    );
    expect(SHELL_RUNTIME.indexOf("__FIND__")).toBeGreaterThan(
      SHELL_RUNTIME.indexOf('wrapInsert(proto, "appendChild", [0]);'),
    );
    for (const insertion of [
      'callOf(createElement, document, ["div"])',
      'callOf(attachShadow, layer, [{ mode: "closed" }])',
      "callOf(replaceInRoot, shadow, [style, parts])",
      "callOf(appendTo, rootElement(), [layer])",
      "callOf(replaceIn, parts, drawn)",
    ]) {
      expect(FIND_RUNTIME, insertion).toContain(insertion);
    }
  });

  test("answers find's request itself: the shell's own fallback leaves it alone where declared", () => {
    expect(SHELL_RUNTIME).toContain('!(data.method === "porthole/find.query" && declared("find"))');
    // Only from its parent, from the plan's origins; a request only (an id), answered at once.
    expect(FIND_RUNTIME).toContain(
      'if (get(messageSourceOf, event, "source") !== parentWindow || !fromHost(get(messageOriginOf, event, "origin"))) {',
    );
    expect(FIND_RUNTIME).toContain('const id = own(data, "id");');
    expect(FIND_RUNTIME).toContain('if (typeof id !== "string" && typeof id !== "number") {');
    // The shortcut only while the host draws its own bar, a real key the page didn't take.
    expect(FIND_RUNTIME).toContain(
      'if (!handled || !event.isTrusted || get(preventedOf, event, "defaultPrevented") === true) {',
    );
  });

  test("declares find as an event the host serves, rate-limited, taught to the agent", () => {
    const compiled = compile(presets.artifact({ capabilities: { find: {} } }));
    expect(compiled.shell?.capabilities.find).toEqual({ userActivation: false });
    expect(compiled.guide(["interactive"])).toContain(
      "- Find: the person may search the page's words",
    );
  });
});

describe("find on createHost over a stand-in platform", () => {
  const mounted: DisplayHandle[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const display of mounted.splice(0)) {
      display.destroy();
    }
  });
  /** A display whose frames' messages are kept, each frame's handshake and answers by hand. */
  const mount = (
    given: {
      find?: boolean;
      focused?: () => boolean | undefined;
      onNavigated?: (listener: () => void) => void;
    } = {},
  ) => {
    const sent: { id?: unknown; method?: unknown; params?: unknown }[] = [];
    let listeners = new Set<(message: unknown) => void>();
    const platform: PlatformHost = {
      name: "stand-in",
      createSurface: () => {
        listeners = new Set();
        const own = listeners;
        return {
          transport: {
            send: (message) => void sent.push(message),
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
          ...(given.focused === undefined ? {} : { focused: given.focused }),
          onNavigated: (listener) => {
            given.onNavigated?.(listener);
            return () => {};
          },
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
    const config =
      given.find === false ? presets.artifact() : presets.artifact({ capabilities: { find: {} } });
    const display = createHost(config, { platform }).mount(container, {
      displayId: "d1",
      title: "Notes",
      scheme: "light",
    });
    mounted.push(display);
    const say = (message: unknown) => {
      for (const listener of listeners) {
        listener(message);
      }
    };
    const handshake = () =>
      say({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    const finds = () =>
      sent.filter(
        (each) => typeof each.method === "string" && each.method.startsWith("porthole/find."),
      );
    const asked = () => finds().filter((each) => each.method === "porthole/find.query");
    const answer = (id: unknown, body: Record<string, unknown>) =>
      say({ jsonrpc: "2.0", id, ...body });
    const requested: number[] = [];
    const updated: FindResult[] = [];
    const refused: string[] = [];
    display.on("findRequested", () => requested.push(1));
    display.on("findUpdated", (result) => updated.push(result));
    display.on("refused", (detail) => refused.push(`${detail.capability}:${detail.refusal}`));
    return { display, sent, say, handshake, finds, asked, answer, requested, updated, refused };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("asks the frame once it ran, and resolves with its checked answer, the box clamped", async () => {
    const t = mount();
    const early = t.display.find.query("revenue");
    expect(t.asked(), "nothing goes before the handshake").toEqual([]);
    t.handshake();
    expect(t.asked()).toEqual([
      expect.objectContaining({
        method: "porthole/find.query",
        params: { query: "revenue", direction: "none", caseSensitive: false },
      }),
    ]);
    const id = t.asked()[0]?.id;
    expect(typeof id).toBe("string");
    // Another id is no answer; the first answer for this one is, and a second is dropped.
    t.answer("porthole-find-999", { result: { total: 1, active: 1 } });
    t.answer(id, {
      result: { total: 12, active: 3, rect: { x: -50, y: 390, width: 100, height: 30 } },
    });
    t.answer(id, { result: { total: 1, active: 1 } });
    expect(await early).toEqual({
      total: 12,
      active: 3,
      rect: { x: 0, y: 390, width: 50, height: 10 },
    });
    const next = t.display.find.query("revenue", { direction: "next" });
    expect(t.asked().at(-1)?.params).toEqual({
      query: "revenue",
      direction: "next",
      caseSensitive: false,
    });
    t.answer(t.asked().at(-1)?.id, { result: { total: 12, active: 4 } });
    expect(await next).toEqual({ total: 12, active: 4 });
  });

  test("an older shell's 'isn't offered here', a malformed answer, or none in time: unsupported", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const t = mount();
    t.handshake();
    const older = t.display.find.query("a");
    t.answer(t.asked().at(-1)?.id, {
      error: { code: -32601, message: "porthole/find.query isn't offered here" },
    });
    expect(await older).toBe("unsupported");
    const malformed = t.display.find.query("b");
    t.answer(t.asked().at(-1)?.id, { result: { total: 2, active: 3 } });
    expect(await malformed).toBe("unsupported");
    const silent = t.display.find.query("c");
    await vi.advanceTimersByTimeAsync(FIND_LIMITS.timeoutMs - 1);
    let settled = false;
    void silent.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await silent).toBe("unsupported");
  });

  test("without find declared: unsupported, and nothing goes to the frame", async () => {
    const t = mount({ find: false });
    t.handshake();
    expect(await t.display.find.query("revenue")).toBe("unsupported");
    t.display.find.clear();
    t.display.find.takeShortcut(true);
    expect(t.finds()).toEqual([]);
  });

  test("an empty query clears, asking nothing; a query too long rejects", async () => {
    const t = mount();
    t.handshake();
    expect(await t.display.find.query("   ")).toEqual({ total: 0, active: 0 });
    expect(t.finds().map((each) => each.method)).toEqual(["porthole/find.clear"]);
    await expect(t.display.find.query("x".repeat(FIND_LIMITS.query + 1))).rejects.toThrow(
      TypeError,
    );
    t.display.find.clear();
    expect(t.finds().map((each) => each.method)).toEqual([
      "porthole/find.clear",
      "porthole/find.clear",
    ]);
  });

  test("the shortcut: told to the frame and every later one; taken only while the host takes it and the page's focus is in the frame", async () => {
    let focused: boolean | undefined = true;
    const t = mount({ focused: () => focused });
    t.handshake();
    const requested = { jsonrpc: "2.0", method: "porthole/find.requested", params: {} };
    t.say(requested);
    await settle();
    expect(t.requested, "the host doesn't take the shortcut yet").toEqual([]);
    t.display.find.takeShortcut(true);
    expect(t.finds().at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "porthole/find.handled",
      params: { handled: true },
    });
    t.say(requested);
    await settle();
    expect(t.requested).toHaveLength(1);
    // The person types beside the frame: the page can't bring the find bar up over their words.
    focused = false;
    t.say(requested);
    await settle();
    expect(t.requested).toHaveLength(1);
    // Where the platform can't tell, it passes (as the gesture gate does).
    focused = undefined;
    t.say(requested);
    await settle();
    expect(t.requested).toHaveLength(2);
    // A request (an id) is no report.
    t.say({ ...requested, id: 7 });
    await settle();
    expect(t.requested).toHaveLength(2);
    // A new frame is told again.
    const before = t.sent.length;
    t.display.reload();
    t.handshake();
    expect(t.sent.slice(before)).toContainEqual({
      jsonrpc: "2.0",
      method: "porthole/find.handled",
      params: { handled: true },
    });
    t.display.find.takeShortcut(false);
    t.say(requested);
    await settle();
    expect(t.requested).toHaveLength(2);
  });

  test("an update is taken only while a query is shown, checked; a reload forgets the query", async () => {
    const t = mount();
    t.handshake();
    const update = (params: unknown) =>
      t.say({ jsonrpc: "2.0", method: "porthole/find.updated", params });
    update({ total: 3, active: 1 });
    await settle();
    expect(t.updated, "no query shown").toEqual([]);
    const shown = t.display.find.query("revenue", { caseSensitive: true });
    t.answer(t.asked().at(-1)?.id, { result: { total: 2, active: 1 } });
    await shown;
    update({ total: 3, active: 1, rect: { x: 0, y: 0, width: 1, height: 1 } });
    await settle();
    expect(t.updated).toEqual([{ total: 3, active: 1 }]);
    update({ total: 3, active: 4 });
    await settle();
    expect(t.updated).toHaveLength(1);
    expect(t.refused).toEqual(["find:invalid"]);
    // A new frame (a reload) may show other content: the query isn't given to it, and its
    // updates aren't taken until the host asks again.
    const before = t.asked().length;
    t.display.reload();
    t.handshake();
    expect(t.asked()).toHaveLength(before);
    update({ total: 5, active: 2 });
    await settle();
    expect(t.updated).toHaveLength(1);
    const asked = t.display.find.query("revenue");
    t.answer(t.asked().at(-1)?.id, { result: { total: 5, active: 2 } });
    await asked;
    update({ total: 6, active: 2 });
    await settle();
    expect(t.updated.at(-1)).toEqual({ total: 6, active: 2 });
    // Cleared: nothing more is taken.
    t.display.find.clear();
    update({ total: 1, active: 1 });
    await settle();
    expect(t.updated).toHaveLength(2);
  });

  test("a query asked before a frame ran, cleared before it did, is answered as nothing", async () => {
    const t = mount();
    const asked = t.display.find.query("revenue");
    t.display.find.clear();
    t.handshake();
    expect(await asked).toEqual({ total: 0, active: 0 });
    expect(t.asked()).toEqual([]);
  });

  test("a query waiting when its frame stops is answered unsupported, never sent to the next frame", async () => {
    const t = mount();
    t.handshake();
    const asked = t.display.find.query("revenue");
    const first = t.asked().at(-1)?.id;
    t.display.reload();
    expect(await asked).toBe("unsupported");
    t.handshake();
    expect(t.asked().map((each) => each.id)).toEqual([first]);
    // The old frame's late answer is no answer now.
    t.answer(first, { result: { total: 1, active: 1 } });
    await settle();
    expect(t.asked()).toHaveLength(1);
  });

  test("a restart after the content navigated its frame away forgets the query too", async () => {
    let away: (() => void) | undefined;
    const t = mount({ onNavigated: (listener) => (away = listener) });
    t.handshake();
    const shown = t.display.find.query("revenue");
    t.answer(t.asked().at(-1)?.id, { result: { total: 2, active: 1 } });
    await shown;
    away?.();
    t.handshake();
    expect(t.asked(), "nothing asked of the new page").toHaveLength(1);
    t.say({ jsonrpc: "2.0", method: "porthole/find.updated", params: { total: 1, active: 1 } });
    await settle();
    expect(t.updated).toEqual([]);
  });

  test("other content forgets the query and clears the frame; the same content continued keeps it", async () => {
    const t = mount();
    t.handshake();
    t.display.setContent("<p>alpha", { partial: true });
    const shown = t.display.find.query("alpha");
    t.answer(t.asked().at(-1)?.id, { result: { total: 1, active: 1 } });
    await shown;
    // More of the same page (streamed), then the whole of it: the query holds.
    t.display.setContent("<p>alpha beta", { partial: true });
    t.display.setContent("<p>alpha beta</p>");
    expect(t.finds().map((each) => each.method)).toEqual(["porthole/find.query"]);
    const update = {
      jsonrpc: "2.0",
      method: "porthole/find.updated",
      params: { total: 2, active: 1 },
    };
    t.say(update);
    await settle();
    expect(t.updated).toEqual([{ total: 2, active: 1 }]);
    // Another page: forgotten, the frame cleared, what waits answered unsupported.
    const waiting = t.display.find.query("beta");
    t.display.setContent("<p>another page</p>");
    expect(await waiting).toBe("unsupported");
    expect(t.finds().at(-1)?.method).toBe("porthole/find.clear");
    t.say(update);
    await settle();
    expect(t.updated).toHaveLength(1);
    // And the next run of it doesn't get it either.
    const before = t.asked().length;
    t.display.reload();
    t.handshake();
    expect(t.asked()).toHaveLength(before);
  });

  test("queries asked while the frame loads: only the latest is sent, the others unsupported", async () => {
    const t = mount();
    const early = ["r", "re", "rev"].map((query) => t.display.find.query(query));
    t.handshake();
    expect(t.asked().map((each) => (each.params as { query: string }).query)).toEqual(["rev"]);
    t.answer(t.asked()[0]?.id, { result: { total: 3, active: 1 } });
    expect(await Promise.all(early)).toEqual([
      "unsupported",
      "unsupported",
      { total: 3, active: 1 },
    ]);
  });

  test("a query the shell answers as superseded by a later one is unsupported; the later one's answer stands", async () => {
    const t = mount();
    t.handshake();
    const first = t.display.find.query("r");
    const second = t.display.find.query("re");
    const [one, two] = t.asked();
    t.answer(one?.id, { error: { code: -32800, message: "superseded by a later query" } });
    t.answer(two?.id, { result: { total: 4, active: 1 } });
    expect(await first).toBe("unsupported");
    expect(await second).toEqual({ total: 4, active: 1 });
  });

  test("a destroyed display answers what waits: unsupported", async () => {
    const t = mount();
    t.handshake();
    const asked = t.display.find.query("revenue");
    t.display.destroy();
    expect(await asked).toBe("unsupported");
  });
});

describe("the React handle's query holds for the content it was asked of", () => {
  const base: PortholeFrameProps = {
    config: presets.artifact({ capabilities: { find: {} } }),
    displayId: "d1",
    title: "Notes",
    content: "<p>alpha beta</p>",
  };
  // The same props without content (a served display's, or before any came).
  const { content: _content, ...empty } = base;
  const asked = findScopeOf(base);
  const now = (change: Partial<PortholeFrameProps>) =>
    sameFindScope(asked, findScopeOf({ ...base, ...change }));

  test("the same content, again or continued, or other props alike: found again", () => {
    expect(now({})).toBe(true);
    // By value: an inline config or instance equal to the last is the same.
    expect(now({ config: presets.artifact({ capabilities: { find: {} } }) })).toBe(true);
    // A streamed page's next part, and props the content doesn't depend on.
    expect(now({ content: "<p>alpha beta</p><p>gamma" })).toBe(true);
    expect(now({ displayId: "d2", title: "Renamed", scheme: "dark" })).toBe(true);
    // Asked before any content came: whatever came is what it was asked of.
    expect(
      sameFindScope(findScopeOf(empty), findScopeOf({ ...base, content: "<p>first</p>" })),
    ).toBe(true);
  });

  test("another page in the same frame: forgotten, never found there", () => {
    // The reviewer's case: the frame run again (a new generation) with other content.
    expect(now({ generation: 1, content: "<p>another page</p>" })).toBe(false);
    // Each part alone.
    expect(now({ generation: 1 }), "a reload").toBe(false);
    expect(now({ content: "<p>another page</p>" }), "other content").toBe(false);
    expect(sameFindScope(asked, findScopeOf(empty)), "no content").toBe(false);
    expect(now({ document: "<!doctype html><p>app</p>" }), "another document").toBe(false);
    expect(now({ config: presets.artifact() }), "another config").toBe(false);
    expect(now({ viewer: { level: "view" } }), "another viewer").toBe(false);
    const instance = { scope: "s", document: { kind: "artifact", id: "a", version: "1" } } as const;
    const served = findScopeOf({ ...empty, instance });
    expect(sameFindScope(served, findScopeOf({ ...empty, instance }))).toBe(true);
    expect(
      sameFindScope(
        served,
        findScopeOf({
          ...empty,
          instance: { ...instance, document: { ...instance.document, version: "2" } },
        }),
      ),
      "a new version",
    ).toBe(false);
    expect(
      sameFindScope(
        served,
        findScopeOf({
          ...empty,
          instance: { ...instance, document: { ...instance.document, id: "b" } },
        }),
      ),
      "another source",
    ).toBe(false);
  });
});

describe("the bridge carries find's reports", () => {
  const events: BridgeEvent[] = [];
  let now = 0;
  const bridge = createBridge({
    config: presets.artifact({ capabilities: { find: {} } }),
    display: { id: "d", title: "Notes" },
    handlers: {},
    onEvent: (event) => events.push(event),
    now: () => now,
  });
  test("a checked report becomes an event; a malformed one a refusal", async () => {
    expect((await bridge.call("find", { type: "requested" })).ok).toBe(true);
    expect(events.at(-1)).toEqual({ type: "find", report: { type: "requested" } });
    expect((await bridge.call("find", { type: "updated", total: 1, active: 1 })).ok).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "find",
      report: { type: "updated", total: 1, active: 1 },
    });
    expect((await bridge.call("find", { type: "updated", total: 1 })).ok).toBe(false);
    expect(events.at(-1)).toEqual({ type: "refused", capability: "find", refusal: "invalid" });
  });
  test("at most 120 a minute by default: a frame can't flood the host", async () => {
    now = 120_000;
    const outcomes = [];
    for (let i = 0; i < 121; i += 1) {
      outcomes.push((await bridge.call("find", { type: "requested" })).ok);
    }
    expect(outcomes.filter((ok) => !ok)).toHaveLength(1);
  });
});
