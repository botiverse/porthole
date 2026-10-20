import { expect, test, type Frame, type Page } from "@playwright/test";
import type { PortholeConfig } from "../../src/index.ts";
import { LATE_NOTICE_MS } from "../../src/host/pages-of-set.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { storedFiles, startTabHost, viteFixture } from "./files.ts";
import { harness } from "./harness.ts";
import { mount, outcomeOf, type Mounted } from "./porthole-host.ts";

/**
 * A served artifact made of many files (P081-P084), in real browsers: in a frame (its access in
 * its files' path, P083) and on a tab (its clean address, the version's own, P081). Its pages load
 * their stylesheets, scripts, modules, images, data and workers by relative path, a Vite + React
 * build runs as built, a page never gets a newer version's file, a file outside the set or a
 * traversal is a 404, an `.html` published as `.txt` is text, another origin reads nothing, its
 * pages open each other in the frame and nothing else, a page loads no other version's files
 * (P082), and no service worker ever registers.
 */

let count = 0;
const unique = (name: string): string => `${name}-${process.pid}-${(count += 1)}`;

/** A version's files, published into the harness under `id@version`. */
async function publish(
  id: string,
  version: string,
  files: Record<string, string | Uint8Array>,
  options: { readonly spa?: boolean } = {},
) {
  const served = await harness();
  served.fileSets.set(`${id}@${version}`, storedFiles(files, options));
}

/** Mounts `id@version` in a frame on the harness's host page; its frame once it has loaded. */
async function showFiles(
  page: Page,
  id: string,
  version: string,
): Promise<{ frame: Frame; shown: Mounted; origin: string }> {
  const served = await harness();
  const instance: InstanceRef = { scope: id, document: { kind: "artifact", id, version } };
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
  return { frame, shown, origin: location.origin };
}

const flag = (frame: Frame, name: string) =>
  frame.evaluate((key) => document.documentElement.dataset[key] ?? "", name);

/** A page that loads one of each kind of file by relative path, each saying so when it ran. */
const MANY = {
  "index.html": `<!doctype html><html><head><title>Many</title>
<link rel="stylesheet" href="./css/style.css">
<script src="./js/classic.js"></script>
<script type="module" src="./js/main.mjs"></script>
</head><body><h1 id="title">Many files</h1><img id="img" src="img/dot.svg" alt="">
<a id="next" href="about">About</a></body></html>`,
  "css/style.css": "#title { color: rgb(1, 2, 3); }",
  "js/classic.js": 'document.documentElement.dataset.classic = "ran";',
  "js/main.mjs": `import { word } from "./lib.mjs";
document.documentElement.dataset.module = word;
// A fetch resolves against the page's address, a module's import and a worker against the module's.
fetch("./data/data.json").then((r) => r.json()).then((d) => { document.documentElement.dataset.data = d.message; });
const worker = new Worker(new URL("./worker.js", import.meta.url));
worker.onmessage = (event) => { document.documentElement.dataset.worker = event.data; };
worker.postMessage("ping");`,
  "js/lib.mjs": 'export const word = "imported";',
  "js/worker.js":
    'self.onmessage = () => fetch("../data/data.json").then((r) => r.json()).then((d) => self.postMessage("pong " + d.message));',
  "data/data.json": '{ "message": "loaded" }',
  "img/dot.svg":
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>',
  "about.html":
    '<!doctype html><title>About</title><main id="about">the about page</main><a id="back" href="./">back</a>',
};

