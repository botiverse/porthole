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
      "probe: use gave an undeclared capability",
    ).toBeNull();
    const publish = await raw(frame, {
      capability: "artifact",
      method: "publish",
      args: { base: "ver_1", files: { "index.html": { text: "<p>owned</p>" } } },
    });
    expect(publish.error?.data?.code, "probe: an undeclared publish was refused").toBe(
      "not_allowed",
    );
    const asked = await raw(frame, { capability: "user", method: "get", args: {} });
    expect(asked.error?.data?.code, "probe: an undeclared user read was refused").toBe(
      "not_allowed",
    );
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
    expect(read, "probe: 0.6's data read was refused").toBe("not_allowed");
    expect(
      (await runtimeCalls(page, key)).map((each) => each.capability),
      "probe: no handler was asked",
    ).toEqual([]);
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
      "probe: a viewer's db write was refused",
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
      "probe: an interactor's publish was refused",
    ).toEqual({ code: "forbidden" });
    const sent = await raw(interact.frame, {
      capability: "artifact",
      method: "publish",
      args: { base: "ver_1", files: { "a.txt": { text: "x" } } },
    });
    expect(sent.error?.data?.code, "probe: an interactor's publish sent anyway was refused").toBe(
      "forbidden",
    );
    expect(
      (await runtimeCalls(page, view.key)).map((each) => [
        each.capability,
        (each.args as { op: string }).op,
      ]),
      "probe: only the viewer's db read reached a handler",
    ).toEqual([["db", "get"]]);
    expect(await runtimeCalls(page, interact.key), "probe: no publish reached a handler").toEqual(
      [],
    );
  });

  test("a resource outside the page's data names: refused with a viewer and without one, its handler never asked", async ({
    page,
  }) => {
    // The page's names are its declaration's word: no viewer is never a way past them (S03, P094).
    // Each viewer's case runs whatever an earlier one found (soft), so a control that takes out
    // only the no-viewer branch is seen to leave the case with a viewer passing.
    for (const viewer of [{ level: "view", id: "vic" }, null]) {
      const { frame, key } = await show(page, {
        declaration: { data: { resources: ["app://allowed"] } },
        viewer,
      });
      const who = viewer === null ? "no viewer" : viewer.level;
      expect
        .soft(
          await settled(frame, `return (await porthole.use("data")).read("app://outside-list");`),
          `probe: ${who}`,
        )
        .toEqual({ code: "not_allowed" });
      const sent = await raw(frame, {
        capability: "data",
        method: "read",
        args: { uri: "app://outside-list" },
      });
      expect.soft(sent.error?.data?.code, `probe: ${who}`).toBe("not_allowed");
      expect
        .soft(
          await settled(frame, `return (await porthole.use("data")).read("app://allowed");`),
          who,
        )
        .toEqual({ value: { n: 1 } });
      expect
        .soft(
          (await runtimeCalls(page, key)).map((each) => (each.args as { uri: string }).uri),
          `probe: ${who}`,
        )
        .toEqual(["app://allowed"]);
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
    await expect.poll(failed, { message: "probe: the cold read was refused" }).toBe(1);
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
    await expect.poll(failed, { message: "probe: the pushed read was refused" }).toBe(2);
    expect(
      await frame.evaluate(() => {
        const { heard, failed: codes } = window as unknown as {
          heard: unknown[];
          failed: string[];
        };
        return { heard, codes };
      }),
      "probe: content heard no result, both reads forbidden",
    ).toEqual({ heard: [], codes: ["forbidden", "forbidden"] });
    expect(
      (await runtimeCalls(page, key)).map((each) => each.capability),
      "probe: no read reached a handler",
    ).toEqual(["subscribeData"]);
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
      "probe: another person's get was refused",
    ).toEqual({ code: "forbidden" });
    expect(
      await settled(bob.frame, `return (await porthole.use("db")).query("data/users/ada");`),
      "probe: another person's query was refused",
    ).toEqual({ code: "forbidden" });
    expect(
      await settled(bob.frame, `return (await porthole.use("db")).get("data/users/me/prefs");`),
      "probe: a person's own data is not another's",
    ).toMatchObject({ value: { exists: false } });
    const bobs = (await runtimeCalls(page, key)).filter((each) => each.viewer === "bob");
    expect(
      bobs.map((each) => (each.args as { path?: string }).path),
      "probe: only the person's own path reached the service",
    ).toEqual(["data/users/bob/prefs"]);
  });

  test("a comment's draft is the host's to check: past the limit, holding what a person can't see, or not text, it opens no composer (P108)", async ({
    page,
  }) => {
    const { frame, key } = await show(page, {
      declaration: {},
      viewer: { level: "view", id: "vic" },
    });
    // Each from its own click, the last outcome cleared first (clicked() waits for a new one).
    const open = async (options: string) => {
      await frame.evaluate(() => delete (window as unknown as { clicked?: unknown }).clicked);
      return clicked(
        frame,
        `const comments = await porthole.use("comments"); return comments.open({ name: "card-2" }, ${options});`,
      );
    };
    const refused = [
      await open(`{ draft: "Appro\\u200Bved" }`),
      await open(`{ draft: "Approved" + String.fromCodePoint(0xE0049, 0xE0067, 0xE006E) }`),
      await open(`{ draft: "x".repeat(2001) }`),
      await open(`{ draft: 42 }`),
      await open(`"Approved"`),
    ];
    expect(
      refused.map((each) => (each as { code?: unknown }).code ?? "opened"),
      "probe: no such draft opened the composer (an invalid call reads as not_allowed to content)",
    ).toEqual(["not_allowed", "not_allowed", "not_allowed", "not_allowed", "not_allowed"]);
    expect(
      (await runtimeCalls(page, key)).filter((each) => each.capability === "comments"),
      "probe: no such draft reached the host's handler",
    ).toEqual([]);
    // A checklist is text a person can see: it reaches the host's composer (the harness's answers false).
    await open(`{ draft: "Approved\\n- [ ] tests" }`);
    expect(
      (await runtimeCalls(page, key)).map((each) => each.args),
      "a checklist reaches the composer",
    ).toEqual([{ anchor: { name: "card-2" }, draft: "Approved\n- [ ] tests" }]);
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
          porthole: {
            use(n: string): Promise<{ open(a: unknown, o?: unknown): Promise<unknown> } & object>;
          };
        }
      ).porthole.use("comments");
      (window as unknown as { keys: string[] }).keys = Object.keys(comments);
      document.getElementById("go")?.addEventListener("click", () => {
        void comments.open({ name: "slide-3", label: "Slide 3" }, { draft: "Approved" }).then(
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
    expect(
      await frame.evaluate(() => (window as unknown as { opened: unknown }).opened),
      "probe: content heard only whether the composer opened",
    ).toBe(false);
    expect(
      await frame.evaluate(() => (window as unknown as { keys: string[] }).keys),
      "probe: comments has open alone",
    ).toEqual(["open"]);
    expect(
      (await raw(frame, { capability: "comments", method: "list", args: {} })).error?.data?.code,
      "probe: a comments list was refused",
    ).toBe("not_allowed");
    expect(
      (await runtimeCalls(page, key)).map((each) => each.capability),
      "probe: only the open reached a handler",
    ).toEqual(["comments"]);
    expect(
      (await runtimeCalls(page, key))[0]?.args,
      "probe: the draft reached the composer as given, beside the anchor",
    ).toEqual({ anchor: { name: "slide-3", label: "Slide 3" }, draft: "Approved" });
  });
});

