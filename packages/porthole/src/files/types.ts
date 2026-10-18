/**
 * The media type a file of a set is served with (P081): Porthole's own table, by the path's
 * extension, never the uploader's word and never sniffed. A file whose extension isn't here is
 * `application/octet-stream`, served as a download. Pure: any runtime.
 */

/** How a type is served: a page (in the shell), a script (it may run as a worker), or a file. */
export type FileRole = "page" | "script" | "file";

export interface FileType {
  /** The `content-type` header. */
  readonly type: string;
  readonly role: FileRole;
}

const UTF8 = "; charset=utf-8";

/** Extension (lowercase, no dot) to media type. Standard web types only. */
const TABLE: Readonly<Record<string, string>> = {
  html: `text/html${UTF8}`,
  htm: `text/html${UTF8}`,
  css: `text/css${UTF8}`,
  js: `text/javascript${UTF8}`,
  mjs: `text/javascript${UTF8}`,
  cjs: `text/javascript${UTF8}`,
  json: `application/json${UTF8}`,
  map: `application/json${UTF8}`,
  webmanifest: `application/manifest+json${UTF8}`,
  txt: `text/plain${UTF8}`,
  md: `text/markdown${UTF8}`,
  markdown: `text/markdown${UTF8}`,
  csv: `text/csv${UTF8}`,
  tsv: `text/tab-separated-values${UTF8}`,
  xml: `application/xml${UTF8}`,
  vtt: `text/vtt${UTF8}`,
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  wasm: "application/wasm",
  pdf: "application/pdf",
  glb: "model/gltf-binary",
  gltf: `model/gltf+json${UTF8}`,
  zip: "application/zip",
};

/** What a file whose extension isn't in the table is served as: a download. */
export const UNKNOWN_TYPE = "application/octet-stream";

/** The extension of a path's last segment, lowercase, without the dot ("" for none). */
export function extensionOf(path: string): string {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot <= 0 ? "" : last.slice(dot + 1).toLowerCase();
}

/** The type a path is served with, and how. */
export function fileTypeOf(path: string): FileType {
  const extension = extensionOf(path);
  const type = Object.hasOwn(TABLE, extension) ? TABLE[extension] : undefined;
  if (type === undefined) {
    return { type: UNKNOWN_TYPE, role: "file" };
  }
  const role: FileRole =
    extension === "html" || extension === "htm"
      ? "page"
      : type.startsWith("text/javascript")
        ? "script"
        : "file";
  return { type, role };
}

/** Whether Porthole's table names the path's extension (else it is served as a download). */
export const knownType = (path: string): boolean => fileTypeOf(path).type !== UNKNOWN_TYPE;

/** Whether a path names a page: an `.html` file. */
export const isPagePath = (path: string): boolean => fileTypeOf(path).role === "page";

/** Every extension the table knows, for the manual and tests. */
export const KNOWN_EXTENSIONS: readonly string[] = Object.keys(TABLE);
