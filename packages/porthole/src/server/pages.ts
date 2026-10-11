import { FRAME_STATUS_METHOD } from "../isolation/types.ts";
import type { FrameBlock } from "../host/types.ts";

/**
 * The server's own pages on a content origin: why it shows nothing of the content, and the page a
 * framed app is entered through. Plain, framable only by the host origins, never cached. Each tells
 * the page that frames it how loading went (`porthole/notifications/frame-status`, P040), posted to
 * the host origins only, so a host can show its own fallback ("Open in a new tab"). Their words are
 * the host-agnostic mechanism's; a host that wants its own wording serves its own page in front.
 */

const escape = (text: string): string =>
  text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

const STYLE =
  ":root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}main{max-width:420px;padding:24px}h1{font-size:17px;margin:0 0 8px}p{margin:0;opacity:.75;line-height:1.5}";

/** Where the pages' scripts are served, on every content origin. */
export const STATUS_SCRIPT_PATH = "/__porthole/status.js";
export const ENTER_SCRIPT_PATH = "/__porthole/enter.js";
/** Answers 204 when the request carries a good session for its origin's app, 401 otherwise. */
export const SESSION_PATH = "/__porthole/session";

const say = (): string =>
  `const say = (params) => { if (window.parent === window) return; for (const origin of hosts) window.parent.postMessage({ jsonrpc: "2.0", method: ${JSON.stringify(FRAME_STATUS_METHOD)}, params }, origin); };`;

/** Tells the host the page is blocked, and why (from the page's data attributes). */
const STATUS_SCRIPT = `(() => {
  const main = document.querySelector("[data-porthole-status]");
  if (main === null) return;
  const hosts = JSON.parse(main.dataset.portholeHosts || "[]");
  ${say()}
  const blocked = { state: "blocked", reason: main.dataset.portholeReason || "error", status: Number(main.dataset.portholeStatus) };
  if (main.dataset.portholeCode) blocked.code = main.dataset.portholeCode;
  say(blocked);
})();`;

/**
 * Enters a framed app: says so, checks that the browser kept the session cookie this page's own
 * answer set (WebKit keeps none in a cross-site frame, P025), then, once this page has loaded,
 * goes on to the app, or says it is blocked and why.
 */
const ENTER_SCRIPT = `(async () => {
  const main = document.querySelector("[data-porthole-enter]");
  if (main === null) return;
  const hosts = JSON.parse(main.dataset.portholeHosts || "[]");
  ${say()}
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

/** The pages' scripts, by path: served with the pages' own policy in mind (`script-src 'self'`). */
export function pageScript(pathname: string): Response | null {
  const body =
    pathname === STATUS_SCRIPT_PATH
      ? STATUS_SCRIPT
      : pathname === ENTER_SCRIPT_PATH
        ? ENTER_SCRIPT
        : null;
  return body === null
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
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main data-porthole-status="${status}" data-porthole-reason="${escape(reason)}"${code === undefined ? "" : ` data-porthole-code="${escape(code)}"`} data-porthole-hosts="${escape(JSON.stringify(hostOrigins))}"><h1>${escape(title)}</h1><p>${escape(detail)}</p></main><script src="${STATUS_SCRIPT_PATH}"></script></body></html>`;
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
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Opening the app</title><style>${STYLE}</style></head><body><main data-porthole-enter="" data-porthole-target="${escape(target)}" data-porthole-hosts="${escape(JSON.stringify(hostOrigins))}"><h1>Opening the app…</h1><p></p></main><script src="${ENTER_SCRIPT_PATH}"></script></body></html>`;
  const headers = new Headers(pageHeaders(frameAncestors, true));
  headers.set("set-cookie", cookie);
  return new Response(body, { status: 200, headers });
}
