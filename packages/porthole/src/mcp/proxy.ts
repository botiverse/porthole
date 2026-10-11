import type { CompiledConfig } from "../compile/compile.ts";
import { MCP_APPS_METHODS } from "../protocol/mcp-apps.ts";

/**
 * The MCP Apps sandbox proxy (spec § Sandbox proxy), served by `/server` on a scope's origin: a
 * second origin, never the host's, where a view gets `allow-scripts allow-same-origin` (P016).
 * It announces itself (`sandbox-proxy-ready`) until its host answers with the view's HTML
 * (`sandbox-resource-ready`), then becomes the view: it writes the shell's document into its own,
 * with the view's HTML as data in the shell's plan (never as markup for the page's parser, which
 * could build what the shell's guards can't see), and the shell renders it inert, guarded, then
 * runs it, under the CSP the proxy's headers already carry. Writing a document erases
 * the window's listeners, so nothing of the proxy is left once the view runs, and the view talks
 * to its host directly: the relay the spec describes is the identity here (P026).
 *
 * The proxy takes the HTML only from its parent, only from the host origins, and only once. It
 * ignores the message's `csp`, `sandbox` and `permissions`: the policy is the one its headers set
 * from the config and the view's declared egress when the host's backend issued it, and the
 * frame's sandbox and `allow` are the host's, from the same config.
 */
export const SANDBOX_PROXY_RUNTIME = String.raw`(() => {
  "use strict";
  const setup = __SETUP__;
  if (window.parent === window) {
    return;
  }
  let done = false;
  window.addEventListener("message", (event) => {
    if (done || event.source !== window.parent || setup.origins.indexOf(event.origin) === -1) {
      return;
    }
    const data = event.data;
    if (data === null || typeof data !== "object" || data.jsonrpc !== "2.0" || data.method !== setup.resource) {
      return;
    }
    const params = data.params;
    if (params === null || typeof params !== "object" || typeof params.html !== "string") {
      return;
    }
    done = true;
    // The view goes into the shell's plan as a JSON string, safe inside its <script>.
    const literal = JSON.stringify(params.html)
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    const page = setup.shell.replace(setup.slot, () => literal);
    document.open();
    document.write(page);
    document.close();
  });
  // Say so until answered: the host may start listening after this runs. Nothing secret is said.
  let tries = 0;
  const announce = () => {
    if (done || tries >= 40) {
      return;
    }
    tries += 1;
    window.parent.postMessage({ jsonrpc: "2.0", method: setup.ready, params: {} }, "*");
    setTimeout(announce, 250);
  };
  announce();
})();`;

/** Where the view's HTML goes in the shell's plan: a string no view can produce as JSON. */
const VIEW_SLOT = "porthole-view-slot-7f3a9c";

/** JSON that is safe inside a `<script>`: no `</script>`, no `<!--`. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");

/**
 * The proxy's document for a view under `compiled` (an `mcp-app` config with domain isolation),
 * taking the view only from `hostOrigins`. The document it becomes is exactly
 * `compiled.shellDocument({ origins: hostOrigins, document: html, cspMeta: false })`: the shell,
 * carrying the view as data.
 */
export function sandboxProxyDocument(
  compiled: CompiledConfig,
  hostOrigins: readonly string[],
): string {
  if (compiled.config.mode !== "mcp-app") {
    throw new TypeError(`The sandbox proxy serves MCP Apps views, not ${compiled.config.mode}`);
  }
  // The shell with a slot for the view: the slot's JSON literal, replaced by the view's.
  const shell = compiled.shellDocument({
    origins: hostOrigins,
    document: VIEW_SLOT,
    cspMeta: false,
  });
  const slot = JSON.stringify(VIEW_SLOT);
  if (shell.split(slot).length !== 2) {
    throw new Error("The shell document must hold the view's slot exactly once");
  }
  const runtime = SANDBOX_PROXY_RUNTIME.replace("__SETUP__", () =>
    scriptJson({
      origins: hostOrigins,
      shell,
      slot,
      ready: MCP_APPS_METHODS.sandboxProxyReady,
      resource: MCP_APPS_METHODS.sandboxResourceReady,
    }),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Sandbox</title>
</head>
<body>
<script>${runtime}</script>
</body>
</html>
`;
}
