import type { PortholeConfig } from "../config/schema.ts";
import {
  checkFileSet,
  DEFAULT_ENTRY,
  fileLimits,
  lookupFile,
  servesFiles,
} from "../files/paths.ts";
import { fileTypeOf, knownType } from "../files/types.ts";
import { lintContent, type Finding } from "./lint.ts";

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

const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

const textOf = (body: string | Uint8Array): string =>
  typeof body === "string" ? body : new TextDecoder().decode(body);

const sizeOf = (body: string | Uint8Array): number =>
  typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;

/** References a page makes, each with what it is (an element's attribute, a CSS url, a script's). */
const HTML_REFERENCES: readonly RegExp[] = [
  /<(?:script|img|source|video|audio|track|embed|input)\b[^>]*?\bsrc\s*=\s*(["']?)([^"'\s>]+)\1/giu,
  /<link\b[^>]*?\bhref\s*=\s*(["']?)([^"'\s>]+)\1/giu,
  /<(?:a|area)\b[^>]*?\bhref\s*=\s*(["']?)([^"'\s>]+)\1/giu,
  /<video\b[^>]*?\bposter\s*=\s*(["']?)([^"'\s>]+)\1/giu,
];
const CSS_REFERENCES: readonly RegExp[] = [
  /url\(\s*(["']?)([^"')\s]+)\1\s*\)/giu,
  /@import\s+(["'])([^"']+)\1/giu,
];
/** In a script: what resolves from the module (imports, `new URL(…, import.meta.url)`). */
const MODULE_REFERENCES: readonly RegExp[] = [
  /\b(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?(["'])(\.{1,2}\/[^"']+)\1/gu,
  /\bimport\s*\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*\)/gu,
  /\bnew\s+URL\s*\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/gu,
];
/** In a script: what resolves from the page (fetches, workers made from a string). */
const PAGE_REFERENCES: readonly RegExp[] = [
  /\bfetch\s*\(\s*(["'`])(\.{0,2}\/?[\w./-][^"'`$]*)\1/gu,
  /\bnew\s+(?:Shared)?Worker\s*\(\s*(["'`])([^"'`$]+)\1/gu,
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
  for (const problem of checkFileSet(sized, { entry, limits: fileLimits(config.limits) })) {
    findings.push({
      rule: "files",
      severity: "error",
      message: `${problem.message}.`,
      ...(problem.path === undefined ? {} : { path: problem.path }),
    });
  }
  const has = (path: string): boolean => Object.hasOwn(files, path);
  const found = (path: string): boolean =>
    lookupFile(has, path, { entry, navigation: false }).kind !== "none";
  const reported = new Set<string>();
  const check = (
    from: string,
    text: string,
    patterns: readonly RegExp[],
    directory: string,
    rooted: "error" | "warning",
    also?: string,
  ) => {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const reference = match[2] ?? "";
        if (reference === "" || elsewhere(reference) || reference.includes("${")) {
          continue;
        }
        const line = lineOf(text, match.index);
        if (reference.startsWith("/")) {
          const key = `${from} / ${reference}`;
          if (!reported.has(key)) {
            reported.add(key);
            findings.push({
              rule: "root-path",
              severity: rooted,
              message: `${reference} starts with /: that is the address's root, not this version's files. Write it relative (.${reference})${reference.startsWith("/assets/") ? '; for a Vite build, set base: "./"' : ""}.`,
              path: from,
              line,
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
            line,
          });
        }
      }
    }
  };
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
      const text = textOf(body);
      for (const finding of lintContent(config, text)) {
        findings.push({ ...finding, path });
      }
      check(path, text, HTML_REFERENCES, directory, "error");
      check(path, text, CSS_REFERENCES, directory, "warning");
      check(path, text, [...MODULE_REFERENCES, ...PAGE_REFERENCES], directory, "warning");
    } else if (path.endsWith(".css")) {
      check(path, textOf(body), CSS_REFERENCES, directory, "warning");
    } else if (role === "script") {
      const text = textOf(body);
      check(path, text, MODULE_REFERENCES, directory, "warning");
      // A fetch from a script resolves from the page that runs it: the entry's directory, or the
      // script's own (a worker's).
      check(path, text, PAGE_REFERENCES, directoryOf(entry), "warning", directory);
    }
  }
  return findings;
}

/** Where a finding is, for the agent: `about.html line 3: `. */
export const whereOf = (finding: FileFinding): string =>
  `${finding.path === undefined ? "" : finding.path}${finding.line === undefined ? "" : `${finding.path === undefined ? "" : " "}line ${finding.line}`}${finding.path === undefined && finding.line === undefined ? "" : ": "}`;
