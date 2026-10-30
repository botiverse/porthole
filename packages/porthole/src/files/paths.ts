import type { Limits, PortholeConfig } from "../config/schema.ts";
import { isPagePath } from "./types.ts";

/**
 * A version made of files (P081): the rules a published path follows, the limits a version is
 * held to, and how a request's path finds its file. Pure: any runtime. A host checks a version
 * with `checkFileSet` when it is published; `/server` looks paths up in the version's manifest
 * only, never on a filesystem.
 */

/** The most files a version holds, by default. */
export const DEFAULT_MAX_FILES = 1_000;
/** The largest file of a version, bytes, by default (25 MiB). */
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
/** A version's files together, bytes, by default (100 MiB): a host sets its own. */
export const DEFAULT_MAX_VERSION_BYTES = 100 * 1024 * 1024;
/** The longest path, characters, and the longest segment of one. */
export const MAX_FILE_PATH_CHARS = 512;
export const MAX_SEGMENT_CHARS = 255;
/** The page a version opens at by default. */
export const DEFAULT_ENTRY = "index.html";

/**
 * Whether a config's pages may come with files of their own (P081): an artifact served on an
 * origin of its own. Opaque frames have no origin to serve them from.
 */
export const servesFiles = (config: PortholeConfig): boolean =>
  config.mode === "artifact" && config.isolation === "domain";

export interface FileLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxVersionBytes: number;
}

/** A config's file limits (`limits.maxFiles`, …), with the defaults where it names none. */
export function fileLimits(limits?: Partial<Limits> | null): FileLimits {
  return {
    maxFiles: limits?.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: limits?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxVersionBytes: limits?.maxVersionBytes ?? DEFAULT_MAX_VERSION_BYTES,
  };
}

/**
 * What a request's path can never hold once decoded, and a published path never holds: control
 * and format characters (`Cc`, `Cf`: a right-to-left override, a zero-width space, a BOM would make
 * a path read as another), and `\ % ? #`.
 */
// oxlint-disable-next-line no-control-regex -- control characters are what it refuses
const FORBIDDEN = /[\p{Cc}\p{Cf}\\%?#]/u;

/**
 * What is wrong with a published path, or null: relative (no leading `/`), `/`-separated, no
 * empty, `.` or `..` segment, none of `\ % ? #` or a control character, in Unicode NFC, no segment
 * starting or ending with a space, at most 512 characters and 255 a segment, not under
 * `__porthole/` (Porthole's own paths at an origin's root). Case-sensitive.
 */
export function filePathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) {
    return "a path is a non-empty string";
  }
  if (path.length > MAX_FILE_PATH_CHARS) {
    return `a path is at most ${MAX_FILE_PATH_CHARS} characters`;
  }
  // A lone surrogate is no character, and no URL can carry it (P095).
  if (!path.isWellFormed()) {
    return "a path is well-formed Unicode: no lone surrogates";
  }
  if (path.startsWith("/")) {
    return "a path is relative: no leading /";
  }
  if (path.endsWith("/")) {
    return "a path names a file: no trailing /";
  }
  const forbidden = FORBIDDEN.exec(path);
  if (forbidden !== null) {
    const char = forbidden[0];
    return `a path holds no ${char === "\\" || char === "%" || char === "?" || char === "#" ? char : "control or format character"}`;
  }
  if (path.normalize("NFC") !== path) {
    return "a path is in Unicode NFC";
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "") {
      return "a path has no empty segment (//)";
    }
    if (segment === "." || segment === "..") {
      return `a path has no ${segment} segment`;
    }
    if (segment.length > MAX_SEGMENT_CHARS) {
      return `a path's segment is at most ${MAX_SEGMENT_CHARS} characters`;
    }
    if (segment.startsWith(" ") || segment.endsWith(" ")) {
      return "a path's segment doesn't start or end with a space";
    }
  }
  if (segments[0] === "__porthole") {
    return "__porthole/ is Porthole's own";
  }
  return null;
}

/** A published path's metadata, as far as the checks read it. */
export interface FileSetEntryLike {
  readonly size: number;
}

export interface FileSetProblem {
  /** The path it is about, where it is about one. */
  readonly path?: string;
  readonly code: "path" | "collision" | "count" | "size" | "total" | "entry";
  /** What to change, for the agent or the person publishing. */
  readonly message: string;
}

