import { expect, type Frame } from "@playwright/test";
import { presets } from "../presets/presets.ts";
import { resolveTheme } from "../theme/variables.ts";
import type { LaunchedDisplay } from "./index.ts";
import { inline, type Probe, type ProbeContext } from "./kit.ts";
import { settle } from "./oracles.ts";

/**
 * The display's behavior in a real frame (item 11: streaming, sizing, theming, base styles) and
 * the host-function gates (item 12), each driven as a person or an agent would: real clicks, real
 * streaming, real theme flips.
 */

const read = <T>(frame: Frame, run: () => T): Promise<T> => frame.evaluate(run);

/** The computed value of a CSS variable on the frame's root. */
const variable = (frame: Frame, name: string): Promise<string> =>
  frame.evaluate(
    (each) => getComputedStyle(document.documentElement).getPropertyValue(each).trim(),
    name,
  );

/** Polls the frame element's height until it is `px` (± 1). */
async function expectHeight(display: LaunchedDisplay, px: number, message: string): Promise<void> {
  await expect
    .poll(async () => Math.round((await display.box()).height), { message, timeout: 5_000 })
    .toBeGreaterThanOrEqual(px - 1);
  await expect
    .poll(async () => Math.round((await display.box()).height), { message, timeout: 5_000 })
    .toBeLessThanOrEqual(px + 1);
}

/** The refusals the display reported, by capability. */
async function refusals(display: LaunchedDisplay): Promise<string[]> {
  return (await display.events()).flatMap((event) =>
    event.type === "refused" ? [`${event.detail.capability}:${event.detail.refusal}`] : [],
  );
}

/** A real click (a trusted event: the user activation a person's click gives). */
async function click(display: LaunchedDisplay, selector: string): Promise<void> {
  await (await display.frame()).locator(selector).click();
}

/**
 * Lets any user activation the test harness gave the host page lapse: Playwright's own
 * evaluations count as gestures in some engines, and Chromium keeps one for 5 s. Between this and
 * the next raw input, the test must not evaluate anything in the page.
 */
const ACTIVATION_LAPSE_MS = 6_000;

