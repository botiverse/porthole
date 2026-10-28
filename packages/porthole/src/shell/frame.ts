import { PAGE_SANDBOX_TOKENS } from "../compile/policy.ts";
import { hostOriginProblem } from "../isolation/served.ts";

/**
 * Porthole's shell for a nested page (P111): the whole document at the address the host frames,
 * with no content in it. It frames the page (the same origin's sealed files' address) in a child
 * sandboxed without `allow-same-origin`, so the page's origin is opaque and nothing of the shell's
 * realm is reachable from it: not its DOM, its globals, its storage, or the window the host hears.
 *
 * The shell:
 * - passes every message between the host (its parent, from the host origins) and the page (its
 *   child's window, by `event.source` alone: the page's origin is "null") unchanged, and drops any
 *   the page sends in the shell's own namespace (`porthole/shell/`), so the shell's words to the
 *   host are only its own;
 * - tells the host its own state (`porthole/shell/state`): whether its transient activation is on,
 *   and since when, and whether the page's focus is in it. A gesture in the page activates the
 *   page and its ancestors, the shell among them, and nothing on the host's page activates the
 *   shell (activation goes up, never down), so the shell's activation turning on is a press or
 *   key of the person's in this page. It is read at every animation frame, on its window's focus
 *   and blur, and before each message of the page's is passed on (a call made in a click's handler
 *   arrives after the state that says so). What it can't see: a gesture while its activation is
 *   already on (within 5 s of the last one) turns nothing on;
 * - renews the page's sealed files' address before it ends, and gives the page the new one
 *   (`porthole/files-renewed`): the page's own loads aren't its origin's (an opaque origin's never
 *   are), so only the shell, on that origin, may renew it (P083);
 * - passes its focus to the page (the host's own move into the frame, or a Tab).
 *
 * Plain ES2020, no imports and no build step, like the runtime. `__PLAN__` is its plan.
 */