const sizeOf = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KiB`
      : `${bytes} bytes`;

/**
 * Checks a version's files before it is published (P081): every path by `filePathProblem`; no
 * two paths that differ only in case, and no path that is both a file and a directory; the
 * entry is one of them, and a page (`.html` or `.htm`, P125); the count, each size and the total
 * within the limits (a config's, see `fileLimits`). Empty when it may be published.
 */
export function checkFileSet(
  files: Readonly<Record<string, FileSetEntryLike>>,
  options: { readonly entry?: string; readonly limits?: FileLimits } = {},
): FileSetProblem[] {
  const limits = options.limits ?? fileLimits();
  const problems: FileSetProblem[] = [];
  const paths = Object.keys(files);
  if (paths.length > limits.maxFiles) {
    problems.push({
      code: "count",
      message: `${paths.length} files: a version holds at most ${limits.maxFiles}`,
    });
  }
  const folded = new Map<string, string>();
  const directories = new Set<string>();
  let total = 0;
  for (const path of paths) {
    const problem = filePathProblem(path);
    if (problem !== null) {
      problems.push({ path, code: "path", message: `${JSON.stringify(path)}: ${problem}` });
      continue;
    }
    const lower = path.toLowerCase();
    const other = folded.get(lower);
    if (other !== undefined) {
      problems.push({
        path,
        code: "collision",
        message: `${JSON.stringify(path)} and ${JSON.stringify(other)} differ only in case: rename one`,
      });
    } else {
      folded.set(lower, path);
    }
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
    const size = files[path]?.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
      problems.push({ path, code: "size", message: `${JSON.stringify(path)}: no size` });
      continue;
    }
    if (size > limits.maxFileBytes) {
      problems.push({
        path,
        code: "size",
        message: `${JSON.stringify(path)} is ${sizeOf(size)}: a file is at most ${sizeOf(limits.maxFileBytes)}`,
      });
    }
    total += size;
  }
  for (const path of paths) {
    if (directories.has(path)) {
      problems.push({
        path,
        code: "collision",
        message: `${JSON.stringify(path)} is a file and a directory: rename one`,
      });
    }
  }
  if (total > limits.maxVersionBytes) {
    problems.push({
      code: "total",
      message: `The files are ${sizeOf(total)} together: a version holds at most ${sizeOf(limits.maxVersionBytes)}`,
    });
  }
  const entry = options.entry ?? DEFAULT_ENTRY;
  if (!Object.hasOwn(files, entry)) {
    problems.push({
      path: entry,
      code: "entry",
      message: `No ${JSON.stringify(entry)}: the page the version opens at is one of its files`,
    });
  } else if (!isPagePath(entry)) {
    // A version opens at a page (P125, P124-2): any other file is served inert, says nothing, and
    // would show only Porthole's fallback.
    problems.push({
      path: entry,
      code: "entry",
      message: `${JSON.stringify(entry)} isn't a page: the version opens at an .html (or .htm) file of its own`,
    });
  }
  return problems;
}

/**
 * A request's path below a version's base, decoded once, as the key it looks up: null where it
 * can name no file (a segment that doesn't decode, or decodes to one holding `/ \ % ? #` or a
 * control character, or is `.` or `..`). The URL parser has already removed the dot segments it
 * sees (`.`, `..`, `%2e`); anything left of that kind is refused rather than resolved. A trailing
 * `/` stays (a directory).
 */
export function requestFilePath(raw: string): string | null {
  if (raw.length > MAX_FILE_PATH_CHARS * 3 + 1) {
    return null;
  }
  const segments = raw.split("/");
  const decoded: string[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment === "") {
      // Only the last segment may be empty: a directory's trailing slash (or the base itself).
      if (index !== segments.length - 1) {
        return null;
      }
      decoded.push("");
      continue;
    }
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (value === "." || value === ".." || value.includes("/") || FORBIDDEN.test(value)) {
      return null;
    }
    decoded.push(value);
  }
  return decoded.join("/");
}

/** What a request's path finds in a version's manifest. */
export type FileLookup =
  /** The file to answer with, and its status (404 for a `404.html`). */
  | { readonly kind: "file"; readonly path: string; readonly status: 200 | 404 }
  /** The canonical address: `dir` → `dir/` (or `page/` → `page`), relative to the base. */
  | { readonly kind: "redirect"; readonly to: string }
  /** Nothing: a plain 404. */
  | { readonly kind: "none" };

export interface LookupOptions {
  /** The page the version opens at (default `index.html`). */
  readonly entry?: string;
  /** A single-page app's routes: a navigation that finds nothing answers the entry. */
  readonly spa?: boolean;
  /** Whether the request is a navigation (a page loading), not a subresource. */
  readonly navigation: boolean;
}

/**
 * Finds a request's file in a version's manifest (P081), as static hosts do (Cloudflare's
 * `auto-trailing-slash`): `""` is the entry; `dir/` is `dir/index.html`; `name` is `name`, else
 * `name.html`, else `dir/` when `name/index.html` exists; `name/` with no index but a
 * `name.html` goes to `name`. What finds nothing: for a navigation, the entry when the version is
 * a single-page app, else the nearest `404.html` (status 404); otherwise none.
 */
export function lookupFile(
  has: (path: string) => boolean,
  path: string,
  options: LookupOptions,
): FileLookup {
  const entry = options.entry ?? DEFAULT_ENTRY;
  if (path === "") {
    if (!has(entry)) {
      return notFound(has, "", options);
    }
    // An entry in a directory opens there, so its relative addresses are its directory's.
    return entry.includes("/")
      ? { kind: "redirect", to: entry }
      : { kind: "file", path: entry, status: 200 };
  }
  if (path.endsWith("/")) {
    const index = `${path}index.html`;
    if (has(index)) {
      return { kind: "file", path: index, status: 200 };
    }
    const page = `${path.slice(0, -1)}.html`;
    if (has(page)) {
      return { kind: "redirect", to: path.slice(0, -1) };
    }
    return notFound(has, path, options);
  }
  if (has(path)) {
    return { kind: "file", path, status: 200 };
  }
  if (has(`${path}.html`)) {
    return { kind: "file", path: `${path}.html`, status: 200 };
  }
  if (has(`${path}/index.html`)) {
    return { kind: "redirect", to: `${path}/` };
  }
  return notFound(has, path, options);
}

function notFound(
  has: (path: string) => boolean,
  path: string,
  options: LookupOptions,
): FileLookup {
  if (!options.navigation) {
    return { kind: "none" };
  }
  const entry = options.entry ?? DEFAULT_ENTRY;
  if (options.spa === true && has(entry)) {
    return { kind: "file", path: entry, status: 200 };
  }
  // The nearest 404.html: in the request's directory, then each one above it.
  const segments = path.split("/").slice(0, -1);
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const candidate = [...segments.slice(0, depth), "404.html"].join("/");
    if (has(candidate)) {
      return { kind: "file", path: candidate, status: 404 };
    }
  }
  return { kind: "none" };
}
