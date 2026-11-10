import { DOOR_SANDBOX_TOKENS } from "../compile/policy.ts";
import { framedByProblem, includesOrigin, normalOrigin } from "../isolation/served.ts";
import { FRAME_STATUS_METHOD } from "../isolation/types.ts";
import type { FrameBlock } from "../host/types.ts";
import { base64url, sha256, utf8 } from "./crypto.ts";

/**
 * The server's own pages on a content origin: why it shows nothing of the content, and the page a
 * framed app is entered through. Plain, framable only by the host origins (and, above them, a
 * host's `framedBy`, P141), never cached. Each tells the page that frames it how loading went
 * (`porthole/notifications/frame-status`, P040), posted to the host origins only, so a host can show
 * its own fallback ("Open in a new tab"). Their words are the host-agnostic mechanism's; a host that
 * wants its own wording serves its own page in front.
 */

/**
 * Whether a page's `frame-ancestors` holds its parent to its host origins: it names no one else.
 * Where it does (a host's `framedBy`, P141), its parent may be an outer page, and the page says
 * `*` only to a parent the engine names as a host origin (`strictParent`, below).
 */
const heldToHosts = (frameAncestors: string, hostOrigins: readonly string[]): boolean =>
  frameAncestors
    .split(" ")
    .filter((each) => each !== "")
    .every((each) => hostOrigins.includes(each));

/** Whether a page is strict: its parent isn't held to its hosts (`heldToHosts`). */
const isStrict = (frameAncestors: string, hostOrigins: readonly string[]): boolean =>
  !heldToHosts(frameAncestors, hostOrigins);

/** The attribute that says so, on a page's `<main>`: none where its parent is held to its hosts. */
const strictParent = (strict: boolean): string => (strict ? ' data-porthole-strict-parent=""' : "");

/**
 * Who may frame a page: the host origins, then a host's `framedBy` (P141), each checked (they go
 * into a header).
 */
export function ancestorsOf(
  hostOrigins: readonly string[],
  framedBy: readonly string[] = [],
): string {
  for (const origin of framedBy) {
    const problem = framedByProblem(origin);
    if (problem !== null) {
      throw new TypeError(`framedBy: ${problem}`);
    }
    if (includesOrigin(hostOrigins, origin)) {
      throw new TypeError(`framedBy: ${origin} is a host origin already`);
    }
  }
  const normal = framedBy.map(normalOrigin);
  return [
    ...hostOrigins,
    ...framedBy.filter((_, at) => normal.indexOf(normal[at] ?? "") === at),
  ].join(" ");
}

const escape = (text: string): string =>
  text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

const STYLE =
  ":root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}main{max-width:420px;padding:24px}h1{font-size:17px;margin:0 0 8px}p{margin:0;opacity:.75;line-height:1.5}";

/** Where the pages' scripts are served, on every content origin. */
export const STATUS_SCRIPT_PATH = "/__porthole/status.js";
export const ENTER_SCRIPT_PATH = "/__porthole/enter.js";
/**
 * A strict page's scripts (P141): a page whose parent may be an outer page loads these, and every
 * other page 0.14.16's at the paths above, byte for byte (P144).
 */
export const STRICT_STATUS_SCRIPT_PATH = "/__porthole/status-strict.js";
export const STRICT_ENTER_SCRIPT_PATH = "/__porthole/enter-strict.js";
/** Answers 204 when the request carries a good session for its origin's app, 401 otherwise. */
export const SESSION_PATH = "/__porthole/session";

