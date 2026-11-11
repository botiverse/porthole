import { expect, test, type Page } from "@playwright/test";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { storedFiles } from "./files.ts";
import {
  STORAGE_CAPS_KEPT,
  STORAGE_CAPS_THROW,
  STORAGE_CARRIED,
  STORAGE_CLEAR,
  STORAGE_CONTENT_WORDS,
  STORAGE_FORGET,
  STORAGE_KEPT,
  STORAGE_LATE,
  STORAGE_NEXT_PAGE,
  STORAGE_PEER,
  STORAGE_SAME_DOCUMENT,
  STORAGE_SCOPES,
} from "../controls.ts";
import { harness, showServed } from "./harness.ts";
import { pageOf, seen, show, unique, type Shown } from "./nested-pages.ts";

/**
 * A nested page's kept storage (P149): its scope's own `localStorage`, kept for it by the store
 * (a document of Porthole's own on the scope's origin), reached over a channel its shell hands
 * out. The page says what it reads over the console. Untraced, as nested.spec.ts.
 */
test.use({ trace: "off" });

const KEPT = "artifactNestedKept" as const;

/** A nested page of `scope` that keeps storage, running `script`. */
const kept = (page: Page, scope: string, script: string) =>
  show(page, script, undefined, {}, scope, KEPT);
const said = (shown: Shown, type: string) => shown.said.find((each) => each.type === type);
/** What a page reads of `key` as it starts. */
const READ = (key: string) =>
  `say("had", { value: localStorage.getItem(${JSON.stringify(key)}), length: localStorage.length });`;
/** Long enough for a write to reach the store before the page goes. */
const written = (page: Page) => page.waitForTimeout(500);
async function reads(page: Page, scope: string, key: string): Promise<unknown> {
  const shown = await kept(page, scope, READ(key));
  await expect.poll(() => said(shown, "had") !== undefined).toBe(true);
  return said(shown, "had")?.value;
}

