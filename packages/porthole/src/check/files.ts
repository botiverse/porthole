import type { PortholeConfig } from "../config/schema.ts";
import {
  checkFileSet,
  DEFAULT_ENTRY,
  fileLimits,
  lookupFile,
  servesFiles,
} from "../files/paths.ts";
import { fileTypeOf, knownType } from "../files/types.ts";
import { sizeWords } from "../guide/limits.ts";
import { lintPage, type Finding } from "./lint.ts";
import { attributesOf } from "./markup.ts";
import { scrollBudget, scrollLock, type LinkedSheet } from "./scroll.ts";

/**
 * What can be told about a page that comes with files (P081), without running it: each page
 * linted as a page is, the set held to the path rules and limits, and every relative reference
 * looked up in the set. Errors are what certainly fails (`admitFiles` refuses them); the rest
 * are warnings. Pure: any runtime.
 */

/** A finding about one file of the set (`path`), or about the set as a whole. */
export interface FileFinding extends Omit<Finding, "rule"> {
  readonly rule: Finding["rule"] | "files" | "missing-file" | "root-path" | "file-type";
  readonly path?: string;
}

/** A set's files, by path: text, or bytes. */
export type FileContents = Readonly<Record<string, string | Uint8Array>>;

/** A text's line numbers by offset: its line starts found once, each line then a binary search. */
function linesOf(text: string): (index: number) => number {
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
    starts.push(at + 1);
  }
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] ?? 0) <= index) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low + 1;
  };
}

const textOf = (body: string | Uint8Array): string =>
  typeof body === "string" ? body : new TextDecoder().decode(body);

const sizeOf = (body: string | Uint8Array): number =>
  typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;

/** How much of one file the references are looked for in: its first 2 MiB of text. */
const SCANNED = 2 * 1024 * 1024;
/** The most references of one kind looked up in one file: past that, a file is only linted. */
const MOST_REFERENCES = 2_000;

/** A reference a file makes, and where it starts in the file's text. */
interface Reference {
  readonly reference: string;
  readonly index: number;
}

/** The elements whose attribute names a file the page loads or links: which attribute. */
const REFERENCE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  script: ["src"],
  img: ["src"],
  source: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  embed: ["src"],
  input: ["src"],
  link: ["href"],
  a: ["href"],
  area: ["href"],
};

/** A tag: its name and its attributes' text. Bounded, and never across another `<`: linear. */
const TAG = /<([a-z][a-z0-9-]{0,30})\b([^<>]{0,8192})>/giu;

/** What a page's markup loads or links: each element's `src`, `href` or `poster`. */
function markupReferences(text: string): Reference[] {
  const found: Reference[] = [];
  for (const tag of text.matchAll(TAG)) {
    if (found.length >= MOST_REFERENCES) {
      break;
    }
    const name = (tag[1] ?? "").toLowerCase();
    const wanted = Object.hasOwn(REFERENCE_ATTRIBUTES, name)
      ? REFERENCE_ATTRIBUTES[name]
      : undefined;
    if (wanted === undefined) {
      continue;
    }
    const offset = tag.index + 1 + name.length;
    for (const attribute of attributesOf(tag[2] ?? "")) {
      if (wanted.includes(attribute.name) && attribute.value !== "") {
        found.push({ reference: attribute.value, index: offset + attribute.at });
      }
    }
  }
  return found;
}

/**
 * The references a text's patterns find (group 2 of each). Every pattern is bounded and stops at
 * its own delimiters, so a text is read in linear time, however it was written.
 */
function patternReferences(text: string, patterns: readonly RegExp[]): Reference[] {
  const found: Reference[] = [];
  for (const pattern of patterns) {
    let count = 0;
    for (const match of text.matchAll(pattern)) {
      found.push({ reference: match[2] ?? "", index: match.index });
      count += 1;
      if (count >= MOST_REFERENCES) {
        break;
      }
    }
  }
  return found;
}

