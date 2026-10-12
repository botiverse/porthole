import type { Page } from "@playwright/test";
import { presets, type PresetOptions } from "../presets/presets.ts";
import type { LaunchedDisplay, LaunchSpec } from "./index.ts";
import type { HttpOracle, ServedFile, UdpOracle } from "./oracles.ts";

/** What every probe is given, and the helpers they share. */

export interface ProbeContext {
  readonly page: Page;
  readonly engine: string;
  launch(spec: LaunchSpec): Promise<LaunchedDisplay>;
  /** A fresh HTTP oracle (serving `files` at their paths), closed after the probe. */
  http(files?: Readonly<Record<string, ServedFile>>): Promise<HttpOracle>;
  /** A fresh UDP oracle, closed after the probe. */
  udp(): Promise<UdpOracle>;
  /** Waits for the content's verdict (`window.portholeProbe`, set by `attack`) and returns it. */
  result(display: LaunchedDisplay, timeoutMs?: number): Promise<Record<string, unknown>>;
  /**
   * The URLs on `origin` that answered the page (any of its frames): requests that left the
   * browser and came back. A load the browser blocked itself never has a response.
   */
  requestsTo(origin: string): string[];
  /** Records a measured engine fact in the report. */
  measured(text: string): void;
  /**
   * Ends the probe as inapplicable on this host (reported as skipped, with the reason): what it
   * proves can't be observed here, through no fault of the host's isolation (P058).
   */
  inapplicable(reason: string): never;
}

export interface Probe {
  /** Stable id, `<item>.<channel>`: what `LeakSuiteOptions.skip` names. */
  readonly id: string;
  /**
   * The DESIGN.md egress-table item it proves; 0 for the shell's own wiring and interop, 11 for
   * behavior (streaming, sizing, theming), 12 for host-function gates, 13 for the clipboard, 14
   * for the manual's claims about the sandbox (`LIMIT_CHECKS`).
   */
  readonly item: number;
  readonly title: string;
  run(context: ProbeContext): Promise<void>;
}

/** A JS literal safe inside an inline `<script>` (no `</script>` can end it early). */
export const js = (value: unknown): string => JSON.stringify(value).replace(/</gu, "\\u003c");

/**
 * Content that runs `code` (an async body with `r`, its verdict, in scope) once the shell has
 * drawn it, then publishes `r` as `window.portholeProbe`. A `#marker` shows the content is still there.
 */
export function attack(code: string, markup = ""): string {
  return `<div id="marker">content</div>${markup}
<script>
(async () => {
  const r = {};
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Whether a policy blocks \`origin\` though the frame's own allows it: then it is the page's,
  // which an opaque frame inherits (P058). \`attempt\` loads something from it once more.
  const inheritedBlocks = async (origin, attempt) => {
    let blocked = false;
    const seen = (event) => { if (String(event.blockedURI).indexOf(origin) === 0) blocked = true; };
    document.addEventListener("securitypolicyviolation", seen);
    try { await attempt(); } catch (e) {}
    await wait(300);
    document.removeEventListener("securitypolicyviolation", seen);
    return blocked;
  };
  try {
${code}
  } catch (error) {
    r.error = String((error && error.message) || error);
  }
  r.done = true;
  window.portholeProbe = r;
})();
</script>`;
}

export const inline = (options: PresetOptions = {}) => presets.inlineWidget(options);
