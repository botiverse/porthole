import type { CompiledConfig } from "../compile/compile.ts";
import {
  assetCspDirectives,
  fileSetCspDirectives,
  INERT_FILE_CSP,
  serializeCsp,
} from "../compile/policy.ts";
import { DEFAULT_ENTRY, lookupFile, requestFilePath, type FileLookup } from "../files/paths.ts";
import { fileTypeOf } from "../files/types.ts";
import { isCodeAsset } from "../runtime/requests.ts";
import { sha256, utf8 } from "./crypto.ts";
import type { FileBody, StoredAsset, StoredFiles } from "./types.ts";

/**
 * Serving a version made of files (P081, P082): each path looked up in its manifest only, each
 * answer typed by Porthole's table, with `nosniff`, its CSP in a header, its cache rule and a
 * strong ETag; pages in the shell, ranges for the rest.
 */

export interface FileServing {
  readonly request: Request;
  readonly set: StoredFiles;
  /** The request's path below the base, as the URL has it (percent-encoded). */
  readonly rest: string;
  /** The search part, kept on a redirect. */
  readonly search: string;
  /** The version's own address on its origin: a path ending in `/`. */
  readonly base: string;
  readonly origin: string;
  /**
   * Whether `base` names this version and no other (a pinned address, a frame's): its files are
   * immutable there. Else they are revalidated (an address that may mean another version later).
   */
  readonly pinned: boolean;
  /** The CSP source the version's files load from (P082): its path on the origin. */
  readonly source: string;
  readonly compiled: CompiledConfig;
  readonly hostOrigins: readonly string[];
  readonly frameAncestors: string;
  /**
   * A ticket's answer (P083): the entry, served at the ticket's address, never stored; its shell
   * moves the frame to the entry's own address under `base` before anything loads, and renews
   * that address before it ends (`expires`, epoch ms).
   */
  readonly ticket?: { readonly expires: number };
  /** The artifact version the set is, which its pages name in their notices to the host (P098). */
  readonly artifact?: { readonly id: string; readonly version: string };
}

const HEX = /^[0-9a-f]{64}$/u;
const YEAR = 31_536_000;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A path's segments percent-encoded, for a `Location`. */
const encodePath = (path: string): string =>
  path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

/** Whether the request is a page loading (a navigation), not a subresource. */
export function isNavigation(request: Request): boolean {
  const mode = request.headers.get("sec-fetch-mode");
  const dest = request.headers.get("sec-fetch-dest");
  if (mode !== null || dest !== null) {
    return mode === "navigate" || dest === "document" || dest === "iframe" || dest === "frame";
  }
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * Whether the request is a running page's own load: from its own origin (`Sec-Fetch-Site`, which
 * only a browser sets and no page can change), and not a navigation.
 */
export const ownLoad = (request: Request): boolean =>
  request.headers.get("sec-fetch-site") === "same-origin" && !isNavigation(request);

/** Whether `If-None-Match` names this ETag. */
function notModified(request: Request, etag: string): boolean {
  const asked = request.headers.get("if-none-match");
  if (asked === null) {
    return false;
  }
  return asked
    .split(",")
    .map((each) => each.trim().replace(/^W\//u, ""))
    .some((each) => each === "*" || each === etag);
}

/** A single `bytes=` range of a body of `size` bytes: the range, "unsatisfiable", or null (ignore it). */
function rangeOf(
  header: string | null,
  size: number,
): { readonly start: number; readonly end: number } | "unsatisfiable" | null {
  if (header === null) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) {
    return null;
  }
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") {
    return null;
  }
  if (from === "") {
    // The last `to` bytes.
    const length = Number(to);
    if (length === 0) {
      return "unsatisfiable";
    }
    return size === 0 ? "unsatisfiable" : { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || end < start) {
    return "unsatisfiable";
  }
  return { start, end };
}

/** `body` from byte `start` through `end`. */
function slice(body: FileBody, start: number, end: number): FileBody {
  if (body instanceof Uint8Array) {
    return body.subarray(start, end + 1);
  }
  let offset = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const from = Math.max(start - offset, 0);
        const to = Math.min(end + 1 - offset, chunk.byteLength);
        if (from < to) {
          controller.enqueue(chunk.subarray(from, to));
        }
        offset += chunk.byteLength;
        if (offset > end) {
          controller.terminate();
        }
      },
    }),
  );
}

async function textOf(body: FileBody): Promise<string> {
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  return new Response(body).text();
}

const asBody = (body: FileBody): BodyInit =>
  body instanceof Uint8Array ? new Uint8Array(body) : body;

