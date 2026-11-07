import { expect, test, type Frame, type Page } from "@playwright/test";
import type { PortholeConfig } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import {
  NESTED_LATE_WORD,
  NESTED_MOVED_ON,
  NESTED_SECOND_MOVE,
  NESTED_WORD_LATE,
} from "../controls.ts";
import { mount, outcomeOf, runtimeCalls } from "./porthole-host.ts";
import { storedFiles } from "./files.ts";
import { harness } from "./harness.ts";
import {
  STOPPED,
  button,
  composer,
  composerText,
  field,
  fightOver,
  hostActive,
  hostButton,
  seen,
  show,
  tell,
  type Shown,
  unique,
  valueOf,
} from "./nested-pages.ts";

/**
 * A nested page (P111) in real browsers: the framed address is Porthole's shell, the page its
 * child, sandboxed to an opaque origin; the shell's own activation decides the keyboard and
 * `comments.open`. Run on full Chromium (`chromium-oopif`: the frames are out of process, and the
 * host's page sees no press in them), the headless shell, WebKit and Firefox.
 *
 * Every gesture here is a real one (`page.mouse`, `page.keyboard`). Playwright runs every
 * evaluation in a frame as a user gesture (`userGesture: true`), which would turn the page's and
 * the shell's activation on: nothing is evaluated in the page's or the shell's frame before what a
 * case decides has been decided. The page says what happens over the console (`__P`), and takes
 * its orders as messages the host page posts through the shell.
 */

// A trace's snapshots evaluate in every frame (as gestures): the page's and the shell's activation
// would turn on at each action, which no person's browser does (measured: the shell's activation
// on as the page loaded, with no input). These cases run untraced.
test.use({ trace: "off" });

/** The host's page's displays, as a case drives them. */
interface Driven {
  readonly portholeHost: {
    readonly displays: readonly {
      focus(): void;
      annotations: {
        show(marks: unknown[]): void;
        track(id: string | null): void;
        focusMark(id: string): void;
      };
    }[];
  };
}

const elementMark = (id: string, selector: string) => ({
  id,
  anchor: {
    kind: "element",
    selectors: [{ type: "CssSelector", value: selector }],
    label: selector,
  },
  count: 2,
});

/** A `show` and a `focusMark` in one task: the second is parked while the first's marks are found. */
const park = (page: Page, marks: unknown[], id: string) =>
  page.evaluate(
    ([shown, which]) => {
      const display = (window as unknown as Driven).portholeHost.displays.at(-1);
      display?.annotations.show(shown);
      display?.annotations.focusMark(which);
    },
    [marks, id] as const,
  );

/** The person's press on the page's field: the focus in the page. */
async function pressPage(page: Page, shown: Shown) {
  await page.mouse.click(field(shown).x, field(shown).y);
  await expect.poll(() => hostActive(page), { message: "the page has the focus" }).toBe("IFRAME");
}

/** The person moves on: the focus on the host's own button. */
async function moveOn(page: Page) {
  await page.evaluate(() => document.getElementById("host-button")?.focus());
  await expect.poll(() => hostActive(page), { message: "the person moved on" }).toBe("host-button");
}

/** The page's own frame, the shell's child. */
async function pageFrame(shown: Shown): Promise<Frame> {
  const child = (await shown.shell()).childFrames()[0];
  if (child === undefined) {
    throw new Error("the shell has no child frame");
  }
  return child;
}

/** Whether the page's focus is on the shell's layer: on one of its markers, to the page. */
const onMarker = (child: Frame) =>
  child.evaluate(
    () => document.activeElement === document.querySelector("[data-porthole-annotations]"),
  );