async function expectAllLoaded(frame: Frame): Promise<void> {
  await expect.poll(() => flag(frame, "classic")).toBe("ran");
  await expect.poll(() => flag(frame, "module")).toBe("imported");
  await expect.poll(() => flag(frame, "data")).toBe("loaded");
  await expect.poll(() => flag(frame, "worker")).toBe("pong loaded");
  expect(
    await frame.evaluate(() => getComputedStyle(document.getElementById("title") as Element).color),
  ).toBe("rgb(1, 2, 3)");
  await expect
    .poll(() =>
      frame.evaluate(() => (document.getElementById("img") as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
}

test.describe("in a frame", () => {
  test("a page of many files loads its stylesheet, scripts, module, image, data and worker by relative path", async ({
    page,
  }) => {
    const id = unique("many");
    await publish(id, "1", MANY);
    const { frame } = await showFiles(page, id, "1");
    expect(new URL(frame.url()).pathname).toMatch(/^\/__porthole\/f\/[\w-]+\/$/u);
    await expectAllLoaded(frame);
  });

  test("a Vite + React build runs as built: its module, stylesheet, image, data and lazy chunk", async ({
    page,
  }) => {
    const id = unique("vite");
    await publish(id, "1", await viteFixture());
    const { frame } = await showFiles(page, id, "1");
    await expect(frame.locator("#data")).toHaveText("data loaded");
    await expect(frame.locator("#details")).toHaveText("details loaded");
    expect(
      await frame.evaluate(() => getComputedStyle(document.querySelector("h1") as Element).color),
    ).toBe("rgb(1, 2, 3)");
    await expect
      .poll(() =>
        frame.evaluate(() => (document.getElementById("logo") as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await frame.locator("#count").click();
    await expect(frame.locator("#count")).toHaveText("count 1");
  });

  test("a page keeps its own version's files when a newer one is published while it runs", async ({
    page,
  }) => {
    const id = unique("pinned");
    const late = (version: string) => ({
      "index.html": `<!doctype html><title>Pinned</title><button id="go" type="button">go</button><script>
document.getElementById("go").addEventListener("click", async () => {
  const data = await (await fetch("./data.json")).json();
  const late = await import("./late.mjs");
  document.documentElement.dataset.seen = data.version + " " + late.version;
});</script>`,
      "data.json": `{ "version": "${version}" }`,
      "late.mjs": `export const version = "${version}";`,
    });
    await publish(id, "1", late("1"));
    const { frame } = await showFiles(page, id, "1");
    await publish(id, "2", late("2"));
    await frame.locator("#go").click();
    await expect.poll(() => flag(frame, "seen")).toBe("1 1");
  });

  test("a link to another page of the set opens it in the frame; the display goes on", async ({
    page,
  }) => {
    const id = unique("pages");
    await publish(id, "1", MANY);
    const { frame, shown } = await showFiles(page, id, "1");
    const base = frame.url();
    await frame.locator("#next").click();
    await expect(frame.locator("#about")).toHaveText("the about page");
    expect(frame.url()).toBe(`${base}about`);
    await frame.locator("#back").click();
    await expect(frame.locator("#title")).toHaveText("Many files");
    // The display goes on past the wait the host gives a late notice (P098): a page nobody
    // announced (the guard's control, navigate-guard) starts it again only then.
    await page.waitForTimeout(LATE_NOTICE_MS + 500);
    const record = await shown.read();
    expect(record.outcomes).toEqual([{ state: "loaded" }]);
    expect(record.navigationsBlocked).toEqual([]);
  });

  for (const lost of ["dropped", "late"] as const) {
    test(`a link to another page of the set opens it in the frame when the leaving page's notice is ${lost} (P098)`, async ({
      page,
    }) => {
      // As Chromium may deliver it: a cross-process message is forwarded from a task of the
      // sending document's, so the notice of a page that leaves can reach the host after the next
      // page's load, or never (CI: the display started again at its spent ticket). Here the host
      // page drops each leaving page's notice, or holds it until the frame's next load (the
      // arriving page's own notice comes as the browser delivers it, before or after its load).
      const id = unique(`pages-${lost}`);
      await publish(id, "1", MANY);
      const { frame, shown } = await showFiles(page, id, "1");
      await page.evaluate((mode) => {
        const held: MessageEventInit[] = [];
        let releasing = false;
        window.addEventListener(
          "message",
          (event) => {
            const data = event.data as { method?: unknown; params?: { arrived?: unknown } } | null;
            if (releasing || data?.method !== "porthole/navigating") {
              return;
            }
            if (data.params?.arrived === true) {
              return;
            }
            event.stopImmediatePropagation();
            if (mode === "late") {
              held.push({ data: event.data, origin: event.origin, source: event.source });
            }
          },
          true,
        );
        document.querySelector("#displays iframe")?.addEventListener("load", () => {
          releasing = true;
          for (const each of held.splice(0)) {
            window.dispatchEvent(new MessageEvent("message", each));
          }
          releasing = false;
        });
      }, lost);
      const base = frame.url();
      await frame.locator("#next").click();
      await expect(frame.locator("#about")).toHaveText("the about page");
      expect(frame.url()).toBe(`${base}about`);
      await frame.locator("#back").click();
      await expect(frame.locator("#title")).toHaveText("Many files");
      await page.waitForTimeout(LATE_NOTICE_MS + 500);
      const record = await shown.read();
      expect(record.outcomes).toEqual([{ state: "loaded" }]);
      expect(record.navigationsBlocked).toEqual([]);
    });
  }

  test("a page opens nothing else: not a file that isn't a page, not another path of its origin", async ({
    page,
  }) => {
    const id = unique("stays");
    await publish(id, "1", {
      "index.html": `<!doctype html><title>Stays</title><main id="here">here</main>
<a id="file" href="notes.txt">notes</a>
<button id="text" type="button">text</button><button id="root" type="button">root</button>
<button id="away" type="button">away</button>
<script>
const go = (id, to) => document.getElementById(id).addEventListener("click", () => { location.href = to; });
go("text", "notes.txt"); go("root", "/"); go("away", "/__porthole/d/aaaaaaaaaaaaaaaa");
</script>`,
      "notes.txt": "notes",
    });
    const served = await harness();
    const { frame, shown } = await showFiles(page, id, "1");
    const before = served.requests.length;
    const opened = () =>
      served.requests
        .slice(before)
        .map((each) => new URL(each).pathname)
        .filter(
          (each) =>
            each.endsWith("/notes.txt") || each === "/" || each.startsWith("/__porthole/d/"),
        );
    // Each click is checked before the next: a page that went away takes the next button with it,
    // and the guard's control (navigate-guard) must fail this by its assertion (P096).
    for (const target of ["#file", "#text", "#root", "#away"]) {
      await frame.locator(target).click();
      await page.waitForTimeout(500);
      expect(opened(), `${target} opened nothing`).toEqual([]);
    }
    await page.waitForTimeout(1_000);
    await expect(frame.locator("#here")).toHaveText("here");
    expect(opened()).toEqual([]);
    expect((await shown.read()).outcomes).toEqual([{ state: "loaded" }]);
  });

  test("a file outside the set is a 404, and so is every spelling of a way out", async ({
    page,
  }) => {
    const id = unique("outside");
    await publish(id, "1", {
      "index.html": "<!doctype html><title>Outside</title><main>outside</main>",
      "sub/x.json": "{}",
    });
    const { frame } = await showFiles(page, id, "1");
    // The URL parser resolves what it sees (a dot segment, %2e, a backslash) before any request:
    // within the set that is another of its files; past the version's path, the CSP stops it, or
    // the server has nothing there. What it doesn't resolve (an encoded separator, a double
    // encoding) the server refuses.
    const expected: Record<string, string> = {
      "./missing.json": "404",
      "./sub/missing.json": "404",
      "./sub/%2e%2e/index.html": "200 page",
      "./sub/..%2findex.html": "404",
      "./sub/%252e%252e/index.html": "404",
      "./sub%5c..%5cindex.html": "404",
      "./sub%2f..%2findex.html": "404",
      "../index.html": "404",
      "./sub\\..\\..\\index.html": "404",
      "./%2e%2e/%2e%2e/%2e%2e/d/x": "blocked",
    };
    const statuses = await frame.evaluate(async (paths) => {
      const answers: Record<string, string> = {};
      for (const each of paths) {
        const answer = await fetch(each).catch(() => null);
        answers[each] =
          answer === null
            ? "blocked"
            : answer.status === 200
              ? `200 ${(await answer.text()).includes("outside") ? "page" : "?"}`
              : String(answer.status);
      }
      return answers;
    }, Object.keys(expected));
    expect(statuses).toEqual(expected);
  });

  test("an .html published as .txt is text, never sniffed into a page", async ({
    page,
    context,
  }) => {
    const id = unique("text");
    await publish(id, "1", {
      "index.html": "<!doctype html><title>Text</title><main>text</main>",
      "page.txt":
        "<!doctype html><script>window.parent.postMessage('ran', '*'); document.title = 'ran';</script>",
    });
    const { frame } = await showFiles(page, id, "1");
    const headers = await frame.evaluate(async () => {
      const answer = await fetch("./page.txt");
      return [answer.headers.get("content-type"), answer.headers.get("x-content-type-options")];
    });
    expect(headers).toEqual(["text/plain; charset=utf-8", "nosniff"]);
    // Opened on its own: shown as text, nothing runs.
    const tab = await context.newPage();
    await tab.goto(`${frame.url()}page.txt`);
    expect(await tab.evaluate(() => document.contentType)).toBe("text/plain");
    expect(await tab.title()).not.toBe("ran");
    await tab.close();
  });

  test("another origin reads none of the files: not another artifact's page, not a page elsewhere", async ({
    page,
    context,
  }) => {
    const served = await harness();
    const owner = unique("owner");
    await publish(owner, "1", {
      "index.html": "<!doctype html><title>Owner</title><main>owner</main>",
      "secret.json": '{ "secret": "owner only" }',
      "secret.js": 'window.stolen = "owner script";',
      "secret.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    const { frame } = await showFiles(page, owner, "1");
    const base = frame.url();
    const before = served.requests.filter((each) => each.startsWith(base)).length;
    const thief = unique("thief");
    await publish(thief, "1", {
      "index.html": `<!doctype html><title>Thief</title><main>thief</main><script>
fetch(${JSON.stringify(`${base}secret.json`)}).then((r) => r.text()).then((t) => { document.documentElement.dataset.got = t; }, () => { document.documentElement.dataset.got = "refused"; });
const s = document.createElement("script"); s.src = ${JSON.stringify(`${base}secret.js`)};
s.onerror = () => { document.documentElement.dataset.script = "refused"; }; document.head.append(s);
</script>`,
    });
    const stolen = await showFiles(page, thief, "1");
    await expect.poll(() => flag(stolen.frame, "got")).toBe("refused");
    await expect.poll(() => flag(stolen.frame, "script")).toBe("refused");
    // Its CSP stopped them before any request.
    expect(served.requests.filter((each) => each.startsWith(base)).length).toBe(before);

    // A page elsewhere, with no CSP of its own: no CORS, and the resource policy keeps it the
    // owner's origin's.
    const elsewhere = await context.newPage();
    await elsewhere.goto(`${served.foreignOrigin}/elsewhere`);
    const results = await elsewhere.evaluate(async (at) => {
      const read = await fetch(`${at}secret.json`).then(
        (r) => r.text(),
        () => "refused",
      );
      const script = await new Promise<string>((resolve) => {
        const s = document.createElement("script");
        s.src = `${at}secret.js`;
        s.addEventListener("load", () =>
          resolve((window as unknown as { stolen?: string }).stolen ?? "loaded"),
        );
        s.addEventListener("error", () => resolve("refused"));
        document.head.append(s);
      });
      const image = await new Promise<string>((resolve) => {
        const i = new Image();
        i.addEventListener("load", () => resolve("loaded"));
        i.addEventListener("error", () => resolve("refused"));
        i.src = `${at}secret.png`;
      });
      return { read, script, image };
    }, base);
    expect(results).toEqual({ read: "refused", script: "refused", image: "refused" });
    await elsewhere.close();
  });
});

test.describe("in a frame, what the host hears", () => {
  test("no report, content error or blocked navigation names the frame's sealed address (P083)", async ({
    page,
  }) => {
    const id = unique("reports");
    await publish(id, "1", {
      "index.html": `<!doctype html><title>Reports</title><main id="here">here</main>
<a id="file" href="notes.txt">notes</a><button id="away" type="button">away</button>
<script src="./missing.js"></script>
<script type="module" src="./boom.mjs"></script>
<script>
document.getElementById("away").addEventListener("click", () => { location.href = "./data.json?x=1"; });
setTimeout(() => Promise.reject(new Error("at " + location.href)), 50);
</script>`,
      "boom.mjs": 'throw new Error("boom from " + import.meta.url);',
      "notes.txt": "notes",
      "data.json": "{}",
    });
    const { frame, shown } = await showFiles(page, id, "1");
    await frame.locator("#file").click();
    await frame.locator("#away").click();
    await expect
      .poll(async () => {
        const record = await shown.read();
        return record.errors.length + record.navigationsBlocked.length;
      })
      .toBeGreaterThanOrEqual(5);
    // The host page's clock, not the frame's: a frame that navigated away is gone (P096).
    await page.waitForTimeout(500);
    const record = await shown.read();
    const said = [...record.errors, ...record.contentErrors, ...record.navigationsBlocked];
    expect(said.filter((each) => each.includes("/__porthole/f/"))).toEqual([]);
    // What it says names the page's own files as ./ instead.
    expect(record.navigationsBlocked).toEqual(
      expect.arrayContaining(["./notes.txt", "./data.json?x=1"]),
    );
    expect(said.some((each) => each.includes("./missing.js"))).toBe(true);
    expect(said.some((each) => each.includes("boom from ./boom.mjs"))).toBe(true);
    expect(said.some((each) => each.includes("at ./"))).toBe(true);
  });

  test("the shell renews its sealed address before it ends, in place; the page goes on loading its files", async ({
    page,
    context,
  }) => {
    await context.clock.install();
    const id = unique("renew");
    await publish(id, "1", {
      "index.html": `<!doctype html><title>Renew</title><button id="go" type="button">go</button><script>
document.getElementById("go").addEventListener("click", async () => {
  document.documentElement.dataset.seen = (await (await fetch("./data.json")).json()).v;
});</script>`,
      "data.json": '{ "v": "fresh" }',
    });
    const { frame } = await showFiles(page, id, "1");
    const first = frame.url();
    await context.clock.fastForward("56:00");
    await expect.poll(() => frame.url(), { timeout: 10_000 }).not.toBe(first);
    expect(new URL(frame.url()).pathname).toMatch(/^\/__porthole\/f\/[\w-]+\/$/u);
    await frame.locator("#go").click();
    await expect.poll(() => flag(frame, "seen")).toBe("fresh");
  });
});

test.describe("on a tab", () => {
  const LATEST = (version: string) => ({
    ...MANY,
    "data.json": `{ "version": "${version}" }`,
    "late.mjs": `export const version = "${version}";`,
    "sw.js": "self.addEventListener('fetch', () => {});",
    "probe.html": `<!doctype html><title>Probe</title><button id="go" type="button">go</button><script>
document.getElementById("go").addEventListener("click", async () => {
  const data = await (await fetch("./data.json")).json();
  const late = await import("./late.mjs");
  document.documentElement.dataset.seen = data.version + " " + late.version;
});</script>`,
  });

  test("the latest address opens the version's own, where its files load by relative path", async ({
    page,
  }) => {
    const host = await startTabHost();
    const scope = unique("tab");
    host.versions.set(scope, new Map([["1", storedFiles(LATEST("1"))]]));
    host.latest.set(scope, "1");
    await page.goto(`${host.origin(scope)}/`);
    expect(page.url()).toBe(`${host.origin(scope)}/v/1/`);
    await expectAllLoaded(page.mainFrame());
  });

  test("a page opened as the latest never gets a newer version's file, published while it runs", async ({
    page,
  }) => {
    const host = await startTabHost();
    const scope = unique("tab-pinned");
    const versions = new Map([["1", storedFiles(LATEST("1"))]]);
    host.versions.set(scope, versions);
    host.latest.set(scope, "1");
    await page.goto(`${host.origin(scope)}/probe`);
    expect(page.url()).toBe(`${host.origin(scope)}/v/1/probe`);
    versions.set("2", storedFiles(LATEST("2")));
    host.latest.set(scope, "2");
    await page.locator("#go").click();
    await expect.poll(() => flag(page.mainFrame(), "seen")).toBe("1 1");
    // The latest address now opens the new one.
    await page.goto(`${host.origin(scope)}/probe`);
    expect(page.url()).toBe(`${host.origin(scope)}/v/2/probe`);
    await page.locator("#go").click();
    await expect.poll(() => flag(page.mainFrame(), "seen")).toBe("2 2");
  });

  test("a page loads no other version's files, though the browser may open both (P082)", async ({
    page,
  }) => {
    const host = await startTabHost();
    const scope = unique("tab-versions");
    host.versions.set(
      scope,
      new Map([
        ["1", storedFiles(LATEST("1"))],
        ["2", storedFiles(LATEST("2"))],
      ]),
    );
    host.latest.set(scope, "2");
    await page.goto(`${host.origin(scope)}/v/1/`);
    await page.goto(`${host.origin(scope)}/v/2/`);
    const before = host.requests.length;
    const seen = await page.evaluate(async () => {
      const read = await fetch("/v/1/data.json").then(
        async (r) => `${r.status} ${await r.text()}`,
        () => "refused",
      );
      const other = "/v/1/late.mjs";
      const imported = await (import(other) as Promise<{ version: string }>).then(
        (m) => m.version,
        () => "refused",
      );
      return { read, imported };
    });
    expect(seen).toEqual({ read: "refused", imported: "refused" });
    expect(host.requests.slice(before).filter((each) => each.includes("/v/1/"))).toEqual([]);
  });

  test("no service worker ever registers", async ({ page }) => {
    const host = await startTabHost();
    const scope = unique("tab-sw");
    host.versions.set(scope, new Map([["1", storedFiles(LATEST("1"))]]));
    host.latest.set(scope, "1");
    await page.goto(`${host.origin(scope)}/v/1/`);
    const registered = await page.evaluate(async () => {
      if (navigator.serviceWorker === undefined) {
        return "no service workers here";
      }
      return navigator.serviceWorker.register("./sw.js", { scope: "./" }).then(
        () => "registered",
        (error: unknown) => `refused: ${String(error).slice(0, 80)}`,
      );
    });
    expect(registered).not.toBe("registered");
  });
});
