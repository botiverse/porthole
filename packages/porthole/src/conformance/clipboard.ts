import { expect, type Page } from "@playwright/test";
import type { LaunchedDisplay } from "./index.ts";
import { inline, type Probe } from "./kit.ts";
import { settle } from "./oracles.ts";

/**
 * The clipboard (item 13, P051): content can't write it, whatever it tries in a person's click,
 * and what a person copies themselves is what they selected. `copyText` is the way copy buttons
 * work instead (item 12, P052). The oracle is the person's own clipboard: known text put on it
 * from the host's page, then pasted back into a text area there.
 */

const SEED = "porthole-seed";

/**
 * A text area of the oracle's own on the host's page: in the conformance harness's layer where
 * there is one (over an app's own page, P066), else at the top of the page.
 */
async function area(page: Page, id: string): Promise<void> {
  await page.evaluate((each) => {
    if (document.getElementById(each) === null) {
      const element = document.createElement("textarea");
      element.id = each;
      element.style.cssText = "display:block;width:200px;height:40px";
      (document.getElementById("porthole-conformance") ?? document.body).prepend(element);
    }
  }, id);
}

/** Puts `text` on the clipboard the way a person does: selects it on the host's page, copies. */
async function seed(page: Page, text: string): Promise<void> {
  await area(page, "porthole-oracle-seed");
  await page.evaluate((each) => {
    (document.getElementById("porthole-oracle-seed") as HTMLTextAreaElement).value = each;
  }, text);
  await page.locator("#porthole-oracle-seed").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+C");
}

/** What is on the clipboard: pasted into a text area on the host's page. */
async function pasted(page: Page): Promise<string> {
  await area(page, "porthole-oracle-paste");
  await page.evaluate(() => {
    (document.getElementById("porthole-oracle-paste") as HTMLTextAreaElement).value = "";
  });
  await page.locator("#porthole-oracle-paste").click();
  await page.keyboard.press("ControlOrMeta+V");
  await settle(200);
  return page.evaluate(
    () => (document.getElementById("porthole-oracle-paste") as HTMLTextAreaElement).value,
  );
}

/** Clicks `selector` in the display (a real click: the user activation a person gives). */
async function click(display: LaunchedDisplay, selector: string): Promise<void> {
  await (await display.frame()).locator(selector).click();
}

async function bodyData(display: LaunchedDisplay, name: string, verdict?: string): Promise<string> {
  const frame = await display.frame();
  // A probe's verdict where the answer is a wall's (P096): none coming fails it, not its setup.
  await expect
    .poll(() => frame.locator("body").getAttribute(`data-${name}`), {
      timeout: 5_000,
      ...(verdict === undefined ? {} : { message: verdict }),
    })
    .not.toBeNull();
  return (await frame.locator("body").getAttribute(`data-${name}`)) ?? "";
}

const settled = (name: string) =>
  `(value) => (document.body.dataset.${name} = String(value)), (error) => (document.body.dataset.${name} = "refused: " + (error && error.name))`;