/**
 * Tells the page that frames this one how loading went, at each web host origin. A desktop app's
 * own scheme (`ferry://app`) is no target origin a browser takes (postMessage throws), so where
 * the host origins hold one, and the parent isn't known to be a web host origin, the word goes to
 * the parent as `*`: these pages' `frame-ancestors` hold their parent to the host origins, and what
 * they say is no secret (P070). Where it names an outer page too (`framedBy`, P141), the parent may be
 * the outer page: then `*` goes only to a parent the engine names (`location.ancestorOrigins`,
 * not masked as "null") as one of the host origins, so an outer page is never told. One origin
 * failing never stops the page. Only a strict page's scripts (`strict`) carry that check: every other
 * page's are 0.14.16's, byte for byte, so their hashes are too (P144).
 */
const say = (strict: boolean): string =>
  `${strict ? "const strict = main.dataset.portholeStrictParent !== undefined;\n  " : ""}const say = (params) => {
    if (window.parent === window) return;
    const message = { jsonrpc: "2.0", method: ${JSON.stringify(FRAME_STATUS_METHOD)}, params };
    const web = hosts.filter((origin) => origin.startsWith("https://") || origin.startsWith("http://"));
    for (const origin of web) { try { window.parent.postMessage(message, origin); } catch (_) {} }
    const parent = location.ancestorOrigins && location.ancestorOrigins.length > 0 ? location.ancestorOrigins[0] : null;
    if (web.length < hosts.length && (parent === null || !web.includes(parent))${strict ? " && (!strict || (parent !== null && hosts.includes(parent)))" : ""}) { try { window.parent.postMessage(message, "*"); } catch (_) {} }
  };`;

/** Tells the host the page is blocked, and why (from the page's data attributes). */
const statusScript = (strict: boolean): string => `(() => {
  const main = document.querySelector("[data-porthole-status]");
  if (main === null) return;
  const hosts = JSON.parse(main.dataset.portholeHosts || "[]");
  ${say(strict)}
  const blocked = { state: "blocked", reason: main.dataset.portholeReason || "error", status: Number(main.dataset.portholeStatus) };
  if (main.dataset.portholeCode) blocked.code = main.dataset.portholeCode;
  say(blocked);
})();`;
const STATUS_SCRIPT = statusScript(false);
const STRICT_STATUS_SCRIPT = statusScript(true);

/**
 * Enters a framed app: says so, checks that the browser kept the session cookie this page's own
 * answer set (WebKit keeps none in a cross-site frame, P025), then, once this page has loaded,
 * goes on to the app, or says it is blocked and why.
 */
const enterScript = (strict: boolean): string => `(async () => {
  const main = document.querySelector("[data-porthole-enter]");
  if (main === null) return;
  const hosts = JSON.parse(main.dataset.portholeHosts || "[]");
  ${say(strict)}
  say({ state: "entering" });
  let kept = false;
  try {
    kept = (await fetch(${JSON.stringify(SESSION_PATH)}, { credentials: "same-origin", cache: "no-store" })).ok;
  } catch (_) {}
  if (kept) {
    // The host counts this page's load, then the app's (P040): leave only once this page has
    // loaded, or a fast answer would leave first and its load would never be seen.
    if (document.readyState !== "complete") {
      await new Promise((resolve) => addEventListener("load", resolve, { once: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    location.replace(main.dataset.portholeTarget || "/");
    return;
  }
  say({ state: "blocked", reason: "cookies", status: 401 });
  main.querySelector("h1").textContent = "Open this app in a new tab";
  main.querySelector("p").textContent = "This browser keeps no sign-in for it inside a frame.";
})();`;
const ENTER_SCRIPT = enterScript(false);
const STRICT_ENTER_SCRIPT = enterScript(true);

/** The pages' scripts, by path. */
const PAGE_SCRIPTS: ReadonlyMap<string, string> = new Map([
  [STATUS_SCRIPT_PATH, STATUS_SCRIPT],
  [ENTER_SCRIPT_PATH, ENTER_SCRIPT],
  [STRICT_STATUS_SCRIPT_PATH, STRICT_STATUS_SCRIPT],
  [STRICT_ENTER_SCRIPT_PATH, STRICT_ENTER_SCRIPT],
]);

