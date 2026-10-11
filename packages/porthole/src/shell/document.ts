import { SHELL_RUNTIME } from "./runtime.ts";
import type { ShellPlan } from "./plan.ts";

export interface ShellDocumentOptions {
  /**
   * The origins the shell takes messages from: the embedding page's own (`location.origin`), or
   * every host origin a served document may be embedded by. Exact origins, no wildcards. The
   * sender must also be the frame's parent.
   */
  readonly origins: readonly string[];
  /** The frame document's title (for assistive technology inside the frame). */
  readonly title?: string;
  /**
   * A whole document to harden instead of the shell's own empty one (an MCP Apps view, a page
   * served as it is): the shell's policy and runtime go first in it, before anything of its own.
   */
  readonly document?: string;
  /**
   * Whether the CSP goes in a `<meta>` (default). A served document sends it as a header too;
   * both apply, and the stricter wins.
   */
  readonly cspMeta?: boolean;
}

const EXACT_ORIGIN = /^(https?:\/\/[a-z0-9.-]+(:\d{1,5})?|https?:\/\/\[::1\](:\d{1,5})?)$/u;

const escapeAttribute = (value: string): string =>
  value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");

const escapeText = (value: string): string =>
  value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** JSON that is safe inside a `<script>`: no `</script>`, no `<!--`. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");

/** The base styles: the theme's type and color on the body, and nothing drawn by the shell. */
const BASE_STYLE = `:root { color-scheme: light dark; }
html, body { margin: 0; padding: 0; background: transparent; }
body {
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: var(--font-text-md-size, 14px);
  line-height: var(--font-text-md-line-height, 20px);
  color: var(--color-text-primary, CanvasText);
  overflow-wrap: anywhere;
  -webkit-text-size-adjust: 100%;
}
#porthole-root { display: flow-root; }
#porthole-root > svg { display: block; max-width: 100%; height: auto; }`;

/**
 * The frame's document: its policy, the base styles, and the runtime, before anything else. For
 * a given `document`, the shell's head comes first and the document follows with its doctype
 * dropped, so nothing of the document's can run before the runtime, while the page keeps
 * standards mode.
 */
export function shellDocument(plan: ShellPlan, csp: string, options: ShellDocumentOptions): string {
  for (const origin of options.origins) {
    if (!EXACT_ORIGIN.test(origin)) {
      throw new TypeError(`shellDocument: ${JSON.stringify(origin)} is not an exact origin`);
    }
  }
  const runtime = SHELL_RUNTIME.replace("__PLAN__", () =>
    scriptJson({ ...plan, origins: options.origins }),
  );
  const head = [
    '<meta charset="utf-8">',
    options.cspMeta === false
      ? null
      : `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    '<meta name="referrer" content="no-referrer">',
  ].filter((line) => line !== null);

  if (options.document !== undefined) {
    const rest = options.document.replace(/^﻿?\s*<!doctype[^>]*>/iu, "");
    return `<!doctype html>\n<html>\n<head>\n${head.join("\n")}\n<script>${runtime}</script>\n${rest}`;
  }

  return `<!doctype html>
<html lang="en">
<head>
${head.join("\n")}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(options.title ?? "Content")}</title>
<style>
${BASE_STYLE}
</style>
</head>
<body>
<div id="porthole-root"></div>
<script>${runtime}</script>
</body>
</html>
`;
}
