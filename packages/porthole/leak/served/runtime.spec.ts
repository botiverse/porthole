import { expect, test, type Frame, type Page } from "@playwright/test";
import type { PortholeConfig } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { storedFiles } from "./files.ts";
import { harness, storedAsset } from "./harness.ts";
import { mount, outcomeOf, runtimeCalls, type MountExtras } from "./porthole-host.ts";

/**
 * The capability runtime in real browsers (P085-P090), on Porthole's own `createHost` and
 * `/server`, with the reference app's services in the host page: a page gets `porthole.use` and
 * nothing else; it reaches only the built-ins and what it declared, whatever it sends; a call above
 * the viewer's level is refused before any handler; comments are write-only; a person's own data
 * is theirs; the asset library loads in a frame and its scripts run only where uploads are the
 * admins'; an asset opened on its own runs nothing; a 0.6 page without a declaration behaves as
 * before. The oracle for "never reached" is the services' own record of every call they were asked.
 */

let count = 0;
const unique = (name: string): string => `${name}-${process.pid}-${(count += 1)}`;

const PAGE = `<!doctype html><html><head><title>Runtime</title></head><body><main id="artifact">runtime</main>
<button id="go" style="width:200px;height:40px">go</button></body></html>`;

interface Shown {
  readonly frame: Frame;
  readonly key: string;
  readonly scope: string;
  readonly origin: string;
}

/** Shows a page under `preset` with the reference services, as `viewer`, declaring `declaration`. */
async function show(
  page: Page,
  options: {
    readonly preset?: "runtime" | "runtimeOpen" | "artifactLegacy";
    readonly declaration?: Record<string, unknown> | null;
    readonly viewer?: { level: string; id?: string; name?: string } | null;
    readonly html?: string;
    readonly files?: Record<string, string>;
    readonly key?: string;
    readonly scope?: string;
    readonly uploadLevel?: string;
    /** The artifact's id (its assets' owner); default a new one. */
    readonly id?: string;
  } = {},
): Promise<Shown & { readonly id: string }> {
  const served = await harness();
  const preset = options.preset ?? "runtime";
  const scope = options.scope ?? unique("rt");
  const id = options.id ?? unique("page");
  if (options.files === undefined) {
    served.pages.set(`${id}@1`, options.html ?? PAGE);
  } else {
    served.fileSets.set(`${id}@1`, storedFiles(options.files));
  }
  const instance: InstanceRef = { scope, document: { kind: "artifact", id, version: "1", preset } };
  const location = await served.porthole.issue(instance, { viewer: "probe" });
  const key = options.key ?? scope;
  const extras: MountExtras = {
    runtime: {
      key,
      scope,
      artifact: id,
      // Under a runtime the host says what the page declared, or null for a page from before 0.7.
      ...(options.declaration === null
        ? { declaration: null }
        : { declaration: { capabilities: options.declaration ?? {}, runtime: "1" } }),
      ...(options.viewer === null
        ? {}
        : { viewer: options.viewer ?? { level: "interact", id: "ada", name: "Ada" } }),
      ...(options.uploadLevel === undefined ? {} : { uploadLevel: options.uploadLevel }),
    },
  };
  const shown = await mount(
    page,
    served.hostOrigin,
    served.configs[preset] as PortholeConfig,
    location,
    instance,
    extras,
  );
  expect(await outcomeOf(shown.read)).toEqual({ state: "loaded" });
  const frame = await shown.frame();
  await frame.waitForLoadState("load");
  return { frame, key, scope, origin: location.origin, id };
}

/** A page of files (P081): in a frame its files' address is sealed, which its asset loads carry. */
const filesWith = (body: string, head = ""): Record<string, string> => ({
  "index.html": `<!doctype html><html><head><title>Files</title>${head}</head><body><main id="artifact">files</main><button id="go" style="width:200px;height:40px">go</button>${body}</body></html>`,
});

/** Runs `script` in the frame from a real click (a gesture-gated method), and its outcome. */
async function clicked(frame: Frame, script: string): Promise<unknown> {
  await frame.evaluate(
    `document.getElementById("go").onclick = () => { (async () => { ${script} })().then((value) => { window.clicked = { value }; }, (error) => { window.clicked = { code: error && error.code ? error.code : String(error && error.message) }; }); };`,
  );
  await frame.locator("#go").click();
  await expect
    .poll(() =>
      frame.evaluate(() =>
        JSON.stringify((window as unknown as { clicked?: unknown }).clicked ?? null),
      ),
    )
    .not.toBe("null");
  return frame.evaluate(() => (window as unknown as { clicked: unknown }).clicked);
}

