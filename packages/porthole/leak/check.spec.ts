import { expect, test } from "@playwright/test";
import { cdpDriver, checkPage, playwrightDriver } from "../src/check/index.ts";
import { GUIDE_EXAMPLES, presets, type PortholeConfig } from "../src/index.ts";

/**
 * The agent's pre-show check (P073) in real browsers: the manual's own examples pass it under
 * every preset, at the manual's widths, in light and dark (OBJECTIVES criterion 5); a page that
 * breaks is told so, briefly; the CDP driver (Cloudflare Browser Rendering's way) works too.
 */

const PRESETS: Record<string, PortholeConfig> = {
  inlineWidget: presets.inlineWidget(),
  artifact: presets.artifact(),
  "artifact, a whole-page viewer": presets.artifact({
    layout: { kind: "fill" },
    theme: { documents: "never" },
  }),
  mcpApp: presets.mcpApp(),
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
