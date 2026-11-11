import { expect, test, type Page } from "@playwright/test";
import {
  PRESS_FORGED_PORT,
  PRESS_KEY_ORDER,
  PRESS_MADE_UP,
  PRESS_OPEN_LOCKED,
  PRESS_PORT_UNHEARD,
  PRESS_REPEAT,
  PRESS_ROLE,
  PRESS_SAME_DOCUMENT,
  PRESS_SCROLL,
  PRESS_SECOND,
  PRESS_STALL,
  PRESS_SUBMIT,
  PRESS_WENT_BACK,
} from "../controls.ts";
import { runtimeCalls } from "./porthole-host.ts";
import {
  button,
  composer,
  composerText,
  field,
  hostActive,
  hostButton,
  seen,
  show,
  tell,
  type Shown,
  valueOf,
} from "./nested-pages.ts";

/**
 * A nested page's real presses, told to its shell by its runtime over a port no content holds
 * (P148). Every gesture is a real one (`page.mouse`, `page.keyboard`, a touch through the
 * browser's own input), and nothing is evaluated in the page's or the shell's frame (an evaluation
 * there is a gesture to the engine): the page says what happens over the console, and the host's
 * page hears how many presses the shell says it has heard (`seen().presses`). Untraced, as
 * nested.spec.ts.
 */
test.use({ trace: "off" });

const presses = async (page: Page) => (await seen(page)).presses;
const comments = (shown: Shown) => shown.said.filter((each) => each.type === "comments");
/** Until the shell has spoken at least once, so a count of none is its word and not its silence. */
const spoken = (page: Page) =>
  expect.poll(() => presses(page), { message: "the shell said its state" }).toBeGreaterThan(-1);
/** A while in which a press told would have reached the host's page. */
const settle = (page: Page) => page.waitForTimeout(400);

/** A place in the page, by its own coordinates. */
const at = (shown: Shown, x: number, y: number) => ({ x: shown.box.x + x, y: shown.box.y + y });

