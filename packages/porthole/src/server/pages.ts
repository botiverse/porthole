/**
 * The server's own pages on a content origin: why it shows nothing of the content. Plain, no
 * script, framable only by the host origins, never cached. Their words are the host-agnostic
 * mechanism's; a host that wants its own wording serves its own page in front.
 */

const escape = (text: string): string =>
  text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

const STYLE =
  ":root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}main{max-width:420px;padding:24px}h1{font-size:17px;margin:0 0 8px}p{margin:0;opacity:.75;line-height:1.5}";

export function statusPage(
  status: number,
  title: string,
  detail: string,
  frameAncestors: string,
  method = "GET",
): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main data-porthole-status="${status}"><h1>${escape(title)}</h1><p>${escape(detail)}</p></main></body></html>`;
  return new Response(method === "HEAD" ? null : body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors ${frameAncestors}`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
