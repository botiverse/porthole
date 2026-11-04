import { runInNewContext, Script } from "node:vm";
import { describe, expect, test } from "vitest";
import { compile, MCP_APPS_METHODS, presets, resolveTheme, DEFAULT_THEME } from "../src/index.ts";
import { HELD_BACK, OWN_FRAME, SHELL_RUNTIME } from "../src/shell/runtime.ts";

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
    expect(SHELL_RUNTIME).toContain(
      'const once = (value) => (value !== null && (typeof value === "object" || typeof value === "function") ? NativeString(value) : value);',
    );
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
