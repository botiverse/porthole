import { runInNewContext, Script } from "node:vm";
import { describe, expect, test } from "vitest";
import { compile, MCP_APPS_METHODS, presets, resolveTheme, DEFAULT_THEME } from "../src/index.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  HANDSHAKE,
  HELD_BACK,
  ONCE,
  OWN_FRAME,
  PASSES_AS_IS,
  SHELL_RUNTIME,
} from "../src/shell/runtime.ts";

const ORIGIN = "https://host.example.com";

/** The plan the runtime was given, read back out of a shell document. */
function planIn(html: string): Record<string, unknown> {
  const match = /const plan = (\{.*?\});\n/su.exec(html);
  if (match?.[1] === undefined) {
    throw new Error("no plan in the document");
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("the shell runtime", () => {
  test("is a plain script every engine can parse", () => {
    expect(() => new Script(SHELL_RUNTIME.replace("__PLAN__", "{}"))).not.toThrow();
  });

  test("speaks only MCP Apps methods, plus the standard ping", () => {
    const methods = new Set(Object.values(MCP_APPS_METHODS) as string[]);
    for (const [, method] of SHELL_RUNTIME.matchAll(
      /"((?:ui|notifications|tools|resources)\/[a-z/-]+)"/gu,
    )) {
      expect(methods, method).toContain(method);
    }
  });

  test("a draft holds back a tag start it was cut in, and draws everything else (P117)", () => {
    const heldBack = runInNewContext(HELD_BACK) as (html: string) => string;
    const rows = '<div class="row">one</div>';
    // Cut right after "<" or "</": the tokenizer would draw them as text (porthole#16).
    expect(heldBack(`${rows}<`)).toBe(rows);
    expect(heldBack(`${rows}<div class="row">two</`)).toBe(`${rows}<div class="row">two`);
    // Cut in a tag's name or attributes: held back too (the tokenizer drops it anyway).
    expect(heldBack(`${rows}<div class="row">two</di`)).toBe(`${rows}<div class="row">two`);
    expect(heldBack(`${rows}<scr`)).toBe(rows);
    expect(heldBack(`${rows}<div title="a<b`)).toBe(`${rows}<div title="a`);
    // Whole content, text with a "<" that starts no tag, and no content: drawn as they are.
    for (const html of [
      rows,
      `${rows}<p>1 < 2</p>`,
      "1 < 2",
      "<!-- a",
      '<a title="x>y">z</a>',
      "",
    ]) {
      expect(heldBack(html), html).toBe(html);
    }
    // The draft uses it; the whole content (render) never does.
    expect(SHELL_RUNTIME).toContain(`const heldBack = ${HELD_BACK};`);
    expect(SHELL_RUNTIME.match(/heldBack\(/gu)).toHaveLength(1);
    expect(SHELL_RUNTIME).toContain('parseInert(heldBack(String(input.html || "")))');
  });
});

type Handshake = (
  topLevel: boolean,
  ask: () => Promise<unknown>,
  answered: (result: unknown) => void,
  none: () => void,
  later: (run: () => void, ms: number) => void,
) => void;

/** The handshake run with its every effect recorded, its timers run by hand. */
function handshakeOf(topLevel: boolean) {
  const handshake = runInNewContext(HANDSHAKE) as Handshake;
  const said: string[] = [];
  const asks: { resolve: (result: unknown) => void; reject: (error: unknown) => void }[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  handshake(
    topLevel,
    () =>
      new Promise((resolve, reject) => {
        said.push("ask");
        asks.push({ resolve, reject });
      }),
    (result) => said.push(`answered ${JSON.stringify(result)}`),
    () => said.push("none"),
    (run, ms) => timers.push({ run, ms }),
  );
  /** The next timer, as the browser would run it 250 ms on. */
  const tick = () => {
    const next = timers.shift();
    expect(next?.ms).toBe(250);
    next?.run();
  };
  return { said, asks, timers, tick };
}

describe("the shell's handshake with its host (P085, P139)", () => {
  test("on a tab of its own, asks nothing and offers nothing at once: no retry, no timer", () => {
    const { said, asks, timers } = handshakeOf(true);
    expect(said).toEqual(["none"]);
    expect(asks).toHaveLength(0);
    expect(timers).toHaveLength(0);
  });

  test("in a frame, asks up to 40 times, 250 ms apart, then offers nothing", () => {
    const { said, timers, tick } = handshakeOf(false);
    expect(said).toEqual(["ask"]);
    for (let i = 1; i < 40; i += 1) {
      tick();
    }
    expect(said.filter((each) => each === "ask")).toHaveLength(40);
    expect(said).not.toContain("none");
    tick();
    expect(said.at(-1)).toBe("none");
    expect(said.filter((each) => each === "ask")).toHaveLength(40);
    expect(timers).toHaveLength(0);
  });

  test("in a frame, takes the first answer once and stops asking", async () => {
    const { said, asks, timers, tick } = handshakeOf(false);
    tick();
    asks[1]?.resolve({ hostCapabilities: {} });
    await Promise.resolve();
    asks[0]?.resolve({ late: true });
    await Promise.resolve();
    tick();
    expect(said).toEqual(["ask", "ask", 'answered {"hostCapabilities":{}}']);
    expect(timers).toHaveLength(0);
  });

  test("in a frame, a refusal is no answer, and an answer after it gave up is still taken", async () => {
    const { said, asks, tick } = handshakeOf(false);
    asks[0]?.reject(new Error("refused"));
    await Promise.resolve();
    for (let i = 0; i < 40; i += 1) {
      tick();
    }
    expect(said.at(-1)).toBe("none");
    asks[39]?.resolve({ hostCapabilities: {} });
    await Promise.resolve();
    expect(said.at(-1)).toBe('answered {"hostCapabilities":{}}');
  });

  test("is the runtime's own: told the top by the window itself, its end marked on the document's root", () => {
    expect(SHELL_RUNTIME).toContain(`const handshake = ${HANDSHAKE};`);
    expect(SHELL_RUNTIME).toContain("handshake(\n    window.top === window,");
    expect(SHELL_RUNTIME.match(/request\("ui\/initialize"/gu)).toHaveLength(1);
    // On the root, which a whole document's render keeps (its body, and the shell's script in it,
    // are replaced), read when the shell starts.
    expect(SHELL_RUNTIME).toContain("const shellRoot = document.documentElement;");
    expect(SHELL_RUNTIME).toContain(
      'callOf(setAttributeOfShell, shellRoot, ["data-porthole-host", how]);',
    );
    expect(
      SHELL_RUNTIME.indexOf("const setAttributeOfShell = Element.prototype.setAttribute;"),
    ).toBeLessThan(SHELL_RUNTIME.indexOf("const lock = "));
    // The render adds the page's attributes to the root and removes none.
    expect(SHELL_RUNTIME).toContain("element.setAttribute(attribute.name, attribute.value);");
    expect(SHELL_RUNTIME).not.toMatch(/element\.removeAttribute\(attribute/u);
    expect(SHELL_RUNTIME).toContain('settled("none");\n      runtimeOffer(null);');
    expect(SHELL_RUNTIME).toContain('settled("answered");');
  });
});

describe("a page's own frames, as the shell keeps them (P128)", () => {
  type Rule = (
    hasSrcdoc: boolean,
    src: string | null,
    filesBase: string | null,
    resolve: (text: string) => string,
  ) => boolean;
  const ownFrame = runInNewContext(OWN_FRAME) as Rule;
  const BASE = "https://a-x.example-usercontent.com/__porthole/f/sealed123/";
  const PAGE = `${BASE}index.html`;
  const resolve = (text: string) => new URL(text, PAGE).href;

  test("keeps a srcdoc frame, whatever its src, and with no files to frame", () => {
    expect(ownFrame(true, null, BASE, resolve)).toBe(true);
    expect(ownFrame(true, "https://elsewhere.example/", BASE, resolve)).toBe(true);
    expect(ownFrame(true, null, null, resolve)).toBe(true);
  });

  test("keeps a frame of the version's own files, by the platform's reading of its address", () => {
    for (const src of [
      "chart.html",
      "./chart.html",
      "pages/table.html?x=1#y",
      " chart.html ",
      "a/../chart.html",
      `${BASE}chart.html`,
    ]) {
      expect(ownFrame(false, src, BASE, resolve), src).toBe(true);
    }
  });

  test("removes every other frame: no address, the origin's other paths, other origins, schemes", () => {
    for (const src of [
      null,
      "",
      "   ",
      "\n\t",
      "/other.html",
      "../other/",
      "%2e%2e/%2e%2e/",
      "\\..\\..\\x",
      "/__porthole/f/other/",
      "https://a-x.example-usercontent.com/",
      "https://a-y.example-usercontent.com/__porthole/f/sealed123/x.html",
      "//evil.example/__porthole/f/sealed123/",
      "https://evil.example/",
      "data:text/html,<p>x</p>",
      "blob:https://a-x.example-usercontent.com/uuid",
      "javascript:parent.x=1",
      "about:blank",
    ]) {
      expect(ownFrame(false, src, BASE, resolve), String(src)).toBe(false);
    }
    // Without the page's files (an opaque frame, a single page), only srcdoc.
    expect(ownFrame(false, "chart.html", null, resolve)).toBe(false);
    // A base that isn't a directory's address is no base.
    expect(ownFrame(false, "chart.html", BASE.slice(0, -1), resolve)).toBe(false);
    // An address the parser refuses is removed, not thrown.
    expect(
      ownFrame(false, "x", BASE, () => {
        throw new TypeError("Invalid URL");
      }),
    ).toBe(false);
  });

  test("is the runtime's own rule, read through the platform's getters, and only where opted in", () => {
    expect(SHELL_RUNTIME).toContain(`const ownFrame = ${OWN_FRAME};`);
    expect(SHELL_RUNTIME).toContain('const ownFrames = plan.nestedFrames === "own";');
    expect(() => new Script(SHELL_RUNTIME.replace("__PLAN__", "{}"))).not.toThrow();
    const strict = compile(presets.artifact());
    const own = compile(presets.artifact({ nestedFrames: "own" }));
    const strictPlan = planIn(strict.shellDocument({ origins: [ORIGIN] }));
    const ownPlan = planIn(own.shellDocument({ origins: [ORIGIN] }));
    expect(strictPlan).not.toHaveProperty("nestedFrames");
    expect(ownPlan).toMatchObject({ nestedFrames: "own" });
    // Everything else the shell does is the same.
    const { nestedFrames: _own, ...rest } = ownPlan;
    expect(rest).toEqual(strictPlan);
  });
});

describe("the frame guard and its observer call only built-ins captured before content runs", () => {
  // The portion of the runtime that walks and prunes content-controlled subtrees: the synchronous
  // guard, the mutation observer, the before-change backstop, and the insertion wrappers. A page
  // can replace any prototype method or getter it names (and the global Array.from) before it
  // inserts a subtree, so the guard must read none of them live off the nodes it inspects.
  const between = (from: string, to: string): string => {
    const start = SHELL_RUNTIME.indexOf(from);
    const end = SHELL_RUNTIME.indexOf(to, start);
    expect(start, from).toBeGreaterThanOrEqual(0);
    expect(end, to).toBeGreaterThan(start);
    return SHELL_RUNTIME.slice(start, end + to.length);
  };
  // The whole guard-and-wrapper region: the capture table, the walk and observer, the insertion
  // wrappers, the HTML-parse wrappers (innerHTML/outerHTML/insertAdjacentHTML/execCommand), the
  // before-change backstop, and the attribute-turn guards — everything a running page can reach by
  // calling a DOM API. None of it may invoke a built-in through a member the page can replace.
  const wrapperRegion = between(
    'const nodeTypeOf = getterOf(Node.prototype, "nodeType");',
    'let root = document.getElementById("porthole-root");',
  );

  test("captures each DOM built-in it uses, once, before content runs", () => {
    for (const capture of [
      'const nodeTypeOf = getterOf(Node.prototype, "nodeType");',
      'const isConnectedOf = getterOf(Node.prototype, "isConnected");',
      'const parentNodeOf = getterOf(Node.prototype, "parentNode");',
      'const shadowRootOfNode = getterOf(Element.prototype, "shadowRoot");',
      'const childNodesOf = getterOf(Node.prototype, "childNodes");',
      "const removeIn = Element.prototype.remove;",
      "const cloneNodeIn = Node.prototype.cloneNode;",
      "const queryAllElement = Element.prototype.querySelectorAll;",
      "const queryAllDocument = Document.prototype.querySelectorAll;",
      "const queryAllFragment = DocumentFragment.prototype.querySelectorAll;",
      'const nodeListLengthOf = getterOf(NodeList.prototype, "length");',
      "const weakSetHas = WeakSet.prototype.has;",
      "const weakSetAdd = WeakSet.prototype.add;",
      "const weakMapGet = WeakMap.prototype.get;",
      "const weakMapSet = WeakMap.prototype.set;",
      "const observeIn = MutationObserver.prototype.observe;",
      "const makeText = Document.prototype.createTextNode;",
      "const setAttributeNSIn = Element.prototype.setAttributeNS;",
      "const removeAttributeIn = Element.prototype.removeAttribute;",
      'const addedNodesOf = getterOf(recordProto, "addedNodes");',
      'const recordTypeOf = getterOf(recordProto, "type");',
      'const recordTargetOf = getterOf(recordProto, "target");',
    ]) {
      expect(SHELL_RUNTIME, capture).toContain(capture);
    }
  });

  test("callOf is Reflect.apply, captured before content runs", () => {
    // callOf does not read Function.prototype's call/apply/bind: it is Reflect.apply itself, kept
    // before content, and invoked directly. So replacing Function.prototype.apply/call changes
    // nothing the guard does.
    expect(SHELL_RUNTIME).toContain("const callOf = Reflect.apply;");
    // Nothing above the capture is content; the binding is the runtime's first few statements.
    expect(SHELL_RUNTIME.indexOf("const callOf = Reflect.apply;")).toBeLessThan(
      SHELL_RUNTIME.indexOf("Object.getOwnPropertyNames(window)"),
    );
  });

  test("never invokes a built-in through a member the page can replace", () => {
    // In the whole guard-and-wrapper region, every built-in is reached through a captured
    // reference and callOf; there is no live `.call(` / `.apply(` / `.bind(`, no array walk or
    // decision through a replaceable prototype method (Array.from, for…of over live collections,
    // .indexOf / .includes / .map / .filter / .forEach / Object.keys), and no DOM method called
    // as a member on a node the page controls.
    for (const live of [
      ".call(",
      ".apply(",
      ".bind(",
      ".querySelectorAll(",
      ".remove()",
      "Array.from(",
      ".cloneNode(",
      ".isConnected",
      "document.createTextNode(",
      ".indexOf(",
      ".includes(",
      ".forEach(",
      ".map(",
      ".filter(",
      "Object.keys(",
    ]) {
      expect(wrapperRegion, live).not.toContain(live);
    }
    // It does reach them, through the captured table and callOf.
    for (const used of [
      "callOf(removeIn,",
      "callOf(observeIn, frameGuard,",
      "callOf(weakSetHas, guardedRoots,",
      "callOf(weakSetAdd, guardedRoots,",
      "callOf(cloneNodeIn, element,",
      "callOf(original, this, fixed)",
      "callOf(setAttributeNSIn,",
    ]) {
      expect(wrapperRegion, used).toContain(used);
    }
  });

  test("forwards only values it has already pinned, so a name or value is read once", () => {
    // A guard that inspects a name or value and then forwards the argument must forward the same
    // reading it checked: an argument whose toString answers differently the second time cannot
    // be checked as one thing and acted on as another. Every such guard pins the argument through
    // `once` (an object or function becomes its string here, before the check) and forwards that.
    expect(SHELL_RUNTIME).toContain(`const passesAsIs = ${PASSES_AS_IS};`);
    expect(SHELL_RUNTIME).toContain(`const once = (${ONCE})(passesAsIs, NativeString);`);
    // The command the refusal checks is the command it runs (read once).
    expect(wrapperRegion).toContain("const cmd = NativeString(command);");
    expect(wrapperRegion).toContain("pushTo(args, cmd);");
    // The attribute and token guards pin their arguments, then both check the copy and act on the
    // real element with that pinned list — never with the raw argument a second time.
    expect(wrapperRegion).toContain("pushTo(fixed, pin[i] === true ? once(args[i]) : args[i]);");
    expect(wrapperRegion).toContain("pushTo(fixed, once(args[i]));");
    expect(wrapperRegion).toContain("const v = once(value);");
    // The before-change backstop and the native call take the same fixed list.
    expect(wrapperRegion).toContain("beforeChange(this, (copy) => change(copy, fixed, original));");
  });
});

describe("once: a value a guard inspects is read once, or refused (P130)", () => {
  const passesAsIs = runInNewContext(PASSES_AS_IS) as (value: unknown) => boolean;
  const makeOnce = runInNewContext(ONCE) as (
    pass: (value: unknown) => boolean,
    toText: (value: unknown) => string,
  ) => (value: unknown) => unknown;
  const once = makeOnce(passesAsIs, String);
  // The refusal is the other realm's TypeError (runInNewContext), so it is matched by message.
  const REFUSED = /can't be used here/u;

  test("passes as they are only the primitives that are their own single reading", () => {
    for (const value of ["", "x", 0, -0, 1.5, Number.NaN, true, false, 10n, null, undefined]) {
      expect(passesAsIs(value), String(value)).toBe(true);
    }
    for (const value of [
      {},
      [],
      () => "x",
      Symbol("s"),
      new String("x"),
      Object.create(null),
      new Proxy({}, {}),
    ]) {
      expect(passesAsIs(value)).toBe(false);
    }
  });

  test("tests undefined by identity, never by typeof", () => {
    // An object whose typeof is "undefined" (document.all's kind) can't be made in Node, so the
    // predicate's own source is what says it: identity with undefined, and no typeof "undefined".
    expect(PASSES_AS_IS).toContain("value === undefined");
    expect(PASSES_AS_IS).not.toMatch(/typeof value === "undefined"|kind === "undefined"/u);
  });

  test("forwards a primitive unchanged, and turns anything else into its string once", () => {
    for (const value of ["x", 3, false, 7n, null, undefined]) {
      expect(once(value)).toBe(value);
    }
    let reads = 0;
    const shifting = {
      toString: () => {
        reads += 1;
        return reads === 1 ? "first" : "second";
      },
    };
    expect(once(shifting)).toBe("first");
    expect(reads).toBe(1);
    expect(once(["a", "b"])).toBe("a,b");
  });

  test("fails closed: a reading that throws, a symbol, or no string at all is refused", () => {
    const throwingGetter = {
      get toString(): () => string {
        throw new Error("unreadable");
      },
    };
    expect(() => once(throwingGetter)).toThrow(REFUSED);
    const throwingTrap = new Proxy(
      {},
      {
        get() {
          throw new Error("unreadable");
        },
      },
    );
    expect(() => once(throwingTrap)).toThrow(REFUSED);
    expect(() => once(Symbol("s"))).toThrow(REFUSED);
    expect(() => once({ toString: () => ({}), valueOf: () => ({}) })).toThrow(REFUSED);
    // A converter that hands back something other than a string is refused too.
    expect(() => makeOnce(passesAsIs, () => 1 as unknown as string)({})).toThrow(REFUSED);
    // A predicate that throws lets nothing through as it is.
    const throwingPredicate = makeOnce(() => {
      throw new Error("x");
    }, String);
    expect(throwingPredicate({ toString: () => "y" })).toBe("y");
  });
});

describe("every insertion entry point is guarded, and every subtree producer strips (P130)", () => {
  // docs/insertion-entry-points.md, entry by entry: each id, how it is guarded, and the runtime
  // text that does it. A new entry point is a row here, in the doc, and in the runtime.
  type Row = readonly [id: string, status: string, text: readonly string[]];
  const CREATION_REFUSED = [
    "if (!ownFrames) {",
    'refuseFrameCreation(proto, "createElement", 0);',
    'refuseFrameCreation(proto, "createElementNS", 1);',
    "if (fixed.length > nameAt && frameCapableName(fixed[nameAt])) {",
  ];
  const ROWS: readonly Row[] = [
    [
      "A1",
      "wrapped",
      [
        'wrapInsert(proto, "appendChild", [0]);',
        'wrapInsert(proto, "insertBefore", [0]);',
        'wrapInsert(proto, "replaceChild", [0]);',
      ],
    ],
    [
      "A2",
      "wrapped",
      [
        'for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {\n    for (const name of ["append", "prepend", "replaceChildren"]) {\n      wrapInsert(proto, name, "all");',
      ],
    ],
    [
      "A3",
      "wrapped",
      [
        'for (const proto of [Element.prototype, CharacterData.prototype, DocumentType.prototype]) {\n    for (const name of ["before", "after", "replaceWith"]) {\n      wrapInsert(proto, name, "all");',
      ],
    ],
    ["A4", "wrapped", ['wrapInsert(Element.prototype, "insertAdjacentElement", [1]);']],
    [
      "A5",
      "text only",
      [
        '[[Attr.prototype, "value"], [Node.prototype, "nodeValue"], [Node.prototype, "textContent"]]',
      ],
    ],
    [
      "A6",
      "wrapped",
      [
        'wrapInsert(Range.prototype, "insertNode", [0]);',
        'wrapInsert(Range.prototype, "surroundContents", [0]);',
      ],
    ],
    [
      "A7",
      "parsed and stripped",
      [
        "callOf(forFragment ? replaceChildrenFragIn : replaceChildrenElIn, this, parseIn(",
        "callOf(descriptor.set, this, [html]);\n          strip(callOf(templateContentOf, this, []));",
      ],
    ],
    ["A8", "parsed and stripped", ["callOf(replaceWithIn, this, parseIn("]],
    ["A9", "parsed and stripped", ['lock(Element.prototype, "insertAdjacentHTML", function']],
    [
      "A10",
      "parsed and stripped",
      ['lock(proto, "setHTML", function (html) {\n        this.innerHTML'],
    ],
    [
      "A11",
      "parsed and stripped",
      [
        'lock(proto, "setHTMLUnsafe", function (html) {\n        this.innerHTML = NativeString(html);',
      ],
    ],
    [
      "A12",
      "refused",
      [
        'for (const name of ["open", "write", "writeln"]) {\n    lock(Document.prototype, name, noRewrite);',
      ],
    ],
    ["A13", "refused", ['const REFUSED_COMMANDS = ["inserthtml", "copy", "cut", "paste"];']],
    [
      "A14",
      "wrapped",
      [
        'if (proto !== null && callOf(hasOwn, proto, ["body"])) {\n      wrapNodeSetter(proto, "body");',
      ],
    ],
    [
      "A15",
      "wrapped",
      [
        'for (const name of ["tHead", "tFoot", "caption"]) {\n    wrapNodeSetter(typeof HTMLTableElement === "function" ? HTMLTableElement.prototype : null, name);',
      ],
    ],
    ["A16", "nothing to guard", CREATION_REFUSED],
    [
      "A17",
      "wrapped",
      [
        'wrapInsert(typeof HTMLSelectElement === "function" ? HTMLSelectElement.prototype : null, "add", [0]);',
        'wrapInsert(typeof HTMLOptionsCollection === "function" ? HTMLOptionsCollection.prototype : null, "add", [0]);',
      ],
    ],
    ["A18", "nothing to guard", CREATION_REFUSED],
    [
      "A19",
      "wrapped",
      [
        "const copy = bare(null);",
        "const value = init[field];",
        "const root = callOf(attachShadow, this, [init]);\n    guardRoot(root);",
      ],
    ],
    [
      "A20",
      "parsed and stripped",
      [
        'for (const name of ["parseHTMLUnsafe", "parseHTML"]) {',
        "lock(Document, name, (html) => {",
      ],
    ],
    ["A21", "nothing to guard", CREATION_REFUSED],
    [
      "A22",
      "wrapped",
      [
        'ownFrames && typeof HTMLIFrameElement === "function" ? HTMLIFrameElement.prototype : null,',
      ],
    ],
    [
      "A23",
      "refused",
      [
        'const FRAMES = "iframe,frame,frameset,object,embed,portal,fencedframe";',
        ...CREATION_REFUSED,
      ],
    ],
    [
      "A24",
      "wrapped",
      [
        'for (const proto of [Node.prototype, Element.prototype, Document.prototype, DocumentFragment.prototype]) {\n    if (callOf(hasOwn, proto, ["moveBefore"])) {\n      wrapInsert(proto, "moveBefore", [0]);',
      ],
    ],
    [
      "A25",
      "refused",
      ["const registry = typeof CustomElementRegistry", 'lock(registry, "define", function'],
    ],
    ["A26", "refused", ["const KNOWN_HTML = bare(null);", "lock(target, name, unknownMarkup);"]],
    ["B1", "producer stripped", ['wrapProducer(DOMParser.prototype, "parseFromString");']],
    [
      "B2",
      "producer stripped",
      [
        'strippedGetter(typeof HTMLTemplateElement === "function" ? HTMLTemplateElement.prototype : null, "content", false);',
      ],
    ],
    [
      "B3",
      "producer stripped",
      [
        'const parsed = callOf(parseFromStringIn, new NativeDOMParser(), [NativeString(html), "text/html"]);\n        strip(parsed);',
      ],
    ],
    [
      "B4",
      "producer stripped",
      [
        'wrapProducer(typeof DOMImplementation === "function" ? DOMImplementation.prototype : null, "createHTMLDocument");',
      ],
    ],
    [
      "B5",
      "producer stripped",
      [
        'wrapProducer(typeof DOMImplementation === "function" ? DOMImplementation.prototype : null, "createDocument");',
      ],
    ],
    ["B6", "producer stripped", ['wrapProducer(Range.prototype, "createContextualFragment");']],
    [
      "B7",
      "producer stripped",
      [
        'wrapProducer(typeof XSLTProcessor === "function" ? XSLTProcessor.prototype : null, "transformToFragment");',
        'wrapProducer(typeof XSLTProcessor === "function" ? XSLTProcessor.prototype : null, "transformToDocument");',
      ],
    ],
    [
      "B8",
      "producer stripped",
      [
        'strippedGetter(typeof XMLHttpRequest === "function" ? XMLHttpRequest.prototype : null, "responseXML", true);',
        'strippedGetter(typeof XMLHttpRequest === "function" ? XMLHttpRequest.prototype : null, "response", true);',
      ],
    ],
    [
      "B9",
      "producer stripped",
      [
        'wrapProducer(Document.prototype, "importNode");',
        'lock(Document.prototype, "adoptNode", function (...args) {',
        "strip(args[0]);\n      return callOf(adoptNodeIn, this, argumentsOf(args));",
      ],
    ],
    ["B10", "parsed and stripped", ["const framed = queryAllOf(node, type, GUARDED);"]],
    [
      "B11",
      "wrapped",
      ['wrapNodeSetter(proto, "body");', 'wrapProducer(Document.prototype, "importNode");'],
    ],
    [
      "B12",
      "producer stripped",
      [
        'const templates = queryAllOf(node, type, "template");',
        "pushTo(pending, callOf(templateContentOf, templates[i], []));",
        "watchRoot(root);\n          pushTo(pending, root);",
      ],
    ],
    [
      "E1",
      "text only",
      [
        '["insertFromPaste", "insertFromPasteAsQuotation", "insertFromDrop", "insertReplacementText", "insertFromYank"]',
        'if (types[i] !== "text/plain") {',
        "callOf(preventNavigation, event, []);",
        'callOf(execCommand, document, ["insertText", false, text]);',
        'callOf(listenIn, window, [\n      "beforeinput",',
      ],
    ],
  ];

  test.each(ROWS)("%s (%s) is in the runtime", (_id, _status, text) => {
    for (const each of text) {
      expect(SHELL_RUNTIME, each).toContain(each);
    }
  });

  test("the doc lists every entry, with the status the runtime gives it", () => {
    const doc = readFileSync(
      path.join(import.meta.dirname, "..", "..", "..", "docs", "insertion-entry-points.md"),
      "utf8",
    );
    for (const [id, status] of ROWS) {
      const row = doc.split("\n").find((line) => line.startsWith(`| ${id} |`));
      expect(row, id).toBeDefined();
      expect(row, id).toContain(`| ${status} |`);
    }
    // And no row the table above lacks.
    const ids = new Set(ROWS.map(([id]) => id));
    for (const [, id] of doc.matchAll(/^\| ([A-Z]\d+) \|/gmu)) {
      expect(ids, String(id)).toContain(id);
    }
  });

  test("every wrapper goes through the same synchronous admit and strip", () => {
    // The setters admit their value as the insertion methods admit their arguments; a producer
    // strips what it made before it returns; a getter strips what it hands out.
    expect(SHELL_RUNTIME).toContain(
      "if (!admit(value)) {\n            refuseInsert();\n          }\n          callOf(descriptor.set, this, [value]);",
    );
    expect(SHELL_RUNTIME).toContain(
      "const made = callOf(original, this, argumentsOf(args));\n      strip(made);\n      if (framedElement(made)) {\n        refuseFrame();",
    );
    expect(SHELL_RUNTIME).toContain(
      "const value = callOf(descriptor.get, this, []);\n          if (!documentsOnly || typeOf(value) === 9) {\n            strip(value);",
    );
    // Each built-in they call was captured before content runs.
    for (const capture of [
      'const templateContentOf = typeof HTMLTemplateElement === "function" ? getterOf(HTMLTemplateElement.prototype, "content") : null;',
      "const parseFromStringIn = DOMParser.prototype.parseFromString;",
      "const adoptNodeIn = Document.prototype.adoptNode;",
      "const listenIn = EventTarget.prototype.addEventListener;",
      'const inputTypeOf = getterOf(inputProto, "inputType");',
      'const dataTransferOf = getterOf(inputProto, "dataTransfer");',
      'const transferTypesOf = getterOf(transferProto, "types");',
      "const NativeDOMException = DOMException;",
    ]) {
      expect(SHELL_RUNTIME, capture).toContain(capture);
    }
    // The walk into template contents and shadow roots is a list, not recursion.
    expect(SHELL_RUNTIME).toContain(
      "const pending = listOf();\n    pushTo(pending, start);\n    for (let at = 0; at < pending.length; at += 1) {",
    );
  });

  test("refuses frame-like elements at creation only under the default config", () => {
    // Under nestedFrames "own" (P128) an iframe is made, and the attribute guard decides.
    const at = SHELL_RUNTIME.indexOf(
      "  if (!ownFrames) {\n    for (const proto of [Document.prototype",
    );
    expect(at).toBeGreaterThan(0);
    expect(
      SHELL_RUNTIME.indexOf('refuseFrameCreation(proto, "createElement", 0);'),
    ).toBeGreaterThan(at);
    // Every name the guard removes is a name content can't create.
    expect(SHELL_RUNTIME).toContain(
      'for (const tag of FRAMES.split(",")) {\n    frameTags[tag] = true;',
    );
    expect(
      () => new Script(SHELL_RUNTIME.replace("__PLAN__", '{"nestedFrames":"own"}')),
    ).not.toThrow();
  });
});

describe("the shell document", () => {
  const compiled = compile(presets.inlineWidget({ capabilities: { sendPrompt: {} } }));
  const html = compiled.shellDocument({ origins: [ORIGIN], title: 'A "chart" </title><script>' });

  test("carries the compiled CSP in a <meta>, first in the head", () => {
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${compiled.csp.replace(/'/gu, "'")}">`,
    );
    expect(head.indexOf("Content-Security-Policy")).toBeLessThan(head.indexOf("<style>"));
    expect(head).toContain('<meta name="referrer" content="no-referrer">');
  });

  test("gives the runtime its plan and the origins it takes messages from", () => {
    expect(planIn(html)).toEqual({ ...compiled.shell, origins: [ORIGIN] });
  });

  test("escapes what it is given", () => {
    expect(html).toContain('<title>A "chart" &lt;/title&gt;&lt;script&gt;</title>');
    // The runtime's own closing tag is the only one: nothing it embeds can end the script early.
    expect(html.match(/<\/script>/gu)).toHaveLength(1);
  });

  test("takes exact origins only", () => {
    expect(() => compiled.shellDocument({ origins: ["https://*.example.com"] })).toThrow(
      /exact origin/u,
    );
    expect(() => compiled.shellDocument({ origins: ["*"] })).toThrow(/exact origin/u);
  });

  test("carries a given document as data, for the shell to render inert, never as markup", () => {
    const view =
      '<!DOCTYPE html>\n<script>window.early = 1</script>\n<html lang="fr"><body>Hi <template shadowrootmode="closed"><iframe></iframe></template></body></html>';
    const hardened = compile(presets.mcpApp()).shellDocument({ origins: [ORIGIN], document: view });
    // The page's parser sees the shell alone: one script, one doctype, no markup of the view's.
    expect(hardened.match(/<!doctype/giu)).toHaveLength(1);
    expect(hardened.match(/<script>/gu)).toHaveLength(1);
    expect(hardened).not.toContain("<template");
    expect(planIn(hardened)).toMatchObject({ protocol: "none", globals: [], document: view });
  });

  test("may leave the CSP to a served document's headers", () => {
    expect(compiled.shellDocument({ origins: [ORIGIN], cspMeta: false })).not.toContain(
      "Content-Security-Policy",
    );
  });
});

describe("resolveTheme", () => {
  test("takes the host's live values for declared names, the defaults otherwise, and nothing else", () => {
    const values = resolveTheme(DEFAULT_THEME, "dark", {
      "--color-text-primary": " #eee ",
      "--color-text-secondary": "",
      "--color-accent": "red; } body {",
      "--not-declared": "#000",
    });
    expect(values["--color-text-primary"]).toBe("#eee");
    expect(values["--color-text-secondary"]).toBe("#b5b4ae");
    expect(values["--color-accent"]).toBe("#3987e5");
    expect(values).not.toHaveProperty("--not-declared");
    expect(Object.keys(values)).toEqual(Object.keys(DEFAULT_THEME.variables));
  });
});

describe("a strict embedding page's nonce (P054)", () => {
  const compiled = compile(presets.inlineWidget());
  test("is carried by the shell's own script and style, and taken from its script at run time", () => {
    const html = compiled.shellDocument({ origins: [ORIGIN], nonce: "r4nd0m+N0nce/=" });
    expect(html).toContain('<script nonce="r4nd0m+N0nce/=">');
    expect(html).toContain('<style nonce="r4nd0m+N0nce/=">');
    expect(html).not.toContain('"nonce"');
    expect(SHELL_RUNTIME).toContain("document.currentScript.nonce");
    expect(SHELL_RUNTIME).toContain("live.nonce = nonce;");
  });
  test("is a nonce, never markup", () => {
    for (const bad of ['x" onload="alert(1)', "short", "a b c d e f g h"]) {
      expect(() => compiled.shellDocument({ origins: [ORIGIN], nonce: bad }), bad).toThrow(
        /nonce/u,
      );
    }
    expect(compiled.shellDocument({ origins: [ORIGIN] })).not.toContain("nonce=");
  });
});
