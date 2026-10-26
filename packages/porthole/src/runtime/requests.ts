import { unseen } from "../bridge/unseen.ts";
import type { Limits } from "../config/schema.ts";
import { fileLimits, filePathProblem } from "../files/paths.ts";
import { fileTypeOf } from "../files/types.ts";
import type { ViewerLevel } from "./levels.ts";

/**
 * What the runtime's own host functions carry (P088–P090), checked where they cross the frame:
 * `artifact` (this artifact's version, and a new one), `assets` (its library), `comments` (the
 * host's composer at an anchor), `user` (who is viewing). A call that doesn't fit is refused
 * before any handler runs; one past a limit is refused as `too_large`.
 */

type Parsed<T> = T | "too_large" | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A short text of the content's: a string of `1..max` characters, no control characters, and
 * well-formed Unicode (P095: a lone surrogate makes `encodeURIComponent` throw, and is no text).
 */
const shortText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= max &&
  value.isWellFormed() &&
  !/\p{Cc}/u.test(value);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

/** The bytes a base64 text decodes to, or null if it isn't base64. */
export function base64Bytes(value: unknown): number | null {
  if (typeof value !== "string" || value.length % 4 !== 0 || !BASE64.test(value)) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

const encoder = new TextEncoder();

// --- user ---------------------------------------------------------------------------------------

/** Who is viewing, as the host said (`ViewerInfo`): what `user.get()` answers. */
export interface UserInfo {
  readonly id: string | null;
  readonly name: string | null;
  readonly level: ViewerLevel;
}

// --- comments -----------------------------------------------------------------------------------

/**
 * Where a comment goes, in the page's own words (P090): a name the page chose (`refs/a.md#L12`,
 * `slide-3`), a label to show, the text it quotes. The content's word: the host shows it as such.
 */
export interface CommentAnchor {
  readonly name: string;
  readonly label?: string;
  readonly quote?: string;
}

export interface CommentRequest {
  readonly anchor: CommentAnchor;
  /**
   * Text to start the person's comment with (P108): the content's word, a draft in the composer
   * that the person edits and posts themselves, or doesn't. Never posted by the host on its own.
   */
  readonly draft?: string;
}

/**
 * A draft (P108): text the person will post in their own name, so all of it must be text they can
 * see: at most 2,000 characters, well-formed, not blank, and nothing `unseen` (P100: no zero-width
 * or bidi characters, no tags, no controls but a new line and a tab), which a host would show as
 * nothing and an agent would read as the person's words. Lines and tabs are fine: a checklist.
 */
const draftText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= 2_000 &&
  value.isWellFormed() &&
  !unseen(value);

export function parseCommentRequest(args: unknown): CommentRequest | null {
  const anchor = isRecord(args) ? args.anchor : undefined;
  if (!isRecord(anchor) || !shortText(anchor.name, 256)) {
    return null;
  }
  const draft = isRecord(args) ? args.draft : undefined;
  if (
    (anchor.label !== undefined && !shortText(anchor.label, 200)) ||
    (anchor.quote !== undefined && !shortText(anchor.quote, 2_000)) ||
    (draft !== undefined && !draftText(draft))
  ) {
    return null;
  }
  return {
    anchor: {
      name: anchor.name,
      ...(anchor.label === undefined ? {} : { label: anchor.label }),
      ...(anchor.quote === undefined ? {} : { quote: anchor.quote }),
    },
    ...(draft === undefined ? {} : { draft }),
  };
}

// --- artifact -----------------------------------------------------------------------------------

/** One file of a new version: text, bytes as base64, or `null` (removed from the base's set). */
export type PublishedFile = { readonly text: string } | { readonly base64: string } | null;

/** The most files one publish names (as the publish protocol, task #124 §4). */
export const MAX_PUBLISH_FILES = 255;

export type ArtifactRequest =
  | { readonly op: "get" }
  | {
      readonly op: "publish";
      /** The version the page read and changed: the host refuses with `conflict` if it moved. */
      readonly base: string;
      /** A patch on `base`'s files: listed paths added or replaced, `null` removes, the rest kept. */
      readonly files: Readonly<Record<string, PublishedFile>>;
      readonly entry?: string;
      readonly label?: string;
      readonly note?: string;
    };

/** This artifact as `artifact.get()` answers it: its current version and that version's files. */
export interface ArtifactInfo {
  readonly version: string;
  readonly number?: number;
  readonly entry: string;
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

/** What a publish answers: the new version. */
export interface PublishedVersion {
  readonly version: string;
  readonly number?: number;
}

export function parseArtifactRequest(
  args: unknown,
  limits: Partial<Limits>,
): Parsed<ArtifactRequest> {
  if (!isRecord(args)) {
    return null;
  }
  if (args.op === "get") {
    return { op: "get" };
  }
  if (args.op !== "publish" || !shortText(args.base, 200) || !isRecord(args.files)) {
    return null;
  }
  const { maxFiles, maxFileBytes, maxVersionBytes } = fileLimits(limits);
  // Its count before any file is read, and each file's size before it is encoded, against the
  // version's total so far (P095: one file object shared under every path is one object to send).
  const given = args.files;
  const paths = Object.keys(given);
  if (paths.length === 0) {
    return null;
  }
  if (paths.length > Math.min(MAX_PUBLISH_FILES, maxFiles)) {
    return "too_large";
  }
  // No prototype: a path named `__proto__` is a path (after the review).
  const files = Object.create(null) as Record<string, PublishedFile>;
  let total = 0;
  for (const path of paths) {
    if (filePathProblem(path) !== null) {
      return null;
    }
    const file = given[path];
    if (file === null) {
      files[path] = null;
      continue;
    }
    if (!isRecord(file)) {
      return null;
    }
    let size: number | null = null;
    if (typeof file.text === "string" && file.base64 === undefined) {
      // A character is a byte or more in UTF-8: past a limit by its length, it isn't encoded.
      if (file.text.length > maxFileBytes || total + file.text.length > maxVersionBytes) {
        return "too_large";
      }
      size = encoder.encode(file.text).length;
      files[path] = { text: file.text };
    } else if (file.text === undefined) {
      if (typeof file.base64 === "string" && (file.base64.length / 4) * 3 - 2 > maxFileBytes) {
        return "too_large";
      }
      size = base64Bytes(file.base64);
      if (size !== null) {
        files[path] = { base64: file.base64 as string };
      }
    }
    if (size === null) {
      return null;
    }
    total += size;
    if (size > maxFileBytes || total > maxVersionBytes) {
      return "too_large";
    }
  }
  if (
    (args.entry !== undefined && filePathProblem(args.entry) !== null) ||
    (args.label !== undefined && !shortText(args.label, 60)) ||
    (args.note !== undefined && !shortText(args.note, 500))
  ) {
    return null;
  }
  return {
    op: "publish",
    base: args.base,
    files,
    ...(args.entry === undefined ? {} : { entry: args.entry as string }),
    ...(args.label === undefined ? {} : { label: args.label }),
    ...(args.note === undefined ? {} : { note: args.note }),
  };
}

// --- assets -------------------------------------------------------------------------------------

/** Where an artifact's assets are served, on its own origin, outside every version (P089). */
export const ASSET_PATH = "/_blob/";

/** An asset's id: 32 lowercase hex characters, made by the host, never guessable. */
export const ASSET_ID = /^[0-9a-f]{32}$/u;

/** An asset's address on its artifact's origin: what a page puts in `src`, as given. */
export const assetUrl = (id: string): string => `${ASSET_PATH}${id}`;

/** An asset as the library lists it. `type` is Porthole's for its name, never the uploader's. */
export interface AssetInfo {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export type AssetRequest =
  | { readonly op: "list" }
  | {
      readonly op: "upload";
      /** Its file name: the type it is served with comes from its extension. */
      readonly name: string;
      readonly base64: string;
      readonly size: number;
      /** Porthole's type for `name` (`fileTypeOf`). */
      readonly type: string;
      /**
       * Whether it may run as code (P089, after the review): a script, stylesheet or WebAssembly
       * an admin uploaded where uploaded code may run. Store it (`StoredAsset.trusted`): any other
       * code-typed asset is served as a download.
       */
      readonly trusted: boolean;
    }
  | { readonly op: "delete"; readonly id: string };

/**
 * Whether a file name may go into an asset library: a name (no separators or control
 * characters) whose extension Porthole's table types, and not a page: an asset is never served
 * as a document that runs (P089).
 */
export function assetNameProblem(name: unknown): string | null {
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    name.length > 255 ||
    !name.isWellFormed() ||
    /[/\\\p{Cc}\p{Cf}]/u.test(name)
  ) {
    return "an asset's name is a file name: 1 to 255 characters, no / or \\";
  }
  const { role, type } = fileTypeOf(name);
  if (role === "page") {
    return "a page can't be an asset (HTML is published with the artifact's files)";
  }
  if (type === "application/octet-stream") {
    return "an asset's name needs an extension Porthole types (an image, media, a font, a PDF, a stylesheet, a script, text or data)";
  }
  return null;
}

/** Whether a name's type runs as code in a page (a script, a stylesheet, WebAssembly). */
export function isCodeAsset(name: string): boolean {
  const { role, type } = fileTypeOf(name);
  return role === "script" || type.startsWith("text/css") || type === "application/wasm";
}

export function parseAssetRequest(
  args: unknown,
  limits: Partial<Limits>,
  /** Whether uploaded code may run here (`assetCodeRuns`): else code-typed names are refused. */
  code = true,
): Parsed<AssetRequest> {
  if (!isRecord(args)) {
    return null;
  }
  switch (args.op) {
    case "list":
      return { op: "list" };
    case "delete":
      return typeof args.id === "string" && ASSET_ID.test(args.id)
        ? { op: "delete", id: args.id }
        : null;
    case "upload": {
      if (assetNameProblem(args.name) !== null || (!code && isCodeAsset(args.name as string))) {
        return null;
      }
      const size = base64Bytes(args.base64);
      if (size === null) {
        return null;
      }
      if (size > fileLimits(limits).maxFileBytes) {
        return "too_large";
      }
      const name = args.name as string;
      return {
        op: "upload",
        name,
        base64: args.base64 as string,
        size,
        type: fileTypeOf(name).type,
        // The bridge says, once it knows who uploads (P089).
        trusted: false,
      };
    }
    default:
      return null;
  }
}

// --- downloads ----------------------------------------------------------------------------------

/** A file `downloads.save` hands the person: a name, its text or bytes (base64), its type. */
export interface DownloadedFile {
  readonly name: string;
  readonly type?: string;
  readonly text?: string;
  readonly base64?: string;
}

/**
 * `downloads.save(file)` as MCP Apps' `ui/download-file` carries it (one embedded resource), or
 * null for a file that doesn't fit.
 */
export function downloadContents(file: unknown): readonly unknown[] | null {
  if (!isRecord(file) || !shortText(file.name, 255) || /[/\\]/u.test(file.name)) {
    return null;
  }
  const type =
    file.type === undefined
      ? fileTypeOf(file.name).type
      : typeof file.type === "string" && /^[\w.+-]+\/[\w.+-]+$/u.test(file.type)
        ? file.type
        : null;
  if (type === null) {
    return null;
  }
  const uri = `file:///${encodeURIComponent(file.name)}`;
  if (typeof file.text === "string" && file.base64 === undefined) {
    return [{ type: "resource", resource: { uri, mimeType: type, text: file.text } }];
  }
  if (file.text === undefined && base64Bytes(file.base64) !== null) {
    return [{ type: "resource", resource: { uri, mimeType: type, blob: file.base64 } }];
  }
  return null;
}