export const CLIPBOARD_PROBES: readonly Probe[] = [
  {
    id: "13.clipboard-api",
    item: 13,
    title:
      "content can't write (or read) the clipboard through the async Clipboard API, even in a click",
    async run(context) {
      const display = await context.launch({
        config: inline(),
        content: `<button id="go">copy</button>
<script>
  document.getElementById("go").addEventListener("click", () => {
    navigator.clipboard.writeText("porthole-pwned-text").then(${settled("text")});
    if (typeof ClipboardItem === "function") {
      navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob(["porthole-pwned-item"], { type: "text/plain" }) })]).then(${settled("item")});
    } else {
      document.body.dataset.item = "refused: no ClipboardItem";
    }
    navigator.clipboard.readText().then(${settled("read")});
  });
</script>`,
      });
      await seed(context.page, SEED);
      await click(display, "#go");
      expect(
        await bodyData(display, "text", "probe: writeText is refused"),
        "probe: writeText is refused",
      ).toMatch(/^refused/u);
      expect(
        await bodyData(display, "item", "probe: write is refused"),
        "probe: write is refused",
      ).toMatch(/^refused/u);
      expect(
        await bodyData(display, "read", "probe: readText is refused"),
        "probe: readText is refused",
      ).toMatch(/^refused/u);
      expect(await pasted(context.page), "probe: the clipboard still holds the person's own").toBe(
        SEED,
      );
    },
  },
  {
    id: "13.clipboard-command",
    item: 13,
    title:
      "content can't copy or cut its own text onto the clipboard with execCommand, even in a click",
    async run(context) {
      const display = await context.launch({
        config: inline(),
        content: `<button id="go">copy</button>
<script>
  document.getElementById("go").addEventListener("click", () => {
    const area = document.createElement("textarea");
    area.value = "porthole-pwned-command";
    area.style.cssText = "position:absolute;left:-9999px";
    document.body.append(area);
    area.select();
    let copied = "threw";
    let cut = "threw";
    try { copied = document.execCommand("copy"); } catch (_) {}
    area.select();
    try { cut = document.execCommand("cut"); } catch (_) {}
    document.body.dataset.copied = String(copied) + "," + String(cut);
  });
</script>`,
      });
      await seed(context.page, SEED);
      await click(display, "#go");
      expect(
        await bodyData(display, "copied", "probe: execCommand copied or cut"),
        "probe: execCommand copied or cut",
      ).not.toContain("true");
      expect(await pasted(context.page), "probe: the clipboard still holds the person's own").toBe(
        SEED,
      );
    },
  },
  {
    id: "13.clipboard-event",
    item: 13,
    title:
      "what a person copies is what they selected: no copy listener of the content's can swap it",
    async run(context) {
      const display = await context.launch({
        config: inline(),
        content: `<p id="safe">porthole-selected-text</p>
<script>
  const swap = (event) => {
    event.clipboardData.setData("text/plain", "porthole-pwned-event");
    event.preventDefault();
    document.body.dataset.ran = "yes";
  };
  document.addEventListener("copy", swap);
  document.addEventListener("copy", swap, true);
  window.addEventListener("copy", swap);
  document.getElementById("safe").oncopy = swap;
</script>`,
      });
      await seed(context.page, SEED);
      const frame = await display.frame();
      await frame.locator("#safe").click({ clickCount: 3 });
      await context.page.keyboard.press("ControlOrMeta+C");
      await settle(200);
      // The positive control: the person's own copy works, and copies what they selected.
      expect(
        (await pasted(context.page)).trim(),
        "probe: the clipboard holds what the person selected",
      ).toBe("porthole-selected-text");
      expect(
        await frame.locator("body").getAttribute("data-ran"),
        "probe: a copy listener of the content's ran",
      ).toBeNull();
    },
  },
  {
    id: "12.copy-text",
    item: 12,
    title:
      "copyText reaches the host's handler from a click, with the whole text, never without one",
    async run(context) {
      const display = await context.launch({
        config: inline({ capabilities: { copyText: {} } }),
        content: `<button id="copy">Copy the command</button>
<script>
  document.getElementById("copy").addEventListener("click", () => {
    copyText("npm test -- --run").then(${settled("result")});
  });
  copyText("copied on load").then(${settled("onload")});
</script>`,
      });
      expect(
        await bodyData(display, "onload", "probe: copyText without a click is refused"),
        "probe: copyText without a click is refused",
      ).toMatch(/^refused/u);
      await click(display, "#copy");
      expect(await bodyData(display, "result")).toBe("true");
      expect(
        await display.calls(),
        "probe: only the click's whole text reached the host's handler",
      ).toEqual([{ capability: "copyText", args: { text: "npm test -- --run" } }]);
    },
  },
];
