import type { PageDeclaration } from "../runtime/declaration.ts";
import type { ColorScheme, PortholeConfig } from "../config/schema.ts";
import type { InstanceRef } from "../isolation/types.ts";

/**
 * What the check puts in the content it runs (P073, P074): a small script first that reports
 * what happens inside to the page that frames it, and a name on each inline script so an error
 * says the line in the content as written. Pure: the check (any runtime) and its page both use it.
 */

export interface CheckRunSpec {
  readonly config: PortholeConfig;
  readonly content: string;
  /** Where each inline script's text starts in the content as written (file lines), by index. */
  readonly scriptLines: readonly number[];
  /** A served config's instance (located through the check's own server), else opaque. */
  readonly instance?: InstanceRef;
  /** Under a runtime: the page's declaration (null: none). */
  readonly declaration?: PageDeclaration | null;
  readonly widthPx: number;
  readonly heightPx?: number;
  readonly scheme: ColorScheme;
  readonly hostTheme?: Readonly<Record<string, string>>;
}

/**
 * A host function the content called (P074): `answered` where the call reached the check's stub
 * (which answers no, as a declining host would), else the refusal a host's gates gave it
 * (`no-user-activation` for a call on load, `declined` where a person was asked).
 */
export interface CheckCall {
  readonly capability: string;
  readonly outcome: string;
}

export interface CheckRunData {
  readonly errors: string[];
  readonly calls: CheckCall[];
  readonly blocked: { readonly url: string; readonly directive: string }[];
  readonly failedLoads: { readonly url: string; readonly tag: string }[];
  readonly console: { readonly level: "error" | "warning"; readonly text: string }[];
  readonly height: number | null;
  readonly scrollWidth: number | null;
  readonly clientWidth: number | null;
  readonly outcome: string | null;
}

/** Each inline script's name (`//# sourceURL`): its index in the content. */
export const SCRIPT_NAME = "porthole-script-";

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
      const error = event.error;
      send("error", {
        message: (error && error.message ? (error.name || "Error") + ": " + error.message : String(event.message)).slice(0, 400),
        file: String(event.filename || ""),
        line: event.lineno || 0,
        stack: error && error.stack ? String(error.stack).slice(0, 1000) : "",
      });
    }
  }, true);
  addEventListener("unhandledrejection", (event) => send("error", {
    message: ("Unhandled rejection: " + text(event.reason)).slice(0, 400),
    file: "", line: 0,
    stack: event.reason && event.reason.stack ? String(event.reason.stack).slice(0, 1000) : "",
  }));
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

/**
 * The content with each inline script named (`//# sourceURL=porthole-script-<n>`, after its
 * last line, so no line moves), and where each one's text starts in the content as written.
 */
export function namedScripts(content: string): { content: string; scriptLines: number[] } {
  const scriptLines: number[] = [];
  const named = content.replace(
    /(<script\b(?![^>]*\bsrc\s*=)[^>]*>)([\s\S]*?)(<\/script>)/giu,
    (whole, open: string, body: string, close: string, offset: number) => {
      const index = scriptLines.length;
      scriptLines.push(content.slice(0, offset + open.length).split("\n").length);
      return `${open}${body}\n//# sourceURL=${SCRIPT_NAME}${index}\n${close}`;
    },
  );
  return { content: named, scriptLines };
}

/**
 * An error's line in the content as written: from its script's name (the event's file, or its
 * stack's first frame there) and its line in that script; null where it can't be told.
 */
export function contentLine(
  error: { readonly file: string; readonly line: number; readonly stack: string },
  scriptLines: readonly number[],
): number | null {
  const named = new RegExp(`${SCRIPT_NAME}(\\d+)(?::(\\d+))?`, "u");
  const fromFile = named.exec(error.file);
  if (fromFile?.[1] !== undefined && error.line > 0) {
    const start = scriptLines[Number(fromFile[1])];
    return start === undefined ? null : start + error.line - 1;
  }
  const fromStack = named.exec(error.stack);
  if (fromStack?.[1] !== undefined && fromStack[2] !== undefined) {
    const start = scriptLines[Number(fromStack[1])];
    return start === undefined ? null : start + Number(fromStack[2]) - 1;
  }
  return null;
}
