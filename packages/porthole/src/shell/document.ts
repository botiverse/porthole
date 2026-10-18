import { hostOriginProblem } from "../isolation/served.ts";
import { ANNOTATE_RUNTIME } from "./annotate.ts";
import { SHELL_RUNTIME } from "./runtime.ts";
import type { ShellPlan } from "./plan.ts";

export interface ShellDocumentOptions {
  /**
   * The origins the shell takes messages from: the embedding page's own (`location.origin`), or
   * every host origin a served document may be embedded by. Exact origins of any scheme (a
   * desktop app's own, `ferry://app`), no wildcards, never "null". The sender must also be the
   * frame's parent.
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
  /**
   * The embedding page's CSP nonce, where its `script-src` is nonce-based (P054): a `srcdoc` frame
   * inherits the embedding page's policy, so the shell's script and style carry it, and so does
   * every script the shell runs for the content. The frame can read it.
   */
  readonly nonce?: string;
  /**
   * A page that comes with files (P081, P084): the absolute URL its version's files are under
   * (`https://a-x.example-usercontent.com/v/3/`). The shell lets the frame navigate to the set's
   * other pages there, and to nothing else.
   */
  readonly files?: {
    readonly base: string;
    /**
     * The page's own address under `base`, where the request's isn't it (a ticket's answer, P083):
     * the shell puts it in the frame's history first, before anything loads, so the page's
     * relative addresses are its files' and the spent ticket leaves the address.
     */
    readonly address?: string;
    /**
     * When a sealed address stops opening the page's files on its own (epoch ms, P083): the shell
     * renews it before then, at `<base>__porthole/renew`, and moves the page there.
     */
    readonly expires?: number;
  };
}

/** A file set's base: an absolute http(s) URL that ends in `/`, no query or fragment. */
function filesBaseOk(base: string): boolean {
  try {
    const url = new URL(base);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.href === base &&
      base.endsWith("/") &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** A CSP nonce: base64 or base64url characters, 8 to 256 of them. */
const NONCE = /^[A-Za-z0-9+/_=-]{8,256}$/u;

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
    const problem = hostOriginProblem(origin);
    if (problem !== null) {
      throw new TypeError(`shellDocument: ${problem}`);
    }
  }
  if (options.nonce !== undefined && !NONCE.test(options.nonce)) {
    throw new TypeError("shellDocument: a nonce is 8 to 256 base64 characters");
  }
  if (options.files !== undefined && !filesBaseOk(options.files.base)) {
    throw new TypeError("shellDocument: files.base is an http(s) URL ending in /, with no query");
  }
  if (
    options.files?.address !== undefined &&
    (!options.files.address.startsWith(options.files.base) || /[?#]/u.test(options.files.address))
  ) {
    throw new TypeError("shellDocument: files.address is under files.base, with no query");
  }
  const nonce = options.nonce === undefined ? "" : ` nonce="${options.nonce}"`;
  // The annotation runtime only where it is declared; spliced in before the plan, which may carry
  // any text (a document) and must not be searched.
  const runtime = SHELL_RUNTIME.replace("__ANNOTATE__", () =>
    plan.capabilities.annotate === undefined ? "" : ANNOTATE_RUNTIME,
  ).replace("__PLAN__", () =>
    scriptJson({
      ...plan,
      origins: options.origins,
      ...(options.document === undefined ? {} : { document: options.document }),
      ...(options.files === undefined
        ? {}
        : {
            files: {
              base: options.files.base,
              ...(options.files.address === undefined ? {} : { address: options.files.address }),
              ...(options.files.expires === undefined ? {} : { expires: options.files.expires }),
            },
          }),
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
<style${nonce}>
${BASE_STYLE}
</style>
</head>
<body>
<div id="porthole-root"></div>
<script${nonce}>${runtime}</script>
</body>
</html>
`;
}
