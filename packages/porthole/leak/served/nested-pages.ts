import { expect, type Frame, type Page } from "@playwright/test";
import type { PortholeConfig } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { storedFiles } from "./files.ts";
import { harness } from "./harness.ts";
import { mount, outcomeOf } from "./porthole-host.ts";

/**
 * A nested page's cases' helpers (P111): the page, the host's own UI above it, what the page says
 * over the console and the display tells the host. Every gesture in the cases is a real one; see
 * nested.spec.ts.
 */

let count = 0;
export const unique = (name: string): string => `${name}-${process.pid}-${(count += 1)}`;

export const STOPPED = "The content kept taking the keyboard from the page; it was stopped.";

/** The page: a field, a button and a target at fixed places, its words on the console. */
export const pageOf = (
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

export interface Shown {
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
export async function hostUi(page: Page): Promise<void> {
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
export async function listen(page: Page): Promise<void> {
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

export const seen = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          seen: { taken: boolean[]; errors: string[]; storage: boolean[]; activated: string[] };
        }
      ).seen,
  );
export const composerText = (page: Page) =>
  page.evaluate(() => (document.getElementById("host-composer") as HTMLTextAreaElement).value);
export const hostActive = (page: Page) =>
  page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || null);
/** A message from the host page to the page, through the shell (`event.source` its parent). */
export const tell = (page: Page, message: Record<string, unknown>) =>
  page.evaluate((data) => {
    document
      .querySelector<HTMLIFrameElement>("#displays iframe")
      ?.contentWindow?.postMessage(data, "*");
  }, message);

/** Shows a nested page (`script` runs in it) under the reference services, the host's UI above. */
export async function show(
  page: Page,
  script = "",
  before?: () => Promise<void>,
  /** More files of the page's set, beside its `index.html`. */
  files: Readonly<Record<string, string>> = {},
  /**
   * The page's scope; default a new one. A case that mounts other displays of the same scope beside
   * it names one (P114: the gap a fresh scope per case hid, porthole#56).
   */
  scope: string = unique("nest"),
): Promise<Shown> {
  const served = await harness();
  const id = unique("page");
  served.fileSets.set(`${id}@1`, storedFiles({ ...files, "index.html": pageOf(script) }));
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

/**
 * Until a fight over the keyboard is over: the display stopped, or the host's composer holding
 * focus; at most `ms`. It decides nothing (a control that takes the guard out leaves the fight
 * on): the probes after it do.
 */
export async function fightOver(page: Page, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (
      (await seen(page)).errors.includes(STOPPED) ||
      (await hostActive(page)) === "host-composer"
    ) {
      return;
    }
    await page.waitForTimeout(100);
  }
}

export const field = (shown: Shown) => ({ x: shown.box.x + 130, y: shown.box.y + 40 });
export const button = (shown: Shown) => ({ x: shown.box.x + 120, y: shown.box.y + 110 });
export const composer = { x: 100, y: 30 };
export const hostButton = { x: 60, y: 85 };
export const valueOf = (shown: Shown): string => {
  const value = shown.said.filter((each) => each.type === "value").at(-1)?.value;
  return typeof value === "string" ? value : "";
};
