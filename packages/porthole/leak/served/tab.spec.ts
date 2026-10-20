import { expect, test, type Frame, type Page } from "@playwright/test";
import type { PortholeConfig } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { servedTests, TAB_CASES } from "../../src/conformance/served.ts";
import { storedFiles, startTabHost } from "./files.ts";
import { harness, servedHost } from "./harness.ts";
import { mount, outcomeOf } from "./porthole-host.ts";

/**
 * A served page on a tab of its own (P099, the review's S4): the served suite's tab cases against
 * the reference serving, then the other ways a page reaches a tab: a file set's clean address
 * (its own pages still open, P084) and a frame's sealed address opened outside its frame (P083).
 * On a tab no frame's sandbox applies; the page's CSP `sandbox` (the frame's own tokens) and the
 * shell's `window.open` are the walls, `tab-sandbox` and `window-open` their negative controls.
 */

test.describe(`served modes on a tab (${servedHost.name})`, () => {
  for (const each of servedTests(servedHost).filter((one) => TAB_CASES.includes(one.id))) {
    test(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
  }
});

let count = 0;
const unique = (name: string): string => `${name}-${process.pid}-${(count += 1)}`;

/**
 * What a page's script tries once a visitor clicks: `window.open`, a target=_blank link clicked
 * past the shell's own click handling, a blob download, a browser dialog; every window, download,
 * dialog and canary request it started.
 */
async function tryEscapes(page: Page, name: string) {
  const served = await harness();
  const canary = `${served.foreignOrigin}/canary/${name}`;
  const opened: string[] = [];
  const downloads: string[] = [];
  page.context().on("page", (each) => opened.push(each.url()));
  page.on("download", (each) => downloads.push(each.url()));
  const dialogs: string[] = [];
  page.on("dialog", (each) => {
    dialogs.push(each.type());
    void each.dismiss();
  });
  await page.evaluate((url) => {
    const blank = document.createElement("a");
    blank.id = "porthole-probe-blank";
    blank.href = `${url}?via=link`;
    blank.target = "_blank";
    blank.textContent = "blank";
    document.body.append(blank);
    window.addEventListener(
      "click",
      (event) => {
        if (event.target instanceof Element && event.target.closest("a") !== null) {
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    const button = document.createElement("button");
    button.id = "porthole-probe-escape";
    button.textContent = "send";
    button.addEventListener("click", () => {
      try {
        document.body.dataset.popup = String(window.open(`${url}?via=open`) !== null);
      } catch {
        document.body.dataset.popup = "false";
      }
      blank.click();
      const save = document.createElement("a");
      save.href = URL.createObjectURL(new Blob(["secret"]));
      save.download = "secret.txt";
      document.body.append(save);
      save.click();
      window.prompt("Your password, to go on");
    });
    document.body.append(button);
  }, canary);
  // Raw input: a person's click, and an action that waits on nothing it starts.
  const box = await page.locator("#porthole-probe-escape").boundingBox();
  await page.mouse.click((box?.x ?? 0) + 4, (box?.y ?? 0) + 4);
  await page.waitForTimeout(800);
  return {
    popup: await page.evaluate(() => document.body.dataset.popup),
    opened,
    downloads,
    dialogs,
    hits: served.hits.get(name) ?? 0,
  };
}

const CLOSED = { popup: "false", opened: [], downloads: [], dialogs: [], hits: 0 };

test("a file set's page on a tab of its own opens its own pages, and no window, link in a new window or download", async ({
  page,
}) => {
  const host = await startTabHost();
  const scope = unique("tab-set");
  host.versions.set(
    scope,
    new Map([
      [
        "1",
        storedFiles({
          "index.html": `<!doctype html><title>Set</title><main id="home">home</main><a id="next" href="about">About</a>
<script type="module">import { word } from "./lib.mjs"; document.documentElement.dataset.module = word;
fetch("./data.json").then((r) => r.json()).then((d) => { document.documentElement.dataset.data = d.message; });</script>`,
          "lib.mjs": 'export const word = "imported";',
          "data.json": '{ "message": "loaded" }',
          "about.html": '<!doctype html><title>About</title><main id="about">the about page</main>',
        }),
      ],
    ]),
  );
  host.latest.set(scope, "1");
  const answer = await page.goto(`${host.origin(scope)}/v/1/`);
  // Its own origin works under the sandbox: a module and a fetch by relative path, on its cookie.
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.module))
    .toBe("imported");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.data))
    .toBe("loaded");
  // Its links open its own pages (P084), on the tab.
  await page.locator("#next").click();
  await expect(page.locator("#about")).toHaveText("the about page");
  expect(page.url()).toBe(`${host.origin(scope)}/v/1/about`);
  expect(
    await tryEscapes(page, unique("tab-set-escape")),
    "probe: a window, new-window link, download, dialog or canary request got out",
  ).toEqual(CLOSED);
  expect(answer?.headers()["content-security-policy"], "probe: the page's own sandbox").toContain(
    "sandbox allow-scripts allow-same-origin",
  );
});

test("a frame's sealed address opened on a tab of its own is sandboxed as its frame is", async ({
  page,
  context,
}) => {
  const served = await harness();
  const id = unique("tab-sealed");
  served.fileSets.set(
    `${id}@1`,
    storedFiles({
      "index.html": '<!doctype html><title>Sealed</title><main id="sealed">sealed</main>',
    }),
  );
  const instance: InstanceRef = { scope: id, document: { kind: "artifact", id, version: "1" } };
  const location = await served.porthole.issue(instance, { viewer: "probe" });
  const shown = await mount(
    page,
    served.hostOrigin,
    served.configs.artifact as PortholeConfig,
    location,
    instance,
  );
  expect(await outcomeOf(shown.read)).toEqual({ state: "loaded" });
  const frame = await shown.frame();
  await frame.waitForLoadState("load");
  expect(new URL(frame.url()).pathname).toMatch(/^\/__porthole\/f\/[\w-]+\/$/u);
  // "Open frame in new tab": the address on its own, within its hour.
  const tab = await context.newPage();
  const answer = await tab.goto(frame.url());
  expect(answer?.status()).toBe(200);
  await expect(tab.locator("#sealed")).toHaveText("sealed");
  expect(
    await tryEscapes(tab, unique("tab-sealed-escape")),
    "probe: a window, new-window link, download, dialog or canary request got out",
  ).toEqual(CLOSED);
  await tab.close();
});

test("the shell fixes each of its walls in place, and says which it couldn't", async ({ page }) => {
  const instance: InstanceRef = {
    scope: unique("tab-locks"),
    document: { kind: "shell", preset: "inlineWidget" },
  };
  const unfixed = (where: Page | Frame) =>
    where.evaluate(
      () =>
        document
          .querySelector("script[data-porthole-unfixed]")
          ?.getAttribute("data-porthole-unfixed") ?? null,
    );
  // In a frame and on a tab, as every page is: each one fixed.
  const shown = await servedHost.show(page, instance);
  expect(await unfixed(await shown.frame()), "in a frame").toBeNull();
  await page.goto((await servedHost.locate(instance)).url);
  expect(await unfixed(page), "on a tab").toBeNull();
  // A property fixed before the shell ran (an extension's, an engine's own): the shell says so.
  // WebRTC's constructor, which no control here touches (its removal is the shell's from start).
  await page.addInitScript(() => {
    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: false,
      writable: false,
      value: window.RTCPeerConnection,
    });
  });
  await page.goto((await servedHost.locate(instance)).url);
  expect((await unfixed(page))?.split(" ")).toContain("RTCPeerConnection");
});
