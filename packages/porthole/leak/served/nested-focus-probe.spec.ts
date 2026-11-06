import { test, type Page } from "@playwright/test";
import { field, hostActive, hostButton, seen, show, tell, valueOf } from "./nested-pages.ts";

/**
 * A measurement, not a check (#proj-workspace:#214): where the host's `display.focus()` stops on a
 * nested page (P111) that had the focus, and what a shell's candidate does on each engine. Nothing
 * here asserts: each case prints one `PROBE214` line for reading out of CI's log, and this file goes
 * when that is read.
 *
 * Every frame logs by itself, on the console, from an init script: its window's and elements'
 * focus and blur as they fire, each `focus()` and `blur()` called, where a key landed, and each
 * change of its own `activeElement` and `hasFocus`. Nothing is evaluated in the shell or the page
 * while a case runs, because an evaluation there is a gesture (nested.spec.ts).
 *
 * A candidate runs in the shell from the same init script, ahead of the shell's own listener, so
 * `frame.ts` is as it is on main:
 * - `blur-first`: in the focus listener, the page's frame blurred, then focused;
 * - `blur-task`: the same a task later, if the shell's document still has the focus;
 * - `word-plain`, `word-blur`, `word-window`: not in a focus event, on a message from the host 300 ms
 *   after its move (`frame.focus()`; blurred first; the page's window's own `focus()`);
 * - `page-field`: nothing in the shell: the page calls its own field's `focus()` on that message.
 */

test.use({ trace: "off" });

type Variant =
  | "none"
  | "blur-first"
  | "blur-task"
  | "word-plain"
  | "word-blur"
  | "word-window"
  | "page-field";

/** Runs in every frame before its scripts. */
const recorder = (variant: Variant) => {
  const top = window === window.parent;
  const nested = location.hostname.startsWith("porthole-");
  if (!top && !nested) {
    return;
  }
  const role = top ? "host" : location.pathname.startsWith("/__porthole/f/") ? "page" : "shell";
  const log = console.log.bind(console);
  const clock = () => Math.round(performance.timeOrigin + performance.now()) % 1_000_000;
  const named = (target: unknown): string => {
    if (target === window) {
      return "window";
    }
    if (target instanceof Document) {
      return "document";
    }
    const element = target as Element | null;
    return element === null ? "null" : element.id || element.tagName;
  };
  const state = () => `active=${named(document.activeElement)} has=${String(document.hasFocus())}`;
  const say = (what: string) => log(`__F ${clock()} ${role} ${what} | ${state()}`);

  for (const type of ["focus", "blur"]) {
    addEventListener(type, (event) => say(`${type}@${named(event.target)}`), true);
  }
  addEventListener("keydown", (event) => say(`keydown:${event.key}`), true);

  const focusOf = Reflect.get(HTMLElement.prototype, "focus");
  const blurOf = Reflect.get(HTMLElement.prototype, "blur");
  HTMLElement.prototype.focus = function focus(options) {
    say(`call-focus(${named(this)}) before`);
    Reflect.apply(focusOf, this, [options]);
    say(`call-focus(${named(this)}) after`);
  };
  HTMLElement.prototype.blur = function blur() {
    say(`call-blur(${named(this)}) before`);
    Reflect.apply(blurOf, this, []);
    say(`call-blur(${named(this)}) after`);
  };

  let last = "";
  setInterval(() => {
    if (document.documentElement === null) {
      return;
    }
    const now = state();
    if (now !== last) {
      last = now;
      say("state");
    }
  }, 25);

  if (role !== "shell") {
    return;
  }
  const frameOf = () => document.querySelector("iframe");
  addEventListener("focus", (event) => {
    const frame = frameOf();
    if (event.target !== window || frame === null || document.activeElement !== frame) {
      return;
    }
    if (variant === "blur-first") {
      frame.blur();
      frame.focus();
    }
    if (variant === "blur-task") {
      setTimeout(() => {
        if (document.hasFocus()) {
          frame.blur();
          frame.focus();
        }
      }, 0);
    }
  });
  addEventListener("message", (event) => {
    const frame = frameOf();
    const data = event.data as { test?: unknown } | null;
    if (event.source !== window.parent || data?.test !== "shell-focus" || frame === null) {
      return;
    }
    say("word");
    if (variant === "word-plain") {
      frame.focus();
    }
    if (variant === "word-blur") {
      frame.blur();
      frame.focus();
    }
    if (variant === "word-window") {
      frame.contentWindow?.focus();
    }
  });
};

/** How the case stands before the host's move. */
type Scenario = "had" | "had-pressed-away" | "had-body" | "in-page" | "never-body" | "never-button";

const display = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { portholeHost: { displays: { focus(): void }[] } }).portholeHost.displays
      .at(-1)
      ?.focus(),
  );

const toButton = async (page: Page) => {
  await page.evaluate(() => document.getElementById("host-button")?.focus());
};

for (const [scenario, variant] of [
  ["had", "none"],
  ["had-pressed-away", "none"],
  ["had-body", "none"],
  ["in-page", "none"],
  ["never-body", "none"],
  ["never-button", "none"],
  ["had", "blur-first"],
  ["had-pressed-away", "blur-first"],
  ["had-body", "blur-first"],
  ["in-page", "blur-first"],
  ["never-button", "blur-first"],
  ["had", "blur-task"],
  ["had", "word-plain"],
  ["had", "word-blur"],
  ["had", "word-window"],
  ["had", "page-field"],
] as readonly [Scenario, Variant][]) {
  test(`probe ${scenario} ${variant}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    const lines: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("__F ")) {
        lines.push(text.slice(4));
      }
    });
    await page.addInitScript(recorder, variant);
    const shown = await show(page);
    const mark = (what: string) => lines.push(`---- ${what}`);

    if (scenario.startsWith("had") || scenario === "in-page") {
      await page.mouse.click(field(shown).x, field(shown).y);
      await page.waitForTimeout(300);
      mark("pressed the page");
    }
    if (scenario === "had" || scenario === "had-body" || scenario === "never-button") {
      await toButton(page);
      await page.waitForTimeout(300);
      mark("host's button");
    }
    if (scenario === "had-pressed-away") {
      await page.mouse.click(hostButton.x, hostButton.y);
      await page.waitForTimeout(300);
      mark("pressed the host's button");
    }
    if (scenario === "had-body") {
      await page.evaluate(() => (document.activeElement as HTMLElement).blur());
      await page.waitForTimeout(300);
      mark("host's body");
    }
    // Past the activation of the host's own evaluations and any press: a gesture isn't the cause.
    await page.waitForTimeout(5_500);
    mark("display.focus()");
    await display(page);
    await page.waitForTimeout(300);
    if (variant.startsWith("word-")) {
      mark("the host's word");
      await tell(page, { test: "shell-focus" });
      await page.waitForTimeout(300);
    }
    if (variant === "page-field") {
      mark("the page's field.focus()");
      await tell(page, { test: "focus" });
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(500);
    mark("a key");
    await page.keyboard.press("k");
    await page.waitForTimeout(300);

    const out = {
      engine: info.project.name,
      scenario,
      variant,
      host: await hostActive(page),
      value: valueOf(shown),
      seen: await seen(page),
      lines,
    };
    console.log(`PROBE214 ${JSON.stringify(out)}`);
  });
}
