import { expect, test, type Frame, type Page } from "@playwright/test";
import type { PortholeConfig } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { storedFiles } from "./files.ts";
import { harness } from "./harness.ts";
import { mount, outcomeOf, runtimeCalls } from "./porthole-host.ts";

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

let count = 0;
const unique = (name: string): string => `${name}-${process.pid}-${(count += 1)}`;

const STOPPED = "The content kept taking the keyboard from the page; it was stopped.";

/** The page: a field, a button and a target at fixed places, its words on the console. */
const pageOf = (
  script = "",
): string => `<!doctype html><html><head><title>Nested</title></head><body>
<input id="field" style="position:absolute;left:20px;top:20px;width:220px;height:40px">
<button id="go" style="position:absolute;left:20px;top:90px;width:200px;height:40px">go</button>
<div id="target" style="position:absolute;left:300px;top:20px;width:200px;height:80px">target</div>
<script>
  const say = (type, more) => console.log("__P " + JSON.stringify(Object.assign({ type }, more || {})));
  const field = document.getElementById("field");
  field.addEventListener("input", () => say("value", { value: field.value }));
  const open = () => {
    try {
      Promise.resolve(porthole.use("comments")).then((comments) => comments.open({ name: "chart", label: "Chart" }))
        .then((value) => say("comments", { ok: true, value }), (error) => say("comments", { ok: false, code: error.code || String(error.message) }));
    } catch (error) {
      say("comments", { ok: false, code: "threw: " + String(error && error.message) });
    }
  };
  let typedTimer = 0;
  addEventListener("message", (event) => {
    const data = event.data;
    if (data === null || typeof data !== "object" || typeof data.test !== "string") return;
    if (data.test === "focus") field.focus();
    if (data.test === "open") open();
    // The host's composer was typed in: the page takes the keyboard once the person pauses.
    if (data.test === "typed") {
      clearTimeout(typedTimer);
      typedTimer = setTimeout(() => { field.focus(); say("took"); }, data.after);
    }
  });
  document.getElementById("go").addEventListener("click", () => window.onGo ? window.onGo() : open());
  ${script}
  say("ready", { origin: String(self.origin), href: location.href });
</script></body></html>`;

interface Shown {
  readonly key: string;
  readonly origin: string;
  /** The display's frame (the shell's document): evaluate in it only once a case has decided. */
  readonly shell: () => Promise<Frame>;
  /** What the page said, in order. */
  readonly said: Record<string, unknown>[];
  /** Where the frame's box is on the host's page. */
  readonly box: { readonly x: number; readonly y: number };
}

/** The host's own composer and button, above the display, and what the display tells it. */
async function hostUi(page: Page): Promise<void> {
  await page.evaluate(() => {
    const composer = document.createElement("textarea");
    composer.id = "host-composer";
    composer.style.cssText = "display:block;width:300px;height:60px";
    const button = document.createElement("button");
    button.id = "host-button";
    button.textContent = "host";
    button.style.cssText = "display:block;width:120px;height:40px";
    document.body.prepend(composer, button);
    const w = window as unknown as {
      seen: { taken: boolean[]; errors: string[]; storage: boolean[]; activated: string[] };
    };
    w.seen = { taken: [], errors: [], storage: [], activated: [] };
  });
}

/** The display's events, heard from its mount on (the host page's last display). */
async function listen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      seen: { taken: boolean[]; errors: string[]; storage: boolean[]; activated: string[] };
      portholeHost: { displays: { on(event: string, listener: (detail: never) => void): void }[] };
    };
    const display = w.portholeHost.displays.at(-1);
    display?.on("focusTaken", (detail: { typing: boolean }) => w.seen.taken.push(detail.typing));
    display?.on("contentError", (detail: { message: string }) =>
      w.seen.errors.push(detail.message),
    );
    display?.on("storage", (detail: { used: boolean }) => w.seen.storage.push(detail.used));
    display?.on("annotation", (detail: { type: string; id?: string }) => {
      if (detail.type === "activated") {
        w.seen.activated.push(detail.id ?? "");
      }
    });
  });
}

const seen = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          seen: { taken: boolean[]; errors: string[]; storage: boolean[]; activated: string[] };
        }
      ).seen,
  );
const composerText = (page: Page) =>
  page.evaluate(() => (document.getElementById("host-composer") as HTMLTextAreaElement).value);
const hostActive = (page: Page) =>
  page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || null);
/** A message from the host page to the page, through the shell (`event.source` its parent). */
const tell = (page: Page, message: Record<string, unknown>) =>
  page.evaluate((data) => {
    document
      .querySelector<HTMLIFrameElement>("#displays iframe")
      ?.contentWindow?.postMessage(data, "*");
  }, message);

/** Shows a nested page (`script` runs in it) under the reference services, the host's UI above. */
async function show(page: Page, script = "", before?: () => Promise<void>): Promise<Shown> {
  const served = await harness();
  const scope = unique("nest");
  const id = unique("page");
  served.fileSets.set(`${id}@1`, storedFiles({ "index.html": pageOf(script) }));
  const instance: InstanceRef = {
    scope,
    document: { kind: "artifact", id, version: "1", preset: "artifactNested" },
  };
  const location = await served.porthole.issue(instance, { viewer: "probe" });
  const said: Record<string, unknown>[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("__P ")) {
      said.push(JSON.parse(text.slice(4)) as Record<string, unknown>);
    }
  });
  await page.goto(`${served.hostOrigin}/porthole-host`);
  await page.waitForFunction(() => "portholeHost" in window);
  await hostUi(page);
  await before?.();
  const shown = await mount(
    page,
    served.hostOrigin,
    served.configs.artifactNested as PortholeConfig,
    location,
    instance,
    {
      runtime: {
        key: scope,
        scope,
        artifact: id,
        declaration: { capabilities: {}, runtime: "1" },
        viewer: { level: "interact", id: "ada", name: "Ada" },
      },
    },
  );
  await listen(page);
  expect(await outcomeOf(shown.read)).toEqual({ state: "loaded" });
  await expect.poll(() => said.some((each) => each.type === "ready")).toBe(true);
  const box = await page.locator("#displays iframe").boundingBox();
  return {
    key: scope,
    origin: location.origin,
    shell: shown.frame,
    said,
    box: { x: box?.x ?? 0, y: box?.y ?? 0 },
  };
}

const field = (shown: Shown) => ({ x: shown.box.x + 130, y: shown.box.y + 40 });
const button = (shown: Shown) => ({ x: shown.box.x + 120, y: shown.box.y + 110 });
const composer = { x: 100, y: 30 };
const hostButton = { x: 60, y: 85 };
const valueOf = (shown: Shown): string => {
  const value = shown.said.filter((each) => each.type === "value").at(-1)?.value;
  return typeof value === "string" ? value : "";
};

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
      params: { supported: true, active: true, ago: 0, focused: true },
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
