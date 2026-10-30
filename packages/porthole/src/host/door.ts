import type { DoorSurface } from "../platform/types.ts";
import { parseFrameStatus, SETTLE_MS } from "./outcome.ts";
import type { FrameOutcome } from "./types.ts";

/**
 * A served display's door (P125). A served display that isn't nested (a served shell, a page, a
 * view through the sandbox proxy) is framed on its scope's origin, where the scope's other displays
 * run content with `allow-same-origin`: one of them reaches a new document there before its first
 * script runs, so nothing its frame says, and nothing its silence suggests, is Porthole's word.
 *
 * So before its frame is made, the host frames its door: a page of Porthole's server on the same
 * origin, in a frame of the host's own, hidden, sandboxed with scripts alone (an opaque origin, a
 * new one each time, which no content is the same origin as), with no name (nothing targets it).
 * The server takes the door's own ticket and runs the checks the content's address runs for the
 * same grant (the host's check, the document, its entry), and the door says how loading went, once:
 * `open` (frame the display), or `blocked` and why. The host takes that word only from the door
 * frame's window, from an opaque origin (`"null"`), the first well-formed frame status it says; a
 * door that loaded and said nothing never ran (`framing`: its server didn't let this page frame
 * it). The door's frame is gone once it said, before the display's frame is made.
 *
 * "A `load` event is not a committed document" (DECISIONS P125): a document wiped and navigated
 * while it parses never fires `load`, so no host may read a frame's first load as its first
 * document. The door's "load, then `SETTLE_MS` of silence: framing" doesn't rest on that: no content
 * ever runs in the door (its one script is Porthole's, by its hash, under `default-src 'none'`),
 * so nothing navigates it from inside; and a sibling of its scope can't reach it from outside (it
 * is opaque, so reading it or setting its `location` throws, and it has no name, so `window.open`
 * and a link's or a form's `target` find nothing): `[door-reach]` and `door-opaque` hold that.
 */

export interface DoorWatch {
  stop(): void;
}

export function watchDoor(options: {
  readonly door: DoorSurface;
  readonly timeoutMs: number;
  /** The door said `open`: the display may be framed. */
  readonly onOpen: () => void;
  /** The door said `blocked`, or loaded and said nothing (`framing`), or nothing came in time. */
  readonly onOutcome: (outcome: Exclude<FrameOutcome, { state: "loaded" }>) => void;
}): DoorWatch {
  const { door } = options;
  let decided = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };
  const stop = () => {
    decided = true;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
    unlisten();
    unload();
  };
  const unlisten = door.transport.listen((data) => {
    if (decided) {
      return;
    }
    const status = parseFrameStatus(data);
    // A door says `open` or `blocked`, nothing else: anything else is no door's word.
    if (status?.state === "open") {
      stop();
      options.onOpen();
    } else if (status?.state === "blocked") {
      stop();
      options.onOutcome({
        state: "blocked",
        reason: status.reason ?? "error",
        ...(status.status === undefined ? {} : { status: status.status }),
        ...(status.code === undefined ? {} : { code: status.code }),
      });
    }
  });
  const unload = door.onLoad(() =>
    later(SETTLE_MS, () => {
      if (!decided) {
        stop();
        options.onOutcome({ state: "blocked", reason: "framing" });
      }
    }),
  );
  later(options.timeoutMs, () => {
    if (!decided) {
      stop();
      options.onOutcome({ state: "timeout" });
    }
  });
  return { stop };
}