/** A runtime call as content can send it, past the shell's namespace: the host's answer. */
const raw = (frame: Frame, params: Record<string, unknown>) =>
  frame.evaluate(
    (each) =>
      new Promise<{ result?: unknown; error?: { data?: { code?: string } } }>((resolve) => {
        const id = `raw-${Math.random()}`;
        const listen = (event: MessageEvent) => {
          const data = event.data as { id?: string } | null;
          if (event.source === window.parent && data !== null && data.id === id) {
            window.removeEventListener("message", listen);
            resolve(data as never);
          }
        };
        window.addEventListener("message", listen);
        window.parent.postMessage(
          { jsonrpc: "2.0", id, method: "porthole/call", params: each },
          "*",
        );
        setTimeout(() => resolve({ error: { data: { code: "no answer" } } }), 5_000);
      }),
    params,
  );

/** What a call through the namespace settles to: its value, or its error's code. */
const settled = (frame: Frame, script: string): Promise<unknown> =>
  frame.evaluate(
    `(async () => { ${script} })().then((value) => ({ value }), (error) => ({ code: error && error.code ? error.code : String(error && error.message) }))`,
  );

test.describe("porthole.use (P085)", () => {
  test("one global with use alone; built-ins and what the page declared, frozen; null for the rest", async ({
    page,
  }) => {
    const { frame } = await show(page, { declaration: { db: {} } });
    const seen = await frame.evaluate(async () => {
      const runtime = (
        window as unknown as { porthole: { use(name: string): Promise<object | null> } }
      ).porthole;
      const db = await runtime.use("db");
      const clipboard = await runtime.use("clipboard");
      return {
        keys: Object.keys(runtime),
        frozen: Object.isFrozen(runtime) && Object.isFrozen(db),
        db: db === null ? null : Object.keys(db).sort(),
        same: db === (await runtime.use("db")),
        clipboard: clipboard === null ? null : Object.keys(clipboard),
        artifact: await runtime.use("artifact"),
        user: await runtime.use("user"),
        nope: await runtime.use("nope"),
        replaced: (() => {
          try {
            (window as unknown as { porthole: unknown }).porthole = { use: () => 1 };
          } catch {
            // Strict mode in the page: an assignment to a fixed global throws.
          }
          return (
            typeof (window as unknown as { porthole: { use: unknown } }).porthole.use ===
              "function" &&
            (window as unknown as { porthole: { use: () => unknown } }).porthole.use() instanceof
              Promise
          );
        })(),
      };
    });
    expect(seen).toEqual({
      keys: ["use"],
      frozen: true,
      db: ["batch", "delete", "get", "onSnapshot", "query", "set", "update"],
      same: true,
      clipboard: ["copy"],
      artifact: null,
      user: null,
      nope: null,
      replaced: true,
    });
  });

  test("db end to end: set, get, a conflict, a query, a watch hearing another person's write", async ({
    page,
  }) => {
    const key = unique("shared");
    const scope = unique("rt");
    const ada = await show(page, { declaration: { db: {} }, key, scope });
    const bob = await show(page, {
      declaration: { db: {} },
      key,
      scope,
      viewer: { level: "interact", id: "bob" },
    });
    await ada.frame.evaluate(async () => {
      const db = await (
        window as unknown as {
          porthole: {
            use(n: string): Promise<{ onSnapshot(p: string, f: (s: unknown) => void): () => void }>;
          };
        }
      ).porthole.use("db");
      (window as unknown as { heard: unknown[] }).heard = [];
      db.onSnapshot("votes", (state) =>
        (window as unknown as { heard: unknown[] }).heard.push(state),
      );
    });
    const wrote = await settled(
      bob.frame,
      `
      const db = await porthole.use("db");
      const first = await db.set("votes/bob", { choice: "b" });
      let conflict = null;
      try { await db.set("votes/bob", { choice: "c" }); } catch (error) { conflict = error.code; }
      const second = await db.update("votes/bob", { choice: "c" }, { ifVersion: first.version });
      const got = await db.get("votes/bob");
      const found = await db.query("votes", { where: [["choice", "==", "c"]] });
      return { first, conflict, second, got, found: found.docs.map((doc) => doc.id) };
    `,
    );
    expect(wrote).toEqual({
      value: {
        first: { version: 1 },
        conflict: "conflict",
        second: { version: 2 },
        got: { path: "votes/bob", id: "bob", exists: true, version: 2, data: { choice: "c" } },
        found: ["bob"],
      },
    });
    await expect
      .poll(() =>
        ada.frame.evaluate(() =>
          JSON.stringify((window as unknown as { heard: unknown[] }).heard.at(-1)),
        ),
      )
      .toContain('"choice":"c"');
  });

  test("a page publishes a new version of itself from its base; a stale base is a conflict", async ({
    page,
  }) => {
    const { frame, key } = await show(page, {
      declaration: { artifact: {} },
      viewer: { level: "admin", id: "ann" },
    });
    // A publish needs the person's click and their yes (after the review): from a button.
    const result = await clicked(
      frame,
      `
      const artifact = await porthole.use("artifact");
      const current = await artifact.get();
      const next = await artifact.publish({ base: current.version, files: { "index.html": "<!doctype html><p>v2</p>", "data.bin": new Uint8Array([1, 2, 3]) }, label: "From the page" });
      let stale = null;
      try { await artifact.publish({ base: current.version, files: { "a.txt": "x" } }); } catch (error) { stale = error.code; }
      return { base: current.version, next, stale };
    `,
    );
    expect(result).toEqual({
      value: { base: "ver_1", next: { version: "ver_2", number: 2 }, stale: "conflict" },
    });
    const calls = await runtimeCalls(page, key);
    expect(calls.filter((each) => each.capability === "artifact")).toHaveLength(3);
  });

  test("an upload is served at /_blob/<id> on the page's own origin and loads in its frame", async ({
    page,
  }) => {
    // A page of files: in a frame, its asset loads carry its sealed address (P091).
    const { frame } = await show(page, {
      declaration: { assets: {} },
      viewer: { level: "admin", id: "ann" },
      files: filesWith(""),
    });
    // A 1x1 PNG, made in the page, uploaded, then shown by the url the upload gave.
    const shown = await settled(
      frame,
      `
      const assets = await porthole.use("assets");
      const canvas = document.createElement("canvas");
      canvas.width = 3; canvas.height = 2;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const asset = await assets.upload(blob, { name: "dot.png" });
      const img = new Image();
      img.src = assets.url(asset.id);
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error("no load")); });
      const listed = await assets.list();
      return { url: asset.url.replace(/[0-9a-f]{32}/u, "<id>"), type: asset.type, width: img.naturalWidth, listed: listed.length };
    `,
    );
    expect(shown).toEqual({
      value: { url: "/_blob/<id>", type: "image/png", width: 3, listed: 1 },
    });
  });
});

