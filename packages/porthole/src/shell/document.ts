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
   * A whole document to show in place of the shell's own empty one (an MCP Apps view): the shell
   * parses it inert, guards it, imports it, and runs its scripts in order, once its own policy
   * and runtime are in place. It is never handed to the page's parser, which could build what the
   * shell's guards can't see.
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
#porthole-root > svg { display: block; max-width: 100%; height: auto; }
:where(button, input, select, textarea) { font: inherit; color: inherit; box-sizing: border-box; }
:where(button, select, input:is([type="button" i], [type="submit" i], [type="reset" i])) {
  min-height: 44px;
  padding: 0 14px;
  border: var(--border-width-regular, 1px) solid var(--color-border-primary, ButtonBorder);
  border-radius: var(--border-radius-md, 8px);
  background: var(--color-background-secondary, ButtonFace);
  color: var(--color-text-primary, ButtonText);
  cursor: pointer;
}
:where(input:not([type]), input:is([type="text" i], [type="search" i], [type="number" i], [type="email" i], [type="url" i], [type="tel" i], [type="password" i], [type="date" i], [type="time" i]), textarea) {
  min-height: 44px;
  padding: 0 10px;
  border: var(--border-width-regular, 1px) solid var(--color-border-primary, FieldText);
  border-radius: var(--border-radius-md, 8px);
  background: var(--color-background-secondary, Field);
}
:where(textarea) { padding: 8px 10px; }
:where(input:is([type="checkbox" i], [type="radio" i], [type="range" i])) { accent-color: var(--color-accent, auto); }
:where(button, input, select, textarea):focus-visible { outline: 2px solid var(--color-ring-primary, Highlight); outline-offset: 1px; }
:where(button, input, select, textarea):disabled { color: var(--color-text-disabled, GrayText); cursor: default; }`;

/**
 * The frame's document: its policy first, then the base styles, an empty root, and the runtime.
 * A given `document` travels in the runtime's plan, as data.
 */
export function shellDocument(plan: ShellPlan, csp: string, options: ShellDocumentOptions): string {
  for (const origin of options.origins) {
    if (!EXACT_ORIGIN.test(origin)) {
      throw new TypeError(`shellDocument: ${JSON.stringify(origin)} is not an exact origin`);
    }
  }
  const runtime = SHELL_RUNTIME.replace("__PLAN__", () =>
    scriptJson({
      ...plan,
      origins: options.origins,
      ...(options.document === undefined ? {} : { document: options.document }),
    }),
  );
  const head = [
    '<meta charset="utf-8">',
    options.cspMeta === false
      ? null
      : `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    '<meta name="referrer" content="no-referrer">',
    // Off for good: an engine may prefetch names it sees in links, outside the CSP.
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
  ].filter((line) => line !== null);

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
