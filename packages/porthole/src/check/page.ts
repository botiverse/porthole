import type { ColorScheme, PortholeConfig } from "../config/schema.ts";
import { createHost } from "../host/create-host.ts";
import type { DisplayHandle } from "../host/types.ts";

/**
 * The check page (P073): runs content in the real sandbox (the core's `createHost`, the config's
 * own CSP) at one width and scheme at a time, and hears what happens inside from a small script
 * the check puts first in the content: what it throws, what the sandbox blocks, what fails to
 * load, what it logs, and its width. Bundled into one script (`@botiverse/porthole/check/page`)
 * that `checkPage` loads into a blank page through its driver.
 */

export interface CheckRunSpec {
  readonly config: PortholeConfig;
  readonly content: string;
  readonly widthPx: number;
  readonly heightPx?: number;
  readonly scheme: ColorScheme;
  readonly hostTheme?: Readonly<Record<string, string>>;
}

export interface CheckRunData {
  readonly errors: string[];
  readonly blocked: { readonly url: string; readonly directive: string }[];
  readonly failedLoads: { readonly url: string; readonly tag: string }[];
  readonly console: { readonly level: "error" | "warning"; readonly text: string }[];
  readonly height: number | null;
  readonly scrollWidth: number | null;
  readonly clientWidth: number | null;
  readonly outcome: string | null;
}

/** Put first in the content: it reports to the page that frames it. */
export const INSTRUMENT = `<script>(() => {
  const send = (kind, data) => { try { parent.postMessage({ portholeCheck: kind, data }, "*"); } catch (_) {} };
  const text = (value) => { try { return String(value && value.stack ? value.message || value : value); } catch (_) { return "?"; } };
  for (const [method, level] of [["error", "error"], ["warn", "warning"]]) {
    const original = console[method];
    console[method] = (...args) => { send("console", { level, text: args.map(text).join(" ").slice(0, 400) }); return original.apply(console, args); };
  }
  addEventListener("error", (event) => {
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      send("load", { url: String(target.src || target.href).slice(0, 400), tag: String(target.tagName || "").toLowerCase() });
    } else if (event.message || event.error) {
      const where = event.lineno ? " (line " + event.lineno + ")" : "";
      send("error", (event.error && event.error.message ? (event.error.name || "Error") + ": " + event.error.message : String(event.message)).slice(0, 400) + where);
    }
  }, true);
  addEventListener("unhandledrejection", (event) => send("error", ("Unhandled rejection: " + text(event.reason)).slice(0, 400)));
  addEventListener("securitypolicyviolation", (event) => send("blocked", { url: String(event.blockedURI || "inline").slice(0, 400), directive: String(event.effectiveDirective) }));
  addEventListener("message", (event) => {
    if (event.source === parent && event.data && event.data.portholeCheck === "measure") {
      const root = document.documentElement;
      send("measure", { scrollWidth: Math.max(root.scrollWidth, document.body ? document.body.scrollWidth : 0), clientWidth: root.clientWidth });
    }
  });
})();</script>`;

/** The content with the instrument first: after a document's <head>, or before a fragment. */
export function instrumented(content: string): string {
  const head = /<head[^>]*>/iu.exec(content);
  if (head !== null) {
    const at = head.index + head[0].length;
    return `${content.slice(0, at)}${INSTRUMENT}${content.slice(at)}`;
  }
  const html = /<html[^>]*>/iu.exec(content);
  if (html !== null) {
    const at = html.index + html[0].length;
    return `${content.slice(0, at)}<head>${INSTRUMENT}</head>${content.slice(at)}`;
  }
  return /^\s*<!doctype/iu.test(content)
    ? content.replace(/^(\s*<!doctype[^>]*>)/iu, `$1${INSTRUMENT}`)
    : `${INSTRUMENT}${content}`;
}

interface Run {
  readonly display: DisplayHandle;
  readonly box: HTMLElement;
  readonly data: {
    errors: string[];
    blocked: { url: string; directive: string }[];
    failedLoads: { url: string; tag: string }[];
    console: { level: "error" | "warning"; text: string }[];
    height: number | null;
    scrollWidth: number | null;
    clientWidth: number | null;
    outcome: string | null;
  };
}

const runs = new Map<number, Run>();
let next = 0;

const frameOf = (run: Run) => run.box.querySelector("iframe");

addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { portholeCheck?: unknown; data?: unknown } | null;
  if (data === null || typeof data !== "object" || typeof data.portholeCheck !== "string") {
    return;
  }
  for (const run of runs.values()) {
    if (frameOf(run)?.contentWindow !== event.source) {
      continue;
    }
    const said = data.data as Record<string, unknown>;
    switch (data.portholeCheck) {
      case "error":
        run.data.errors.push(String(data.data));
        break;
      case "blocked":
        run.data.blocked.push({ url: String(said.url), directive: String(said.directive) });
        break;
      case "load":
        run.data.failedLoads.push({ url: String(said.url), tag: String(said.tag) });
        break;
      case "console":
        run.data.console.push({
          level: said.level === "warning" ? "warning" : "error",
          text: String(said.text),
        });
        break;
      case "measure":
        run.data.scrollWidth = Number(said.scrollWidth);
        run.data.clientWidth = Number(said.clientWidth);
        break;
      default:
        break;
    }
  }
});

const check = {
  /** Shows the content at one width and scheme; returns its run id. */
  run(spec: CheckRunSpec): number {
    const id = next;
    next += 1;
    const box = document.createElement("section");
    box.id = `porthole-check-${id}`;
    box.style.cssText = `width:${spec.widthPx}px;${spec.heightPx === undefined ? "" : `height:${spec.heightPx}px;`}`;
    document.body.append(box);
    const theme = spec.hostTheme ?? {};
    const display = createHost(spec.config, {
      theme: () => theme,
      hostInfo: { name: "porthole-check", version: "1" },
    }).mount(box, {
      displayId: `check-${id}`,
      title: "Check",
      scheme: spec.scheme,
    });
    const run: Run = {
      display,
      box,
      data: {
        errors: [],
        blocked: [],
        failedLoads: [],
        console: [],
        height: null,
        scrollWidth: null,
        clientWidth: null,
        outcome: null,
      },
    };
    display.on("resize", ({ height }) => {
      run.data.height = height;
    });
    display.on("outcome", (outcome) => {
      run.data.outcome = outcome.state === "blocked" ? `blocked: ${outcome.reason}` : outcome.state;
    });
    runs.set(id, run);
    display.on("initialized", () => display.setContent(instrumented(spec.content)));
    return id;
  },
  /** Asks the frame for its width; resolves when it answers (or after a second). */
  async measure(id: number): Promise<void> {
    const run = runs.get(id);
    const frame = run === undefined ? null : frameOf(run);
    if (run === undefined || frame?.contentWindow === null || frame === null) {
      return;
    }
    frame.contentWindow.postMessage({ portholeCheck: "measure" }, "*");
    const started = Date.now();
    while (run.data.scrollWidth === null && Date.now() - started < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },
  /** What the run saw. */
  result(id: number): CheckRunData | null {
    return runs.get(id)?.data ?? null;
  },
  /** Removes a run's display. */
  end(id: number): void {
    const run = runs.get(id);
    run?.display.destroy();
    run?.box.remove();
    runs.delete(id);
  },
};

export type CheckPageApi = typeof check;

(window as unknown as { portholeCheck: CheckPageApi }).portholeCheck = check;
document.documentElement.dataset.portholeCheck = "ready";
