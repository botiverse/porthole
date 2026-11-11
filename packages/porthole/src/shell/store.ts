import { hostOriginProblem } from "../isolation/served.ts";
import { scriptJson } from "./frame.ts";

/**
 * A nested page's store (P149): a document of Porthole's own on the page's **scope's own origin**,
 * the origin a served page of that scope runs on. It does one thing: it reads and writes that
 * origin's `localStorage` for one peer, the page's runtime, over a `MessagePort` its shell hands
 * it. The page itself is an opaque origin and has no storage; the shell is another origin
 * (`porthole-<24>`) and reads nothing that crosses.
 *
 * What it takes from whom:
 * - **a port**, from its parent alone, at its shell's origin alone, in a message that is the
 *   browser's own (`porthole/shell/store-port`, one port). The store is on a content origin: to
 *   answer anyone else's port would be to hand over the whole storage. A new port from its shell
 *   (the page's frame loaded again) replaces the one before;
 * - **the host's word to clear** (`porthole/shell/store-clear`), from its shell the same way;
 * - **data**, on the port: `ask` (answered with every key the origin holds), `set`, `remove`,
 *   `clear`. Keys and values are strings and nothing else; they are the content's words, kept as
 *   they come and never read as anything.
 *
 * It never grows the origin's `localStorage` past the caps (`units`: the sum of every key's and
 * value's length, in UTF-16 code units; `keys`): a write that would is dropped, and the page's
 * runtime, which counts the same way, has already said so to the page. What the origin already
 * holds past them (a served page wrote it, before its scope was nested) stays readable and can
 * shrink. A change another tab makes reaches it as the origin's `storage` event, and is passed on.
 *
 * Plain ES2020, no imports and no build step, as the shell's and the runtime's. `__PLAN__` is its
 * plan: `{ shell, units, keys }`.
 */
export const STORE_RUNTIME = String.raw`(() => {
  "use strict";
  const plan = __PLAN__;
  const PORT = "porthole/shell/store-port";
  const CLEAR = "porthole/shell/store-clear";
  if (window.parent === window || typeof plan.shell !== "string") {
    return;
  }
  // The origin's own storage; null where the browser gives a framed page none.
  let storage = null;
  try {
    storage = window.localStorage;
    storage.length;
  } catch (_) {
    storage = null;
  }
  let port = null;
  const say = (message) => {
    if (port !== null) {
      try {
        port.postMessage(message);
      } catch (_) {}
    }
  };
  // Every key the origin holds, with its value: a list of pairs, never an object's properties (a
  // key may be named __proto__).
  const pairs = () => {
    const all = [];
    if (storage === null) {
      return all;
    }
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      const value = key === null ? null : storage.getItem(key);
      if (key !== null && value !== null) {
        all.push([key, value]);
      }
    }
    return all;
  };
  const answer = () => say({ keys: pairs(), kept: storage !== null });
  // Whether writing value under key keeps the origin within the caps, or at least grows neither
  // count (what is already past them can shrink).
  const fits = (key, value) => {
    let units = 0;
    let count = 0;
    let before = null;
    for (const [each, held] of pairs()) {
      units += each.length + held.length;
      count += 1;
      if (each === key) {
        before = held;
      }
    }
    const grown = before === null ? key.length + value.length : value.length - before.length;
    const more = before === null ? 1 : 0;
    return (units + grown <= plan.units || grown <= 0) && (count + more <= plan.keys || more === 0);
  };
  const heard = (data) => {
    if (storage === null || data === null || typeof data !== "object") {
      return;
    }
    try {
      if (data.ask === 1) {
        answer();
      } else if (Array.isArray(data.set) && data.set.length === 2 && typeof data.set[0] === "string" && typeof data.set[1] === "string") {
        if (fits(data.set[0], data.set[1])) {
          storage.setItem(data.set[0], data.set[1]);
        }
      } else if (typeof data.remove === "string") {
        storage.removeItem(data.remove);
      } else if (data.clear === 1) {
        storage.clear();
      }
    } catch (_) {}
  };
  addEventListener("message", (event) => {
    if (event.isTrusted !== true || event.source !== window.parent || event.origin !== plan.shell) {
      return;
    }
    const data = event.data;
    if (data === null || typeof data !== "object") {
      return;
    }
    if (data.method === CLEAR) {
      try {
        if (storage !== null) {
          storage.clear();
        }
      } catch (_) {}
      say({ cleared: 1 });
      return;
    }
    if (data.method !== PORT || event.ports.length !== 1) {
      return;
    }
    if (port !== null) {
      port.onmessage = null;
      port.close();
    }
    port = event.ports[0];
    port.onmessage = (message) => heard(message.data);
  });
  // Another tab of this origin wrote: its page's map follows.
  addEventListener("storage", (event) => {
    if (storage === null || event.storageArea !== storage) {
      return;
    }
    if (event.key === null) {
      say({ cleared: 1 });
    } else {
      say({ changed: [event.key, event.newValue] });
    }
  });
})();`;

/** The most a nested page's writes may grow its scope's `localStorage` to (P149). */
export const STORE_MAX_UNITS = 1_048_576;
export const STORE_MAX_KEYS = 1_024;

export interface StoreOptions {
  /** The origin of the one shell this store answers: its parent's, exactly. */
  readonly shell: string;
}

/** The store's script for `options`: what its document runs, and what its CSP's hash names. */
export function storeScript(options: StoreOptions): string {
  const problem = hostOriginProblem(options.shell);
  if (problem !== null) {
    throw new TypeError(`storeScript: shell: ${problem}`);
  }
  return STORE_RUNTIME.replace("__PLAN__", () =>
    scriptJson({ shell: options.shell, units: STORE_MAX_UNITS, keys: STORE_MAX_KEYS }),
  );
}

/** The store's document around its script: nothing else (its CSP allows that script alone). */
export function storeDocument(script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Porthole</title>
</head>
<body>
<script>${script}</script>
</body>
</html>
`;
}
