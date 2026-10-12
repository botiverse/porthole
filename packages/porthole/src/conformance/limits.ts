import { expect, type Page } from "@playwright/test";
import type { LimitId } from "../guide/limits.ts";
import type { LaunchedDisplay } from "./index.ts";
import { presets } from "../presets/presets.ts";
import { resolveTheme } from "../theme/variables.ts";
import { attack, inline, js, type Probe } from "./kit.ts";
import { settle } from "./oracles.ts";

/**
 * The manual's claims about the sandbox, each proven in a real browser (item 14, P064). Every
 * limit the manual can state (`manualLimits`) names the checks that prove it here (`LIMIT_CHECKS`);
 * a unit test fails if it names none, so a new line can't go untested. Where engines differ, the
 * check holds the safe common behavior the manual states and records what each engine did.
 */

/** A real click in the display (the user activation a person's click gives). */
async function click(display: LaunchedDisplay, selector: string): Promise<void> {
  await (await display.frame()).locator(selector).click();
}

/** What the content recorded in `window.r`, once `done` is set. */
async function recorded(
  display: LaunchedDisplay,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const frame = await display.frame();
  await expect
    .poll(
      () =>
        frame
          .evaluate(() => (window as unknown as { r?: { done?: boolean } }).r?.done === true)
          .catch(() => false),
      { timeout: timeoutMs },
    )
    .toBe(true);
  return frame.evaluate(() => (window as unknown as { r: Record<string, unknown> }).r);
}

/** Counts what the page shows the person beyond the frame: dialogs, downloads, new windows. */
function watch(page: Page): { dialogs: string[]; downloads: string[]; windows: string[] } {
  const seen = { dialogs: [] as string[], downloads: [] as string[], windows: [] as string[] };
  page.on("dialog", (dialog) => {
    seen.dialogs.push(dialog.type());
    void dialog.dismiss().catch(() => {});
  });
  page.on("download", (download) => seen.downloads.push(download.suggestedFilename()));
  page.context().on("page", (opened) => seen.windows.push(opened.url()));
  return seen;
}

/** A WAV of silence, small enough to inline. */
const SILENCE =
  "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

const RECORDER = "<script>window.r = {};</script>";

