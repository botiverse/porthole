import { declaredCapabilities, egressOrigins, sandboxTokens } from "../compile/policy.ts";
import type { CapabilityName } from "../config/capabilities.ts";
import type { PortholeConfig } from "../config/schema.ts";
import { shellPlan } from "../shell/plan.ts";

/**
 * The sandbox's limits as the manual states them (P064): each a short line, derived from the
 * config, for what silently changes how content behaves. Every limit has an id, and the
 * conformance suite has a named check for each (`LIMIT_CHECKS`), so the manual can't claim what
 * no browser test proves. What differs by engine is stated as the behavior safe on all of them.
 */

export const LIMIT_IDS = [
  "layout",
  "theme",
  "silent",
  "network",
  "inline-assets",
  "dialogs",
  "print",
  "downloads",
  "forms",
  "link-schemes",
  "windows",
  "devices",
  "workers",
  "sound",
  "address",
  "shell",
  "storage",
  "errors",
] as const;

export type LimitId = (typeof LIMIT_IDS)[number];

/** Where the manual states a limit: where it runs, the sandbox list, or the interactive topic. */
export type LimitTopic = "where" | "sandbox" | "interactive";

export interface ManualLimit {
  readonly id: LimitId;
  readonly text: string;
  readonly topic: LimitTopic;
}

const TOPICS: { readonly [Id in LimitId]: LimitTopic } = {
  layout: "where",
  theme: "where",
  storage: "interactive",
  errors: "interactive",
  silent: "sandbox",
  network: "sandbox",
  "inline-assets": "sandbox",
  dialogs: "sandbox",
  print: "sandbox",
  downloads: "sandbox",
  forms: "sandbox",
  "link-schemes": "sandbox",
  windows: "sandbox",
  devices: "sandbox",
  workers: "sandbox",
  sound: "sandbox",
  address: "sandbox",
  shell: "sandbox",
};

const noun = (config: PortholeConfig): string =>
  config.mode === "artifact" ? "page" : config.mode === "mcp-app" ? "view" : "widget";

/** Whether content may load `kind` from somewhere outside (listed origins, or any https site). */
const opens = (config: PortholeConfig, kind: "img" | "style" | "font" | "media"): boolean =>
  egressOrigins(config, kind).length > 0 ||
  (config.egress.anyHttps ?? []).some((each) => each === kind);

/**
 * The limits the manual states for `config`, in the order it states them. `network` is the
 * caller's (the egress line, from the CSP's own sources); `storage` goes in the interactive topic.
 * Url mode has no shell and no manual: none.
 */