export const FRAME_SHELL_RUNTIME = String.raw`(() => {
  "use strict";
  const plan = __PLAN__;
  const PREFIX = "porthole/shell/";
  const own = location.origin;
  let page = null;
  try {
    page = new URL(plan.page);
  } catch (_) {}
  // Only a page of this origin's sealed files: nothing else is ever framed here.
  if (page === null || page.origin !== own || page.pathname.indexOf("/__porthole/f/") !== 0) {
    return;
  }
  // Belt and braces: a plan that would give the page this origin frames nothing.
  if (typeof plan.sandbox !== "string" || /allow-same-origin/i.test(plan.sandbox)) {
    return;
  }
  const root = document.documentElement;
  root.style.height = "100%";
  document.body.style.margin = "0";
  document.body.style.height = "100%";
  document.body.style.background = "transparent";
  const frame = document.createElement("iframe");
  // Scripts only: never allow-same-origin (the page would have this origin, and so this realm).
  frame.setAttribute("sandbox", plan.sandbox);
  frame.setAttribute("allow", "clipboard-read 'none'; clipboard-write 'none'");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = typeof plan.title === "string" ? plan.title : "Content";
  frame.style.display = "block";
  frame.style.border = "0";
  frame.style.width = "100%";
  frame.style.height = "100%";
  frame.style.background = "transparent";
  frame.src = page.href;
  document.body.append(frame);

  const framed = window.parent !== window;
  const web = plan.origins.filter((origin) => origin.indexOf("https://") === 0 || origin.indexOf("http://") === 0);
  // To the host: each web host origin (only the parent's is delivered); a desktop app's own scheme
  // is no target a browser takes, so where one is listed and the parent isn't a known web origin,
  // "*" (frame-ancestors holds the parent to the host origins; nothing said here is secret).
  const toHost = (message) => {
    if (!framed) {
      return;
    }
    for (const origin of web) {
      try {
        window.parent.postMessage(message, origin);
      } catch (_) {}
    }
    const parent = location.ancestorOrigins && location.ancestorOrigins.length > 0 ? location.ancestorOrigins[0] : null;
    if (web.length < plan.origins.length && (parent === null || web.indexOf(parent) === -1)) {
      try {
        window.parent.postMessage(message, "*");
      } catch (_) {}
    }
  };

  // The shell's own state: its transient activation (and when it turned on), the page's focus.
  const activation = navigator.userActivation;
  let active = false;
  let since = 0;
  let focused = false;
  const tell = () => {
    toHost({
      jsonrpc: "2.0",
      method: PREFIX + "state",
      params: {
        supported: activation !== undefined,
        active,
        ago: active ? Math.max(0, Math.round(performance.now() - since)) : null,
        focused,
      },
    });
  };
  const look = () => {
    const on = activation !== undefined && activation.isActive === true;
    const inside = document.hasFocus();
    let changed = false;
    if (on !== active) {
      active = on;
      if (on) {
        since = performance.now();
      }
      changed = true;
    }
    if (inside !== focused) {
      focused = inside;
      changed = true;
    }
    if (changed) {
      tell();
    }
  };
  const tick = () => {
    look();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  addEventListener("blur", look);
  addEventListener("focus", (event) => {
    // The host's move into the frame (or a Tab) lands here: on to the page.
    if (event.target === window && document.activeElement !== frame) {
      frame.focus();
    }
    look();
  });
  document.addEventListener("visibilitychange", look);
  tell();

  addEventListener("message", (event) => {
    const source = event.source;
    if (source !== null && source === frame.contentWindow) {
      const data = event.data;
      // Never the shell's words in the page's mouth.
      if (data !== null && typeof data === "object" && typeof data.method === "string" && data.method.indexOf(PREFIX) === 0) {
        return;
      }
      // What the shell knows now goes first: a call in a click's handler follows its activation.
      look();
      toHost(data);
      return;
    }
    if (framed && source === window.parent && plan.origins.indexOf(event.origin) !== -1) {
      const child = frame.contentWindow;
      if (child !== null) {
        child.postMessage(event.data, "*");
      }
    }
  });

  // The page's sealed address, renewed before it ends (P083): the page can't, the shell can.
  if (plan.renew && typeof plan.renew.url === "string" && typeof plan.renew.expires === "number") {
    const prefix = own + "/__porthole/f/";
    let renewUrl = plan.renew.url;
    const renewIn = (expires) => Math.max(30000, expires - Date.now() - 300000);
    const renew = () => {
      fetch(renewUrl, { credentials: "omit", cache: "no-store" })
        .then((answer) => (answer.ok ? answer.json() : null))
        .then((renewed) => {
          if (!renewed || typeof renewed.base !== "string" || typeof renewed.expires !== "number" || renewed.base.indexOf(prefix) !== 0) {
            setTimeout(renew, 60000);
            return;
          }
          renewUrl = renewed.base + "__porthole/renew";
          const child = frame.contentWindow;
          if (child !== null) {
            child.postMessage({ jsonrpc: "2.0", method: "porthole/files-renewed", params: { base: renewed.base } }, "*");
          }
          setTimeout(renew, renewIn(renewed.expires));
        })
        .catch(() => setTimeout(renew, 60000));
    };
    setTimeout(renew, renewIn(plan.renew.expires));
  }
})();`;

export { SHELL_METHOD_PREFIX, SHELL_STATE_METHOD } from "../isolation/types.ts";

export interface FrameShellOptions {
  /** The host origins: the shell takes messages from its parent only from these. */
  readonly origins: readonly string[];
  /** The page's address: absolute, on the shell's own origin, under `/__porthole/f/`. */
  readonly page: string;
  /** The page frame's accessible name. */
  readonly title?: string;
  /** Where the page's sealed address is renewed (`<base>__porthole/renew`), and when it ends. */
  readonly renew?: { readonly url: string; readonly expires: number };
}

/** JSON that is safe inside a `<script>`. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");

/** The shell's script for `options`: what its document runs, and what its CSP's hash names. */
export function frameShellScript(options: FrameShellOptions): string {
  for (const origin of options.origins) {
    const problem = hostOriginProblem(origin);
    if (problem !== null) {
      throw new TypeError(`frameShellScript: ${problem}`);
    }
  }
  let page: URL;
  try {
    page = new URL(options.page);
  } catch {
    throw new TypeError("frameShellScript: page is an absolute URL");
  }
  if (!page.pathname.startsWith("/__porthole/f/") || page.hash !== "") {
    throw new TypeError("frameShellScript: page is under /__porthole/f/, with no fragment");
  }
  return FRAME_SHELL_RUNTIME.replace("__PLAN__", () =>
    scriptJson({
      origins: options.origins,
      page: page.href,
      sandbox: PAGE_SANDBOX_TOKENS.join(" "),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.renew === undefined
        ? {}
        : { renew: { url: options.renew.url, expires: options.renew.expires } }),
    }),
  );
}

/** The shell's document around its script: nothing else (its CSP allows that script alone). */
export function frameShellDocument(script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Porthole</title>
</head>
<body>
<script>${script}</script>
</body>
</html>
`;
}
