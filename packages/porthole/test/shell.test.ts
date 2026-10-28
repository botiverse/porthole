import { runInNewContext, Script } from "node:vm";
import { describe, expect, test } from "vitest";
import { compile, MCP_APPS_METHODS, presets, resolveTheme, DEFAULT_THEME } from "../src/index.ts";
import { HELD_BACK, SHELL_RUNTIME } from "../src/shell/runtime.ts";

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
