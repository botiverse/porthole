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
 *   (the page's frame loaded again) takes the place of the one before, once what that one's page
 *   wrote before it went has been kept (below);
 * - **the host's word to clear** (`porthole/shell/store-clear`), from its shell the same way;
 * - **data**, on the port: `ask` (answered with every key the origin holds), `set`, `remove`,
 *   `clear`, and `bye` (its page is going). Keys and values are strings and nothing else; they
 *   are the content's words, kept as they come and never read as anything.
 *
 * **One page after another.** A page writes, and goes on to the next page of its set: its last
 * writes are still on the way when the next page's port comes. The port before stays heard, for
 * writes alone, until its page said `bye` (or 300 ms, for one that never does) and a turn of this
 * document's own has passed with nothing more from it, and never longer than a second in all;
 * what the next page says meanwhile waits, in order. So the next page starts with everything
 * the one before wrote, and its own writes come after them.
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
  // The port answered: the page's frame's current load's.
  let port = null;
  // Whether that load said it is going ("bye": its document's pagehide, or its runtime taking a
  // port in this one's place).
  let leaving = false;
  // The port before it, while what its page sent before going is worked through, and what the
  // current one has said meanwhile, in order. A page that saves as it leaves and goes on to the
  // next page of its set has its last writes still on the way, or waiting here behind others,
  // when the next page's port comes: closed then, they were lost, and the next page read what
  // was kept before them. So the port before is heard on, for writes alone, until its page has
  // said bye (or DRAIN_MS, for one that never does: a frame taken away) and a whole turn of this
  // document's own then passes with nothing more from it; only then is the next page answered,
  // with everything the one before wrote, and what it writes itself comes after.
  let before = null;
  let gone = false;
  let since = 0;
  let held = null;
  const DRAIN_MS = 300;
  // And never longer than this in all, from the next page's port: a page that goes on writing
  // (stuck in a loop, or meaning to) keeps the next one waiting no longer, and what it still
  // had on the way then is dropped.
  const SETTLE_MS = 1000;
  const later = setTimeout;
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
  // What the origin holds, counted once and then kept up with this document's own writes: every
  // key's and value's length, and how many keys. Counted again when it may no longer be right:
  // another document of the origin wrote (its storage event, or a count of keys that differs),
  // a write threw, the storage was cleared. (Counting it all at every write made a few thousand
  // writes take seconds, with the page's next ones waiting behind them.)
  let units = 0;
  let count = 0;
  let counted = false;
  // What writing value under key would add, [units, keys], if that keeps the origin within the
  // caps or at least grows neither count (what is already past them can shrink); else null.
  const fits = (key, value) => {
    if (!counted || storage.length !== count) {
      units = 0;
      count = 0;
      for (const [each, held] of pairs()) {
        units += each.length + held.length;
        count += 1;
      }
      counted = true;
    }
    const had = storage.getItem(key);
    const grown = had === null ? key.length + value.length : value.length - had.length;
    const more = had === null ? 1 : 0;
    return (units + grown <= plan.units || grown <= 0) && (count + more <= plan.keys || more === 0) ? [grown, more] : null;
  };
  // One message from a port: the current one's (asked: it may be answered), or the one before's.
  const heard = (data, asked) => {
    if (storage === null || data === null || typeof data !== "object") {
      return;
    }
    try {
      if (data.ask === 1) {
        if (asked) {
          answer();
        }
      } else if (Array.isArray(data.set) && data.set.length === 2 && typeof data.set[0] === "string" && typeof data.set[1] === "string") {
        const room = fits(data.set[0], data.set[1]);
        if (room !== null) {
          storage.setItem(data.set[0], data.set[1]);
          units += room[0];
          count += room[1];
        }
      } else if (typeof data.remove === "string") {
        const had = storage.getItem(data.remove);
        storage.removeItem(data.remove);
        if (counted && had !== null) {
          units -= data.remove.length + had.length;
          count -= 1;
        }
      } else if (data.clear === 1) {
        storage.clear();
        counted = false;
      }
    } catch (_) {
      counted = false;
    }
  };
  // The port before is done with: closed, and what the current one said meanwhile is heard.
  const settle = () => {
    if (before !== null) {
      before.onmessage = null;
      before.close();
      before = null;
    }
    const waiting = held;
    held = null;
    if (waiting !== null) {
      for (let i = 0; i < waiting.length; i += 1) {
        heard(waiting[i], true);
      }
    }
  };
  // A turn of this document's own: a message to itself, which comes back after what was already
  // waiting on the port before has had its turn (a browser may hear a port one message at a
  // time, with other tasks between). With something heard from it meanwhile, another turn.
  const turn = (was) => {
    since = 0;
    const own = new MessageChannel();
    own.port1.onmessage = () => {
      own.port1.close();
      if (before !== was) {
        return;
      }
      if (since === 0) {
        settle();
      } else {
        turn(was);
      }
    };
    own.port2.postMessage(0);
  };
  const listen = (taken) => {
    taken.onmessage = (message) => {
      const data = message.data;
      const bye = data !== null && typeof data === "object" && data.bye === 1;
      if (taken === before) {
        since += 1;
        if (bye) {
          if (!gone) {
            gone = true;
            turn(taken);
          }
        } else {
          heard(data, false);
        }
      } else if (taken === port) {
        if (bye) {
          leaving = true;
        } else if (held !== null) {
          held.push(data);
        } else {
          heard(data, true);
        }
      }
    };
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
      // The host's word is the last word: nothing a page that has gone still had on the way is
      // written after it.
      if (before !== null) {
        before.onmessage = null;
        before.close();
        before = null;
      }
      try {
        if (storage !== null) {
          storage.clear();
        }
      } catch (_) {}
      counted = false;
      say({ cleared: 1 });
      settle();
      return;
    }
    if (data.method !== PORT || event.ports.length !== 1) {
      return;
    }
    const taken = event.ports[0];
    if (before !== null) {
      // A third while the first is worked through: the second's page never ran (it had no
      // answer yet), so it is closed and the third waits in its place.
      if (port !== null) {
        port.onmessage = null;
        port.close();
      }
      held = [];
    } else if (port !== null) {
      before = port;
      gone = leaving;
      held = [];
      const was = before;
      if (gone) {
        turn(was);
      } else {
        later(() => {
          if (before === was && !gone) {
            gone = true;
            turn(was);
          }
        }, DRAIN_MS);
      }
      later(() => {
        if (before === was) {
          settle();
        }
      }, SETTLE_MS);
    }
    port = taken;
    leaving = false;
    listen(taken);
  });
  // Another tab of this origin wrote: its page's map follows.
  addEventListener("storage", (event) => {
    if (storage === null || event.storageArea !== storage) {
      return;
    }
    counted = false;
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