/** A click by raw mouse input at `selector`'s center, after any harness activation has lapsed. */
async function clickAfterLapse(
  context: ProbeContext,
  display: LaunchedDisplay,
  selector: string,
): Promise<void> {
  const frame = await display.frame();
  const box = await frame.locator(selector).boundingBox();
  if (box === null) {
    throw new Error(`${selector} is not on screen`);
  }
  await context.page.waitForTimeout(ACTIVATION_LAPSE_MS);
  await context.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** The attribute `name` of the frame's body, once set. */
async function bodyData(display: LaunchedDisplay, name: string, timeout = 5_000): Promise<string> {
  const frame = await display.frame();
  await expect
    .poll(() => frame.locator("body").getAttribute(`data-${name}`), { timeout })
    .not.toBeNull();
  return (await frame.locator("body").getAttribute(`data-${name}`)) ?? "";
}

const PROMPT_CONTENT = `<button id="ask">Explain March</button>
<script>
  document.getElementById("ask").addEventListener("click", () => {
    document.body.removeAttribute("data-result");
    sendPrompt("Explain why signups doubled in March").then(
      (sent) => (document.body.dataset.result = String(sent)),
      (error) => (document.body.dataset.result = "refused: " + error.message),
    );
  });
  sendPrompt("asked on load").then(
    () => (document.body.dataset.onload = "sent"),
    (error) => (document.body.dataset.onload = "refused: " + error.message),
  );
</script>`;

const prompts = () => inline({ capabilities: { sendPrompt: {} } });

export const BEHAVIOR_PROBES: readonly Probe[] = [
  // ── 11: streaming ──────────────────────────────────────────────────────────────────────────
  {
    id: "11.streaming",
    item: 11,
    title:
      "streamed content is drawn as it grows, inert, keeping what was drawn; the whole runs once",
    async run(context: ProbeContext) {
      const display = await context.launch({ config: inline() });
      const pixel = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
      const head = `<style>.row { height: 20px }</style><img id="img" src="${pixel}" alt=""><div class="row" id="r1">one</div>`;
      const step2 = `${head}<a id="js" href="javascript:document.body.dataset.ran='href'">x</a><button id="b" onclick="document.body.dataset.ran='handler'">b</button><div class="row" id="r2">two</div><script>document.body.dataset.ran = "draft"</script>`;
      const whole = `${step2}<script>document.body.dataset.ran = String((Number(document.body.dataset.ran) || 0) + 1)</script>`;

      await display.setContent(head, { partial: true });
      const frame = await display.frame();
      await expect(frame.locator("#r1")).toHaveText("one");
      // Mark what was drawn: the next draft must keep the same node (an image doesn't reload).
      await frame.evaluate(() => {
        (document.getElementById("img") as HTMLElement & { portholeMark?: number }).portholeMark =
          1;
      });
      await display.setContent(step2, { partial: true });
      await expect(frame.locator("#r2")).toHaveText("two");
      expect(
        await read(frame, () => ({
          kept: (document.getElementById("img") as HTMLElement & { portholeMark?: number })
            .portholeMark,
          ran: document.body.dataset.ran ?? null,
          href: document.getElementById("js")?.getAttribute("href") ?? null,
          handler: document.getElementById("b")?.getAttribute("onclick") ?? null,
          scripts: document.querySelectorAll("#porthole-root script").length,
        })),
      ).toEqual({ kept: 1, ran: null, href: null, handler: null, scripts: 0 });

      await display.setContent(whole);
      await expect(frame.locator("body")).toHaveAttribute("data-ran", "1");
      expect(await frame.locator("#b").getAttribute("onclick")).not.toBeNull();
      // The whole goes once: sending it again, or a late draft, changes nothing.
      await display.setContent(whole);
      await display.setContent(head, { partial: true });
      await settle(400);
      await expect(frame.locator("body")).toHaveAttribute("data-ran", "1");
      await expect(frame.locator("#r2")).toHaveText("two");
    },
  },

  // ── 11: sizing ─────────────────────────────────────────────────────────────────────────────
  {
    id: "11.size",
    item: 11,
    title: "the frame's height follows its content, within the config's limits",
    async run(context) {
      const config = inline({ limits: { maxHeightPx: 400, minHeightPx: 30 } });
      const display = await context.launch({
        config,
        content: `<div id="box" style="height: 150px"></div><script>window.setBox = (px) => (document.getElementById("box").style.height = px + "px");</script>`,
      });
      await expectHeight(display, 150, "follows its content");
      const frame = await display.frame();
      await frame.evaluate(() => (window as unknown as { setBox(px: number): void }).setBox(300));
      await expectHeight(display, 300, "grows with it");
      await frame.evaluate(() => (window as unknown as { setBox(px: number): void }).setBox(1_000));
      await expectHeight(display, 400, "stops at maxHeightPx");
      expect(
        await read(
          frame,
          () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
        ),
        "past its height, the content scrolls inside",
      ).toBe(true);
      await frame.evaluate(() => (window as unknown as { setBox(px: number): void }).setBox(5));
      await expectHeight(display, 30, "shrinks to minHeightPx");
      const sizes = (await display.events()).flatMap((event) =>
        event.type === "resize" ? [event.detail.height] : [],
      );
      expect(sizes).toEqual(expect.arrayContaining([150, 300, 400, 30]));
      expect(Math.max(...sizes)).toBe(400);
    },
  },
  {
    id: "11.size-document",
    item: 11,
    title: "a whole page's frame follows the page's height, within the artifact's limits",
    async run(context) {
      const display = await context.launch({
        config: presets.artifact(),
        content: `<!doctype html><html><head><title>Report</title></head><body style="margin: 0"><div id="page" style="height: 500px">page</div><script>document.body.dataset.loaded = "0"; addEventListener("load", () => (document.body.dataset.loaded = "1"));</script></body></html>`,
      });
      await expectHeight(display, 500, "follows the page");
      const frame = await display.frame();
      await expect(frame.locator("#page")).toHaveText("page");
      await expect(frame.locator("body"), "the page's own load event fires").toHaveAttribute(
        "data-loaded",
        "1",
      );
      expect(await read(frame, () => document.title)).toBe("Report");
    },
  },

  // ── 11: theming ────────────────────────────────────────────────────────────────────────────
  {
    id: "11.theme-flip",
    item: 11,
    title: "a theme flip re-themes the running content in place, and tells it once",
    async run(context) {
      const config = inline({ theme: { event: "app:theme" } });
      const light = resolveTheme(config.theme, "light");
      const dark = resolveTheme(config.theme, "dark");
      const display = await context.launch({
        config,
        scheme: "light",
        content: `<p>themed</p><script>window.kept = "yes"; window.flips = []; addEventListener("app:theme", (event) => window.flips.push(event.detail.theme));</script>`,
      });
      const frame = await display.frame();
      await expect(frame.locator("p")).toHaveText("themed");
      expect(await variable(frame, "--color-text-primary")).toBe(light["--color-text-primary"]);
      await display.setTheme("dark");
      await expect
        .poll(() => variable(frame, "--color-text-primary"))
        .toBe(dark["--color-text-primary"]);
      expect(await variable(frame, "--color-chart-1")).toBe(dark["--color-chart-1"]);
      expect(
        await read(frame, () => ({
          kept: (window as unknown as { kept?: string }).kept,
          flips: (window as unknown as { flips: string[] }).flips,
          theme: document.documentElement.dataset.theme,
          scheme: document.documentElement.style.colorScheme,
        })),
      ).toEqual({ kept: "yes", flips: ["dark"], theme: "dark", scheme: "dark" });
      const element = await frame.frameElement();
      expect(await element.evaluate((node) => (node as HTMLElement).style.colorScheme)).toBe(
        "dark",
      );
      await display.setTheme("light");
      await expect
        .poll(() => variable(frame, "--color-text-primary"))
        .toBe(light["--color-text-primary"]);
      expect(await read(frame, () => (window as unknown as { flips: string[] }).flips)).toEqual([
        "dark",
        "light",
      ]);
    },
  },
  {
    id: "11.theme-host-values",
    item: 11,
    title:
      "the host's live values reach the frame, the spec's names and Porthole's own; others don't",
    async run(context) {
      const display = await context.launch({
        config: inline(),
        scheme: "dark",
        hostTheme: {
          dark: {
            "--color-text-primary": "rgb(1, 2, 3)",
            "--color-chart-1": "rgb(4, 5, 6)",
            "--not-declared": "red",
          },
        },
        content: "<p>live</p>",
      });
      const frame = await display.frame();
      await expect(frame.locator("p")).toHaveText("live");
      await expect.poll(() => variable(frame, "--color-text-primary")).toBe("rgb(1, 2, 3)");
      expect(await variable(frame, "--color-chart-1")).toBe("rgb(4, 5, 6)");
      expect(await variable(frame, "--not-declared")).toBe("");
    },
  },
  {
    id: "11.base-styles",
    item: 11,
    title: "native controls take the theme, and content's own CSS overrides them",
    async run(context) {
      const config = inline();
      const display = await context.launch({
        config,
        content: `<style>.square { border-radius: 0 }</style><button id="b">Go</button><button id="c" class="square">C</button><input id="i" value="x">`,
      });
      const frame = await display.frame();
      await expect(frame.locator("#b")).toHaveText("Go");
      const styles = await read(frame, () => {
        const of = (id: string) => getComputedStyle(document.getElementById(id) as HTMLElement);
        return {
          radius: of("b").borderTopLeftRadius,
          font: of("b").fontFamily === getComputedStyle(document.body).fontFamily,
          height: (document.getElementById("b") as HTMLElement).getBoundingClientRect().height,
          overridden: of("c").borderTopLeftRadius,
          input: of("i").borderTopLeftRadius,
        };
      });
      expect(styles).toEqual({
        radius: resolveTheme(config.theme, "light")["--border-radius-md"],
        font: true,
        height: expect.any(Number),
        overridden: "0px",
        input: resolveTheme(config.theme, "light")["--border-radius-md"],
      });
      expect(styles.height, "a control is tall enough to tap").toBeGreaterThanOrEqual(44);
    },
  },

  // ── 12: the host-function gates ────────────────────────────────────────────────────────────
  {
    id: "12.prompt-gesture-confirm",
    item: 12,
    title: "sendPrompt needs a click and the person's yes; a no sends nothing",
    async run(context) {
      const display = await context.launch({ config: prompts(), content: PROMPT_CONTENT });
      expect(
        await bodyData(display, "onload"),
        "a call made on load is refused by the shell",
      ).toContain("needs a click");
      expect(await display.calls()).toEqual([]);

      // The host's own check needs the frame's click to reach the host page (activation
      // propagates to ancestors): measured with raw input, after the harness's activation lapsed.
      await clickAfterLapse(context, display, "#ask");
      await context.page.waitForTimeout(500);
      const refused = await refusals(display);
      context.measured(
        `${context.engine}: a click in the frame ${refused.includes("sendPrompt:no-user-activation") ? "does not reach" : "reaches"} the host page's user activation`,
      );
      expect(refused, "the frame's click didn't count as a gesture on the host page").toEqual([]);
      const declined = await display.answerNextConfirmation(false);
      expect(declined).toMatchObject({
        capability: "sendPrompt",
        args: { text: "Explain why signups doubled in March" },
        display: { title: "Probe" },
      });
      expect(await bodyData(display, "result")).toBe("false");
      expect(await display.calls(), "a declined prompt reached the host's handler").toEqual([]);

      await click(display, "#ask");
      await display.answerNextConfirmation(true);
      expect(await bodyData(display, "result")).toBe("true");
      expect(await display.calls()).toEqual([
        { capability: "sendPrompt", args: { text: "Explain why signups doubled in March" } },
      ]);
    },
  },
  {
    id: "12.raw-message",
    item: 12,
    title: "a prompt sent around the shell (raw ui/message, no click) is refused by the host",
    async run(context) {
      const display = await context.launch({
        config: prompts(),
        content: `<script>
  addEventListener("message", (event) => {
    if (event.data && event.data.id === "raw-1") document.body.dataset.answer = JSON.stringify(event.data.result ?? event.data.error);
  });
  // Late enough that no harness gesture is still active on the host page.
  setTimeout(() => parent.postMessage({ jsonrpc: "2.0", id: "raw-1", method: "ui/message", params: { role: "user", content: [{ type: "text", text: "sent around the shell" }] } }, "*"), ${ACTIVATION_LAPSE_MS});
</script>`,
      });
      // Nothing is evaluated in the page until the message has been answered.
      await context.page.waitForTimeout(ACTIVATION_LAPSE_MS + 1_500);
      expect(await bodyData(display, "answer")).toBe(JSON.stringify({ isError: true }));
      expect(await display.calls()).toEqual([]);
      expect(await refusals(display)).toEqual(["sendPrompt:no-user-activation"]);
    },
  },
  {
    id: "12.link",
    item: 12,
    title: "a link opens only through the host, http(s) only, with the person's yes",
    async run(context) {
      const display = await context.launch({
        config: inline({ capabilities: { openLink: {} } }),
        content: `<a id="web" href="https://example.com/report?q=1">report</a>
<a id="js" href="javascript:document.body.dataset.ran = 'yes'">js</a>
<button id="raw">raw</button>
<script>
  document.getElementById("raw").addEventListener("click", () => openLink("javascript:alert(1)").then((opened) => (document.body.dataset.raw = String(opened)), () => (document.body.dataset.raw = "refused")));
</script>`,
      });
      await click(display, "#web");
      const asked = await display.answerNextConfirmation(true);
      expect(asked).toMatchObject({
        capability: "openLink",
        args: { url: "https://example.com/report?q=1" },
      });
      await expect
        .poll(() => display.calls())
        .toEqual([{ capability: "openLink", args: { url: "https://example.com/report?q=1" } }]);
      await click(display, "#js");
      await click(display, "#raw");
      expect(await bodyData(display, "raw")).toBe("false");
      await settle(300);
      expect(await (await display.frame()).locator("body").getAttribute("data-ran")).toBeNull();
      expect(await refusals(display)).toContain("openLink:invalid");
      expect(await display.calls()).toHaveLength(1);
    },
  },
  {
    id: "12.mute",
    item: 12,
    title: "after the config's number of declines, the display stops asking",
    async run(context) {
      const display = await context.launch({
        config: inline({ capabilities: { sendPrompt: {} }, limits: { declinesBeforeMute: 2 } }),
        content: PROMPT_CONTENT,
      });
      for (let index = 0; index < 2; index += 1) {
        await click(display, "#ask");
        await display.answerNextConfirmation(false);
        expect(await bodyData(display, "result")).toBe("false");
      }
      await expect
        .poll(async () => (await display.events()).some((event) => event.type === "muted"))
        .toBe(true);
      await click(display, "#ask");
      expect(await bodyData(display, "result")).toBe("false");
      expect(await refusals(display)).toContain("sendPrompt:muted");
      expect(await display.calls()).toEqual([]);
    },
  },
  {
    id: "12.no-confirm",
    item: 12,
    title: "a host without a confirm function sends nothing that needs one",
    async run(context) {
      const display = await context.launch({
        config: prompts(),
        confirms: false,
        content: PROMPT_CONTENT,
      });
      await click(display, "#ask");
      expect(await bodyData(display, "result")).toBe("false");
      expect(await refusals(display)).toContain("sendPrompt:no-confirm");
      expect(await display.calls()).toEqual([]);
    },
  },
];