/** The pages' scripts, by path: served with the pages' own policy in mind (`script-src 'self'`). */
export function pageScript(pathname: string): Response | null {
  const body = PAGE_SCRIPTS.get(pathname);
  return body === undefined
    ? null
    : new Response(body, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
}

const policy = (frameAncestors: string, connect: boolean): string =>
  `default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; ${connect ? "connect-src 'self'; " : ""}base-uri 'none'; form-action 'none'; frame-ancestors ${frameAncestors}`;

const pageHeaders = (frameAncestors: string, connect: boolean) => ({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": policy(frameAncestors, connect),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  // Content origins are behind tickets: nothing on them is for search engines.
  "x-robots-tag": "noindex, nofollow",
});

export function statusPage(
  status: number,
  title: string,
  detail: string,
  frameAncestors: string,
  method = "GET",
  reason: FrameBlock = "error",
  hostOrigins: readonly string[] = [],
  code?: string,
): Response {
  const strict = isStrict(frameAncestors, hostOrigins);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main data-porthole-status="${status}" data-porthole-reason="${escape(reason)}"${code === undefined ? "" : ` data-porthole-code="${escape(code)}"`} data-porthole-hosts="${escape(JSON.stringify(hostOrigins))}"${strictParent(strict)}><h1>${escape(title)}</h1><p>${escape(detail)}</p></main><script src="${strict ? STRICT_STATUS_SCRIPT_PATH : STATUS_SCRIPT_PATH}"></script></body></html>`;
  return new Response(method === "HEAD" ? null : body, {
    status,
    headers: pageHeaders(frameAncestors, false),
  });
}

/** The page a framed app is entered through (its answer also sets the session cookie). */
export function enterPage(
  target: string,
  frameAncestors: string,
  hostOrigins: readonly string[],
  cookie: string,
): Response {
  const strict = isStrict(frameAncestors, hostOrigins);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Opening the app</title><style>${STYLE}</style></head><body><main data-porthole-enter="" data-porthole-target="${escape(target)}" data-porthole-hosts="${escape(JSON.stringify(hostOrigins))}"${strictParent(strict)}><h1>Opening the app…</h1><p></p></main><script src="${strict ? STRICT_ENTER_SCRIPT_PATH : ENTER_SCRIPT_PATH}"></script></body></html>`;
  const headers = new Headers(pageHeaders(frameAncestors, true));
  headers.set("set-cookie", cookie);
  return new Response(body, { status: 200, headers });
}

/** A script's hash, for a page that carries it inline (`script-src 'sha256-…'`). */
const hashOf = (script: string): string => {
  const hash = base64url(sha256(utf8(script)))
    .replace(/-/gu, "+")
    .replace(/_/gu, "/");
  const padding = (4 - (hash.length % 4)) % 4;
  return `'sha256-${hash}${"=".repeat(padding)}'`;
};
const hashes = new Map<string, string>();
/** An inline script's hash, worked out once. */
const hashOfScript = (script: string): string => {
  let hash = hashes.get(script);
  if (hash === undefined) {
    hash = hashOf(script);
    hashes.set(script, hash);
  }
  return hash;
};
/** The status script a page carries inline: a strict page's (P141), or 0.14.16's. */
const statusScriptOf = (strict: boolean): string => (strict ? STRICT_STATUS_SCRIPT : STATUS_SCRIPT);

/**
 * A redirect entry's page on the app's own origin (P068): why it shows nothing, told to the page
 * that frames it like a content origin's page. Plain, no app chrome; its one script inline under
 * its hash (the app origin serves no script of Porthole's).
 */
export function appStatusPage(
  status: number,
  title: string,
  detail: string,
  frameAncestors: string,
  reason: FrameBlock,
  hostOrigins: readonly string[],
  link?: { readonly href: string; readonly text: string },
  method = "GET",
): Response {
  const more =
    link === undefined
      ? ""
      : `<p><a href="${escape(link.href)}" target="_top" rel="noopener">${escape(link.text)}</a></p>`;
  const strict = isStrict(frameAncestors, hostOrigins);
  const script = statusScriptOf(strict);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${STYLE}a{color:inherit}</style></head><body><main data-porthole-status="${status}" data-porthole-reason="${escape(reason)}" data-porthole-hosts="${escape(JSON.stringify(hostOrigins))}"${strictParent(strict)}><h1>${escape(title)}</h1><p>${escape(detail)}</p>${more}</main><script>${script}</script></body></html>`;
  return new Response(method === "HEAD" ? null : body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src ${hashOfScript(script)}; base-uri 'none'; form-action 'none'; frame-ancestors ${frameAncestors}`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/** Who a page is framed by and tells: the host origins, and whom else may frame it. */
export interface HostedPage {
  readonly hostOrigins: readonly string[];
  /**
   * Origins of an outer page that may be an ancestor above a host origin's page (P141): added to its
   * `frame-ancestors` after the host origins, never told anything. Default none.
   */
  readonly framedBy?: readonly string[];
  /** Who may frame it (`frame-ancestors`): default, the host origins, then `framedBy`. */
  readonly frameAncestors?: string;
  readonly embed?: false;
}

/**
 * An embedded document's page (P143, `Grant.embed`): framed by any page (`frame-ancestors *`), and
 * told to no one (it names no host, `data-porthole-hosts="[]"`). For a content Worker's answer
 * before an embed session exists (not public, rate-limited), shown where the embed is.
 */
export interface EmbedPage {
  readonly embed: true;
  readonly hostOrigins?: never;
  readonly framedBy?: never;
  readonly frameAncestors?: never;
}

/** Whom a page tells, and who may frame it: the host origins' (P141), or an embed's (P143). */
const framingOf = (
  options: HostedPage | EmbedPage,
): { readonly hosts: readonly string[]; readonly ancestors: string } =>
  options.embed === true
    ? { hosts: [], ancestors: "*" }
    : {
        hosts: options.hostOrigins,
        ancestors: options.frameAncestors ?? ancestorsOf(options.hostOrigins, options.framedBy),
      };

/**
 * A page saying why a frame shows nothing, for a relay of the app's own (P072): told to the page
 * that frames it, at each web host origin and (a desktop scheme among them) to its parent (P070),
 * its one script inline under its hash, so it works on any origin. With `embed` (P143), framed by
 * any page and told to no one.
 */
export function statusPageOf(
  options: {
    readonly status: number;
    readonly title: string;
    readonly detail: string;
    readonly reason?: FrameBlock;
    readonly link?: { readonly href: string; readonly text: string };
    readonly method?: string;
  } & (HostedPage | EmbedPage),
): Response {
  const { hosts, ancestors } = framingOf(options);
  return appStatusPage(
    options.status,
    options.title,
    options.detail,
    ancestors,
    options.reason ?? "error",
    hosts,
    options.link,
    options.method,
  );
}

/** A door's word that its display may be framed (P125), from the page's data attributes. */
const doorScript = (strict: boolean): string => `(() => {
  const main = document.querySelector("[data-porthole-door]");
  if (main === null) return;
  const hosts = JSON.parse(main.dataset.portholeHosts || "[]");
  ${say(strict)}
  say({ state: "open" });
})();`;
const DOOR_SCRIPT = doorScript(false);
const STRICT_DOOR_SCRIPT = doorScript(true);

/**
 * A door's headers (P125): its one script by its hash (an opaque document has no `'self'` to load
 * one from), nothing else loads, sandboxed with scripts alone in its header too (opaque on a tab, and
 * in a frame whose attribute a host's own platform forgot), framed by the host origins, never
 * cached, never sent on, no cookie.
 */
const doorHeaders = (script: string, frameAncestors: string): Headers =>
  new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; script-src ${script}; base-uri 'none'; form-action 'none'; sandbox ${DOOR_SANDBOX_TOKENS.join(" ")}; frame-ancestors ${frameAncestors}`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
  });

/**
 * What a door is given: the host origins it tells, and who may frame it (default, those and then
 * `framedBy`, P141: an outer page's origins above a host origin's page, never told anything).
 */
export interface DoorOptions {
  readonly hostOrigins: readonly string[];
  readonly framedBy?: readonly string[];
  readonly frameAncestors?: string;
  readonly method?: string;
}

/**
 * A door that opens (P125): its display may be framed. It says `open` to the page that frames it,
 * at each web host origin and (a desktop scheme among them) to its parent (P070), once, as it
 * parses. For a content Worker of a host's own: answer it at `DOOR_PATH<key>` only once the door's
 * own ticket was taken and the checks the content's address runs passed for the same grant.
 */
export function doorResponse(options: DoorOptions): Response {
  const hosts = escape(JSON.stringify(options.hostOrigins));
  const ancestors = options.frameAncestors ?? ancestorsOf(options.hostOrigins, options.framedBy);
  const strict = isStrict(ancestors, options.hostOrigins);
  const script = strict ? STRICT_DOOR_SCRIPT : DOOR_SCRIPT;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Opening</title></head><body><main data-porthole-door="" data-porthole-hosts="${hosts}"${strictParent(strict)}></main><script>${script}</script></body></html>`;
  return new Response(options.method?.toUpperCase() === "HEAD" ? null : body, {
    status: 200,
    headers: doorHeaders(hashOfScript(script), ancestors),
  });
}

/**
 * A door that doesn't open (P125): why, said `blocked` to the page that frames it, as a content
 * origin's status page says it (`session` 401: no ticket, or one used, ended, or not a door's of
 * this instance on this origin; `denied` 403 with the host's code; `not-found` 404: no document, or
 * a file set whose entry isn't a page; `error` 500). With `embed` (P143), for a content Worker's
 * refusal before an embed session exists: framed by any page and told to no one.
 */
export function doorStatusResponse(
  options: (
    | (DoorOptions & { readonly embed?: false })
    | (EmbedPage & { readonly method?: string })
  ) & {
    readonly status: number;
    readonly reason: FrameBlock;
    readonly code?: string;
  },
): Response {
  const { status, reason, code } = options;
  const framing = framingOf(options);
  const hosts = escape(JSON.stringify(framing.hosts));
  const ancestors = framing.ancestors;
  const strict = isStrict(ancestors, framing.hosts);
  const script = statusScriptOf(strict);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not shown</title></head><body><main data-porthole-status="${status}" data-porthole-reason="${escape(reason)}"${code === undefined ? "" : ` data-porthole-code="${escape(code)}"`} data-porthole-hosts="${hosts}"${strictParent(strict)}></main><script>${script}</script></body></html>`;
  return new Response(options.method?.toUpperCase() === "HEAD" ? null : body, {
    status,
    headers: doorHeaders(hashOfScript(script), ancestors),
  });
}

/**
 * What a clean address answers in a frame (P125): a clean address is for a tab of its own, so in a
 * frame it never goes to the app (no authorize, no sign-in, no refusal page of the app's) and says
 * nothing to the page that frames it: no script at all, under the status pages' policy without
 * `script-src` (so `default-src 'none'` forbids every script), framed by the host origins only. A
 * host frames what a clean address names by resolving it through `issue` (`client.resolve`).
 */
export function tabOnlyPage(frameAncestors: string, method = "GET"): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open this in a new tab</title><style>${STYLE}</style></head><body><main data-porthole-tab-only=""><h1>Open this in a new tab</h1><p>This address opens in a tab of its own, not inside a frame.</p></main></body></html>`;
  return new Response(method.toUpperCase() === "HEAD" ? null : body, {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors ${frameAncestors}`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