test.describe("a nested page's kept storage (P149)", () => {
  test.setTimeout(90_000);

  test(STORAGE_KEPT, async ({ page }) => {
    const scope = unique("kept");
    const script = `say("had", { value: localStorage.getItem("k"), length: localStorage.length });
      localStorage.setItem("k", "v1");
      say("wrote", { value: localStorage.getItem("k") });`;
    const first = await show(page, script, undefined, {}, scope, KEPT);
    await expect.poll(() => first.said.find((each) => each.type === "wrote")?.value).toBe("v1");
    expect(first.said.find((each) => each.type === "had")?.value, "nothing kept yet").toBeNull();
    await expect.poll(async () => (await seen(page)).storage).toEqual([true]);
    expect((await seen(page)).kept, "probe: this load's storage is kept").toEqual([true]);
    // The write has to reach the store before the page goes.
    await page.waitForTimeout(500);
    const second = await show(page, script, undefined, {}, scope, KEPT);
    await expect.poll(() => second.said.some((each) => each.type === "wrote")).toBe(true);
    expect(
      second.said.find((each) => each.type === "had")?.value,
      "probe: the next load read what the last one wrote",
    ).toBe("v1");
  });
  test(STORAGE_SCOPES, async ({ page }) => {
    const scope = unique("kept");
    const first = await kept(page, scope, `localStorage.setItem("mine", "one"); say("wrote");`);
    await expect.poll(() => said(first, "wrote") !== undefined).toBe(true);
    await written(page);
    expect(
      await reads(page, unique("kept"), "mine"),
      "probe: another scope read nothing",
    ).toBeNull();
    // Each `show` is another document id of the scope: another version's page, the same origin.
    expect(await reads(page, scope, "mine"), "probe: the scope's next page read it").toBe("one");
  });

  test(STORAGE_CARRIED, async ({ page }) => {
    // A served page's frame and a nested page's store have the same top-level page above them:
    // the browser keeps them one storage. Checked, not assumed.
    const served = await harness();
    const scope = unique("carried");
    const id = unique("served");
    served.fileSets.set(`${id}@1`, storedFiles({ "index.html": "<!doctype html><p>served</p>" }));
    const instance: InstanceRef = {
      scope,
      document: { kind: "artifact", id, version: "1", preset: "artifact" },
    };
    const display = await showServed(page, instance);
    await (await display.frame()).evaluate(() => localStorage.setItem("carried", "from-served"));
    expect(
      await reads(page, scope, "carried"),
      "probe: the nested page read what the served page wrote",
    ).toBe("from-served");
  });

  test(STORAGE_CAPS_THROW, async ({ page }) => {
    const scope = unique("kept");
    const names = ["__proto__", "hasOwnProperty", "toString", "constructor"];
    // The names first, in a load of their own: four writes, which reach the store well within
    // `written`. (After the flood below they waited behind some two thousand, and a slow Firefox
    // had not kept them yet when the page went: a write is kept a moment after it is made, P149.)
    const first = await kept(
      page,
      scope,
      `for (const name of ${JSON.stringify(names)}) localStorage.setItem(name, "v:" + name);
      say("names", { names: ${JSON.stringify(names)}.map((name) => localStorage.getItem(name)), length: localStorage.length });`,
    );
    await expect.poll(() => said(first, "names") !== undefined).toBe(true);
    expect(said(first, "names")?.names, "names an object would trip on").toEqual(
      names.map((name) => `v:${name}`),
    );
    await written(page);
    // Read back at the next load, then the caps, last: nothing after them is read from the store.
    const second = await kept(
      page,
      scope,
      `say("again", { names: ${JSON.stringify(names)}.map((name) => localStorage.getItem(name)), length: localStorage.length });
      let threw = null;
      try { localStorage.setItem("big", "x".repeat(1048577)); } catch (error) { threw = error.name; }
      let many = null;
      try { for (let i = 0; i < 1100; i += 1) localStorage.setItem("n" + i, ""); } catch (error) { many = error.name; }
      say("caps", { threw, big: localStorage.getItem("big"), many, count: localStorage.length });`,
    );
    await expect.poll(() => said(second, "caps") !== undefined).toBe(true);
    expect(said(second, "again")?.names, "kept under those names, and read back").toEqual(
      names.map((name) => `v:${name}`),
    );
    expect(said(second, "again")?.length, "nothing else was kept").toBe(names.length);
    const caps = said(second, "caps");
    expect(caps?.threw, "probe: past 1 MiB, QuotaExceededError").toBe("QuotaExceededError");
    expect(caps?.big, "probe: and nothing of it in the page's own map").toBeNull();
    expect(caps?.many, "probe: past 1,024 keys, QuotaExceededError").toBe("QuotaExceededError");
    expect(caps?.count, "probe: the keys stopped at the cap").toBe(1024);
  });

  test(STORAGE_CAPS_KEPT, async ({ page }) => {
    // The store counts for itself. The page's runtime counts first and never sends it a write
    // past the caps, so this holds twice over; with the runtime's count out (its control), the
    // store's is what is left, and this is its probe.
    const scope = unique("kept");
    const first = await kept(
      page,
      scope,
      `localStorage.setItem("small", "s");
      try { localStorage.setItem("big", "x".repeat(1048577)); } catch (_) {}
      try { for (let i = 0; i < 1100; i += 1) localStorage.setItem("n" + i, ""); } catch (_) {}
      say("tried");`,
    );
    await expect.poll(() => said(first, "tried") !== undefined).toBe(true);
    await written(page);
    await written(page);
    const second = await kept(
      page,
      scope,
      `say("again", { big: localStorage.getItem("big"), small: localStorage.getItem("small"), length: localStorage.length });`,
    );
    await expect.poll(() => said(second, "again") !== undefined).toBe(true);
    expect(said(second, "again")?.small, "what fits is kept").toBe("s");
    expect(said(second, "again")?.big, "probe: nothing past 1 MiB was kept").toBeNull();
    expect(said(second, "again")?.length, "probe: nor more than 1,024 keys").toBeLessThanOrEqual(
      1024,
    );
  });

  test(STORAGE_CLEAR, async ({ page }) => {
    const scope = unique("kept");
    const shown = await kept(
      page,
      scope,
      `localStorage.setItem("k", "v"); say("wrote");
      addEventListener("message", (event) => {
        if (event.data && event.data.test === "read") say("now", { value: localStorage.getItem("k"), length: localStorage.length });
      });`,
    );
    await expect.poll(() => said(shown, "wrote") !== undefined).toBe(true);
    await written(page);
    await page.evaluate(() => {
      const host = (
        window as unknown as { portholeHost: { displays: { storage: { clear(): void } }[] } }
      ).portholeHost;
      host.displays.at(-1)?.storage.clear();
    });
    await written(page);
    await page.evaluate(() => {
      document
        .querySelector<HTMLIFrameElement>("#displays iframe")
        ?.contentWindow?.postMessage({ test: "read" }, "*");
    });
    await expect.poll(() => said(shown, "now") !== undefined).toBe(true);
    expect(said(shown, "now")?.value, "probe: the open page's is empty").toBeNull();
    expect(await reads(page, scope, "k"), "probe: and the next page's").toBeNull();
  });

  test(STORAGE_LATE, async ({ page }) => {
    const scope = unique("kept");
    const first = await kept(
      page,
      scope,
      `localStorage.setItem("k", "kept-before"); say("wrote");`,
    );
    await expect.poll(() => said(first, "wrote") !== undefined).toBe(true);
    await written(page);
    // The store's document held back for 4 s: past the runtime's wait.
    await page.route("**/__porthole/store/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await route.continue();
    });
    const late = await kept(
      page,
      scope,
      `say("had", { value: localStorage.getItem("k") }); localStorage.setItem("k", "written-on-memory"); say("wrote");
      // And again once the store has answered at last: this load is on memory, and stays so.
      setTimeout(() => { localStorage.setItem("k", "written-after-the-store-came"); say("wrote-late"); }, 6000);`,
    );
    await expect.poll(() => said(late, "wrote") !== undefined, { timeout: 15_000 }).toBe(true);
    expect(said(late, "had")?.value, "it started empty").toBeNull();
    await expect.poll(async () => (await seen(page)).kept).toEqual([false]);
    // The store does answer in the end: nothing of this load's reaches it, then or after.
    await expect.poll(() => said(late, "wrote-late") !== undefined, { timeout: 15_000 }).toBe(true);
    await written(page);
    await page.unroute("**/__porthole/store/**");
    expect(
      await reads(page, scope, "k"),
      "probe: what was kept is as it was: the late load wrote nothing back",
    ).toBe("kept-before");
  });

  test(STORAGE_PEER, async ({ page }) => {
    const scope = unique("kept");
    const shown = await kept(page, scope, `localStorage.setItem("secret", "s3"); say("wrote");`);
    await expect.poll(() => said(shown, "wrote") !== undefined).toBe(true);
    await written(page);
    // The store's address, from the shell's own document (a test may read it; no page can).
    const address = /"store":"([^"]+)"/u.exec(await (await shown.shell()).content())?.[1];
    expect(address, "the shell's plan names its store").toBeDefined();
    const answer = await page.evaluate(async (url) => {
      const frame = document.createElement("iframe");
      frame.style.display = "none";
      const loaded = new Promise((resolve) => frame.addEventListener("load", resolve));
      frame.src = url;
      document.body.append(frame);
      await loaded;
      const channel = new MessageChannel();
      const heard = new Promise<unknown>((resolve) => {
        channel.port2.addEventListener("message", (event) => resolve(event.data));
        channel.port2.start();
        setTimeout(() => resolve(null), 1_500);
      });
      frame.contentWindow?.postMessage(
        { jsonrpc: "2.0", method: "porthole/shell/store-port" },
        new URL(url).origin,
        [channel.port1],
      );
      channel.port2.postMessage({ ask: 1 });
      return await heard;
    }, address as string);
    expect(answer, "probe: the store told the host's own frame nothing").toBeNull();
  });

  test(STORAGE_FORGET, async ({ page }) => {
    const served = await harness();
    const gone = unique("kept");
    const other = unique("kept");
    for (const scope of [gone, other]) {
      const shown = await kept(page, scope, `localStorage.setItem("k", "v"); say("wrote");`);
      await expect.poll(() => said(shown, "wrote") !== undefined).toBe(true);
      await written(page);
    }
    const address = await served.porthole.forgetStorage(gone);
    const load = (url: string) =>
      page.evaluate(async (at) => {
        const frame = document.createElement("iframe");
        frame.style.display = "none";
        const loaded = new Promise((resolve) => frame.addEventListener("load", resolve));
        frame.src = at;
        document.body.append(frame);
        await loaded;
        frame.remove();
      }, url);
    await load(address);
    const again = await page.request.get(address);
    expect(again.status(), "its ticket is spent").toBe(404);
    expect(
      again.headers()["clear-site-data"],
      "probe: and no status page carries the header",
    ).toBeUndefined();
    expect(await reads(page, gone, "k"), "probe: the forgotten scope kept nothing").toBeNull();
    expect(await reads(page, other, "k"), "probe: another scope's is as it was").toBe("v");
  });
  test(STORAGE_NEXT_PAGE, async ({ page }) => {
    // A page that saves as it leaves, the tightest order there is: its writes, the last of them
    // and the move to its next page in one task, and one more in its own pagehide handler
    // (after the runtime's own word that it is going). The next page reads all of it as it
    // starts, and writes the same key at once: its value is the one that stays.
    const scope = unique("kept");
    const next = pageOf(
      `say("next", { last: localStorage.getItem("last"), hide: localStorage.getItem("hide"), both: localStorage.getItem("both"), length: localStorage.length });
      localStorage.setItem("both", "second");`,
    );
    const shown = await show(
      page,
      `if (localStorage.getItem("last") === null) {
        addEventListener("pagehide", () => { localStorage.setItem("hide", "h"); });
        for (let i = 0; i < 40; i += 1) localStorage.setItem("n" + i, "x".repeat(200) + i);
        localStorage.setItem("both", "first");
        localStorage.setItem("last", "v");
        location.href = "next.html";
      }`,
      undefined,
      { "next.html": next },
      scope,
      KEPT,
    );
    await expect.poll(() => said(shown, "next") !== undefined).toBe(true);
    expect(said(shown, "next")?.last, "probe: the write made in the task that left").toBe("v");
    expect(said(shown, "next")?.hide, "probe: and the one made in its pagehide handler").toBe("h");
    expect(said(shown, "next")?.both).toBe("first");
    expect(said(shown, "next")?.length, "the forty keys, and the three").toBe(43);
    expect((await seen(page)).kept, "no load fell back to memory").not.toContain(false);
    await written(page);
    expect(await reads(page, scope, "both"), "probe: the next page's write is what stays").toBe(
      "second",
    );
  });

  test(STORAGE_SAME_DOCUMENT, async ({ page }) => {
    // WebKit fires the frame's load for a link within the document, so the shell hands the same
    // document a second channel. What the page writes after it is kept, once, and the store tells
    // the page nothing of its own write (a value told back late would undo a later one).
    const scope = unique("kept");
    const shown = await kept(
      page,
      scope,
      `localStorage.setItem("k", "one");
      location.hash = "#there";
      setTimeout(() => {
        localStorage.setItem("k", "two");
        localStorage.setItem("k", "three");
        setTimeout(() => say("after", { value: localStorage.getItem("k"), length: localStorage.length }), 400);
      }, 300);`,
    );
    await expect.poll(() => said(shown, "after") !== undefined).toBe(true);
    expect(said(shown, "after")?.value, "probe: the page reads its own last write").toBe("three");
    expect(said(shown, "after")?.length).toBe(1);
    await written(page);
    expect(await reads(page, scope, "k"), "probe: and it is what was kept").toBe("three");
  });

  test(STORAGE_CONTENT_WORDS, async ({ page }) => {
    // The host's word to clear, and the ports' own messages, said by the page: to its parent
    // (its shell) and to the top (the host's page). The shell takes the first from its host alone
    // and the rest from no one; the host passes on nothing of the shell's namespace.
    const scope = unique("kept");
    const shown = await kept(
      page,
      scope,
      `localStorage.setItem("k", "mine");
      const words = [
        { jsonrpc: "2.0", method: "porthole/shell/storage-clear" },
        { jsonrpc: "2.0", method: "porthole/shell/store-clear" },
        { jsonrpc: "2.0", method: "porthole/shell/store-port" },
        { jsonrpc: "2.0", method: "porthole/shell/storage-port" },
        { set: ["k", "theirs"] },
        { clear: 1 },
      ];
      setTimeout(() => {
        for (const word of words) {
          try { parent.postMessage(word, "*"); } catch (_) {}
          try { top.postMessage(word, "*"); } catch (_) {}
        }
        say("said");
      }, 300);`,
    );
    await expect.poll(() => said(shown, "said") !== undefined).toBe(true);
    await written(page);
    expect(await reads(page, scope, "k"), "probe: what the page kept is as it wrote it").toBe(
      "mine",
    );
  });
});