/** A page with a text field first (a Tab from the host's composer lands in it), then a button. */
const KEYS_PAGE = `<!doctype html><html><head><title>Keys</title></head><body><input id="field" style="width:200px"><button id="go" style="width:200px;height:40px">go</button><main id="artifact">runtime</main></body></html>`;

/**
 * The host's own composer, before the displays (so a Tab from it goes into the frame), and what
 * the display tells the host about the keyboard (P109): each `focusTaken`, and content errors.
 */
const hostComposer = (page: Page) =>
  page.evaluate(() => {
    const box = document.createElement("textarea");
    box.id = "host-composer";
    box.style.cssText = "width:300px;height:60px";
    document.body.prepend(box);
    const w = window as unknown as {
      keyboard: { taken: boolean[]; errors: string[] };
      portholeHost: { displays: { on(event: string, listener: (detail: never) => void): void }[] };
    };
    w.keyboard = { taken: [], errors: [] };
    const display = w.portholeHost.displays.at(-1);
    display?.on("focusTaken", (detail: { typing: boolean }) =>
      w.keyboard.taken.push(detail.typing),
    );
    display?.on("contentError", (detail: { message: string }) =>
      w.keyboard.errors.push(detail.message),
    );
  });
const keyboardOf = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { keyboard: { taken: boolean[]; errors: string[] } }).keyboard,
  );
