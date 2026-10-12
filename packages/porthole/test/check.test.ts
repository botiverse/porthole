import { describe, expect, it } from "vitest";
import {
  admitContent,
  answerGuide,
  checkTool,
  compile,
  fragmentOf,
  guideChanges,
  guideTool,
  lintContent,
  LIBRARY_CDNS,
  presets,
  showTool,
  GUIDE_EXAMPLES,
} from "../src/index.ts";
import type { CDPSession as PlaywrightSession } from "@playwright/test";
import { cdpDriver, checkPage, type CdpSession, type CheckDriver } from "../src/check/index.ts";
import type { CheckRunData } from "../src/check/instrument.ts";

/** The agent's side without a browser (P073): the lint, the show tool's gate, the tools. */

const rules = (findings: readonly { rule: string; severity: string }[]) =>
  findings.map((each) => `${each.severity} ${each.rule}`);

describe("lintContent", () => {
  it("says nothing of the manual's own examples", () => {
    for (const [name, example] of Object.entries(GUIDE_EXAMPLES)) {
      expect(lintContent(presets.inlineWidget(), example), name).toEqual([]);
      expect(lintContent(presets.artifact(), example), name).toEqual([]);
    }
  });

  it("errors only on what certainly fails or is cut", () => {
    const config = presets.inlineWidget({ limits: { maxBytes: 2_000 } });
    expect(rules(lintContent(config, "x".repeat(3_000)))).toEqual(["error size"]);
    expect(rules(lintContent(config, '<p>a</p><iframe src="x"></iframe>'))).toEqual([
      "error nested-frame",
    ]);
    expect(rules(lintContent(config, "<script>document.write('x')</script>"))).toEqual([
      "error document-write",
    ]);
    expect(
      rules(lintContent(config, "<!doctype html><html><head></head><body></body></html>")),
    ).toEqual(["error document"]);
  });

  it("warns on what the sandbox would quietly stop, with the line", () => {
    const config = presets.inlineWidget();
    const findings = lintContent(
      config,
      [
        "<p>hello</p>",
        '<img src="https://example.com/a.png">',
        "<script>navigator.clipboard.writeText('x'); alert('hi')</script>",
        '<form><button>go</button></form><a target="_blank" href="https://x.example">x</a>',
        '<script src="https://cdn.jsdelivr.net/npm/chart.js@latest"></script>',
        "<style>.bar { position: fixed }</style>",
      ].join("\n"),
    );
    expect(rules(findings)).toEqual([
      "warning clipboard",
      "warning dialog",
      "warning form",
      "warning egress",
      "warning unpinned",
      "warning egress",
      "warning position-fixed",
      "warning new-window",
    ]);
    expect(findings.filter((each) => each.rule === "egress").map((each) => each.line)).toEqual([
      5, 2,
    ]);
    // Opened egress, and a pinned version: nothing to say.
    const open = presets.inlineWidget({ egress: LIBRARY_CDNS });
    expect(
      lintContent(
        open,
        '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>',
      ),
    ).toEqual([]);
  });

  it("takes a whole document sent as a widget as its body", () => {
    const content =
      "<!doctype html><html><head><style>p{color:red}</style></head><body><p>hi</p></body></html>";
    expect(rules(lintContent(presets.inlineWidget(), content))).toEqual(["warning document"]);
    expect(fragmentOf(content)).toBe("<style>p{color:red}</style>\n<p>hi</p>");
    expect(lintContent(presets.artifact(), content)).toEqual([]);
  });
});

describe("the show tool's gate (admitContent)", () => {
  it("refuses errors by default, saying what to change", () => {
    const refused = admitContent(presets.inlineWidget(), "<iframe src=x></iframe>");
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.refusal).toMatch(
      /^Not shown\. Change this, then call show_widget again:\n- line 1: Remove the <iframe>/u,
    );
    const shown = admitContent(presets.inlineWidget(), "<iframe src=x></iframe>", {
      refuseOn: "never",
    });
    expect(shown.ok).toBe(true);
  });

  it("shows warnings with the content, and a widget's document as its body", () => {
    const admitted = admitContent(
      presets.inlineWidget(),
      "<!doctype html><html><body><p>hi</p></body></html>",
    );
    expect(admitted).toMatchObject({ ok: true, content: "<p>hi</p>" });
    expect(admitted.ok && admitted.note).toMatch(/^Shown\. Fix these next time:/u);
    expect(admitContent(presets.inlineWidget(), "<p>fine</p>")).toEqual({
      ok: true,
      content: "<p>fine</p>",
      findings: [],
      note: null,
    });
  });
});

