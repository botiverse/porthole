import { expect, test } from "@playwright/test";
import { runtimeCalls } from "./porthole-host.ts";
import { storedFiles } from "./files.ts";
import { harness } from "./harness.ts";
import {
  STOPPED,
  button,
  composer,
  composerText,
  field,
  hostActive,
  hostButton,
  seen,
  show,
  tell,
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

test.describe("a nested page (P111)", () => {
  test.setTimeout(90_000);

  test("is the shell's child, an opaque origin, sandboxed to scripts alone, at its sealed address", async ({
    page,
  }) => {
    const shown = await show(page);
    const ready = shown.said.find((each) => each.type === "ready") ?? {};
    expect(ready.origin, "probe: the page's origin is opaque").toBe("null");
    expect(String(ready.href), "probe: the page is at its sealed files' address").toContain(
      `${shown.origin}/__porthole/f/`,
    );
    const shell = await shown.shell();
    expect(
      new URL(shell.url()).origin,
      "the display's frame is the shell, on the content origin",
    ).toBe(shown.origin);
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
          parent.postMessage(forged, "*");
          top.postMessage(forged, "*");
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