export const LIMIT_PROBES: readonly Probe[] = [
  {
    id: "14.fill",
    item: 14,
    title:
      "a layout that fills: the frame is its box's height, the page scrolls itself, position: fixed stays put",
    async run(context) {
      const display = await context.launch({
        config: presets.artifact({ layout: { kind: "fill" } }),
        heightPx: 400,
        content: `<!doctype html><html><head><title>Tall</title></head><body style="margin:0">
<header id="bar" style="position:fixed;top:0;left:0;right:0;height:30px">bar</header>
<div style="height:2000px">tall</div></body></html>`,
      });
      const frame = await display.frame();
      await expect(frame.locator("#bar")).toBeAttached();
      await expect.poll(async () => Math.round((await display.box()).height)).toBe(400);
      await frame.evaluate(() => window.scrollTo(0, 600));
      const seen = await frame.evaluate(() => ({
        scrolled: window.scrollY,
        scrolls: document.documentElement.scrollHeight > window.innerHeight,
        barTop: Math.round(
          (document.getElementById("bar") as HTMLElement).getBoundingClientRect().top,
        ),
      }));
      expect(seen).toEqual({ scrolled: 600, scrolls: true, barTop: 0 });
      await settle(500);
      expect(Math.round((await display.box()).height), "it doesn't grow with its content").toBe(
        400,
      );
    },
  },
  {
    id: "14.theme-never",
    item: 14,
    title:
      "a page the host doesn't theme stays light, whatever the person's scheme, and hears no change",
    async run(context) {
      const config = presets.artifact({ theme: { documents: "never" } });
      const light = resolveTheme(config.theme, "light");
      const display = await context.launch({
        config,
        scheme: "dark",
        content: `<!doctype html><html><head><meta name="color-scheme" content="light dark"><title>Light</title></head><body><p id="p">text</p>
<script>window.events = 0; addEventListener("porthole:theme", () => (window.events += 1));</script></body></html>`,
      });
      const frame = await display.frame();
      await expect(frame.locator("#p")).toHaveText("text");
      await display.setTheme("dark");
      await settle(500);
      const seen = await frame.evaluate(() => ({
        theme: document.documentElement.dataset.theme ?? null,
        text: getComputedStyle(document.documentElement)
          .getPropertyValue("--color-text-primary")
          .trim(),
        events: (window as unknown as { events: number }).events,
        prefers: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      }));
      expect(seen.theme).toBeNull();
      expect(seen.text).toBe(light["--color-text-primary"]);
      expect(seen.events).toBe(0);
      const element = await frame.frameElement();
      expect(await element.evaluate((node) => (node as HTMLElement).style.colorScheme)).toBe(
        "light",
      );
      context.measured(`prefers-color-scheme inside, the person on dark: ${seen.prefers}`);
    },
  },
  {
    id: "14.errors",
    item: 14,
    title:
      "what content throws reaches the host where reportError is declared, and nothing where it isn't",
    async run(context) {
      const thrower = `<p>x</p><script>throw new Error("porthole-thrown")</script>`;
      const reported = await context.launch({
        config: inline({ errors: "host" }),
        content: thrower,
      });
      await expect
        .poll(async () =>
          (await reported.errors()).some(
            (each) => each.includes("porthole-thrown") || each.includes("Script error"),
          ),
        )
        .toBe(true);
      const quiet = await context.launch({ config: inline({ errors: "none" }), content: thrower });
      await expect((await quiet.frame()).locator("p")).toHaveText("x");
      await settle(800);
      expect(await quiet.errors()).toEqual([]);
    },
  },
  {
    id: "14.silent",
    item: 14,
    title:
      "what the sandbox blocks fails silently: nothing loads, a fetch rejects, nothing is shown",
    async run(context) {
      const canary = await context.http();
      const seen = watch(context.page);
      const c = canary.origin;
      const display = await context.launch({
        config: inline(),
        content: attack(
          `
    r.fetch = await fetch(${js(`${c}/fetch`)}).then(() => "sent", (e) => "rejected " + e.name);
    const image = document.getElementById("img");
    r.image = await new Promise((resolve) => { if (image.complete) resolve(image.naturalWidth > 0 ? "loaded" : "failed"); image.addEventListener("load", () => resolve("loaded")); image.addEventListener("error", () => resolve("failed")); setTimeout(() => resolve("pending"), 3000); });
    r.script = typeof window.__portholeBlocked;
    r.after = "ran";`,
          `<img id="img" src="${c}/img.png"><link rel="stylesheet" href="${c}/style.css"><script src="${c}/script.js"></script>`,
        ),
      });
      const verdict = await context.result(display, 15_000);
      await settle();
      expect(verdict).toMatchObject({
        fetch: "rejected TypeError",
        image: "failed",
        script: "undefined",
        after: "ran",
      });
      expect(canary.requests()).toEqual([]);
      expect(seen.dialogs).toEqual([]);
    },
  },
  {
    id: "14.inline-assets",
    item: 14,
    title: "assets inline as data: URLs and CSS in a <style> work where nothing outside is open",
    async run(context) {
      const canary = await context.http();
      const pixel =
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      const display = await context.launch({
        config: inline(),
        content: attack(
          `
    const image = document.getElementById("inline");
    r.inline = await new Promise((resolve) => { if (image.complete && image.naturalWidth > 0) resolve("loaded"); image.addEventListener("load", () => resolve("loaded")); image.addEventListener("error", () => resolve("failed")); setTimeout(() => resolve("pending"), 3000); });
    r.styled = getComputedStyle(document.getElementById("styled")).width;`,
          `<style>#styled { width: 37px }</style><div id="styled"></div><img id="inline" src="${pixel}"><img src="${canary.origin}/outside.png">`,
        ),
      });
      const verdict = await context.result(display);
      await settle();
      expect(verdict).toMatchObject({ inline: "loaded", styled: "37px" });
      expect(canary.requests()).toEqual([]);
    },
  },
  {
    id: "14.dialogs",
    item: 14,
    title: "alert, confirm and prompt show nothing: confirm returns false, prompt null",
    async run(context) {
      const seen = watch(context.page);
      const display = await context.launch({
        config: inline(),
        content: `<button id="go">Ask</button>${RECORDER}<script>
  document.getElementById("go").addEventListener("click", () => {
    const started = Date.now();
    r.alert = String(alert("Hello"));
    r.confirm = String(confirm("Sure?"));
    r.prompt = String(prompt("Name?", "default"));
    r.ms = Date.now() - started;
    r.done = true;
  });
</script>`,
      });
      await click(display, "#go");
      const verdict = await recorded(display);
      expect(verdict).toMatchObject({ alert: "undefined", confirm: "false", prompt: "null" });
      expect(verdict.ms as number).toBeLessThan(1_000);
      expect(seen.dialogs).toEqual([]);
    },
  },
  {
    id: "14.print",
    item: 14,
    title: "window.print() does nothing",
    async run(context) {
      const seen = watch(context.page);
      const display = await context.launch({
        config: inline(),
        content: `<button id="go">Print</button>${RECORDER}<script>
  addEventListener("beforeprint", () => (r.beforeprint = true));
  addEventListener("afterprint", () => (r.afterprint = true));
  document.getElementById("go").addEventListener("click", () => {
    r.print = String(print());
    setTimeout(() => (r.done = true), 800);
  });
</script>`,
      });
      await click(display, "#go");
      const verdict = await recorded(display);
      expect(verdict.print).toBe("undefined");
      expect(verdict.beforeprint).toBeUndefined();
      expect(verdict.afterprint).toBeUndefined();
      expect(seen.dialogs).toEqual([]);
    },
  },
  {
    id: "14.downloads",
    item: 14,
    title: "downloads don't work: <a download>, data: and blob: links, saves from script",
    async run(context) {
      const seen = watch(context.page);
      const display = await context.launch({
        config: inline(),
        content: `<a id="data" download="a.txt" href="data:text/plain,hello">data</a>
<button id="blob">blob</button><button id="script">script</button>
<script>
  const save = (name) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["hi"], { type: "text/plain" })); a.download = name; document.body.append(a); a.click(); };
  document.getElementById("blob").addEventListener("click", () => save("b.txt"));
  document.getElementById("script").addEventListener("click", () => { try { location.href = URL.createObjectURL(new Blob(["x"], { type: "application/octet-stream" })); } catch (e) {} });
</script>`,
      });
      for (const selector of ["#data", "#blob", "#script"]) {
        await click(display, selector);
      }
      await settle(1_000);
      expect(seen.downloads).toEqual([]);
    },
  },
  {
    id: "14.forms",
    item: 14,
    title: "forms never submit anywhere; a button's click handler is how a form works",
    async run(context) {
      const canary = await context.http();
      const display = await context.launch({
        config: inline(),
        content: `<form id="form" action="${canary.origin}/submit"><input name="q" value="secret"><button id="submit">Send</button><button id="button" type="button">Apply</button></form>${RECORDER}<script>
  document.getElementById("form").addEventListener("submit", () => (r.submitEvent = (r.submitEvent || 0) + 1));
  document.getElementById("button").addEventListener("click", () => (r.clicked = true));
</script>`,
      });
      await click(display, "#submit");
      await click(display, "#button");
      await settle(800);
      const frame = await display.frame();
      const state = await frame.evaluate(() => ({
        r: (window as unknown as { r: Record<string, unknown> }).r,
        form: document.getElementById("form") !== null,
      }));
      expect(state.form, "the frame stayed on its content").toBe(true);
      expect(state.r.clicked).toBe(true);
      expect(canary.requests()).toEqual([]);
      context.measured(`submit event fired: ${JSON.stringify(state.r.submitEvent ?? 0)} time(s)`);
    },
  },
  {
    id: "14.link-schemes",
    item: 14,
    title: "mailto:, tel: and sms: links open nothing",
    async run(context) {
      const seen = watch(context.page);
      const display = await context.launch({
        config: inline({ capabilities: { openLink: {} } }),
        content: `<a id="mail" href="mailto:someone@example.com">mail</a> <a id="tel" href="tel:+15551234567">tel</a> <a id="sms" href="sms:+15551234567">sms</a><p id="still">still here</p>`,
      });
      for (const selector of ["#mail", "#tel", "#sms"]) {
        await click(display, selector);
      }
      await settle(800);
      await expect((await display.frame()).locator("#still")).toHaveText("still here");
      expect(seen.windows).toEqual([]);
      expect(await display.calls(), "nothing went to the host").toEqual([]);
    },
  },
  {
    id: "14.windows",
    item: 14,
    title:
      "window.open and target=_blank open no window; with openLink, a link goes through the app",
    async run(context) {
      const seen = watch(context.page);
      const content = `<a id="blank" href="https://example.com/report" target="_blank">report</a><button id="open">open</button>${RECORDER}<script>
  document.getElementById("open").addEventListener("click", () => {
    try { r.open = window.open("https://example.com/") === null ? "null" : "window"; } catch (e) { r.open = "throws"; }
    r.done = true;
  });
</script>`;
      const closed = await context.launch({ config: inline(), content });
      await click(closed, "#open");
      const verdict = await recorded(closed);
      expect(["null", "throws"]).toContain(verdict.open);
      context.measured(`window.open: ${String(verdict.open)}`);
      await click(closed, "#blank");
      await settle(800);
      expect(seen.windows).toEqual([]);
      // With openLink declared, the link asks the app instead (the person says no here).
      const linked = await context.launch({
        config: inline({ capabilities: { openLink: {} } }),
        content,
      });
      await click(linked, "#blank");
      const asked = await linked.answerNextConfirmation(false);
      expect(asked).toMatchObject({
        capability: "openLink",
        args: { url: "https://example.com/report" },
      });
      await settle(500);
      expect(seen.windows).toEqual([]);
    },
  },
  {
    id: "14.devices",
    item: 14,
    title: "camera, microphone, location and sharing are denied without asking; files can be read",
    async run(context) {
      const seen = watch(context.page);
      const display = await context.launch({
        config: inline(),
        content: `<button id="go">Ask</button><input id="file" type="file">${RECORDER}<script>
  const settle = (p) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve("waiting"), 4000))]);
  document.getElementById("go").addEventListener("click", async () => {
    r.media = navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? await settle(navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(() => "granted", (e) => "rejected " + e.name)) : "absent";
    r.location = navigator.geolocation ? await settle(new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve("granted"), (e) => resolve("denied " + e.code)))) : "absent";
    r.share = typeof navigator.share === "function" ? await settle(navigator.share({ text: "x" }).then(() => "shared", (e) => "rejected " + e.name)) : "absent";
    r.asked = true;
  });
  document.getElementById("file").addEventListener("change", (event) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => { r.file = reader.result; r.done = r.asked === true; });
    reader.readAsText(event.target.files[0]);
  });
</script>`,
      });
      await click(display, "#go");
      const frame = await display.frame();
      await expect
        .poll(
          () =>
            frame.evaluate(
              () => (window as unknown as { r: { asked?: boolean } }).r.asked === true,
            ),
          {
            timeout: 15_000,
          },
        )
        .toBe(true);
      await frame.locator("#file").setInputFiles({
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("file text"),
      });
      const verdict = await recorded(display);
      expect(String(verdict.media)).toMatch(/^(rejected|absent)/u);
      expect(String(verdict.location)).toMatch(/^(denied 1|absent)$/u);
      expect(String(verdict.share)).toMatch(/^(rejected|absent)/u);
      expect(verdict.file).toBe("file text");
      expect(seen.dialogs).toEqual([]);
      context.measured(
        `camera/microphone: ${String(verdict.media)}; share: ${String(verdict.share)}`,
      );
    },
  },
  {
    id: "14.workers",
    item: 14,
    title: "Web Workers from blob: work; service workers can't be registered; WebRTC is gone",
    async run(context) {
      const display = await context.launch({
        config: inline(),
        content: attack(`
    r.blobBlocked = false;
    document.addEventListener("securitypolicyviolation", (event) => { if (String(event.blockedURI).indexOf("blob") === 0) r.blobBlocked = true; });
    r.worker = await new Promise((resolve) => { try { const worker = new Worker(URL.createObjectURL(new Blob(["postMessage(6 * 7)"], { type: "text/javascript" }))); worker.addEventListener("message", (event) => resolve("answered " + event.data)); worker.addEventListener("error", () => resolve("error")); } catch (e) { resolve("throws " + e.name); } setTimeout(() => resolve("silent"), 3000); });
    try {
      r.serviceWorker = !navigator.serviceWorker ? "absent" : await navigator.serviceWorker.register("worker.js").then(() => "registered", (e) => "rejected " + e.name);
    } catch (e) { r.serviceWorker = "throws " + e.name; }
    r.rtc = typeof RTCPeerConnection;`),
      });
      const verdict = await context.result(display);
      // The frame's own policy allows blob: workers: a violation for one is the page's (P058).
      if (verdict.worker !== "answered 42" && verdict.blobBlocked === true) {
        context.inapplicable(
          "the page's own CSP, which an opaque frame inherits, blocks blob: workers (worker-src falls back to its script-src): opaque content here gets no workers, whatever its config",
        );
      }
      expect(verdict.worker).toBe("answered 42");
      expect(String(verdict.serviceWorker)).toMatch(/^(absent|rejected|throws)/u);
      expect(verdict.rtc).toBe("undefined");
      context.measured(`service worker: ${String(verdict.serviceWorker)}`);
    },
  },
  {
    id: "14.sound",
    item: 14,
    title: "sound plays from a click",
    async run(context) {
      const display = await context.launch({
        config: inline(),
        content: `<button id="go">Play</button>${RECORDER}<script>
  new Audio(${js(SILENCE)}).play().then(() => (r.unasked = "played"), (e) => (r.unasked = "refused " + e.name));
  document.getElementById("go").addEventListener("click", () => {
    new Audio(${js(SILENCE)}).play().then(() => { r.clicked = "played"; r.done = true; }, (e) => { r.clicked = "refused " + e.name; r.done = true; });
  });
</script>`,
      });
      await settle(500);
      await click(display, "#go");
      const verdict = await recorded(display);
      expect(verdict.clicked, "play() in a click's handler").toBe("played");
      context.measured(`play() without a click: ${String(verdict.unasked)}`);
    },
  },
  {
    id: "14.address",
    item: 14,
    title: "an opaque frame's address is about:srcdoc, with no query string or hash",
    async run(context) {
      const display = await context.launch({
        config: inline(),
        content: attack(`
    r.href = location.href;
    r.search = location.search;
    r.hash = location.hash;`),
      });
      expect(await context.result(display)).toMatchObject({
        href: "about:srcdoc",
        search: "",
        hash: "",
      });
    },
  },
  {
    id: "14.shell",
    item: 14,
    title:
      "document.write and open throw; nested frames are removed; full screen and the clipboard are closed",
    async run(context) {
      const display = await context.launch({
        config: inline(),
        content: `<button id="go">Go</button>${RECORDER}<script>
  document.getElementById("go").addEventListener("click", async () => {
    try { document.write("<p>x</p>"); r.write = "wrote"; } catch (e) { r.write = "throws"; }
    try { document.open(); r.open = "opened"; } catch (e) { r.open = "throws"; }
    const frame = document.createElement("iframe");
    document.body.append(frame);
    await new Promise((resolve) => setTimeout(resolve, 100));
    r.frames = document.querySelectorAll("iframe, object, embed").length;
    r.fullscreen = await document.documentElement.requestFullscreen().then(() => "entered", (e) => "rejected");
    r.clipboard = navigator.clipboard ? await navigator.clipboard.writeText("x").then(() => "wrote", () => "rejected") : "absent";
    r.done = true;
  });
</script>`,
      });
      await click(display, "#go");
      expect(await recorded(display)).toMatchObject({
        write: "throws",
        open: "throws",
        frames: 0,
        fullscreen: "rejected",
      });
      expect(["rejected", "absent"]).toContain((await recorded(display)).clipboard);
    },
  },
  {
    id: "14.storage",
    item: 14,
    title:
      "storage in an opaque frame works while it is shown and is its own: no other frame reads it",
    async run(context) {
      const first = await context.launch({
        config: inline(),
        content: attack(`
    localStorage.setItem("porthole-limits", "first");
    r.read = localStorage.getItem("porthole-limits");`),
      });
      expect((await context.result(first)).read).toBe("first");
      const second = await context.launch({
        config: inline(),
        content: attack(`r.read = String(localStorage.getItem("porthole-limits"));`),
      });
      expect((await context.result(second)).read, "another frame's storage").toBe("null");
    },
  },
];

/**
 * The checks that prove each limit the manual can state: leak-suite probes, and served cases for
 * what holds in domain mode. A unit test fails if a limit names none, or one that doesn't exist.
 */
export const LIMIT_CHECKS: { readonly [Id in LimitId]: readonly string[] } = {
  layout: ["11.size", "14.fill"],
  theme: ["11.theme-flip", "11.document-theme", "14.theme-never"],
  errors: ["14.errors"],
  silent: ["14.silent"],
  network: ["1.connect", "2.resources"],
  "inline-assets": ["14.inline-assets"],
  dialogs: ["14.dialogs"],
  print: ["14.print"],
  downloads: ["14.downloads", "6.download"],
  forms: ["14.forms"],
  "link-schemes": ["14.link-schemes"],
  windows: ["14.windows", "6.open"],
  devices: ["14.devices"],
  workers: ["14.workers", "3.webrtc"],
  sound: ["14.sound"],
  address: ["14.address", "served.domain.address"],
  shell: ["14.shell", "4.document-write", "4.light-dom"],
  storage: ["14.storage", "served.domain.storage-scope"],
};