test.describe("a nested page's real presses (P148)", () => {
  test.setTimeout(90_000);

  test(PRESS_SECOND, async ({ page }) => {
    const shown = await show(page);
    await spoken(page);
    await page.mouse.click(button(shown).x, button(shown).y);
    await expect.poll(() => comments(shown).length).toBe(1);
    expect(comments(shown)[0]?.ok, "the first press opened the composer").toBe(true);
    // The person answers on the host's page (a dialog's Cancel, say), and presses the page's button
    // again a second later: the shell's activation is still on, so it turns nothing on.
    await page.mouse.click(hostButton.x, hostButton.y);
    await expect.poll(() => hostActive(page)).toBe("host-button");
    await page.waitForTimeout(1_000);
    await page.mouse.click(button(shown).x, button(shown).y);
    await expect.poll(() => comments(shown).length).toBe(2);
    expect(comments(shown)[1]?.ok, "probe: the second press opened the composer too").toBe(true);
    // And once more, as soon after as a person presses twice.
    await page.mouse.click(hostButton.x, hostButton.y);
    await page.waitForTimeout(300);
    await page.mouse.click(button(shown).x, button(shown).y);
    await expect.poll(() => comments(shown).length).toBe(3);
    expect(comments(shown)[2]?.ok, "probe: and the third").toBe(true);
    expect(
      (await runtimeCalls(page, shown.key)).map((each) => each.capability),
      "probe: each reached the handler",
    ).toEqual(["comments", "comments", "comments"]);
    expect(await presses(page), "the shell heard each press").toBeGreaterThanOrEqual(3);
  });

  test(PRESS_WENT_BACK, async ({ page }) => {
    // The page takes the keyboard 700 ms after the person's second press on its button, within
    // the second a press told to the shell counts, but after they pressed and typed on the host's
    // page. The shell's activation, on since the first press, turned nothing on for the second:
    // only the press told speaks for it.
    const shown = await show(
      page,
      "let times = 0; window.onGo = () => { times += 1; if (times === 2) setTimeout(() => { field.focus(); say('took'); }, 700); };",
    );
    await spoken(page);
    await page.mouse.click(button(shown).x, button(shown).y);
    await page.waitForTimeout(1_500);
    await page.mouse.click(button(shown).x, button(shown).y);
    // The hand from the page to the composer: a test's own input comes within a few milliseconds
    // of the press, before the host's page has heard the shell tell it, and a press told within
    // 250 ms of a key on the host's page is that key's (P122), whatever the rule under test says.
    await page.waitForTimeout(150);
    await page.mouse.click(composer.x, composer.y);
    await page.keyboard.type("abc", { delay: 60 });
    await expect.poll(() => shown.said.some((each) => each.type === "took")).toBe(true);
    await page.waitForTimeout(800);
    await page.keyboard.type("def", { delay: 60 });
    await page.waitForTimeout(300);
    expect(await composerText(page), "probe: the composer kept the person's words").toBe("abcdef");
    expect(valueOf(shown), "probe: the page got none").toBe("");
  });

  test(PRESS_STALL, async ({ page }) => {
    // The host's rule on a press a stalled shell tells, in the browser's own event loop (as the
    // activation's, nested.spec.ts): the shell notes a press when it hears it, and a page that
    // holds the thread it shares with its shell makes that late. The shell's activation is on
    // throughout, since long ago: only a press told can be a gesture here.
    await page.goto("/");
    const rule = await page.evaluate(async (module) => {
      const { focusGuard } = (await import(module)) as {
        focusGuard: (view: Window) => {
          add(frame: HTMLIFrameElement, taken: () => void, options: { nested: boolean }): void;
          shell(
            frame: HTMLIFrameElement,
            said: {
              supported: boolean;
              ago: number | null;
              focused: boolean;
              gap: number;
              pressed: number | null;
              presses: number;
            },
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
      const heard = (count: number, gap: number) =>
        guard.shell(frame, {
          supported: true,
          ago: 3_000,
          focused: false,
          gap,
          pressed: count === 0 ? null : 0,
          presses: count,
        });
      // The shell beating, as it does every 50 ms, for a while: no stall, and none just before.
      const beating = async (ms: number) => {
        const until = performance.now() + ms;
        while (performance.now() < until) {
          guard.beat(frame);
          await wait(20);
        }
        guard.beat(frame);
      };
      heard(0, 16);
      const none = guard.gesture(frame);
      await beating(600);
      heard(1, 16);
      const told = guard.gesture(frame);
      // Told as the first word after 400 ms of silence.
      await wait(400);
      heard(2, 16);
      const silent = guard.gesture(frame);
      // Told by a shell that says it went 400 ms without a look.
      await beating(600);
      heard(3, 400);
      const selfStalled = guard.gesture(frame);
      // Told just after the stall was: the shell's own look ran first when the page let go, and
      // said it; the press that waited behind the page follows, looking new.
      await beating(600);
      await wait(400);
      guard.beat(frame);
      heard(4, 16);
      const afterStall = guard.gesture(frame);
      guard.beat(frame);
      heard(4, 16);
      const same = guard.gesture(frame);
      await beating(600);
      heard(5, 16);
      const next = guard.gesture(frame);
      return { none, told, silent, selfStalled, afterStall, same, next };
    }, "/src/platform/focus-guard.ts");
    expect(rule.none, "an activation on for 3 s is no gesture, with no press told").toBe(false);
    expect(rule.told, "a beating shell's press is a gesture").toBe(true);
    expect(rule.silent, "probe: told after 400 ms without a word, no one's").toBe(false);
    expect(rule.selfStalled, "probe: told after 400 ms without a look, no one's").toBe(false);
    expect(rule.afterStall, "probe: told just after a stall the shell said first, no one's").toBe(
      false,
    );
    expect(rule.same, "the same press told again is no new one").toBe(false);
    expect(rule.next, "the next press, the shell beating since, is a gesture again").toBe(true);
  });

  test(PRESS_KEY_ORDER, async ({ page, browserName }) => {
    // On Firefox a page's focus() with no gesture of the person's in it leaves the focus on its
    // body (measured): no key can land on its button without a press there first, which earns the
    // frame the keyboard and decides the call before any press is told.
    test.skip(browserName === "firefox", "a page's own focus() puts no key on its button there");
    // The page puts the focus on its own button (from the host's button, no text field: nothing is
    // taken back), and the person's Enter lands on it within 5 s of their press on the host's
    // page. The call is made in the click the key gives the button, in the same task as the key:
    // it reaches the host only after the state that says the key was pressed.
    const shown = await show(
      page,
      `addEventListener("message", (event) => {
        if (event.data && event.data.test === "take") { document.getElementById("go").focus(); say("took"); }
      });`,
    );
    await spoken(page);
    await page.mouse.click(hostButton.x, hostButton.y);
    await tell(page, { test: "take" });
    await expect.poll(() => shown.said.some((each) => each.type === "took")).toBe(true);
    await expect.poll(() => hostActive(page)).toBe("IFRAME");
    await page.waitForTimeout(1_200);
    const before = await presses(page);
    await page.keyboard.press("Enter");
    await expect.poll(() => comments(shown).length).toBe(1);
    expect(comments(shown)[0]?.ok, "probe: the key's own call opened the composer").toBe(true);
    expect(await presses(page), "the shell heard the key").toBeGreaterThan(before);
  });

  test(PRESS_MADE_UP, async ({ page }) => {
    // Every event a page can make up, at its own button and at its window: none is the browser's.
    const shown = await show(
      page,
      `window.onGo = () => {};
      addEventListener("message", (event) => {
        if (!event.data || event.data.test !== "make-up") return;
        const go = document.getElementById("go");
        for (const target of [go, window]) {
          target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", isPrimary: true }));
          target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", isPrimary: true }));
          target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
          target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " }));
          target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }
        go.click();
        say("made-up");
      });`,
    );
    await spoken(page);
    // The person typed on the host's page a while ago: its activation is on, the page's to borrow.
    await page.mouse.click(composer.x, composer.y);
    await page.keyboard.type("x", { delay: 40 });
    await page.waitForTimeout(1_200);
    await tell(page, { test: "make-up" });
    await expect.poll(() => shown.said.some((each) => each.type === "made-up")).toBe(true);
    await settle(page);
    expect(await presses(page), "probe: the shell heard no press").toBe(0);
  });

  test(PRESS_ROLE, async ({ page }) => {
    // Typing is no press, whatever the content calls the field it is typed in: a text field, one
    // that says it is a button, one inside a custom element that says it is a button, a button
    // the page made editable. A press on each (the pointer's) is one; no key typed there is.
    const shown = await show(
      page,
      `document.getElementById("target").remove();
      const place = (element, top) => { element.style.cssText = "position:absolute;left:300px;width:200px;height:30px;top:" + top + "px"; document.body.append(element); };
      const called = document.createElement("input"); called.setAttribute("role", "button"); place(called, 20);
      const host = document.createElement("x-called"); host.setAttribute("role", "button"); host.tabIndex = 0;
      const inner = document.createElement("input"); inner.style.cssText = "width:100%;height:100%;box-sizing:border-box";
      host.attachShadow({ mode: "closed" }).append(inner); place(host, 70);
      const editable = document.createElement("button"); editable.contentEditable = "true"; editable.textContent = "x"; place(editable, 120);`,
    );
    await spoken(page);
    for (const [x, y] of [
      [130, 40],
      [400, 35],
      [400, 85],
      [400, 135],
    ] as const) {
      await page.mouse.click(at(shown, x, y).x, at(shown, x, y).y);
      await expect.poll(() => hostActive(page)).toBe("IFRAME");
      await settle(page);
      const before = await presses(page);
      expect(before, "the press on it was heard").toBeGreaterThan(0);
      await page.keyboard.type("a b ", { delay: 50 });
      await page.keyboard.press("Enter");
      await settle(page);
      expect(await presses(page), `probe: typing at ${x},${y} told no press`).toBe(before);
    }
  });

  test(PRESS_REPEAT, async ({ page }) => {
    const shown = await show(page, "window.onGo = () => {};");
    await spoken(page);
    // The focus on the page's button, by a real press on it.
    await page.mouse.click(button(shown).x, button(shown).y);
    await settle(page);
    const before = await presses(page);
    await page.keyboard.down("Enter");
    await settle(page);
    const once = await presses(page);
    expect(once, "the key going down was a press").toBeGreaterThan(before);
    // Held: the engine's own repeats of the same key.
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.down("Enter");
    }
    await settle(page);
    expect(await presses(page), "probe: the key held down told no more").toBe(once);
    await page.keyboard.up("Enter");
  });

  test(PRESS_SUBMIT, async ({ page }) => {
    // Enter in a form's text field: the form gives its submit button a click of the browser's own.
    // The field is tied to the form by its form attribute, outside the form's element.
    const shown = await show(
      page,
      `document.getElementById("target").remove();
      const form = document.createElement("form"); form.id = "f";
      form.addEventListener("submit", (event) => event.preventDefault());
      const submit = document.createElement("button"); submit.textContent = "send";
      submit.addEventListener("click", () => say("clicked"));
      form.append(submit); form.style.cssText = "position:absolute;left:300px;top:70px"; document.body.append(form);
      const text = document.createElement("input"); text.setAttribute("form", "f");
      text.style.cssText = "position:absolute;left:300px;top:20px;width:200px;height:30px"; document.body.append(text);`,
    );
    await spoken(page);
    await page.mouse.click(at(shown, 400, 35).x, at(shown, 400, 35).y);
    await expect.poll(() => hostActive(page)).toBe("IFRAME");
    await settle(page);
    const before = await presses(page);
    await page.keyboard.type("words", { delay: 40 });
    await page.keyboard.press("Enter");
    // (The sandbox has no allow-forms: the form is never submitted, and its click still comes.)
    await expect
      .poll(() => shown.said.some((each) => each.type === "clicked"), {
        message: "the form clicked its button",
      })
      .toBe(true);
    await settle(page);
    expect(await presses(page), "probe: Enter in the form's field told no press").toBe(before);
  });

  test(PRESS_PORT_UNHEARD, async ({ page }) => {
    // The first listener content can add, capturing, on its window: it hears no message that
    // carries a port, so it has none to say a press on.
    const shown = await show(
      page,
      `addEventListener("message", (event) => {
        if (event.ports && event.ports.length > 0) {
          say("port");
          try { event.ports[0].postMessage(0); } catch (_) {}
        }
      }, true);`,
    );
    await spoken(page);
    // A real press (on no control: the pointer's alone), so the port is known to be there and
    // working: one press, and no more.
    await page.mouse.click(at(shown, 400, 60).x, at(shown, 400, 60).y);
    await expect.poll(() => presses(page), { message: "the press was heard" }).toBeGreaterThan(0);
    await settle(page);
    expect(
      shown.said.some((each) => each.type === "port"),
      "probe: content heard no port",
    ).toBe(false);
    expect(await presses(page), "probe: one press, the person's").toBe(1);
  });

  test(PRESS_FORGED_PORT, async ({ page, browserName }) => {
    // Content sends itself the shell's message before the shell does, with a port of its own. The
    // runtime takes neither it nor its place: the person's press is told on the shell's port.
    const shown = await show(
      page,
      `const own = new MessageChannel();
      own.port1.onmessage = () => say("mine");
      try {
        dispatchEvent(new MessageEvent("message", { source: parent, origin: location.origin, data: { jsonrpc: "2.0", method: "porthole/shell/press-port" }, ports: [own.port2] }));
        say("forged", { made: true });
      } catch (error) {
        say("forged", { made: false, why: String(error) });
      }`,
    );
    await spoken(page);
    // Firefox makes no message event whose source is a window of another origin (measured: its
    // constructor throws): there the page has nothing to send itself, and the rest still holds.
    expect(
      shown.said.find((each) => each.type === "forged")?.made,
      "the page made its own port message, but on Firefox",
    ).toBe(browserName !== "firefox");
    await page.mouse.click(at(shown, 400, 60).x, at(shown, 400, 60).y);
    await settle(page);
    expect(await presses(page), "probe: the shell heard the person's press").toBe(1);
    expect(
      shown.said.some((each) => each.type === "mine"),
      "probe: content's own port heard nothing",
    ).toBe(false);
  });

  test(PRESS_OPEN_LOCKED, async ({ page }) => {
    // document.open() takes every listener off the window, the runtime's among them, and a
    // document opened and closed again loads again: the shell sends a port at that load, to
    // whoever listens then. The runtime's lock on open is what keeps that the runtime.
    const shown = await show(
      page,
      `addEventListener("message", (event) => {
        if (!event.data || event.data.test !== "reopen") return;
        let opened = true;
        try {
          document.open();
          window.addEventListener("message", (again) => {
            if (again.ports && again.ports.length > 0) {
              say("port");
              try { again.ports[0].postMessage(0); } catch (_) {}
            }
          }, true);
          document.close();
        } catch (_) {
          opened = false;
        }
        say("reopened", { opened });
      });`,
    );
    await spoken(page);
    await tell(page, { test: "reopen" });
    await expect.poll(() => shown.said.some((each) => each.type === "reopened")).toBe(true);
    await page.waitForTimeout(1_500);
    expect(
      shown.said.find((each) => each.type === "reopened")?.opened,
      "probe: the page couldn't open its document again",
    ).toBe(false);
    expect(
      shown.said.some((each) => each.type === "port"),
      "probe: content heard no port",
    ).toBe(false);
    expect(await presses(page), "probe: the shell heard no press").toBe(0);
  });

  test(PRESS_SAME_DOCUMENT, async ({ page }) => {
    // A link within the document: WebKit fires the frame's load for it (P142), and the shell sends
    // a port at every load. The document is the same, its runtime holds the first port and takes
    // no second: the shell goes on hearing the first.
    const shown = await show(
      page,
      `window.onGo = () => {};
      const link = document.createElement("a"); link.href = "#target"; link.textContent = "down";
      link.style.cssText = "position:absolute;left:20px;top:150px;width:100px;height:30px"; document.body.append(link);
      addEventListener("hashchange", () => say("moved"));`,
    );
    await spoken(page);
    await page.mouse.click(at(shown, 60, 165).x, at(shown, 60, 165).y);
    await expect.poll(() => shown.said.some((each) => each.type === "moved")).toBe(true);
    await page.waitForTimeout(800);
    const before = await presses(page);
    await page.mouse.click(button(shown).x, button(shown).y);
    await settle(page);
    expect(await presses(page), "probe: a press after the link was heard").toBeGreaterThan(before);
  });
});

test.describe("a nested page's real presses, by touch (P148)", () => {
  test.setTimeout(90_000);
  test.use({ hasTouch: true });

  test(PRESS_SCROLL, async ({ page, browserName }) => {
    // Only Chromium takes a finger's whole gesture from a test (its own input, through CDP):
    // WebKit and Firefox have a tap here and no drag.
    test.skip(browserName !== "chromium", "no touch drag can be driven on this engine");
    const shown = await show(
      page,
      `document.body.style.height = "4000px";
      window.onGo = () => {};
      for (const type of ["pointerdown", "pointerup", "pointercancel"]) {
        addEventListener(type, (event) => say("pointer", { on: type, kind: event.pointerType }), true);
      }
      addEventListener("scroll", () => say("scrolled"), { once: true });`,
    );
    await spoken(page);
    const client = await page.context().newCDPSession(page);
    const from = field(shown);
    const finger = (y: number) => [{ x: from.x + 150, y, id: 1 }];
    // A finger down on the page, dragged up it, and lifted: the page scrolls.
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: finger(from.y + 200),
    });
    for (let step = 1; step <= 8; step += 1) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: finger(from.y + 200 - step * 20),
      });
      await page.waitForTimeout(20);
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect
      .poll(() => shown.said.some((each) => each.type === "scrolled"), {
        message: "the finger scrolled the page",
      })
      .toBe(true);
    expect(
      shown.said.some((each) => each.type === "pointer" && each.on === "pointerdown"),
      "the finger went down on the page",
    ).toBe(true);
    await settle(page);
    expect(await presses(page), "probe: a finger that scrolled told no press").toBe(0);
    // A tap is one.
    await page.touchscreen.tap(button(shown).x, button(shown).y);
    await expect.poll(() => presses(page), { message: "a tap is a press" }).toBeGreaterThan(0);
  });
});