test.describe("a nested page (P111)", () => {
  test.setTimeout(90_000);

  test("is the shell's child, an opaque origin, sandboxed to scripts alone, at its sealed address", async ({
    page,
  }) => {
    // Beside a display of its own scope (P114): every case before had a scope of its own, which
    // hid that the shell shared its scope's origin (porthole#56).
    const scope = unique("nest-shared");
    const shown = await show(page, "", undefined, {}, scope);
    const served = await harness();
    const widget: InstanceRef = { scope, document: { kind: "shell", preset: "inlineWidget" } };
    const sibling = await mount(
      page,
      served.hostOrigin,
      served.configs.inlineWidget as PortholeConfig,
      await served.porthole.issue(widget, { viewer: "probe" }),
      widget,
      { content: "<p>sibling</p>" },
    );
    expect(await outcomeOf(sibling.read)).toEqual({ state: "loaded" });
    const ready = shown.said.find((each) => each.type === "ready") ?? {};
    expect(ready.origin, "probe: the page's origin is opaque").toBe("null");
    expect(String(ready.href), "probe: the page is at its sealed files' address").toContain(
      `${shown.origin}/__porthole/f/`,
    );
    const shell = await shown.shell();
    expect(
      new URL(shell.url()).origin,
      "the display's frame is the shell, on the shell's own origin",
    ).toBe(shown.origin);
    expect(
      new URL((await sibling.frame()).url()).origin,
      "the scope's other display is on the scope's origin, not the shell's (P114)",
    ).not.toBe(shown.origin);
    const sandbox = await shell.evaluate(
      () => document.querySelector("iframe")?.getAttribute("sandbox") ?? null,
    );
    expect(sandbox, "probe: the page's frame is sandboxed to scripts alone").toBe("allow-scripts");
    // The page's own answer is sandboxed too, so a tab of its own is opaque as well.
    const response = await page.request.get(String(ready.href));
    const csp = response.headers()["content-security-policy"] ?? "";
    expect(csp, "probe: the page's answer carries its sandbox").toMatch(
      /sandbox allow-scripts(;|$)/u,
    );
    expect(csp, "probe: never allow-same-origin").not.toContain("allow-same-origin");
  });

  test("a page's SVG or XML file opened on a tab of its own is an opaque origin, and its script touches nothing of the shell's (P111, after its review)", async ({
    page,
    context,
  }) => {
    const served = await harness();
    const id = `files-${process.pid}-${Date.now()}`;
    const ran = `try { localStorage.setItem("pwned", "yes"); } catch (_) {} document.documentElement.setAttribute("data-ran", "yes");`;
    served.fileSets.set(
      `${id}@1`,
      storedFiles({
        "index.html": "<!doctype html><p>page</p>",
        "pic.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>${ran}</script></svg>`,
        "data.xml": `<?xml version="1.0"?><root xmlns:h="http://www.w3.org/1999/xhtml"><h:script>${ran}</h:script></root>`,
      }),
    );
    const location = await served.porthole.issue(
      { scope: id, document: { kind: "artifact", id, version: "1", preset: "artifactNested" } },
      { viewer: "probe" },
    );
    // The shell's answer, as the frame asks for it: it names the page's sealed address.
    const shell = await page.request.get(location.url, {
      headers: { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
    });
    const pageUrl = /"page":"([^"]+)"/u.exec(await shell.text())?.[1] ?? "";
    expect(pageUrl).toContain("/__porthole/f/");
    const tab = await context.newPage();
    for (const name of ["pic.svg", "data.xml"]) {
      await tab.goto(new URL(name, pageUrl).href);
      expect(
        await tab.evaluate(() => self.origin),
        `probe: ${name} on its own tab is an opaque origin`,
      ).toBe("null");
      expect(
        await tab.locator(":root").getAttribute("data-ran"),
        `${name}'s script ran nothing`,
      ).toBeNull();
    }
    // The shell's origin's storage, read on a page of that origin (Porthole's own status page).
    await tab.goto(`${location.origin}/__porthole/f/${"a".repeat(40)}/`);
    expect(
      await tab.evaluate(() => localStorage.getItem("pwned")),
      "probe: nothing written on the shell's origin",
    ).toBeNull();
  });

  test("a real click into the page's field keeps the keyboard there, and the typed words land in it", async ({
    page,
    browserName,
  }) => {
    const shown = await show(page);
    for (const round of [1, 2]) {
      await page.mouse.click(composer.x, composer.y);
      await page.keyboard.type("ab", { delay: 40 });
      // A person's hand goes from the keys to the pointer before it presses (P122: no press of
      // theirs comes within 250 ms of a key they typed on the host's page).
      await page.waitForTimeout(400);
      await page.mouse.click(field(shown).x, field(shown).y);
      await page.keyboard.type("hello", { delay: 40 });
      await page.waitForTimeout(400);
      expect(await hostActive(page), `probe: round ${round}: focus stayed in the frame`).toBe(
        "IFRAME",
      );
      // Firefox focuses the frame's document but not its field on that press, with or without the
      // guard (measured, P109): the keys go to the frame, not to the field.
      if (browserName !== "firefox") {
        expect(valueOf(shown), `probe: round ${round}: the words went to the page's field`).toMatch(
          /hello$/u,
        );
      }
      // A gesture in the page within 5 s of the last turns nothing on (P111's limit): the next
      // round waits for it to lapse.
      await page.waitForTimeout(5_500);
    }
    expect(await composerText(page), "the composer has only what was typed in it").toBe("abab");
    const { taken, errors } = await seen(page);
    expect(taken, "probe: nothing was taken back").toEqual([]);
    expect(errors, "probe: the display wasn't stopped").not.toContain(STOPPED);
  });

  test("a page's focus() as it loads is taken back: the composer keeps the person's words", async ({
    page,
  }) => {
    const shown = await show(page, "field.focus(); say('took');", async () => {
      await page.mouse.click(composer.x, composer.y);
      await page.keyboard.type("x", { delay: 40 });
    });
    await expect.poll(() => shown.said.some((each) => each.type === "took")).toBe(true);
    await page.waitForTimeout(800);
    await page.keyboard.type("words", { delay: 60 });
    await page.waitForTimeout(300);
    expect(await composerText(page), "probe: the composer kept the person's words").toBe("xwords");
    expect(valueOf(shown), "probe: the page got none").toBe("");
  });

  test("a page that holds the keyboard from its load and takes it back on its own blur gets none of what the person types in the host's composer, and is stopped (P120)", async ({
    page,
    browserName,
  }) => {
    // The page focuses its field as it loads, and again whenever it loses focus (which a take-back
    // fires): no timer, no gesture of its own (the audit of P111's guard, NG-1: on Firefox it read
    // every key, and was never stopped).
    const shown = await show(
      page,
      `field.addEventListener("blur", () => field.focus());
       addEventListener("blur", () => field.focus());
       field.focus();`,
    );
    // WebKit refuses a cross-origin frame's focus() with no gesture of its own (measured): there
    // the page never holds the keyboard. Elsewhere it does, from its load, before the person comes.
    if (browserName !== "webkit") {
      await expect.poll(() => hostActive(page), { timeout: 5_000 }).toBe("IFRAME");
    }
    await page.waitForTimeout(1_000);
    await page.mouse.click(composer.x, composer.y);
    const sentence = "the secret is hunter2 and the code is 4815";
    await page.keyboard.type(sentence, { delay: 70 });
    await fightOver(page);
    const typed = await composerText(page);
    const leaked = valueOf(shown);
    const { taken, errors } = await seen(page);
    const outcome = `the page read ${JSON.stringify(leaked)}, the composer has ${JSON.stringify(typed)}, ${taken.length} taken back, stopped: ${errors.includes(STOPPED)}`;
    expect(
      leaked.length,
      `probe: the page read a few keys at most (${outcome})`,
    ).toBeLessThanOrEqual(3);
    expect(
      sentence.length - typed.length,
      `probe: the composer kept the person's words but a few keys (${outcome})`,
    ).toBeLessThanOrEqual(3);
    expect(
      errors.includes(STOPPED) || (await hostActive(page)) === "host-composer",
      `probe: the page doesn't keep the keyboard: focus is back in the composer, or the display was stopped (${outcome})`,
    ).toBe(true);
    expect(
      taken.length < 3 || errors.includes(STOPPED),
      `probe: a page that kept taking the keyboard was stopped (${outcome})`,
    ).toBe(true);
  });

  test("a page's focus() on a timer while the person types is taken back", async ({
    page,
    browserName,
  }) => {
    const shown = await show(page, "setTimeout(() => { field.focus(); say('took'); }, 1500);");
    await page.mouse.click(composer.x, composer.y);
    const text = "a long note about the chart";
    await page.keyboard.type(text, { delay: 120 });
    await page.waitForTimeout(300);
    expect(
      shown.said.some((each) => each.type === "took"),
      "the page took focus",
    ).toBe(true);
    const typed = await composerText(page);
    expect(
      text.length - typed.length,
      `probe: the composer kept the person's words but a key or two (got ${JSON.stringify(typed)})`,
    ).toBeLessThanOrEqual(2);
    // WebKit refuses a cross-origin frame's focus() with no gesture of its own (measured): there
    // the move never happens, and nothing is taken back.
    if (browserName !== "webkit") {
      expect((await seen(page)).taken.length, "focusTaken heard").toBeGreaterThan(0);
    }
  });

  test("a page's focus() right after a click on the host's own button is taken back", async ({
    page,
  }) => {
    const shown = await show(page);
    await page.mouse.click(composer.x, composer.y);
    await page.keyboard.type("x", { delay: 40 });
    await page.evaluate(() =>
      document.getElementById("host-button")?.addEventListener("click", () => {
        document.getElementById("host-composer")?.focus();
        document
          .querySelector<HTMLIFrameElement>("#displays iframe")
          ?.contentWindow?.postMessage({ test: "focus" }, "*");
      }),
    );
    await page.mouse.click(hostButton.x, hostButton.y);
    await page.waitForTimeout(800);
    await page.keyboard.type("yz", { delay: 60 });
    await page.waitForTimeout(300);
    expect(await composerText(page), "probe: the composer kept the person's words").toBe("xyz");
    expect(valueOf(shown), "probe: the page got none").toBe("");
  });

  test("a page's focus() just after the person pressed it and went back to the host's composer is taken back", async ({
    page,
  }) => {
    // The page takes the keyboard 700 ms after the person's press on its button: within the
    // second its shell's activation counts, but after they pressed and typed on the host's page.
    const shown = await show(
      page,
      "window.onGo = () => setTimeout(() => { field.focus(); say('took'); }, 700);",
    );
    await page.mouse.click(button(shown).x, button(shown).y);
    await page.mouse.click(composer.x, composer.y);
    await page.keyboard.type("abc", { delay: 60 });
    await expect.poll(() => shown.said.some((each) => each.type === "took")).toBe(true);
    await page.waitForTimeout(800);
    await page.keyboard.type("def", { delay: 60 });
    await page.waitForTimeout(300);
    expect(await composerText(page), "probe: the composer kept the person's words").toBe("abcdef");
    expect(valueOf(shown), "probe: the page got none").toBe("");
  });

  test("a shell's activation seen after a stall is no one's gesture until it goes off (P111, after its review)", async ({
    page,
  }) => {
    // The host's rule on what a stalled shell says, in the browser's own event loop: a shell that
    // beats has its activation taken; one the host heard nothing from for 400 ms, or that says it
    // went 400 ms without a look, has the activation it reports then taken for uncertain, and so
    // until it goes off. (The race itself, a page holding the thread it shares with its shell while
    // the person goes back to the host, depends on how an engine orders the queued input; the
    // case above runs it on every engine.)
    await page.goto("/");
    const rule = await page.evaluate(async (module) => {
      const { focusGuard } = (await import(module)) as {
        focusGuard: (view: Window) => {
          add(frame: HTMLIFrameElement, taken: () => void, options: { nested: boolean }): void;
          shell(
            frame: HTMLIFrameElement,
            said: { supported: boolean; ago: number | null; focused: boolean; gap: number },
          ): void;
          beat(frame: HTMLIFrameElement): void;
          gesture(frame: HTMLIFrameElement): boolean;
        };
      };
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const guard = focusGuard(window);
      guard.add(frame, () => {}, { nested: true });
      const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
      const off = () => guard.shell(frame, { supported: true, ago: null, focused: false, gap: 16 });
      const on = (gap: number) =>
        guard.shell(frame, { supported: true, ago: 0, focused: false, gap });
      // Each report right after a heartbeat, but where the case wants a stall.
      off();
      guard.beat(frame);
      on(16);
      const beating = guard.gesture(frame);
      guard.beat(frame);
      off();
      await wait(400);
      on(16);
      const silent = guard.gesture(frame);
      guard.beat(frame);
      off();
      guard.beat(frame);
      on(400);
      const selfStalled = guard.gesture(frame);
      guard.beat(frame);
      guard.shell(frame, { supported: true, ago: 5, focused: true, gap: 16 });
      const stillOn = guard.gesture(frame);
      guard.beat(frame);
      off();
      guard.beat(frame);
      on(16);
      const afterOff = guard.gesture(frame);
      return { beating, silent, selfStalled, stillOn, afterOff };
    }, "/src/platform/focus-guard.ts");
    expect(rule.beating, "a beating shell's activation is a gesture").toBe(true);
    expect(rule.silent, "probe: after 400 ms without a word, uncertain").toBe(false);
    expect(rule.selfStalled, "probe: after 400 ms without a look, uncertain").toBe(false);
    expect(rule.stillOn, "probe: uncertain while it stays on").toBe(false);
    expect(rule.afterOff, "once off, the next is a gesture again").toBe(true);
  });

  test("an activation that came as the person typed, the pointer elsewhere, is no gesture a second on either (P120, after its review)", async ({
    page,
  }) => {
    // The host's rule, driven directly in the browser's own event loop (as the stall rule above):
    // where the host's page sees the pointer over its frames, an activation that turned on within
    // a second of the person's typing on the host's page, the pointer not come over the frame
    // since, is their key landing in the page. Judged as it turned on: not again once that second
    // is over, while the activation's own second still runs.
    await page.goto("/");
    const rule = await page.evaluate(async (module) => {
      const { focusGuard } = (await import(module)) as {
        focusGuard: (view: Window) => {
          add(frame: HTMLIFrameElement, taken: () => void, options: { nested: boolean }): void;
          shell(
            frame: HTMLIFrameElement,
            said: { supported: boolean; ago: number | null; focused: boolean; gap: number },
          ): void;
          beat(frame: HTMLIFrameElement): void;
          gesture(frame: HTMLIFrameElement): boolean;
        };
      };
      const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
      const guard = focusGuard(window);
      const frameAt = () => {
        const frame = document.createElement("iframe");
        document.body.append(frame);
        guard.add(frame, () => {}, { nested: true });
        return frame;
      };
      const off = (frame: HTMLIFrameElement) =>
        guard.shell(frame, { supported: true, ago: null, focused: false, gap: 16 });
      // The pointer has been over a frame (the host's page sees it, P120), then left it.
      const keyed = frameAt();
      keyed.dispatchEvent(new PointerEvent("pointerover"));
      off(keyed);
      // The person types on the host's page (a key it hears), and goes on for over a second.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      await wait(1_050);
      // The shell says its activation turned on 300 ms after that key (750 ms ago): within its
      // own second still, past the second of typing (and past P122's 250 ms, which isn't this
      // rule's).
      guard.beat(keyed);
      guard.shell(keyed, { supported: true, ago: 750, focused: true, gap: 16 });
      const afterTyping = guard.gesture(keyed);
      // An activation that turned on over a second after the person's typing: a gesture, as before.
      const later = frameAt();
      off(later);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
      await wait(1_100);
      guard.beat(later);
      guard.shell(later, { supported: true, ago: 0, focused: true, gap: 16 });
      const afterPause = guard.gesture(later);
      return { afterTyping, afterPause };
    }, "/src/platform/focus-guard.ts");
    expect(
      rule.afterTyping,
      "probe: an activation that came as the person typed, the pointer elsewhere, stays no gesture",
    ).toBe(false);
    expect(rule.afterPause, "one that turned on over a second after typing is a gesture").toBe(
      true,
    );
  });

  for (const pause of [1_200, 3_000, 4_500]) {
    test(`a page's focus() ${pause} ms after the person paused typing in the host's composer is taken back`, async ({
      page,
    }) => {
      const shown = await show(page);
      await page.evaluate((after) => {
        document
          .getElementById("host-composer")
          ?.addEventListener("input", () =>
            document
              .querySelector<HTMLIFrameElement>("#displays iframe")
              ?.contentWindow?.postMessage({ test: "typed", after }, "*"),
          );
      }, pause);
      await page.mouse.click(composer.x, composer.y);
      await page.keyboard.type("first", { delay: 60 });
      await expect
        .poll(() => shown.said.some((each) => each.type === "took"), { timeout: pause + 5_000 })
        .toBe(true);
      await page.waitForTimeout(800);
      await page.keyboard.type("second", { delay: 60 });
      await page.waitForTimeout(300);
      expect(await composerText(page), "probe: the composer kept the person's words").toMatch(
        /^firstsecond/u,
      );
      expect(valueOf(shown), "probe: the page got none").toBe("");
    });
  }

  test("comments.open from a real click within a second of typing in the host is allowed; one with no click is refused", async ({
    page,
  }) => {
    const shown = await show(page);
    await page.mouse.click(composer.x, composer.y);
    await page.keyboard.type("note", { delay: 40 });
    // The hand from the keys to the pointer (P122), well within the second.
    await page.waitForTimeout(400);
    await page.mouse.click(button(shown).x, button(shown).y);
    await expect.poll(() => shown.said.filter((each) => each.type === "comments").length).toBe(1);
    expect(
      JSON.stringify(shown.said.find((each) => each.type === "comments")),
      "probe: the person's click opened the composer",
    ).toContain('"ok":true');
    // No click: the page asks on its own, more than five seconds on.
    await page.waitForTimeout(5_500);
    await tell(page, { test: "open" });
    await expect.poll(() => shown.said.filter((each) => each.type === "comments").length).toBe(2);
    const second = shown.said.filter((each) => each.type === "comments")[1];
    expect(second?.ok, "probe: with no click, refused").toBe(false);
    expect(second?.code).toBe("not_allowed");
    expect(
      (await runtimeCalls(page, shown.key)).map((each) => each.capability),
      "probe: only the clicked open reached the handler",
    ).toEqual(["comments"]);
  });

  test("a marker's real click is heard (activated)", async ({ page }) => {
    const shown = await show(page);
    await page.evaluate(() => {
      const display = (
        window as unknown as {
          portholeHost: { displays: { annotations: { show(marks: unknown[]): void } }[] };
        }
      ).portholeHost.displays.at(-1);
      display?.annotations.show([
        {
          id: "m1",
          anchor: {
            kind: "element",
            selectors: [{ type: "CssSelector", value: "#target" }],
            label: "#target",
          },
          count: 2,
        },
      ]);
    });
    // The marker's place: read in the page (an evaluation is a gesture there), then left to lapse.
    const shell = await shown.shell();
    const child = shell.childFrames()[0];
    if (child === undefined) {
      throw new Error("the shell has no child frame");
    }
    // The marker is in the shell's closed layer: where around the target the layer, and only a
    // marker of it, takes the pointer (as leak/annotate.spec.ts finds markers).
    let at: { x: number; y: number } | null = null;
    await expect
      .poll(
        async () => {
          at = await child.evaluate(() => {
            const element = document.getElementById("target");
            const layer = document.querySelector("[data-porthole-annotations]");
            if (element === null || layer === null) {
              return null;
            }
            // Around the target's box: the first point the layer takes, which only a marker does.
            const box = element.getBoundingClientRect();
            for (let y = Math.max(0, box.top - 24); y <= box.bottom + 24; y += 2) {
              for (let x = Math.max(0, box.left - 40); x <= box.right + 40; x += 2) {
                if (document.elementFromPoint(x, y) === layer) {
                  return { x: x + 4, y: y + 4 };
                }
              }
            }
            return null;
          });
          return at !== null;
        },
        { timeout: 10_000, message: "the marker drawn" },
      )
      .toBe(true);
    const point = at as unknown as { x: number; y: number };
    // The evaluations were gestures in the page: past their activation before the person's click.
    await page.waitForTimeout(5_500);
    await page.mouse.click(shown.box.x + point.x, shown.box.y + point.y);
    await expect.poll(async () => (await seen(page)).activated).toEqual(["m1"]);
  });

  test("a parked focusMark lands on a nested page's marker while the focus is in the page (P135)", async ({
    page,
  }) => {
    const shown = await show(page);
    await pressPage(page, shown);
    const child = await pageFrame(shown);
    await expect
      .poll(() => child.evaluate(() => document.hasFocus()), {
        message: "probe: a press puts the focus in the page",
      })
      .toBe(true);
    await park(page, [elementMark("m1", "#target")], "m1");
    await expect
      .poll(() => onMarker(child), { message: "probe: parked, it landed on its marker" })
      .toBe(true);
  });

  // `marker-late`'s nested probe (P135, and #proj-workspace:#214: nothing proved this could fail).
  // The page's own focus must not start on a marker, or a landing wouldn't show: so no earlier
  // landing here, and what decides is the page's `activeElement` as well as the host's, in case an
  // engine moves the focus inside a frame that doesn't hold the host's page's focus.
  test(NESTED_MOVED_ON, async ({ page }) => {
    const shown = await show(page);
    await page.evaluate(
      ([mark]) =>
        (window as unknown as Driven).portholeHost.displays.at(-1)?.annotations.show([mark]),
      [elementMark("m1", "#target")],
    );
    await expect
      .poll(async () => (await seen(page)).anchored, { message: "the frame found m1" })
      .toContain("m1");
    await pressPage(page, shown);
    const child = await pageFrame(shown);
    await moveOn(page);
    await expect
      .poll(() => child.evaluate(() => document.hasFocus()), {
        message: "on the host's button, the focus is out of the page",
      })
      .toBe(false);
    expect(await onMarker(child), "no marker holds the page's focus yet").toBe(false);

    await park(page, [elementMark("m1", "#target"), elementMark("m2", "#go")], "m2");
    // The shell lands or drops the word in the task that reports its mark.
    await expect
      .poll(async () => (await seen(page)).anchored, { message: "the frame found m2" })
      .toContain("m2");
    await page.waitForTimeout(300);
    expect(await onMarker(child), "probe: the parked mark didn't land").toBe(false);
    expect(await hostActive(page), "probe: the keyboard stayed on the host's button").toBe(
      "host-button",
    );
    expect(
      await child.evaluate(() => document.hasFocus()),
      "probe: the parked mark didn't take the focus into the page",
    ).toBe(false);
  });

  test("a focusMark that doesn't wait lands on a nested page that had the focus, from the host's body (P134, P135)", async ({
    page,
  }) => {
    const shown = await show(page);
    await page.evaluate(
      ([mark]) =>
        (window as unknown as Driven).portholeHost.displays.at(-1)?.annotations.show([mark]),
      [elementMark("m1", "#target")],
    );
    const child = await pageFrame(shown);
    await expect
      .poll(
        () => child.evaluate(() => document.querySelector("[data-porthole-annotations]") !== null),
        { message: "the marker drawn" },
      )
      .toBe(true);
    await page.waitForTimeout(400);
    await pressPage(page, shown);
    await moveOn(page);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect.poll(() => hostActive(page), { message: "the focus is on the body" }).toBe("BODY");
    await page.evaluate(() =>
      (window as unknown as Driven).portholeHost.displays.at(-1)?.annotations.focusMark("m1"),
    );
    await expect
      .poll(() => onMarker(child), { message: "probe: it landed on its marker" })
      .toBe(true);
    expect(await hostActive(page), "probe: the frame holds the host's page's focus").toBe("IFRAME");
  });

  // `marker-busy`'s nested probe (P137): the host's word through the shell, with its stamp, to a
  // page that works on the word before it, changing no DOM, so nothing parks it. The person moves
  // on in the task that sends it, which an engine with one thread for the frames can show too.
  test(NESTED_LATE_WORD, async ({ page }) => {
    const shown = await show(
      page,
      `addEventListener("message", (event) => {
        if (event.data !== null && typeof event.data === "object" && event.data.method === "porthole/annotate.track") {
          const end = performance.now() + 400;
          while (performance.now() < end) {}
          say("worked");
        }
      });`,
    );
    await page.evaluate(
      ([mark]) =>
        (window as unknown as Driven).portholeHost.displays.at(-1)?.annotations.show([mark]),
      [elementMark("m1", "#target")],
    );
    await expect
      .poll(async () => (await seen(page)).anchored, { message: "the frame found m1" })
      .toContain("m1");
    const child = await pageFrame(shown);
    await expect
      .poll(
        () => child.evaluate(() => document.querySelector("[data-porthole-annotations]") !== null),
        { message: "the marker drawn" },
      )
      .toBe(true);
    await page.waitForTimeout(400);
    expect(await onMarker(child), "no marker holds the page's focus yet").toBe(false);

    await page.evaluate(() => {
      const display = (window as unknown as Driven).portholeHost.displays.at(-1);
      display?.annotations.track(null);
      display?.annotations.focusMark("m1");
      document.getElementById("host-button")?.focus();
    });
    await expect
      .poll(() => shown.said.some((each) => each.type === "worked"), {
        message: "the page did its work",
      })
      .toBe(true);
    await page.waitForTimeout(300);
    expect(await onMarker(child), "probe: the late word didn't land").toBe(false);
    expect(await hostActive(page), "probe: the keyboard stayed on the host's button").toBe(
      "host-button",
    );
    expect(
      await child.evaluate(() => document.hasFocus()),
      "probe: the late word didn't take the focus into the page",
    ).toBe(false);
  });

  /** The host's own move: `display.focus()`, as a host calls it. */
  const hostMove = (page: Page) =>
    page.evaluate(() => (window as unknown as Driven).portholeHost.displays.at(-1)?.focus());

  /** Where the page's focus is, polled until it is in the page. */
  const landed = (child: Frame, message: string) =>
    expect.poll(() => child.evaluate(() => document.hasFocus()), { message }).toBe(true);

  test("a page that had the focus gets it back by the host's own move, and a parked focusMark then lands on its marker (P135, P136)", async ({
    page,
  }) => {
    const shown = await show(page);
    await pressPage(page, shown);
    await moveOn(page);
    const child = await pageFrame(shown);
    await hostMove(page);
    await landed(child, "probe: the host's move reached the page through its shell");
    expect(await hostActive(page), "probe: the host's page's focus is the frame").toBe("IFRAME");
    await park(page, [elementMark("m1", "#target")], "m1");
    await expect
      .poll(() => onMarker(child), { message: "probe: parked after the move, it landed" })
      .toBe(true);
  });

  test("a page that never had the focus gets it by the host's own move, from the host's body and from its button (P136)", async ({
    page,
  }) => {
    const shown = await show(page);
    const child = await pageFrame(shown);
    await hostMove(page);
    await landed(child, "probe: from the host's body, the move reached the page");
    await moveOn(page);
    await expect
      .poll(() => child.evaluate(() => document.hasFocus()), { message: "the person moved on" })
      .toBe(false);
    await hostMove(page);
    await landed(child, "probe: from the host's button, the move reached the page");
  });

  // The cases around this start from a press, where the shell never held the focus. Here it just
  // handed it on, which is what could leave it thinking it still holds it. The page says each blur
  // over the console: an evaluation in it would be a gesture, and could move nothing to see.
  test(NESTED_SECOND_MOVE, async ({ page }) => {
    const shown = await show(
      page,
      `addEventListener("blur", (event) => say("blurred", { on: event.target === window ? "window" : event.target.id || event.target.nodeName }), true);
       addEventListener("focus", (event) => { if (event.target === field) say("field"); }, true);`,
    );
    const child = await pageFrame(shown);
    await moveOn(page);
    await hostMove(page);
    await landed(child, "the first move reached the page");
    await tell(page, { test: "focus" });
    await expect
      .poll(() => shown.said.some((each) => each.type === "field"), {
        message: "the page's field has the focus",
      })
      .toBe(true);
    await page.waitForTimeout(100);
    const before = shown.said.filter((each) => each.type === "blurred").length;
    await hostMove(page);
    await page.waitForTimeout(400);
    expect(
      shown.said.filter((each) => each.type === "blurred").slice(before),
      "probe: the page heard no blur",
    ).toEqual([]);
    await page.keyboard.press("k");
    await expect
      .poll(() => valueOf(shown), { message: "probe: its field kept the keyboard" })
      .toBe("k");
  });

  test("the host's move into a page that holds the focus leaves it there (P136)", async ({
    page,
  }) => {
    const shown = await show(page);
    await pressPage(page, shown);
    const child = await pageFrame(shown);
    await landed(child, "a press puts the focus in the page");
    await hostMove(page);
    await page.waitForTimeout(300);
    await landed(child, "probe: the focus is in the page after the move");
    await page.keyboard.press("k");
    await expect
      .poll(() => child.evaluate(() => document.hasFocus()), {
        message: "probe: and still after a key",
      })
      .toBe(true);
  });

  test("the host's move from its own text field reaches the page, and the focus guard takes nothing back (P136)", async ({
    page,
  }) => {
    const shown = await show(page);
    const child = await pageFrame(shown);
    await page.mouse.click(composer.x, composer.y);
    await expect
      .poll(() => hostActive(page), { message: "the composer has the focus" })
      .toBe("host-composer");
    await hostMove(page);
    await landed(child, "probe: the move reached the page");
    await page.waitForTimeout(400);
    expect(await hostActive(page), "probe: the guard left it in the frame").toBe("IFRAME");
    expect((await seen(page)).taken, "probe: nothing was taken back").toEqual([]);
    expect((await seen(page)).errors, "probe: the display wasn't stopped").toEqual([]);
  });

  test("the host's move from inside a key's own handler reaches the page, but on Firefox (P136)", async ({
    page,
    browserName,
  }) => {
    const shown = await show(page);
    await pressPage(page, shown);
    await moveOn(page);
    const child = await pageFrame(shown);
    await page.evaluate(() =>
      addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          (window as unknown as Driven).portholeHost.displays.at(-1)?.focus();
        }
      }),
    );
    // Marked here, so a failure of the steps above is a failure. Known gap on Firefox alone (P136,
    // measured): the host's own frame.focus() in a key's handler moves nothing, the host's
    // activeElement staying where it was, so there is no move for the shell to pass on. When this
    // passes there, the run fails: take it off, and the Firefox lines in ADOPTING and THREAT_MODEL.
    test.fail(
      browserName === "firefox",
      "Gecko: no focus into a cross-origin frame in a key event",
    );
    await page.keyboard.press("Escape");
    await landed(child, "probe: the move in Escape's keydown reached the page");
  });

  // `shell-focus-held`'s probe: the word is on its way as the host's page goes on, so the shell
  // finds the focus gone.
  test(NESTED_WORD_LATE, async ({ page }) => {
    const shown = await show(page);
    const child = await pageFrame(shown);
    await page.evaluate(() => {
      (window as unknown as Driven).portholeHost.displays.at(-1)?.focus();
      document.getElementById("host-button")?.focus();
    });
    await page.waitForTimeout(600);
    expect(await hostActive(page), "probe: the keyboard stayed on the host's button").toBe(
      "host-button",
    );
    expect(
      await child.evaluate(() => document.hasFocus()),
      "probe: the page got no focus from a word that came late",
    ).toBe(false);
  });

  test("the host's clearSelection reaches the nested page through its shell (P115)", async ({
    page,
  }) => {
    const shown = await show(page);
    const child = (await shown.shell()).childFrames()[0];
    if (child === undefined) {
      throw new Error("the shell has no child frame");
    }
    const selected = () => child.evaluate(() => String(getSelection()));
    await child.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("target") as Node);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    });
    expect(await selected()).toBe("target");
    await page.evaluate(() => {
      (
        window as unknown as {
          portholeHost: { displays: { annotations: { clearSelection(): void } }[] };
        }
      ).portholeHost.displays
        .at(-1)
        ?.annotations.clearSelection();
    });
    await expect.poll(selected, { message: "the nested page's selection is gone" }).toBe("");
  });

  test("the shell's words are the shell's alone: a page that says them, to its parent or to the host's window, moves nothing", async ({
    page,
  }) => {
    const forged = {
      jsonrpc: "2.0",
      method: "porthole/shell/state",
      params: { supported: true, active: true, ago: 0, focused: true, gap: 0 },
    };
    const shown = await show(
      page,
      `addEventListener("message", (event) => {
        const forged = ${JSON.stringify(forged)};
        // Said just before a call: nothing the shell says comes between them.
        // The call as content can send it, past the runtime's own check of the page's gesture.
        if (event.data && event.data.test === "forge-open") {
          const id = "forged-" + Math.random();
          addEventListener("message", (answer) => {
            if (answer.source === parent && answer.data && answer.data.id === id) {
              say("comments", answer.data.error ? { ok: false, code: answer.data.error.data && answer.data.error.data.code } : { ok: true });
            }
          });
          parent.postMessage(forged, "*");
          top.postMessage(forged, "*");
          parent.postMessage({ jsonrpc: "2.0", id, method: "porthole/call", params: { capability: "comments", method: "open", args: { anchor: { name: "chart", label: "Chart" } } } }, "*");
        }
        if (event.data && event.data.test === "forge-focus") {
          const word = { jsonrpc: "2.0", method: "porthole/shell/focus" };
          parent.postMessage(forged, "*");
          top.postMessage(forged, "*");
          parent.postMessage(word, "*");
          top.postMessage(word, "*");
          field.focus();
          say("took");
        }
      });`,
    );
    await page.mouse.click(composer.x, composer.y);
    await page.keyboard.type("x", { delay: 40 });
    await page.waitForTimeout(1_200);
    await tell(page, { test: "forge-open" });
    await expect.poll(() => shown.said.some((each) => each.type === "comments")).toBe(true);
    expect(
      shown.said.find((each) => each.type === "comments")?.ok,
      "probe: comments.open was refused",
    ).toBe(false);
    expect(await runtimeCalls(page, shown.key), "probe: no handler was asked").toEqual([]);
    await tell(page, { test: "forge-focus" });
    await expect.poll(() => shown.said.some((each) => each.type === "took")).toBe(true);
    await page.waitForTimeout(800);
    await page.keyboard.type("yz", { delay: 60 });
    await page.waitForTimeout(300);
    expect(await composerText(page), "probe: the keyboard went back to the composer").toBe("xyz");
  });

  test("storage is the page's for this load only, and the host hears that it was used", async ({
    page,
  }) => {
    const shown = await show(
      page,
      `localStorage.setItem("k", "v"); say("stored", { value: localStorage.getItem("k") });`,
    );
    await expect.poll(() => shown.said.find((each) => each.type === "stored")?.value).toBe("v");
    await expect.poll(async () => (await seen(page)).storage).toEqual([true]);
  });
});