const CSS_REFERENCES: readonly RegExp[] = [
  /url\(\s{0,64}(["']?)([^"'()\s]{1,2048})\1\s{0,64}\)/giu,
  /@import\s{1,64}(["'])([^"'\n]{1,2048})\1/giu,
];
/** In a script: what resolves from the module (imports, `new URL(…, import.meta.url)`). */
const MODULE_REFERENCES: readonly RegExp[] = [
  /\bfrom\s{0,64}(["'])(\.{1,2}\/[^"'\n]{0,2048})\1/gu,
  /\bimport\s{0,64}\(?\s{0,64}(["'])(\.{1,2}\/[^"'\n]{0,2048})\1/gu,
  /\bnew\s{1,64}URL\s{0,64}\(\s{0,64}(["'])([^"'\n]{1,2048})\1\s{0,64},\s{0,64}import\.meta\.url\b/gu,
];
/** In a script: what resolves from the page (fetches, workers made from a string). */
const PAGE_REFERENCES: readonly RegExp[] = [
  /\bfetch\s{0,64}\(\s{0,64}(["'`])(\.{0,2}\/?[\w./-][^"'`$\n]{0,2048})\1/gu,
  /\bnew\s{1,64}(?:Shared)?Worker\s{0,64}\(\s{0,64}(["'`])([^"'`$\n]{1,2048})\1/gu,
];

/** Whether a reference leaves the set for good reason: another origin, inline data, an anchor. */
const elsewhere = (reference: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/iu.test(reference) ||
  reference.startsWith("//") ||
  reference.startsWith("#");

/** `reference` from a file in `directory` ("" or "a/b/"), as a path of the set; null above it. */
function resolve(directory: string, reference: string): string | null {
  const bare = reference.split("#")[0]?.split("?")[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    decoded = bare;
  }
  const segments = `${directory}${decoded}`.split("/");
  const out: string[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment === "..") {
      if (out.length === 0) {
        return null;
      }
      out.pop();
    } else if (segment !== "." && (segment !== "" || index === segments.length - 1)) {
      out.push(segment);
    }
  }
  return out.join("/");
}

const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);

/** The most pages the scroll-lock rule reads in a version: its entry, and 7 more (P106). */
export const SCROLL_PAGES = 8;

/**
 * Lints a page that comes with files (P081): the set (paths, limits, its entry), each page as
 * `lintContent` lints a page, each relative reference looked up in the set (a leading `/`, which
 * names the address's root rather than the version, is an error in a page's markup), and each
 * file whose extension the server doesn't know (a download).
 */
export function lintFiles(
  config: PortholeConfig,
  files: FileContents,
  options: { readonly entry?: string } = {},
): FileFinding[] {
  const findings: FileFinding[] = [];
  if (!servesFiles(config)) {
    findings.push({
      rule: "files",
      severity: "error",
      message:
        "A page here is one document: it can't come with files. Put its styles, scripts and data in the page itself.",
    });
    return findings;
  }
  const entry = options.entry ?? DEFAULT_ENTRY;
  const sized = Object.fromEntries(
    Object.entries(files).map(([path, body]) => [path, { size: sizeOf(body) }]),
  );
  const problems = checkFileSet(sized, { entry, limits: fileLimits(config.limits) });
  for (const problem of problems) {
    findings.push({
      rule: "files",
      severity: "error",
      message: `${problem.message}.`,
      ...(problem.path === undefined ? {} : { path: problem.path }),
    });
  }
  // Over the limits, the version isn't taken: nothing in it is read.
  if (
    problems.some((each) => each.code === "count" || each.code === "size" || each.code === "total")
  ) {
    return findings;
  }
  const has = (path: string): boolean => Object.hasOwn(files, path);
  const found = (path: string): boolean =>
    lookupFile(has, path, { entry, navigation: false }).kind !== "none";
  const reported = new Set<string>();
  const check = (
    from: string,
    lineOf: (index: number) => number,
    references: readonly Reference[],
    directory: string,
    rooted: "error" | "warning",
    also?: string,
  ) => {
    const seen = new Set<string>();
    for (const { reference, index } of references) {
      if (seen.has(reference)) {
        continue;
      }
      seen.add(reference);
      if (reference === "" || elsewhere(reference) || reference.includes("${")) {
        continue;
      }
      if (reference.startsWith("/")) {
        const key = `${from} / ${reference}`;
        if (!reported.has(key)) {
          reported.add(key);
          findings.push({
            rule: "root-path",
            severity: rooted,
            message: `${reference} starts with /: that is the address's root, not this version's files. Write it relative (.${reference})${reference.startsWith("/assets/") ? '; for a Vite build, set base: "./"' : ""}.`,
            path: from,
            line: lineOf(index),
          });
        }
        continue;
      }
      const target = resolve(directory, reference);
      const other = also === undefined ? null : resolve(also, reference);
      const named = (target !== null && found(target)) || (other !== null && found(other));
      const key = `${from} ${target ?? reference}`;
      if (!named && !reported.has(key)) {
        reported.add(key);
        findings.push({
          rule: "missing-file",
          severity: "warning",
          message:
            target === null && other === null
              ? `${reference} goes above the version's own files: nothing is there.`
              : `${reference} names ${(target ?? other) === "" ? "the version's entry" : (target ?? other)}, which isn't one of the files.`,
          path: from,
          line: lineOf(index),
        });
      }
    }
  };
  // A stylesheet a page links or a stylesheet imports, found in the set by its path (P106). The
  // fewest characters it may hold first: the rule decodes its text only where it may read it, and
  // nothing keeps it after (P110: kept for the set, one page linking 400 sheets of 240 KB held
  // them all, 200 MB, for the 4 MiB the rule reads).
  const stylesheet: LinkedSheet = (href, from) => {
    if (href === "" || elsewhere(href) || href.startsWith("/")) {
      return null;
    }
    const target = resolve(directoryOf(from), href);
    const sheet = target === null || !has(target) ? undefined : files[target];
    if (sheet === undefined || target === null) {
      return null;
    }
    // As bytes, at most 3 a character (after a BOM's 3): its fewest characters, and the bytes that
    // hold its first SCANNED.
    return typeof sheet === "string"
      ? { path: target, least: sheet.length, text: () => sheet }
      : {
          path: target,
          least: Math.max(0, Math.ceil(sheet.byteLength / 3) - 1),
          text: () => textOf(sheet.subarray(0, 3 * SCANNED + 3)),
        };
  };
  const it = config.mode === "mcp-app" ? "view" : config.mode === "inline" ? "widget" : "page";
  const maxPage = config.limits.maxBytes;
  // The version's pages, read, for the scroll-lock rule after the rest (P106). A page over its
  // limit isn't read at all: its error says so.
  const pages = new Set<string>();
  for (const [path, body] of Object.entries(files)) {
    const { role } = fileTypeOf(path);
    if (!knownType(path)) {
      findings.push({
        rule: "file-type",
        severity: "warning",
        message: `${path} is served as a download: its extension isn't one the server knows.`,
        path,
      });
    }
    const directory = directoryOf(path);
    if (role === "page") {
      const bytes = sizeOf(body);
      if (bytes > maxPage) {
        // Over the page's limit: said, and not read further.
        findings.push({
          rule: "size",
          severity: "error",
          message: `It is ${sizeWords(bytes)}; a page may be at most ${sizeWords(maxPage)}: move what it holds into files of its own (scripts, styles, data).`,
          path,
        });
        continue;
      }
      const text = textOf(body);
      // The scroll-lock rule apart, with the stylesheets the page links (P106).
      for (const finding of lintPage(config, text, { scrollLock: false })) {
        findings.push({ ...finding, path });
      }
      // Its path only: the few the rule reads are decoded again there, one at a time.
      pages.add(path);
      const lines = linesOf(text);
      check(path, lines, markupReferences(text), directory, "error");
      check(path, lines, patternReferences(text, CSS_REFERENCES), directory, "warning");
      check(
        path,
        lines,
        patternReferences(text, [...MODULE_REFERENCES, ...PAGE_REFERENCES]),
        directory,
        "warning",
      );
    } else if (path.endsWith(".css")) {
      const text = textOf(body).slice(0, SCANNED);
      check(path, linesOf(text), patternReferences(text, CSS_REFERENCES), directory, "warning");
    } else if (role === "script") {
      const text = textOf(body).slice(0, SCANNED);
      const lines = linesOf(text);
      check(path, lines, patternReferences(text, MODULE_REFERENCES), directory, "warning");
      // A fetch from a script resolves from the page that runs it: the entry's directory, or the
      // script's own (a worker's).
      check(
        path,
        lines,
        patternReferences(text, PAGE_REFERENCES),
        directoryOf(entry),
        "warning",
        directory,
      );
    }
  }
  // Its own styles holding a page to one screen (P106): the entry first, then the others in path
  // order, at most SCROLL_PAGES, within one budget for them all. A warning: past either, the pages
  // left aren't checked, and it says how many.
  const budget = scrollBudget();
  const order = [
    ...(pages.has(entry) ? [entry] : []),
    ...[...pages].filter((path) => path !== entry).sort(),
  ];
  let checked = 0;
  for (const path of order.slice(0, SCROLL_PAGES)) {
    const body = files[path];
    const text = body === undefined ? "" : textOf(body);
    const held = scrollLock(text, { noun: it, path, sheet: stylesheet, budget });
    if (budget.spent) {
      break;
    }
    checked += 1;
    if (held !== null) {
      findings.push({
        rule: "scroll-lock",
        severity: "warning",
        message: held.message,
        path: held.path ?? path,
        ...(held.line === undefined ? {} : { line: held.line }),
      });
    }
  }
  const unchecked = pages.size - checked;
  if (unchecked > 0) {
    findings.push({
      rule: "scroll-lock",
      severity: "warning",
      message: `${unchecked} page${unchecked === 1 ? "" : "s"} not checked for scroll lock: the check reads the entry and at most ${SCROLL_PAGES - 1} other pages, within one budget. If one of them holds html, body or its root to one screen (overflow: hidden with height: 100% or 100vh, or position: fixed), let it scroll as a document.`,
    });
  }
  return findings;
}

/** Where a finding is, for the agent: `about.html line 3: `. */
export const whereOf = (finding: FileFinding): string =>
  `${finding.path === undefined ? "" : finding.path}${finding.line === undefined ? "" : `${finding.path === undefined ? "" : " "}line ${finding.line}`}${finding.path === undefined && finding.line === undefined ? "" : ": "}`;
