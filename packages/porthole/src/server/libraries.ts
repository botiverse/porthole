import { LIBRARY_FILES } from "../libraries/files.generated.ts";
import { LIBRARY_PATH } from "../libraries/libraries.ts";

/**
 * Porthole's vendored libraries (P079), as every content origin serves them under `LIBRARY_PATH`:
 * fixed files, the same for everyone, so no ticket or cookie is asked for and they may be cached
 * for good (a path's bytes never change). Same-site only: content origins load them, no one else.
 * Null for any other path (the reserved prefix's 404 answers it).
 */
export function libraryFile(pathname: string, method: string): Response | null {
  if (!pathname.startsWith(LIBRARY_PATH) || (method !== "GET" && method !== "HEAD")) {
    return null;
  }
  const body = Object.hasOwn(LIBRARY_FILES, pathname) ? LIBRARY_FILES[pathname] : undefined;
  if (body === undefined) {
    return null;
  }
  return new Response(method === "HEAD" ? null : body, {
    headers: {
      "content-type": pathname.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "text/plain; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      "cross-origin-resource-policy": "same-site",
      "x-content-type-options": "nosniff",
    },
  });
}