export function manualLimits(config: PortholeConfig, network: string): ManualLimit[] {
  if (config.mode === "url") {
    return [];
  }
  const tokens = sandboxTokens(config);
  const declared = new Set<CapabilityName>(declaredCapabilities(config));
  const globals = new Set(shellPlan(config)?.globals ?? []);
  const it = noun(config);
  const out: ManualLimit[] = [];
  const add = (id: LimitId, text: string | null) => {
    if (text !== null) {
      out.push({ id, text, topic: TOPICS[id] });
    }
  };

  // Where it runs (P065): a card that grows with its content, or the whole viewer.
  add(
    "layout",
    config.layout.kind === "fill"
      ? "It is as tall as the viewer, not the window: the page scrolls itself, and position: fixed and sticky work."
      : declared.has("resize")
        ? `Its height follows its content, at most ${config.limits.maxHeightPx.toLocaleString("en-US")} px (then it scrolls inside).`
        : "Its height is fixed by the app: keep it short, or let it scroll inside.",
  );
  const documents = config.theme.documents ?? "declared";
  add(
    "theme",
    config.mode !== "artifact" || documents === "always"
      ? "It runs in the person's light or dark theme."
      : documents === "never"
        ? "It always shows in light: the app doesn't theme it, so style it yourself; prefers-color-scheme may report the reader's system setting, so don't rely on it."
        : 'It shows in light, as you style it; to follow the person\'s light or dark theme, declare it in its head (<meta name="color-scheme" content="light dark">) and draw with the variables below.',
  );

  // What a block does on the page, and where it is reported: as the Errors line says (#4).
  const blocked = "a blocked script, style or image just doesn't load and a blocked fetch rejects";
  add(
    "silent",
    !declared.has("reportError")
      ? "What the sandbox blocks fails silently: a blocked script, style or image just doesn't load, a blocked fetch rejects, and nothing shows an error."
      : config.errors === "agent"
        ? `What the sandbox blocks shows nothing on the page: ${blocked}. Each block comes back to you as an error, so check them.`
        : config.errors === "host"
          ? `What the sandbox blocks shows nothing on the page: ${blocked}. The app is told of each block, but you aren't: test what you write.`
          : `What the sandbox blocks shows nothing on the page: ${blocked}. Each block is reported to the app.`,
  );
  add("network", network);
  // Assets: what isn't opened goes inline (Network: none already says "everything inline").
  const anywhere = (kind: "img" | "font" | "media") =>
    (config.egress.anyHttps ?? []).some((each) => each === kind);
  const passive = (["img", "font", "media"] as const).filter((kind) => !anywhere(kind));
  const listed = passive.some((kind) => opens(config, kind)) || opens(config, "style");
  const anyOpen =
    listed ||
    egressOrigins(config, "script").length > 0 ||
    egressOrigins(config, "connect").length > 0 ||
    passive.length < 3;
  if (anyOpen) {
    const images =
      passive.length === 0
        ? null
        : passive.every((kind) => !opens(config, kind))
          ? "images, icons, fonts and sound go inline (data: URLs or SVG)"
          : "images, fonts and sound from anywhere not listed go inline (data: URLs or SVG)";
    const css = opens(config, "style") ? "other CSS goes in a <style>" : "CSS goes in a <style>";
    const said = [images, css].filter((each) => each !== null).join("; ");
    add("inline-assets", `${said.charAt(0).toUpperCase()}${said.slice(1)}.`);
  }
  if (!tokens.includes("allow-modals")) {
    add(
      "dialogs",
      "alert, confirm and prompt show nothing: confirm returns false and prompt null. Draw your own dialogs.",
    );
    add("print", "window.print() does nothing.");
  }
  if (!tokens.includes("allow-downloads")) {
    add(
      "downloads",
      `Downloads don't work: <a download>, data: and blob: links, saves from script.${!declared.has("downloadFile") ? "" : config.runtime !== undefined ? " To give the person a file: downloads.save (topic capabilities)." : " To give the person a file, ask the app (ui/download-file; with the App SDK, app.downloadFile)."}`,
    );
  }
  if (!tokens.includes("allow-forms")) {
    add(
      "forms",
      'Forms never submit, and some browsers fire no submit event: use them as UI, give buttons type="button" and handle their click.',
    );
  }
  add(
    "link-schemes",
    `mailto:, tel: and sms: links open nothing: show the address or number as text${globals.has("copyText") || (config.runtime !== undefined && declared.has("copyText")) ? " (with a copy button)" : ""}.`,
  );
  if (!tokens.includes("allow-popups")) {
    add(
      "windows",
      globals.has("openLink") || declared.has("openLink")
        ? `window.open and target=_blank open no window (window.open returns null or throws): links open in a new tab through the app (${config.runtime === undefined ? "openLink" : "links.open"}; a click on <a href> does it).`
        : "Links to other pages, window.open and target=_blank open nothing (window.open returns null or throws).",
    );
  }
  add(
    "devices",
    "Camera, microphone, location and sharing are denied without asking (they reject, or aren't there); file inputs and FileReader work.",
  );
  add(
    "workers",
    "Web Workers from blob: URLs work; service workers can't be registered (even reading navigator.serviceWorker can throw), and WebRTC is gone.",
  );
  add("sound", "Sound (and video with sound) plays only from a click: call play() in its handler.");
  add(
    "address",
    config.isolation === "opaque"
      ? `The ${it}'s address is about:srcdoc: it has no query string or hash to read.`
      : `The ${it}'s address is its own (with Porthole's one-time ticket), never the app's: read no parameters from it.`,
  );
  add(
    "shell",
    `document.write and document.open throw; nested frames (iframe, object, embed) are removed; full screen and the clipboard are closed${globals.has("copyText") ? " (copy buttons call copyText)" : config.runtime !== undefined && declared.has("copyText") ? " (copy buttons call clipboard.copy)" : ""}.`,
  );
  add(
    "storage",
    config.isolation === "opaque"
      ? `State isn't saved: localStorage works but lasts only while the ${it} is on screen, and a reload or another device starts fresh. Keep what matters in the ${it}'s code.`
      : config.storage?.scope !== undefined
        ? `localStorage is kept for ${config.storage.scope}, in this browser; another browser or device starts fresh. Reads and writes can throw (private windows, strict settings): wrap them in try/catch and keep only what can be lost.`
        : config.storage?.shared === undefined
          ? `localStorage is kept for this ${it} in this browser; another device starts fresh. Reads and writes can throw (private windows, strict settings): wrap them in try/catch and keep only what can be lost.`
          : `localStorage is shared by every ${it} in this ${config.storage.shared}, in this browser (another device starts fresh): prefix your keys with a name of this ${it}'s own ("budget:filters", not "filters"), or ${it}s overwrite each other. Reads and writes can throw (private windows, strict settings): wrap them in try/catch and keep only what can be lost.`,
  );
  // Where the content's errors go (P065): never promise feedback that doesn't come.
  const reports = config.limits.maxErrorReports;
  const rate = (config.capabilities.reportError?.gates ?? [{ rateLimit: { perMinute: 10 } }]).find(
    (gate): gate is { readonly rateLimit: { readonly perMinute: number } } =>
      typeof gate === "object",
  );
  const atMost = rate === undefined ? "" : ` At most ${rate.rateLimit.perMinute} a minute.`;
  add(
    "errors",
    !declared.has("reportError")
      ? "Errors: nothing reports what your code throws, to you or the app: test what you write."
      : config.errors === "agent"
        ? `Errors: what your code throws, and anything the sandbox blocks, comes back to you (at most ${reports} a run), so you can fix it.${atMost}`
        : config.errors === "host"
          ? `Errors: what your code throws, and anything the sandbox blocks, goes to the app (at most ${reports} a run), not to you: test what you write.${atMost}`
          : `Errors: what your code throws, and anything the sandbox blocks, is reported to the app (at most ${reports} a run).${atMost}`,
  );
  return out;
}

/** A byte limit in words: KB under a megabyte, MB above. */
export function sizeWords(bytes: number): string {
  return bytes < 1_000_000
    ? `${Math.floor(bytes / 1000)} KB`
    : `${Math.round((bytes / 1_048_576) * 10) / 10} MB`;
}
