import { test, type Page } from "@playwright/test";
import { field, hostActive, seen, show, tell, valueOf } from "./nested-pages.ts";

/**
 * A measurement, not a check (#proj-workspace:#214, round two): with the host's word in (P136), what
 * a Tab does, what a move in a key's handler does (Gecko's `IsHandlingKeyBoardEvent`), and what the
 * rejected alternative would have let a page do. Nothing here asserts: each case prints one
 * `PROBE214` line for reading out of CI's log, and this file goes when that is read.
 *
 * Every frame logs by itself, on the console, from an init script: nothing is evaluated in the
 * shell or the page while a case runs, because an evaluation there is a gesture (nested.spec.ts).
 *
 * - `page-parent`: the page calls `parent.focus()`, as frame.ts stands.
 * - `page-parent-task`: the same, with the shell modelled as passing any focus on a task later,
 *   blurred first: the rejected fix, which a page can start with no gesture.
 * - `page-field`: the page's own `field.focus()`, what it can do without any of this.
 */

test.use({ trace: "off" });

type Variant = "none" | "page-parent" | "page-parent-task" | "page-field";

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

  if (role !== "shell" || variant !== "page-parent-task") {
    return;
  }
  addEventListener("focus", (event) => {
    const frame = document.querySelector("iframe");
    if (event.target === window && frame !== null) {
      setTimeout(() => {
        frame.blur();
        frame.focus();
      }, 0);
    }
  });
};

/** How the case stands before the host's move. */
type Scenario = "had" | "never-button" | "tab" | "tab-had" | "key-handler";

const display = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { portholeHost: { displays: { focus(): void }[] } }).portholeHost.displays
      .at(-1)
      ?.focus(),
  );

const toButton = async (page: Page) => {
  await page.evaluate(() => document.getElementById("host-button")?.focus());
};

const CASES: readonly (readonly [Scenario, Variant])[] = [
  ["had", "none"],
  ["never-button", "none"],
  ["tab", "none"],
  ["tab-had", "none"],
  ["key-handler", "none"],
  ["never-button", "page-parent"],
  ["never-button", "page-parent-task"],
  ["never-button", "page-field"],
];

const PAGE = `addEventListener("message", (event) => {
  if (event.data && event.data.test === "parent-focus") parent.focus();
});`;

for (const [scenario, variant] of CASES) {
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
    const shown = await show(page, PAGE);
    const mark = (what: string) => lines.push(`---- ${what}`);

    if (scenario === "had" || scenario === "tab-had" || scenario === "key-handler") {
      await page.mouse.click(field(shown).x, field(shown).y);
      await page.waitForTimeout(300);
      mark("pressed the page");
    }
    await toButton(page);
    await page.waitForTimeout(300);
    mark("host's button");
    if (scenario === "key-handler") {
      await page.evaluate(() => {
        addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            (
              window as unknown as { portholeHost: { displays: { focus(): void }[] } }
            ).portholeHost.displays
              .at(-1)
              ?.focus();
          }
        });
      });
    }
    // Past the activation of the host's own evaluations and any press: a gesture isn't the cause.
    await page.waitForTimeout(5_500);
    if (scenario === "tab" || scenario === "tab-had") {
      mark("Tab");
      await page.keyboard.press("Tab");
    } else if (scenario === "key-handler") {
      mark("Escape, display.focus() in its keydown");
      await page.keyboard.press("Escape");
    } else if (variant === "page-parent" || variant === "page-parent-task") {
      mark("the page's parent.focus()");
      await tell(page, { test: "parent-focus" });
    } else if (variant === "page-field") {
      mark("the page's field.focus()");
      await tell(page, { test: "focus" });
    } else {
      mark("display.focus()");
      await display(page);
    }
    await page.waitForTimeout(800);
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