const composerText = (page: Page) =>
  page.evaluate(() => (document.getElementById("host-composer") as HTMLTextAreaElement).value);
const hostActive = (page: Page) => page.evaluate(() => document.activeElement?.tagName ?? null);

test.describe("the person at the keyboard (P109)", () => {
  test.setTimeout(60_000);

  test("a page that takes the keyboard while the person types in the host's composer gets a key or two at most, and is stopped", async ({
    page,
  }) => {
    const { frame } = await show(page, { html: KEYS_PAGE });
    await hostComposer(page);
    // The pointer rests over the frame, as after the person selected words in it; the composer
    // then takes focus beside it (a host's composer opening on `selected`).
    const box = await page.locator("#displays iframe").boundingBox();
    await page.mouse.move((box?.x ?? 0) + 120, (box?.y ?? 0) + 60, { steps: 4 });
    // The page moves the keyboard into its own field, again and again, with no gesture of its own.
    await frame.evaluate(() => {
      const field = document.getElementById("field") as HTMLInputElement;
      setInterval(() => field.focus(), 500);
    });
    await page.evaluate(() => document.getElementById("host-composer")?.focus());
    const text = "my unposted comment about the chart";
    await page.keyboard.type(text, { delay: 120 });
    await page.waitForTimeout(300);
    const typed = await composerText(page);
    const { taken, errors } = await keyboardOf(page);
    expect(
      text.length - typed.length,
      `probe: the composer kept the person's words but a key or two (got ${JSON.stringify(typed)})`,
    ).toBeLessThanOrEqual(2);
    expect(taken.length, "focusTaken heard").toBeGreaterThan(0);
    expect(errors, "probe: the display that kept taking the keyboard was stopped").toContain(
      "The content kept taking the keyboard from the page; it was stopped.",
    );
  });

  test("a page that takes the keyboard back on its own blur keeps none of it: the composer keeps its words, and comments.open reaches no handler", async ({
    page,
  }) => {
    const { frame, key } = await show(page, {
      html: KEYS_PAGE,
      declaration: {},
      viewer: { level: "view", id: "vic" },
    });
    await hostComposer(page);
    // Once this evaluate's activation has lapsed (it is a gesture in the frame), the page holds its
    // field and takes focus back whenever it loses it (the take-back blurs it), with no gesture or
    // timer of its own (the review of the guard, GK-1: on Firefox this kept every key), and from
    // the first time it loses it asks for the composer every 400 ms.
    await frame.evaluate(() => {
      const field = document.getElementById("field") as HTMLInputElement;
      const focus = () => field.focus();
      const w = window as unknown as {
        porthole: {
          use(name: string): Promise<{ open(a: unknown, o: unknown): Promise<unknown> }>;
        };
      };
      const ask = () =>
        setInterval(() => {
          void w.porthole
            .use("comments")
            .then((comments) => comments.open({ name: "card-5" }, { draft: "Approved." }))
            .catch(() => {});
        }, 400);
      setTimeout(() => {
        field.addEventListener("blur", focus);
        field.addEventListener("blur", ask, { once: true });
        addEventListener("blur", focus);
        focus();
      }, 5_500);
    });
    // Where the composer is, read now: Playwright's own checks before a locator's click run a
    // script in the page, which Firefox takes for a gesture (activation with no event of the page's).
    const box = await page.locator("#host-composer").boundingBox();
    await page.waitForTimeout(5_800);
    // The person clicks into the composer.
    await page.mouse.click((box?.x ?? 0) + 20, (box?.y ?? 0) + 20);
    const text = "my unposted comment to the team";
    await page.keyboard.type(text, { delay: 100 });
    await page.waitForTimeout(500);
    const typed = await composerText(page);
    const { errors } = await keyboardOf(page);
    const opened = (await runtimeCalls(page, key)).filter((each) => each.capability === "comments");
    expect(
      text.length - typed.length,
      // On Firefox the keys typed while a take-back is fought go to nothing or the frame (measured:
      // one to the frame at most).
      `probe: the composer kept the person's words but a few keys (got ${JSON.stringify(typed)})`,
    ).toBeLessThanOrEqual(3);
    expect(
      opened.map((each) => each.args),
      "probe: no open from the page holding the keyboard reached the handler",
    ).toEqual([]);
    expect(
      errors.includes("The content kept taking the keyboard from the page; it was stopped.") ||
        (await hostActive(page)) === "TEXTAREA",
      "probe: the page doesn't keep the keyboard: focus is back in the composer, or the display was stopped",
    ).toBe(true);
  });

  test("a composer the host focuses with focusField, beside a page with the person's gesture that takes focus back on its blur, gets their words", async ({
    page,
  }) => {
    const { frame } = await show(page, { html: `${KEYS_PAGE}<p id="words">words to select</p>` });
    await hostComposer(page);
    await frame.evaluate(() => {
      const field = document.getElementById("field") as HTMLInputElement;
      const focus = () => field.focus();
      field.addEventListener("blur", focus);
      addEventListener("blur", focus);
    });
    // The person selects words in the page (their gesture, the frame's focus), and the host opens
    // its composer focused (Firefox ignores a plain focus() here: measured).
    await frame.locator("#artifact").click({ clickCount: 2 });
    await page.evaluate(() =>
      setTimeout(() => {
        const composer = document.getElementById("host-composer") as HTMLTextAreaElement;
        (window as unknown as { portholeFocusField(field: HTMLElement): void }).portholeFocusField(
          composer,
        );
      }, 50),
    );
    await page.waitForTimeout(400);
    const text = "my unposted comment about it";
    await page.keyboard.type(text, { delay: 100 });
    await page.waitForTimeout(300);
    const typed = await composerText(page);
    expect(
      text.length - typed.length,
      `probe: the composer got the person's words but a key or two (got ${JSON.stringify(typed)})`,
    ).toBeLessThanOrEqual(2);
  });

  test("the person's own moves into the frame keep the keyboard: a press on its field, a Tab, an activation that sends the host no event", async ({
    page,
  }, info) => {
    const { frame } = await show(page, { html: KEYS_PAGE });
    await hostComposer(page);
    const field = () =>
      frame.evaluate(() => (document.getElementById("field") as HTMLInputElement).value);
    // A press on the page's field, after typing in the host's composer.
    await page.locator("#host-composer").click();
    await page.keyboard.type("ab");
    await frame.locator("#field").click();
    await page.keyboard.type("xy");
    await page.waitForTimeout(300);
    expect(await hostActive(page), "a press moved focus into the frame, and it stayed").toBe(
      "IFRAME",
    );
    expect(await composerText(page), "the composer kept its own").toBe("ab");
    // Firefox focuses the frame's document but not its field on that press, with or without the
    // guard (measured): the keys go to the frame, not to the field.
    if (info.project.name !== "firefox") {
      expect(await field(), "typed into the page's field after a press on it").toBe("xy");
    }
    // A Tab from the composer into the frame.
    await page.locator("#host-composer").click();
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);
    await page.keyboard.type("t");
    await page.waitForTimeout(300);
    expect(await hostActive(page), "a Tab moved focus into the frame, and it stayed").toBe(
      "IFRAME",
    );
    expect(await composerText(page), "the key after the Tab didn't go to the composer").toBe("ab");
    // An activation in the frame that sends the host's page no event (as an assistive technology's
    // is; Playwright's evaluate is a gesture in the frame on all three engines, measured), once the
    // composer has had focus and the host no gesture for longer than activation lasts.
    await page.locator("#host-composer").click();
    await page.waitForTimeout(5_500);
    await frame.evaluate(() => (document.getElementById("field") as HTMLInputElement).focus());
    await page.waitForTimeout(500);
    expect(
      await hostActive(page),
      "an activation in the frame moved focus there, and it stayed",
    ).toBe("IFRAME");
    expect((await keyboardOf(page)).taken, "nothing was taken back").toEqual([]);
  });

  test("comments.open while the person types in the host's composer reaches no handler, by the page's own call or the shell's; from a press in the frame it does", async ({
    page,
  }) => {
    const { frame, key } = await show(page, {
      html: KEYS_PAGE,
      declaration: {},
      viewer: { level: "view", id: "vic" },
    });
    await hostComposer(page);
    await page.locator("#host-composer").click();
    // Every 400 ms, past the shell (a raw call) and through it (Firefox gives a frame activation
    // while the person types in the host's page: measured).
    await frame.evaluate(() => {
      const w = window as unknown as {
        poll: number;
        porthole: {
          use(name: string): Promise<{ open(a: unknown, o: unknown): Promise<unknown> }>;
        };
      };
      let n = 0;
      w.poll = setInterval(() => {
        n += 1;
        parent.postMessage(
          {
            jsonrpc: "2.0",
            id: `poll-${n}`,
            method: "porthole/call",
            params: {
              capability: "comments",
              method: "open",
              args: { anchor: { name: "card-2", label: "Card 2" }, draft: "Approved. Ship it." },
            },
          },
          "*",
        );
        void w.porthole
          .use("comments")
          .then((comments) => comments.open({ name: "card-3" }, { draft: "Approved." }))
          .catch(() => {});
      }, 400) as unknown as number;
    });
    await page.keyboard.type("my own words about the chart, still typing", { delay: 100 });
    const during = (await runtimeCalls(page, key)).filter((each) => each.capability === "comments");
    await frame.evaluate(() => clearInterval((window as unknown as { poll: number }).poll));
    expect(
      during.map((each) => each.args),
      "probe: no open reached the handler while the person typed in the host's composer",
    ).toEqual([]);
    // The person presses the page's button: its open reaches the composer.
    await clicked(
      frame,
      `const comments = await porthole.use("comments"); return comments.open({ name: "card-4" }, { draft: "Approved" });`,
    );
    expect(
      (await runtimeCalls(page, key)).map((each) => each.args),
      "a press in the frame opens the composer",
    ).toEqual([{ anchor: { name: "card-4" }, draft: "Approved" }]);
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
        // The script's own load or error event says the attempt is over (a script runs before
        // its load event), so the case reads the result then, not after a fixed wait (P098).
        files: filesWith(
          `<script>porthole.use("assets").then((assets) => { const s = document.createElement("script"); s.src = assets.url("${id}"); s.onload = s.onerror = (event) => { document.documentElement.dataset.settled = event.type; }; document.head.append(s); });</script>`,
        ),
      });
      await expect
        .poll(() => frame.evaluate(() => document.documentElement.dataset.settled ?? ""), {
          message: `probe: ${preset}, trusted ${trusted}: the script's load`,
        })
        .toBe(runs ? "load" : "error");
      const ran = await frame.evaluate(() => document.documentElement.dataset.blob ?? "");
      expect(ran, `probe: ${preset}, trusted ${trusted}`).toBe(runs ? "ran" : "");
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
      expect(ran, `probe: ${preset}`).toBe(runs ? "ran" : "");
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
    expect(
      await tab.evaluate(() => document.documentElement.getAttribute("data-ran")),
      "probe: the asset's script ran",
    ).toBeNull();
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
