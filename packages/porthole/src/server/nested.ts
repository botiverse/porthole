import type { CompiledConfig } from "../compile/compile.ts";
import {
  INERT_FILE_CSP,
  PAGE_SANDBOX_TOKENS,
  servedPermissionsPolicy,
  serializeCsp,
  type CspDirective,
} from "../compile/policy.ts";
import { frameShellDocument, frameShellScript, type FrameShellOptions } from "../shell/frame.ts";
import { onNestedLabel, PORTHOLE_LABEL_PREFIX } from "../isolation/served.ts";
import { sha256, utf8 } from "./crypto.ts";
import { base32 } from "./keys.ts";

export { isNestedLabel, PORTHOLE_LABEL_PREFIX } from "../isolation/served.ts";

/**
 * A nested page's serving (P111): what the address the host frames answers (Porthole's shell,
 * `nestedShellResponse`), and what changes on the page and its files below the sealed prefix
 * (`nestedAncestors`, `NESTED_FILE_HEADERS`). `/server` serves both for a config with `nested`;
 * a host serving its own content origin (its own Worker) answers the same.
 *
 * All of it is served on the shell's own label (P114, `nestedLabelOf`), never on the scope's: every
 * other display of the scope runs agent-made content on the scope's origin with
 * `allow-same-origin`, which would be same-origin with the shell, its realm and the page's sealed
 * address.
 */

/**
 * The label a nested page's shell is served on (P114), for its scope's label: `porthole-` and 24
 * base32 characters of the label's SHA-256, one per scope, the same for every nested page of it. No
 * content label is ever one (a keyed label has no hyphen, a host's is refused the prefix), so
 * nothing but a nested page's shell, its opaque page, that page's files and Porthole's status pages
 * is ever served on it: no other display's content runs there with `allow-same-origin`. Not a
 * secret: anyone who knows the scope's label may work it out. A content Worker of a host's own
 * serves its nested pages on it too.
 */
export function nestedLabelOf(label: string): string {
  return `${PORTHOLE_LABEL_PREFIX}${base32(sha256(utf8(`porthole/nested/${label}`)).subarray(0, 15))}`;
}

/** Where every page and file of a nested page is, on its origin: its sealed files' prefix. */
export const NESTED_FILES_PREFIX = "/__porthole/f/";

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/**
 * The shell's CSP (a header): its own script alone runs (by its hash), it frames and fetches
 * nothing but its origin's sealed files (the page, the renewal), and only the host origins frame
 * it. Nothing of the page's runs here: the page is a document of its own, which inherits none of
 * this (a framed URL's document never does).
 */
export function nestedShellCsp(
  script: string,
  origin: string,
  hostOrigins: readonly string[],
): string {
  const files = `${origin}${NESTED_FILES_PREFIX}`;
  const directives: CspDirective[] = [
    ["default-src", "'none'"],
    ["script-src", `'sha256-${base64(sha256(utf8(script)))}'`],
    ["frame-src", files],
    ["connect-src", files],
    ["base-uri", "'none'"],
    ["form-action", "'none'"],
    ["frame-ancestors", ...hostOrigins],
  ];
  return serializeCsp(directives);
}

/**
 * The answer at the address the host frames, for a nested page (P111): Porthole's shell, never
 * stored (it carries the page's sealed address), its page at `options.page`.
 */
export function nestedShellResponse(
  compiled: CompiledConfig,
  options: FrameShellOptions & { readonly origin: string; readonly method?: string },
): Response {
  // On the shell's own label alone (P114), its page on that origin (P121): a content Worker of a
  // host's own that would serve it beside other content is refused here, not left to its routes.
  if (!onNestedLabel(options.origin)) {
    throw new TypeError(
      `nestedShellResponse: origin ${options.origin} isn't on a nested page's own label (${PORTHOLE_LABEL_PREFIX}<24 base32>, nestedLabelOf)`,
    );
  }
  if (new URL(options.page).origin !== options.origin) {
    throw new TypeError("nestedShellResponse: page is on the shell's own origin");
  }
  const script = frameShellScript(options);
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": nestedShellCsp(script, options.origin, options.origins),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
  });
  // Denied to the shell, so to its child too (a frame's features are its parent's at most).
  const permissions = servedPermissionsPolicy(compiled.config);
  if (permissions !== null) {
    headers.set("permissions-policy", permissions);
  }
  return new Response(options.method === "HEAD" ? null : frameShellDocument(script), {
    status: 200,
    headers,
  });
}

/**
 * Who may frame a nested page and its files' answers: its shell (the shell's own origin, P114) and,
 * above it, the host origins (`frame-ancestors` names every ancestor).
 */
export const nestedAncestors = (origin: string, frameAncestors: string): string =>
  `${origin} ${frameAncestors}`;

/**
 * A nested page's answer's CSP below its sealed prefix, by what it is (P111; the one source for
 * `/server` and a content Worker of a host's own, P121): a page its directives and
 * `sandbox allow-scripts`, so it is an opaque origin in the shell's child and on a tab of its own
 * (never `allow-same-origin`, which would give it the shell's origin and realm); a script its
 * directives and `sandbox` (a worker's policy is its script's; opened on its own it runs nothing on
 * the shell's origin); any other file nothing at all. `directives` are the page's: the compiled
 * config's, its files' prefix opened (`fileSetCspDirectives(compiled.cspDirectives, source)`) for
 * a page of a file set. Then who may frame it: `frame-ancestors` (`nestedAncestors`).
 */
export function nestedFileCsp(
  role: "page" | "script" | "file",
  directives: readonly CspDirective[],
): string {
  switch (role) {
    case "page":
      return serializeCsp([...directives, ["sandbox", ...PAGE_SANDBOX_TOKENS]]);
    case "script":
      return serializeCsp([...directives, ["sandbox"]]);
    case "file":
      return INERT_FILE_CSP;
  }
}

/**
 * What a nested page's files (not its pages) carry beyond a served file's (P111): its page's
 * origin is opaque, so a same-origin resource policy would refuse its own images and scripts, and
 * its fetches, modules and fonts are CORS requests from `null`. The sealed address in their path
 * is their access, never the request's origin.
 */
export const NESTED_FILE_HEADERS: Readonly<Record<string, string>> = {
  "cross-origin-resource-policy": "cross-origin",
  "access-control-allow-origin": "*",
};