test.describe("a page reaches only what it declared, at its viewer's level (P086, P087)", () => {
  test("an undeclared capability: null from use, refused when sent anyway, its handler never asked", async ({
    page,
  }) => {
    const { frame, key } = await show(page, {
      declaration: { db: {} },
      viewer: { level: "owner", id: "olga" },
    });
    expect(
      await frame.evaluate(() =>
        (window as unknown as { porthole: { use(n: string): Promise<unknown> } }).porthole.use(
          "artifact",
        ),
      ),
    ).toBeNull();
    const publish = await raw(frame, {
      capability: "artifact",
      method: "publish",
      args: { base: "ver_1", files: { "index.html": { text: "<p>owned</p>" } } },
    });
    expect(publish.error?.data?.code).toBe("not_allowed");
    const asked = await raw(frame, { capability: "user", method: "get", args: {} });
    expect(asked.error?.data?.code).toBe("not_allowed");
    // 0.6's request for the host's data, from a page that declared db only.
    const read = await frame.evaluate(
      () =>
        new Promise<unknown>((resolve) => {
          const listen = (event: MessageEvent) => {
            if ((event.data as { id?: string } | null)?.id === "rd") {
              resolve((event.data as { error?: { data?: { code?: string } } }).error?.data?.code);
            }
          };
          window.addEventListener("message", listen);
          window.parent.postMessage(
            { jsonrpc: "2.0", id: "rd", method: "resources/read", params: { uri: "app://x" } },
            "*",
          );
        }),
    );
    expect(read).toBe("not_allowed");
    expect((await runtimeCalls(page, key)).map((each) => each.capability)).toEqual([]);
  });

  test("a method above the viewer's level: forbidden, its handler never asked", async ({
    page,
  }) => {
    const view = await show(page, {
      declaration: { db: {}, artifact: {} },
      viewer: { level: "view", id: "vic" },
    });
    expect(
      await settled(
        view.frame,
        `return (await porthole.use("db")).set("votes/vic", { choice: "a" });`,
      ),
    ).toEqual({ code: "forbidden" });
    expect(
      await settled(view.frame, `return (await porthole.use("db")).get("votes/vic");`),
    ).toMatchObject({ value: { exists: false } });
    const interact = await show(page, {
      declaration: { artifact: {} },
      viewer: { level: "interact", id: "ada" },
    });
    expect(
      await settled(
        interact.frame,
        `return (await porthole.use("artifact")).publish({ base: "ver_1", files: { "a.txt": "x" } });`,
      ),
    ).toEqual({ code: "forbidden" });
    const sent = await raw(interact.frame, {
      capability: "artifact",
      method: "publish",
      args: { base: "ver_1", files: { "a.txt": { text: "x" } } },
    });
    expect(sent.error?.data?.code).toBe("forbidden");
    expect(
      (await runtimeCalls(page, view.key)).map((each) => [
        each.capability,
        (each.args as { op: string }).op,
      ]),
    ).toEqual([["db", "get"]]);
    expect(await runtimeCalls(page, interact.key)).toEqual([]);
  });

  test("a resource outside the page's data names: refused with a viewer and without one, its handler never asked", async ({
    page,
  }) => {
    // The page's names are its declaration's word: no viewer is never a way past them (S03, P094).
    for (const viewer of [null, { level: "view", id: "vic" }]) {
      const { frame, key } = await show(page, {
        declaration: { data: { resources: ["app://allowed"] } },
        viewer,
      });
      const who = viewer === null ? "no viewer" : viewer.level;
      expect(
        await settled(frame, `return (await porthole.use("data")).read("app://outside-list");`),
        who,
      ).toEqual({ code: "not_allowed" });
      const sent = await raw(frame, {
        capability: "data",
        method: "read",
        args: { uri: "app://outside-list" },
      });
      expect(sent.error?.data?.code, who).toBe("not_allowed");
      expect(
        await settled(frame, `return (await porthole.use("data")).read("app://allowed");`),
        who,
      ).toEqual({ value: { n: 1 } });
      expect(
        (await runtimeCalls(page, key)).map((each) => (each.args as { uri: string }).uri),
        who,
      ).toEqual(["app://allowed"]);
    }
  });

  test("a read above the viewer's level: a result the host pushed is refused as a cold read is", async ({
    page,
  }) => {
    // Reads need admin, following needs view: a push the host sends answers no read the viewer
    // may not make (S04, P094).
    const { frame, key } = await show(page, {
      declaration: { data: { levels: { read: "admin" } } },
      viewer: { level: "interact", id: "ada" },
    });
    await frame.evaluate(`window.heard = []; window.failed = [];
      porthole.use("data").then((data) => data.subscribe("app://counter",
        (value) => window.heard.push(value), (error) => window.failed.push(error.code)));`);
    const failed = () =>
      frame.evaluate(() => (window as unknown as { failed: string[] }).failed.length);
    // The first read, cold: refused for its level.
    await expect.poll(failed).toBe(1);
    await page.evaluate(
      ([each]) =>
        (
          window as unknown as { runtimePushes: Map<string, (result: unknown) => void> }
        ).runtimePushes.get(`${each} app://counter`)?.({
          contents: [{ uri: "app://counter", mimeType: "application/json", text: '{"pushed":1}' }],
        }),
      [key],
    );
    // The read the push announced: refused the same.
    await expect.poll(failed).toBe(2);
    expect(
      await frame.evaluate(() => {
        const { heard, failed: codes } = window as unknown as {
          heard: unknown[];
          failed: string[];
        };
        return { heard, codes };
      }),
    ).toEqual({ heard: [], codes: ["forbidden", "forbidden"] });
    expect((await runtimeCalls(page, key)).map((each) => each.capability)).toEqual([
      "subscribeData",
    ]);
  });

  test("a person's own data is theirs: another person's is refused, never reaching the service", async ({
    page,
  }) => {
    const key = unique("shared");
    const scope = unique("rt");
    const ada = await show(page, {
      declaration: { db: {} },
      key,
      scope,
      viewer: { level: "interact", id: "ada" },
    });
    expect(
      await settled(
        ada.frame,
        `return (await porthole.use("db")).set("data/users/me/prefs", { secret: "ada's" });`,
      ),
    ).toEqual({ value: { version: 1 } });
    const bob = await show(page, {
      declaration: { db: {} },
      key,
      scope,
      viewer: { level: "interact", id: "bob" },
    });
    expect(
      await settled(bob.frame, `return (await porthole.use("db")).get("data/users/ada/prefs");`),
    ).toEqual({ code: "forbidden" });
    expect(
      await settled(bob.frame, `return (await porthole.use("db")).query("data/users/ada");`),
    ).toEqual({ code: "forbidden" });
    expect(
      await settled(bob.frame, `return (await porthole.use("db")).get("data/users/me/prefs");`),
    ).toMatchObject({ value: { exists: false } });
    const bobs = (await runtimeCalls(page, key)).filter((each) => each.viewer === "bob");
    expect(bobs.map((each) => (each.args as { path?: string }).path)).toEqual([
      "data/users/bob/prefs",
    ]);
  });

  test("comments are write-only: the composer opens from a click, content hears only that", async ({
    page,
  }) => {
    const { frame, key } = await show(page, {
      declaration: {},
      viewer: { level: "view", id: "vic" },
    });
    await frame.evaluate(async () => {
      const comments = await (
        window as unknown as {
          porthole: { use(n: string): Promise<{ open(a: unknown): Promise<unknown> } & object> };
        }
      ).porthole.use("comments");
      (window as unknown as { keys: string[] }).keys = Object.keys(comments);
      document.getElementById("go")?.addEventListener("click", () => {
        void comments.open({ name: "slide-3", label: "Slide 3" }).then(
          (value) => ((window as unknown as { opened: unknown }).opened = value),
          (error: { code?: string }) =>
            ((window as unknown as { opened: unknown }).opened = error.code),
        );
      });
    });
    await frame.locator("#go").click();
    await expect
      .poll(() =>
        frame.evaluate(() =>
          JSON.stringify((window as unknown as { opened?: unknown }).opened ?? null),
        ),
      )
      .not.toBe("null");
    expect(await frame.evaluate(() => (window as unknown as { opened: unknown }).opened)).toBe(
      false,
    );
    expect(await frame.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([
      "open",
    ]);
    expect(
      (await raw(frame, { capability: "comments", method: "list", args: {} })).error?.data?.code,
    ).toBe("not_allowed");
    expect((await runtimeCalls(page, key)).map((each) => each.capability)).toEqual(["comments"]);
  });
});

test.describe("the asset library (P089)", () => {
  /** A script asset of `artifact`'s library that marks the page it runs in. */
  async function scriptAsset(scope: string, artifact: string, trusted: boolean): Promise<string> {
    const served = await harness();
    const id = Array.from(
      { length: 32 },
      () => "0123456789abcdef"[Math.floor(Math.random() * 16)],
    ).join("");
    served.assets.set(
      id,
      storedAsset(
        scope,
        "mark.js",
        new TextEncoder().encode('document.documentElement.dataset.blob = "ran";'),
        { artifact, trusted },
      ),
    );
    return id;
  }

  test("a script asset runs as code only if an admin uploaded it where uploads are the admins'", async ({
    page,
  }) => {
    for (const [preset, trusted, runs] of [
      ["runtime", true, true],
      ["runtime", false, false],
      ["runtimeOpen", true, false],
    ] as const) {
      const scope = unique("rt");
      const pageId = unique("page");
      const id = await scriptAsset(scope, pageId, trusted);
      // Loaded at the frame's own address for it (P091), which every engine sends.
      const { frame } = await show(page, {
        preset,
        scope,
        id: pageId,
        declaration: { assets: {} },
        files: filesWith(
          `<script>porthole.use("assets").then((assets) => { const s = document.createElement("script"); s.src = assets.url("${id}"); document.head.append(s); });</script>`,
        ),
      });
      await frame.waitForLoadState("load");
      await page.waitForTimeout(500);
      const ran = await frame.evaluate(() => document.documentElement.dataset.blob ?? "");
      expect(ran, `${preset}, trusted ${trusted}`).toBe(runs ? "ran" : "");
    }
  });

  test("scripts load from /_blob/ only where uploads are the admins' (a tab, its session)", async ({
    context,
  }) => {
    const served = await harness();
    for (const [preset, runs] of [
      ["runtime", true],
      ["runtimeOpen", false],
    ] as const) {
      const scope = unique("rt");
      const pageId = unique("page");
      const id = await scriptAsset(scope, pageId, true);
      served.pages.set(
        `${pageId}@1`,
        `<!doctype html><html><head><title>Tab</title><script src="/_blob/${id}"></script></head><body><main id="artifact">tab</main></body></html>`,
      );
      const instance: InstanceRef = {
        scope,
        document: { kind: "artifact", id: pageId, version: "1", preset },
      };
      const location = await served.porthole.issue(instance, { viewer: "probe" });
      const tab = await context.newPage();
      await tab.goto(location.url);
      await tab.waitForTimeout(500);
      const ran = await tab.evaluate(() => document.documentElement.dataset.blob ?? "");
      expect(ran, preset).toBe(runs ? "ran" : "");
      await tab.close();
    }
  });

  test("a framed set's page loads /_blob/<id> by its own Referer where the engine sends one (measured)", async ({
    page,
    browserName,
  }) => {
    const served = await harness();
    const scope = unique("rt");
    const pageId = unique("page");
    const id = Array.from(
      { length: 32 },
      () => "0123456789abcdef"[Math.floor(Math.random() * 16)],
    ).join("");
    served.assets.set(
      id,
      storedAsset(
        scope,
        "dot.gif",
        Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (each) =>
          each.charCodeAt(0),
        ),
        { artifact: pageId },
      ),
    );
    const { frame } = await show(page, {
      scope,
      id: pageId,
      declaration: { assets: {} },
      files: filesWith(`<img id="dot" src="/_blob/${id}">`),
    });
    await page.waitForTimeout(500);
    const width = await frame.evaluate(
      () => (document.getElementById("dot") as HTMLImageElement).naturalWidth,
    );
    // WebKit sends a cross-site frame's same-origin requests only its origin as Referer: there a
    // page shows its assets by assets.url(id).
    expect(width).toBe(browserName === "webkit" ? 0 : 1);
  });

  test("an asset reaches only its own artifact's pages, and none without an access", async ({
    page,
  }) => {
    const served = await harness();
    const scope = unique("rt");
    const owner = unique("page");
    const id = await scriptAsset(scope, owner, true);
    // Another artifact on the same scope (one origin) loads none of it.
    const other = await show(page, {
      scope,
      declaration: { assets: {} },
      files: filesWith("", `<script src="/_blob/${id}"></script>`),
    });
    await page.waitForTimeout(300);
    expect(await other.frame.evaluate(() => document.documentElement.dataset.blob ?? "")).toBe("");
    // A request with no access at all: no.
    const bare = await served.porthole.handle(
      new Request(`${other.origin}/_blob/${id}`, {
        headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors" },
      }),
    );
    expect(bare?.status).toBe(401);
  });

  test("an asset opened on its own runs nothing, on a tab with the artifact's session", async ({
    context,
  }) => {
    const served = await harness();
    const scope = unique("rt");
    const pageId = unique("page");
    const id = Array.from(
      { length: 32 },
      () => "abcdef0123456789"[Math.floor(Math.random() * 16)],
    ).join("");
    served.assets.set(
      id,
      storedAsset(
        scope,
        "mark.svg",
        new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>document.documentElement.setAttribute("data-ran", "1")</script><rect width="10" height="10"/></svg>',
        ),
        { artifact: pageId },
      ),
    );
    served.pages.set(`${pageId}@1`, PAGE);
    const instance: InstanceRef = {
      scope,
      document: { kind: "artifact", id: pageId, version: "1", preset: "runtime" },
    };
    const location = await served.porthole.issue(instance, { viewer: "probe" });
    const tab = await context.newPage();
    // The ticket's page on a tab: its answer leaves the artifact's session cookie (P025).
    await tab.goto(location.url);
    const answer = await tab.goto(`${location.origin}/_blob/${id}`);
    expect(answer?.status()).toBe(200);
    expect(answer?.headers()["content-type"]).toBe("image/svg+xml");
    await tab.waitForTimeout(300);
    expect(await tab.evaluate(() => document.documentElement.getAttribute("data-ran"))).toBeNull();
    await tab.close();
  });

  test("a set's page loads the library too, in its frame (its files' address sealed, P083)", async ({
    page,
  }) => {
    const served = await harness();
    const scope = unique("rt");
    const pageId = unique("page");
    const id = Array.from(
      { length: 32 },
      () => "0123456789abcdef"[Math.floor(Math.random() * 16)],
    ).join("");
    // A 1x1 GIF.
    served.assets.set(
      id,
      storedAsset(
        scope,
        "dot.gif",
        Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (each) =>
          each.charCodeAt(0),
        ),
        { artifact: pageId },
      ),
    );
    const { frame } = await show(page, {
      scope,
      id: pageId,
      declaration: { assets: {}, db: {} },
      files: {
        "index.html": `<!doctype html><html><head><title>Set</title></head><body><main id="artifact">set</main><img id="dot"><script src="./app.js"></script></body></html>`,
        "app.js": `porthole.use("db").then((db) => { document.documentElement.dataset.db = db === null ? "null" : Object.keys(db).length; });
porthole.use("assets").then((assets) => { document.getElementById("dot").src = assets.url("${id}"); });`,
      },
    });
    await expect
      .poll(() =>
        frame.evaluate(() => (document.getElementById("dot") as HTMLImageElement).naturalWidth),
      )
      .toBe(1);
    await expect
      .poll(() => frame.evaluate(() => document.documentElement.dataset.db ?? ""))
      .toBe("7");
  });
});

