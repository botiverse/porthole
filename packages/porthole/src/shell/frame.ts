import { PAGE_SANDBOX_TOKENS } from "../compile/policy.ts";
import {
  framedByProblem,
  hostOriginProblem,
  includesOrigin,
  onNestedLabel,
} from "../isolation/served.ts";

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
 *   arrives after the state that says so), and at once when the host asks (`porthole/shell/look`,
 *   P120: the host heard focus move into the frame, and a key the person types into the page
 *   before the shell's next frame would turn its activation on as a press does). What it can't
 *   see: a gesture while its activation is already on (within 5 s of the last one) turns nothing
 *   on;
 * - hears each real press in the page from the page's runtime (P148), over a `MessagePort` it makes
 *   at each load of the page's frame and sends down (`porthole/shell/press-port`): the runtime
 *   takes it before any content runs, and no content holds it. A message on it says only that
 *   there was a press; the shell notes when it heard it, on its own clock, tells the host in its
 *   state (how long ago, and how many it has heard), and then answers on the port, so what the
 *   page says next arrives after the state that says so. Only the port of the frame's last load is
 *   heard, and what was said of a press before it is forgotten; the port before is heard again
 *   only if the runtime that holds it says, on it, that its document is still there (WebKit fires
 *   a load for a navigation within the document, P142);
 * - renews the page's sealed files' address before it ends, and gives the page the new one
 *   (`porthole/files-renewed`): the page's own loads aren't its origin's (an opaque origin's never
 *   are), so only the shell, on that origin, may renew it (P083);
 * - passes its focus to the page: at the focus event where that takes (Firefox, from the host's
 *   `<body>`), and on the host's word that it moved it there (`porthole/shell/focus`, P136), where
 *   it doesn't: a frame's move inside the focus event that made it the focused frame sets the
 *   shell's `activeElement` and goes no further (Chromium, WebKit), and from a focused element of
 *   the host's the window hears no focus event at all (Firefox). A later task's `frame.focus()`
 *   goes through on all of them, the frame blurred first as the failed one left it active.
 *
 * Plain ES2020, no imports and no build step, like the runtime. `__PLAN__` is its plan. A shell
 * whose parent may be an outer page (a host's `framedBy`, P141) runs the strict runtime, which
 * checks that parent before it says `*`; every other shell runs 0.14.16's, byte for byte, so its
 * hash is too (P144).
 */
const frameShellRuntime = (strict: boolean): string => String.raw`(() => {
  "use strict";
  const plan = __PLAN__;
  const PREFIX = "porthole/shell/";
  const own = location.origin;
  // A nested page's shell runs on a label of its own alone (P114, P121): on any other origin (its
  // scope's, where other displays run content with allow-same-origin) it frames nothing and says
  // nothing.
  if (!/^porthole-[a-z2-7]{24}\./.test(location.hostname + ".")) {
    return;
  }
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
  // The page's real presses (P148): when the last one was heard (null: none since the frame's last
  // load), how many were heard in all, and the one port listened to.
  let pressedAt = null;
  let presses = 0;
  let pressPort = null;
  // The port a load set aside, until the next one: its document may still be there (below).
  let asidePort = null;
  const shut = (port) => {
    if (port !== null) {
      port.onmessage = null;
      port.close();
    }
  };
  const hear = (port) => {
    port.onmessage = (event) => {
      if (pressPort !== port || event.data !== 0) {
        return;
      }
      pressedAt = performance.now();
      presses += 1;
      // To the host first, then the answer: what the page held back follows the state.
      look(undefined, true);
      port.postMessage(0);
    };
  };
  frame.addEventListener("load", () => {
    shut(asidePort);
    const before = pressPort;
    asidePort = before;
    pressedAt = null;
    const child = frame.contentWindow;
    if (child === null || typeof MessageChannel !== "function") {
      shut(before);
      asidePort = null;
      pressPort = null;
      return;
    }
    const channel = new MessageChannel();
    const port = channel.port1;
    pressPort = port;
    hear(port);
    if (before !== null) {
      // A load is a new document, whose runtime takes this port, and the one before is heard no
      // more. But not every load is one: WebKit fires it for a navigation within the document
      // (P142), whose runtime is still there and takes no second port. It says so (1) on the port
      // it holds, which no one else can: that port is then the one again, and the new one is shut.
      before.onmessage = (event) => {
        if (event.data === 1 && pressPort === port && asidePort === before) {
          shut(port);
          asidePort = null;
          pressPort = before;
          hear(before);
        }
      };
    }
    child.postMessage({ jsonrpc: "2.0", method: PREFIX + "press-port" }, "*", [channel.port2]);
  });
  frame.src = page.href;
  document.body.append(frame);

  const framed = window.parent !== window;
  const web = plan.origins.filter((origin) => origin.indexOf("https://") === 0 || origin.indexOf("http://") === 0);
  // To the host: each web host origin (only the parent's is delivered); a desktop app's own scheme
  // is no target a browser takes, so where one is listed and the parent isn't a known web origin,
  // "*" (frame-ancestors holds the parent to the host origins; nothing said here is secret).${strict ? STRICT_NOTE : ""}
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
    if (${strict ? STRICT_CONDITION : "web.length < plan.origins.length && (parent === null || web.indexOf(parent) === -1)"}) {
      try {
        window.parent.postMessage(message, "*");
      } catch (_) {}
    }
  };

  // The shell's own state: its transient activation (and when it turned on), the page's focus.
  // "since" is when the shell saw activation turn on, which a page that holds the thread the shell
  // shares with it (WebKit, Firefox) can push later than the press: so the shell looks every 50 ms
  // and beats as often, and each report says how long it went without a look before (gap). The
  // host takes an activation the shell saw after a stall for uncertain (P111, after its review).
  const activation = navigator.userActivation;
  let active = false;
  let since = 0;
  let focused = false;
  let lookedAt = performance.now();
  let toldAt = 0;
  const tell = (gap, asked) => {
    toldAt = performance.now();
    const params = {
      supported: activation !== undefined,
      active,
      ago: active ? Math.max(0, Math.round(performance.now() - since)) : null,
      focused,
      gap: Math.max(0, Math.round(gap)),
      // The page's last real press (P148): how long ago the shell heard it, and how many so far.
      pressed: pressedAt === null ? null : Math.max(0, Math.round(performance.now() - pressedAt)),
      presses,
    };
    // The answer to the host's ask (P120), by its number.
    if (asked !== undefined) {
      params.asked = asked;
    }
    toHost({ jsonrpc: "2.0", method: PREFIX + "state", params });
  };
  const look = (asked, pressed) => {
    const now = performance.now();
    const gap = now - lookedAt;
    lookedAt = now;
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
    if (changed || pressed === true || typeof asked === "number") {
      tell(gap, typeof asked === "number" ? asked : undefined);
    } else if (now - toldAt >= 50) {
      // The heartbeat: the host knows the shell was looking, every 50 ms.
      toldAt = now;
      toHost({ jsonrpc: "2.0", method: PREFIX + "beat", params: { gap: Math.max(0, Math.round(gap)) } });
    }
  };
  const tick = () => {
    look();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setInterval(look, 50);

  // Whether the focus is on the shell's own document, not through it on the page's (P136). Firefox
  // tells a move from a focused element of the host's on the document alone. The host's word needs
  // this: it never moves a focus that isn't here, and a page that has it hears no blur.
  let holds = false;
  // Until when a word that came ahead of the focus it speaks of holds (it crosses processes too).
  let wordUntil = 0;
  const handOn = () => {
    if (holds && document.hasFocus()) {
      frame.blur();
      frame.focus();
    }
  };
  const came = () => {
    holds = true;
    if (performance.now() < wordUntil) {
      wordUntil = 0;
      setTimeout(handOn, 0);
    }
  };
  document.addEventListener("focus", came);
  addEventListener("blur", () => {
    holds = false;
    look();
  });
  addEventListener("focus", (event) => {
    if (event.target === window) {
      came();
      // Where a move can go on from inside this event (P136): Firefox, from the host's <body>.
      if (document.activeElement !== frame) {
        frame.focus();
      }
    }
    look();
  });
  document.addEventListener("visibilitychange", look);
  tell(0);

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
      const data = event.data;
      // The host's words to the shell are never the page's to hear (P120): its ask to look now.
      if (data !== null && typeof data === "object" && typeof data.method === "string" && data.method.indexOf(PREFIX) === 0) {
        const n = data.params !== null && typeof data.params === "object" ? data.params.n : undefined;
        if (data.method === PREFIX + "look" && typeof n === "number" && n >= 0 && Math.floor(n) === n) {
          look(n);
        }
        // The host's own move into the frame, done (P136): on to the page.
        if (data.method === PREFIX + "focus") {
          if (holds) {
            handOn();
          } else {
            wordUntil = performance.now() + 250;
          }
        }
        return;
      }
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

/** What a strict shell says of its `*` (P141), after the default's note. */
const STRICT_NOTE = ` Where
  // it names an outer page above them too (the host's framedBy, P141: plan.strictParent), the parent
  // may be the outer page: "*" then goes only to a parent the engine names as a host origin.`;
/** When a strict shell says `*` (P141): as 0.14.16's, and only to a parent named as a host origin. */
const STRICT_CONDITION = `
      web.length < plan.origins.length &&
      (parent === null || web.indexOf(parent) === -1) &&
      (plan.strictParent !== true || (parent !== null && plan.origins.indexOf(parent) !== -1))
    `;

/** The nested page's shell's runtime: 0.14.16's, byte for byte. */
export const FRAME_SHELL_RUNTIME = frameShellRuntime(false);
/** A strict shell's runtime (P141): its parent may be an outer page. */
export const STRICT_FRAME_SHELL_RUNTIME = frameShellRuntime(true);

export {
  SHELL_METHOD_PREFIX,
  SHELL_PRESS_PORT_METHOD,
  SHELL_STATE_METHOD,
} from "../isolation/types.ts";

export interface FrameShellOptions {
  /** The host origins: the shell takes messages from its parent only from these. */
  readonly origins: readonly string[];
  /**
   * Origins of an outer page that may be an ancestor above a host origin's page (P141): in the
   * shell's `frame-ancestors` after `origins` (`nestedShellResponse`), never heard or told. Where
   * there are any, the shell says `*` only to a parent the engine names as a host origin.
   */
  readonly framedBy?: readonly string[];
  /** The page's address: absolute, on the shell's own origin, under `/__porthole/f/`. */
  readonly page: string;
  /** The page frame's accessible name. */
  readonly title?: string;
  /** Where the page's sealed address is renewed (`<base>__porthole/renew`), and when it ends. */
  readonly renew?: { readonly url: string; readonly expires: number };
}

/** JSON that is safe inside a `<script>`. */
export const scriptJson = (value: unknown): string =>
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
  for (const origin of options.framedBy ?? []) {
    const problem = framedByProblem(origin);
    if (problem !== null || includesOrigin(options.origins, origin)) {
      throw new TypeError(`frameShellScript: framedBy: ${problem ?? `${origin} is a host origin`}`);
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
  // The shell runs on a nested page's own label alone (P114), and its page is on its origin.
  if (!onNestedLabel(page.origin)) {
    throw new TypeError(
      "frameShellScript: page is on a nested page's own label (porthole-<24 base32>, nestedLabelOf)",
    );
  }
  const strict = (options.framedBy ?? []).length > 0;
  return (strict ? STRICT_FRAME_SHELL_RUNTIME : FRAME_SHELL_RUNTIME).replace("__PLAN__", () =>
    scriptJson({
      origins: options.origins,
      ...(strict ? { strictParent: true } : {}),
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