describe("the tools", () => {
  const config = presets.artifact({
    guide: {
      toolName: "show_page",
      guideToolName: "page_guide",
      topics: { files: "How files work." },
    },
  });

  it("are named from the config, with JSON Schemas", () => {
    expect(showTool(config)).toMatchObject({
      name: "show_page",
      description: compile(config).toolDescription(),
      inputSchema: { type: "object", required: ["title", "html"] },
    });
    const guide = guideTool(config);
    expect(guide.name).toBe("page_guide");
    expect(guide.inputSchema).toMatchObject({
      properties: { topics: { items: { enum: ["widget", "chart", "interactive", "files"] } } },
    });
    expect(checkTool(config).name).toBe("check_page");
    expect(showTool(presets.inlineWidget()).name).toBe("show_widget");
  });

  it("answer the guide, and refuse topics that don't exist", () => {
    expect(answerGuide(config, {})).toEqual({
      text: compile(config).guide(["widget", "chart", "interactive", "files"]),
    });
    expect(answerGuide(config, { topics: ["files"] })).toEqual({ text: "How files work." });
    expect(answerGuide(config, { topics: ["nope"] })).toMatchObject({
      error: expect.stringContaining('No topic "nope"'),
    });
    expect(answerGuide(config, { topics: "widget" })).toMatchObject({ error: expect.any(String) });
  });

  it("say what changed in the manual when a kind flips between served and opaque", () => {
    const opaque = presets.inlineWidget();
    const served = presets.inlineWidget({
      isolation: "domain",
      contentOrigins: ["https://*.c.example"],
    });
    expect(guideChanges(opaque, opaque)).toBeNull();
    const told = guideChanges(opaque, served);
    expect(told).toMatch(/^The manual for show_widget changed\. It now says:\n- /u);
    expect(told?.split("\n").length).toBeLessThan(6);
  });
});

describe("checkPage's report", () => {
  /** A driver whose page saw `data` in every run. */
  const saw = (data: Partial<CheckRunData>): CheckDriver => ({
    open: () =>
      Promise.resolve({
        setViewport: () => Promise.resolve(),
        load: () => Promise.resolve(),
        evaluate: <T>(expression: string) =>
          Promise.resolve(
            (expression.includes(".result(")
              ? {
                  errors: [],
                  calls: [],
                  blocked: [],
                  failedLoads: [],
                  console: [],
                  height: 100,
                  scrollWidth: 300,
                  clientWidth: 300,
                  outcome: "loaded",
                  ...data,
                }
              : 0) as T,
          ),
        close: () => Promise.resolve(),
      }),
  });

  it("words host-function calls: what hosts refuse is a problem, what a person may decline a note (P074)", async () => {
    const config = presets.inlineWidget({ capabilities: { sendPrompt: {}, readData: {} } });
    const refused = await checkPage({
      config,
      content: "<p>x</p>",
      page: "",
      settleMs: 0,
      driver: saw({
        calls: [
          { capability: "sendPrompt", outcome: "no-user-activation" },
          { capability: "readData", outcome: "answered" },
        ],
      }),
    });
    expect(refused.ok).toBe(false);
    expect(refused.text.split("\n")).toEqual([
      expect.stringMatching(/^The widget has 1 problem/u),
      "- It called sendPrompt at load, with no click: hosts refuse that. Call sendPrompt from a click (at every width and scheme).",
      "Note: it called readData at load; the check answered no, as a host or a person may. Make sure the widget still works then.",
    ]);
    const declined = await checkPage({
      config,
      content: "<p>x</p>",
      page: "",
      settleMs: 0,
      driver: saw({ calls: [{ capability: "sendPrompt", outcome: "declined" }] }),
    });
    expect(declined.ok).toBe(true);
    expect(declined.text).toMatch(/^OK: .*\nNote: it called sendPrompt at load/u);
  });
});

describe("cdpDriver's session type", () => {
  it("takes Playwright's and Puppeteer's sessions as they are, with no cast (P074)", () => {
    /** Puppeteer's `CDPSession`, as it declares itself: generic over the protocol's maps. */
    interface Commands {
      "Page.enable": { paramsType: []; returnType: Record<string, never> };
      "Runtime.evaluate": {
        paramsType: [{ expression: string; awaitPromise?: boolean; returnByValue?: boolean }];
        returnType: { result: { value?: unknown } };
      };
    }
    interface Events {
      "Fetch.requestPaused": [{ requestId: string; request: { url: string; method: string } }];
      "Page.loadEventFired": [{ timestamp: number }];
    }
    abstract class PuppeteerSession {
      abstract send<T extends keyof Commands>(
        method: T,
        params?: Commands[T]["paramsType"][0],
        options?: { timeout: number },
      ): Promise<Commands[T]["returnType"]>;
      abstract on<K extends keyof Events>(type: K, handler: (event: Events[K][0]) => void): this;
      abstract detach(): Promise<void>;
    }
    const fits = (open: () => Promise<CdpSession>) => cdpDriver(open);
    expect(typeof fits(() => Promise.resolve({} as PlaywrightSession))).toBe("object");
    expect(typeof fits(() => Promise.resolve({} as PuppeteerSession))).toBe("object");
  });
});