test.describe("a 0.6 page without a declaration behaves as before (P085)", () => {
  test("under a config without the runtime: no porthole global, 0.6's globals", async ({
    page,
  }) => {
    const { frame } = await show(page, {
      preset: "artifactLegacy",
      declaration: null,
      viewer: null,
    });
    expect(
      await frame.evaluate(() => ({
        porthole: typeof (window as unknown as { porthole?: unknown }).porthole,
        copyText: typeof (window as unknown as { copyText?: unknown }).copyText,
        readData: typeof (window as unknown as { readData?: unknown }).readData,
      })),
    ).toEqual({ porthole: "undefined", copyText: "function", readData: "function" });
    expect(await settled(frame, "return readData('app://x');")).toEqual({ value: { n: 1 } });
  });

  test("under the runtime, with no declaration: 0.6's globals reach what they did; use gives built-ins only", async ({
    page,
  }) => {
    const { frame, key } = await show(page, { declaration: null, viewer: null });
    expect(await settled(frame, "return readData('app://x');")).toEqual({ value: { n: 1 } });
    expect(
      await frame.evaluate(async () => {
        const runtime = (window as unknown as { porthole: { use(n: string): Promise<unknown> } })
          .porthole;
        return {
          db: await runtime.use("db"),
          clipboard: (await runtime.use("clipboard")) !== null,
        };
      }),
    ).toEqual({ db: null, clipboard: true });
    expect((await runtimeCalls(page, key)).map((each) => each.capability)).toEqual(["readData"]);
  });

  test("on a tab, with no host, use resolves null at once", async ({ context }) => {
    const served = await harness();
    const pageId = unique("page");
    served.pages.set(`${pageId}@1`, PAGE);
    const instance: InstanceRef = {
      scope: unique("rt"),
      document: { kind: "artifact", id: pageId, version: "1", preset: "runtime" },
    };
    const location = await served.porthole.issue(instance, { viewer: "probe" });
    const tab = await context.newPage();
    await tab.goto(location.url);
    const timed = await tab.evaluate(async () => {
      const started = performance.now();
      const db = await (
        window as unknown as { porthole: { use(n: string): Promise<unknown> } }
      ).porthole.use("db");
      return { db, fast: performance.now() - started < 500 };
    });
    expect(timed).toEqual({ db: null, fast: true });
    await tab.close();
  });
});
