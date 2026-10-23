import {
  anyHttps,
  declaredCapabilities,
  egressOrigins,
  type EgressKind,
  librarySources,
} from "../compile/policy.ts";
import type { PortholeConfig } from "../config/schema.ts";
import { sizeWords } from "../guide/limits.ts";
import { originMatchesSource } from "../isolation/served.ts";
import { scrollLock } from "./scroll.ts";

/**
 * What can be told about content without running it (P073), worded as the manual words it, so
 * the agent fixes it before anyone sees it. Pure: any runtime. Errors are only what certainly
 * fails or is cut (`refuseOn: "error"` refuses those); the rest are warnings.
 */

export type LintRule =
  | "size"
  | "document"
  | "nested-frame"
  | "document-write"
  | "clipboard"
  | "dialog"
  | "form"
  | "egress"
  | "unpinned"
  | "position-fixed"
  | "scroll-lock"
  | "new-window";

export interface Finding {
  readonly rule: LintRule;
  readonly severity: "error" | "warning";
  /** What to change, for the agent. */
  readonly message: string;
  /** Where (1-based), where a line says it. */
  readonly line?: number;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

const noun = (config: PortholeConfig) =>
  config.mode === "artifact" ? "page" : config.mode === "mcp-app" ? "view" : "widget";

/** A whole document's markers: what a fragment must not have. */
const DOCUMENT = /<!doctype\b|<html[\s>]|<head[\s>]|<body[\s>]/iu;

/**
 * A whole document sent where a fragment is shown (an inline widget), as the fragment it means:
 * its head's styles and scripts, then its body. Null where it has no body to take.
 */
export function fragmentOf(content: string): string | null {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/iu.exec(content)?.[1] ?? "";
  const kept = [...head.matchAll(/<(style|script)\b[\s\S]*?<\/\1>|<link\b[^>]*>/giu)]
    .map((each) => each[0])
    .join("\n");
  const body =
    /<body[^>]*>([\s\S]*?)(?:<\/body>|$)/iu.exec(content)?.[1] ??
    content
      .replace(/<!doctype[^>]*>/iu, "")
      .replace(/<\/?html[^>]*>/giu, "")
      .replace(/<head[^>]*>[\s\S]*?<\/head>/iu, "");
  return body.trim() === "" ? null : `${kept}${kept === "" ? "" : "\n"}${body.trim()}`;
}

/**
 * Where content reaches out, by the kind of egress each would need. Each pattern is bounded and
 * never runs past its own delimiters (a tag's `<`, a string's quote), so a text is read in linear
 * time however it was written.
 */
const REACHES: readonly { readonly kind: EgressKind; readonly pattern: RegExp }[] = [
  {
    kind: "script",
    pattern: /<script\b[^<>]{0,8192}?\bsrc\s{0,64}=\s{0,64}["']?(https?:\/\/[^"'\s<>]{1,2048})/giu,
  },
  { kind: "script", pattern: /\bfrom\s{0,64}["'](https?:\/\/[^"'\n]{1,2048})/gu },
  { kind: "script", pattern: /\bimport\s{0,64}\(?\s{0,64}["'](https?:\/\/[^"'\n]{1,2048})/gu },
  {
    kind: "style",
    pattern: /<link\b[^<>]{0,8192}?\bhref\s{0,64}=\s{0,64}["']?(https?:\/\/[^"'\s<>]{1,2048})/giu,
  },
  {
    kind: "style",
    pattern: /@import\s{1,64}(?:url\()?["']?(https?:\/\/[^"')\s]{1,2048})/giu,
  },
  {
    kind: "img",
    pattern: /<img\b[^<>]{0,8192}?\bsrc\s{0,64}=\s{0,64}["']?(https?:\/\/[^"'\s<>]{1,2048})/giu,
  },
  { kind: "img", pattern: /url\(\s{0,64}["']?(https?:\/\/[^"')\s]{1,2048})/giu },
  {
    kind: "media",
    pattern:
      /<(?:video|audio|source)\b[^<>]{0,8192}?\bsrc\s{0,64}=\s{0,64}["']?(https?:\/\/[^"'\s<>]{1,2048})/giu,
  },
  { kind: "connect", pattern: /\bfetch\s{0,64}\(\s{0,64}["'`](https?:\/\/[^"'`\n]{1,2048})/gu },
  {
    kind: "connect",
    pattern:
      /\bnew\s{1,64}(?:WebSocket|EventSource)\s{0,64}\(\s{0,64}["'`]((?:https?|wss?):\/\/[^"'`\n]{1,2048})/gu,
  },
];

const CDN_PACKAGE =
  /^https:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com|esm\.sh)\/((?:@[^/]+\/)?[^/@]+)(@[^/]*)?/u;

/**
 * Libraries' own CDNs (P078): the version is in the path (`/3.4.17`, `jquery-3.7.1.min.js`,
 * `plotly-3.4.0.min.js`); without it the host serves its latest (Tailwind redirects to it).
 */
const OWN_CDN: readonly {
  readonly name: string;
  readonly host: RegExp;
  readonly pinned: RegExp;
}[] = [
  {
    name: "Tailwind",
    host: /^https:\/\/cdn\.tailwindcss\.com(?:[/?#]|$)/u,
    pinned: /^\/\d+\.\d+\.\d+/u,
  },
  { name: "jQuery", host: /^https:\/\/code\.jquery\.com\//u, pinned: /\d+\.\d+\.\d+/u },
  { name: "Plotly", host: /^https:\/\/cdn\.plot\.ly\/plotly/u, pinned: /\d+\.\d+\.\d+/u },
];

export function lintContent(config: PortholeConfig, content: string): Finding[] {
  return lintPage(config, content, { scrollLock: true });
}

/**
 * `lintContent`, with or without the scroll-lock rule: `lintFiles` reads that one itself, once,
 * with the stylesheets the page links.
 */
export function lintPage(
  config: PortholeConfig,
  content: string,
  options: { readonly scrollLock: boolean },
): Finding[] {
  if (config.mode === "url") {
    return [];
  }
  const findings: Finding[] = [];
  const add = (rule: LintRule, severity: Finding["severity"], message: string, index?: number) =>
    findings.push({
      rule,
      severity,
      message,
      ...(index === undefined ? {} : { line: lineOf(content, index) }),
    });
  const it = noun(config);
  const declared = new Set(declaredCapabilities(config));

  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > config.limits.maxBytes) {
    add(
      "size",
      "error",
      `It is ${sizeWords(bytes)}; a ${it} may be at most ${sizeWords(config.limits.maxBytes)}: make it smaller (less data inline, no embedded fonts or images it doesn't need).`,
    );
  }
  if (config.mode === "inline") {
    const at = content.search(DOCUMENT);
    if (at >= 0) {
      if (fragmentOf(content) === null) {
        add(
          "document",
          "error",
          "Send an HTML fragment (styles, markup, scripts), not a whole document: this one has no body to show.",
          at,
        );
      } else {
        add(
          "document",
          "warning",
          "Send an HTML fragment, not a whole document (no <!doctype>, <html>, <head> or <body>): it was taken as its body, with its head's styles and scripts.",
          at,
        );
      }
    }
  }
  const frame = /<(iframe|frame|object|embed)\b/iu.exec(content);
  if (frame !== null) {
    add(
      "nested-frame",
      "error",
      `Remove the <${frame[1]?.toLowerCase()}>: nested frames and plugins are taken out of a ${it} and never run. Draw it inline instead.`,
      frame.index,
    );
  }
  const write = /\bdocument\s*\.\s*write(?:ln)?\s*\(/u.exec(content);
  if (write !== null) {
    add(
      "document-write",
      "error",
      "Remove document.write: it throws here. Build elements with document.createElement, or set innerHTML.",
      write.index,
    );
  }
  const clipboard =
    /\bnavigator\s*\.\s*clipboard\b|\bexecCommand\s*\(\s*["'](?:copy|cut)["']/u.exec(content);
  if (clipboard !== null) {
    add(
      "clipboard",
      "warning",
      declared.has("copyText")
        ? config.runtime === undefined
          ? "The clipboard is closed to content: a copy button calls copyText(text) from its click."
          : 'The clipboard is closed to content: a copy button calls (await porthole.use("clipboard")).copy(text) from its click.'
        : "The clipboard is closed to content: copying from a button doesn't work here.",
      clipboard.index,
    );
  }
  const dialog = /(?:^|[^.\w$])(?:window\s*\.\s*)?(alert|confirm|prompt)\s*\(/u.exec(content);
  if (dialog !== null) {
    add(
      "dialog",
      "warning",
      `${dialog[1]}() shows nothing here (confirm returns false, prompt null): show it in the ${it}'s own markup.`,
      dialog.index,
    );
  }
  const form = /<form\b/iu.exec(content);
  if (form !== null) {
    add(
      "form",
      "warning",
      'Forms never submit here, and some browsers fire no submit event: use <button type="button"> and a click handler.',
      form.index,
    );
  }
  const reported = new Set<string>();
  for (const { kind, pattern } of REACHES) {
    for (const match of content.matchAll(pattern)) {
      const address = match[1] ?? "";
      let origin: string;
      try {
        origin = new URL(address.replace(/^ws/u, "http")).origin;
      } catch {
        continue;
      }
      const open =
        (kind !== "script" &&
          kind !== "style" &&
          kind !== "connect" &&
          address.startsWith("https:") &&
          anyHttps(config, kind)) ||
        egressOrigins(config, kind).some(
          (source) => source === origin || originMatchesSource(origin, source),
        );
      if (!open && !reported.has(`${kind} ${origin}`)) {
        reported.add(`${kind} ${origin}`);
        add(
          "egress",
          "warning",
          `Nothing loads from ${origin} here (${kind}): ${kind === "script" && librarySources(config).length > 0 ? "write it inline, or use one of the libraries served here (the manual's Libraries)" : kind === "script" || kind === "style" ? "write it inline, or use a library from an allowed CDN" : kind === "connect" && config.capabilities.readData !== undefined ? `the content can't call it; read the app's data with ${config.runtime === undefined ? "readData" : "data.read"}` : kind === "connect" ? "the content can't call it; work from data in the content" : "put it inline as a data: URL"}.`,
          match.index,
        );
      }
      const own = OWN_CDN.find((each) => each.host.test(address));
      if (own !== undefined && kind === "script" && !own.pinned.test(new URL(address).pathname)) {
        add(
          "unpinned",
          "warning",
          `Pin an exact version of ${own.name} (its version in the URL's path), never its latest: the code then can't change under the ${it}.`,
          match.index,
        );
      }
      const pinned = CDN_PACKAGE.exec(address);
      if (pinned !== null && (pinned[2] === undefined || !/^@\d+\.\d+\.\d+/u.test(pinned[2]))) {
        add(
          "unpinned",
          "warning",
          `Pin an exact version of ${pinned[1]} (${pinned[1]}@1.2.3 in its URL), never @latest or a range: the code then can't change under the ${it}.`,
          match.index,
        );
      }
    }
  }
  if (config.layout.kind !== "fill") {
    const fixed = /position\s*:\s*fixed/iu.exec(content);
    if (fixed !== null) {
      add(
        "position-fixed",
        "warning",
        `No position: fixed: the frame grows with the ${it}'s content, so a fixed element covers it. Use position: sticky or normal flow.`,
        fixed.index,
      );
    }
  }
  // Its own styles holding it to one screen (P106): a warning, as a one-screen app means it.
  const held = options.scrollLock ? scrollLock(content, { noun: it }) : null;
  if (held !== null) {
    findings.push({
      rule: "scroll-lock",
      severity: "warning",
      message: held.message,
      line: held.line,
    });
  }
  const opens = /target\s*=\s*["']?_blank|\bwindow\s*\.\s*open\s*\(/u.exec(content);
  if (opens !== null && !declared.has("openLink")) {
    add(
      "new-window",
      "warning",
      "Nothing opens a new window here (window.open returns null, target=_blank does nothing): show it inline.",
      opens.index,
    );
  }
  return findings;
}