/** The answer for nothing found: plain, inert. */
function nothing(serving: FileServing, status: 403 | 404 | 405, method: string): Response {
  const text =
    status === 404 ? "Not found" : status === 405 ? "Content here is only read" : "Not allowed";
  return new Response(method === "HEAD" ? null : text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": `${INERT_FILE_CSP}; frame-ancestors ${serving.frameAncestors}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      ...(status === 405 ? { allow: "GET, HEAD" } : {}),
    },
  });
}

export async function serveFile(serving: FileServing): Promise<Response> {
  const { request, set } = serving;
  const method = request.method.toUpperCase();
  // No service worker, ever: one would answer this origin's requests with documents of its
  // own making, outside the shell and its CSP (P081).
  if (
    request.headers.get("service-worker") !== null ||
    request.headers.get("sec-fetch-dest") === "serviceworker"
  ) {
    return nothing(serving, 403, method);
  }
  if (method !== "GET" && method !== "HEAD") {
    return nothing(serving, 405, method);
  }
  const path = requestFilePath(serving.rest);
  if (path === null) {
    return nothing(serving, 404, method);
  }
  const has = (each: string): boolean => Object.hasOwn(set.files, each);
  const entryPath = set.entry ?? DEFAULT_ENTRY;
  const found: FileLookup =
    serving.ticket !== undefined
      ? has(entryPath)
        ? { kind: "file", path: entryPath, status: 200 }
        : { kind: "none" }
      : lookupFile(has, path, {
          ...(set.entry === undefined ? {} : { entry: set.entry }),
          ...(set.spa === undefined ? {} : { spa: set.spa }),
          navigation: isNavigation(request),
        });
  if (found.kind === "none") {
    return nothing(serving, 404, method);
  }
  // The version's own address, as a URL writes it.
  const base = new URL(serving.base, serving.origin).href;
  if (found.kind === "redirect") {
    return new Response(null, {
      status: 307,
      headers: {
        location: `${base}${encodePath(found.to)}${serving.search}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }
  const entry = set.files[found.path];
  const body = entry === undefined ? null : await set.read(found.path);
  if (entry === undefined || body === null) {
    return nothing(serving, 404, method);
  }
  const { type, role } = fileTypeOf(found.path);
  // In a frame, the version's files are at a sealed address (P083), which their own loads of the
  // artifact's assets carry as their `Referer` (P091): to this origin only, never another.
  const referrer =
    serving.base.startsWith("/__porthole/f/") &&
    serving.compiled.config.capabilities.assets !== undefined
      ? "same-origin"
      : "no-referrer";
  // Its version's files (P082), and its artifact's assets where the config serves them (P089).
  const frameCsp = serializeCsp(
    assetCspDirectives(
      serving.compiled.config,
      fileSetCspDirectives(serving.compiled.cspDirectives, serving.source),
      serving.origin,
    ),
  );
  const headers = new Headers({
    "content-type": type,
    "x-content-type-options": "nosniff",
    "referrer-policy": referrer,
    "x-robots-tag": "noindex, nofollow",
    // A page and a script (a worker's policy is its script's) get the page's CSP; anything else
    // runs nothing when opened on its own.
    "content-security-policy": `${role === "file" ? INERT_FILE_CSP : frameCsp}; frame-ancestors ${serving.frameAncestors}`,
  });

  if (role === "page") {
    // Every page of the set in the shell (P081): its hardening, its host functions, its theme.
    const html = serving.compiled.shellDocument({
      origins: serving.hostOrigins,
      document: await textOf(body),
      cspMeta: false,
      ...(referrer === "same-origin" ? { referrer } : {}),
      files: {
        base,
        // At a ticket's address: the entry's own (its directory's, for an entry in one).
        ...(serving.ticket === undefined
          ? {}
          : {
              address: `${base}${found.path.includes("/") ? encodePath(found.path) : ""}`,
              expires: serving.ticket.expires,
            }),
        ...(serving.artifact === undefined ? {} : { set: serving.artifact }),
      },
    });
    if (serving.ticket !== undefined) {
      headers.set("cache-control", "no-store");
      return new Response(method === "HEAD" ? null : html, { status: 200, headers });
    }
    const etag = `"${hex(sha256(utf8(html)))}"`;
    headers.set("etag", etag);
    // A page is asked again each time it loads, so the host's check runs on every navigation.
    headers.set("cache-control", "private, no-cache");
    if (found.status === 200 && notModified(request, etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(method === "HEAD" ? null : html, { status: found.status, headers });
  }

  const size = body instanceof Uint8Array ? body.byteLength : entry.size;
  const etag = HEX.test(entry.sha256) ? `"${entry.sha256}"` : null;
  if (etag !== null) {
    headers.set("etag", etag);
  }
  headers.set(
    "cache-control",
    serving.pinned ? `private, max-age=${YEAR}, immutable` : "private, no-cache",
  );
  // Only this origin's own pages load it: no other content origin (a sibling, same-site without
  // the public suffix list) can embed it with the viewer's cookie.
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("accept-ranges", "bytes");
  if (role === "file" && type === "application/octet-stream") {
    headers.set("content-disposition", "attachment");
  }
  if (etag !== null && notModified(request, etag)) {
    if (!(body instanceof Uint8Array)) {
      await body.cancel();
    }
    return new Response(null, { status: 304, headers });
  }
  const range = found.status === 200 ? rangeOf(request.headers.get("range"), size) : null;
  if (range === "unsatisfiable") {
    if (!(body instanceof Uint8Array)) {
      await body.cancel();
    }
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range !== null) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    if (method === "HEAD" && !(body instanceof Uint8Array)) {
      await body.cancel();
    }
    return new Response(method === "HEAD" ? null : asBody(slice(body, range.start, range.end)), {
      status: 206,
      headers,
    });
  }
  // A stream's length is the manifest's word: said for HEAD, left to the transfer otherwise.
  if (body instanceof Uint8Array || method === "HEAD") {
    headers.set("content-length", String(size));
  }
  if (method === "HEAD" && !(body instanceof Uint8Array)) {
    await body.cancel();
  }
  return new Response(method === "HEAD" ? null : asBody(body), { status: found.status, headers });
}

/**
 * An asset of an artifact's library (P089), at `/_blob/<id>`: typed by Porthole's table by its
 * name, never as a page (one named so goes as a download), inert opened on its own (an SVG runs
 * nothing), `nosniff`, loaded only by its own origin's pages (CORP), immutable (an id never names
 * other bytes), its sha256 the ETag, ranges for media.
 */
export async function serveAsset(serving: {
  readonly request: Request;
  readonly asset: StoredAsset;
  readonly frameAncestors: string;
  /** Whether a code-typed asset is served as code (trusted, where uploaded code runs). */
  readonly code: boolean;
}): Promise<Response> {
  const { request, asset } = serving;
  const method = request.method.toUpperCase();
  const plain = (status: 404 | 405) =>
    new Response(method === "HEAD" ? null : status === 404 ? "Not found" : "Only read", {
      status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-security-policy": `${INERT_FILE_CSP}; frame-ancestors ${serving.frameAncestors}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(status === 405 ? { allow: "GET, HEAD" } : {}),
      },
    });
  if (method !== "GET" && method !== "HEAD") {
    return plain(405);
  }
  const body = await asset.read();
  if (body === null) {
    return plain(404);
  }
  const typed = fileTypeOf(asset.name);
  // Never a page: an asset is the library's, outside the shell (P089); code only where it was
  // trusted when it was uploaded (after the review).
  const asCode = typed.role !== "page" && isCodeAsset(asset.name) && serving.code;
  const type =
    typed.role === "page" || (isCodeAsset(asset.name) && !asCode)
      ? "application/octet-stream"
      : typed.type;
  const headers = new Headers({
    "content-type": type,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "content-security-policy": `${INERT_FILE_CSP}; frame-ancestors ${serving.frameAncestors}`,
    // Asked again at each load, so a removal or a revocation holds at once (after the review);
    // the ETag keeps it cheap.
    "cache-control": "private, no-cache",
    "cross-origin-resource-policy": "same-origin",
    "accept-ranges": "bytes",
  });
  if (type === "application/octet-stream") {
    headers.set("content-disposition", "attachment");
  }
  // The ETag carries the decision too (P103): once a stricter config ships, a copy the browser
  // kept as code is a different one, so its revalidation gets the download whole, never a 304
  // that would leave it typed as code.
  const etag = HEX.test(asset.sha256) ? `"${asset.sha256}-${asCode ? "code" : "inert"}"` : null;
  if (etag !== null) {
    headers.set("etag", etag);
    if (notModified(request, etag)) {
      if (!(body instanceof Uint8Array)) {
        await body.cancel();
      }
      return new Response(null, { status: 304, headers });
    }
  }
  const size = body instanceof Uint8Array ? body.byteLength : asset.size;
  const range = rangeOf(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    if (!(body instanceof Uint8Array)) {
      await body.cancel();
    }
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range !== null) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    if (method === "HEAD" && !(body instanceof Uint8Array)) {
      await body.cancel();
    }
    return new Response(method === "HEAD" ? null : asBody(slice(body, range.start, range.end)), {
      status: 206,
      headers,
    });
  }
  if (body instanceof Uint8Array || method === "HEAD") {
    headers.set("content-length", String(size));
  }
  if (method === "HEAD" && !(body instanceof Uint8Array)) {
    await body.cancel();
  }
  return new Response(method === "HEAD" ? null : asBody(body), { status: 200, headers });
}
