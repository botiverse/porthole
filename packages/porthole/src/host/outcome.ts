import { FRAME_STATUS_METHOD, type FrameSource } from "../isolation/types.ts";
import type { Surface } from "../platform/types.ts";
import type { FrameBlock, FrameOutcome } from "./types.ts";

/**
 * How a display's first document went (P040). A frame's content is another origin's, so the host
 * can't look inside; it goes by what it can see:
 *
 * - a shell or view that speaks for itself is loaded when it finishes its handshake;
 * - a page of Porthole's `/server` says how it went (`porthole/notifications/frame-status`): it is
 *   entering an app, or blocked (its ticket used, no cookie kept in a frame, the app down); a url
 *   app is loaded when its document loads after the entry page;
 * - a load from which nothing ever spoke, where something should have, is a page that never ran:
 *   framing refused;
 * - an app from a host's own gateway is loaded on its first load, unless its page says it is
 *   blocked (the gateway may send the same message);
 * - nothing settled in `timeoutMs`: a timeout.
 *
 * Who may say how loading went (P124). A frame status is taken only from a document of Porthole's
 * server, a host's gateway or the host's own pages, never from content: its words draw the host's
 * fallback, in Porthole's wording, with a link. Nothing in a message tells who sent it (a page
 * that shares the frame's window and origin can send the same bytes), so the host goes by what
 * content can't change: where the frame's documents come from, and in what order they speak.
 *
 * - An opaque frame's only document is the host's own shell, with the content in it: no page of
 *   Porthole's server ever loads there, so its every frame status is the content's.
 * - A frame that speaks (a served shell, a view through the sandbox proxy, a nested page's shell)
 *   says Porthole's own word first in every document that holds content, before any of the
 *   content's code runs: the shell's hello, the proxy's ready (a nested page's own runtime's hello
 *   reaches the host before anything its page says, through its shell). A status page says
 *   nothing but its frame status. So a frame status is taken only before anything else was heard
 *   from the frame in this run: from its first document, which then was a page of Porthole's.
 *   After that, it came from the content (or from a later document, which in a display without
 *   files starts the display again, whose first document then says how it went).
 *   That holds against the display's own content, not against another display's (P125): a
 *   scope's displays share its origin, and one that runs reaches a new document of another's
 *   before that document's first script, where it can speak first, or stop or rewrite it so it
 *   says nothing. So the rule holds only where no content runs on the frame's origin: a nested
 *   page's shell, on a label of its own (P114).
 * - A served display that isn't nested (a served shell, a page, a view through the sandbox proxy)
 *   takes no frame status from its frame at all, and infers nothing from its silence (a load and
 *   no word is a timeout, never `framing`): its door said how loading went before the frame was
 *   made (P125, `watchDoor`), from an opaque frame of the host's that no content can reach.
 * - A url-mode app has no shell to speak first, and shares its origin with the entry page and the
 *   status pages: its frame status is taken as before, the app's word (THREAT_MODEL S6).
 *
 * A frame status not taken is dropped, and told once a run to the host (`refused`).
 */

/** How long after a load the frame's word may still arrive. */
export const SETTLE_MS = 400;

const BLOCKS: readonly FrameBlock[] = [
  "framing",
  "cookies",
  "sign-in",
  "session",
  "upstream",
  "denied",
  "not-found",
  "error",
];

interface FrameStatus {
  /** `open` is a door's word alone (P125): its display may be framed. */
  readonly state: "entering" | "open" | "blocked";
  readonly reason?: FrameBlock;
  readonly status?: number;
  readonly code?: string;
}

/** A frame-status message, or null for anything else. */
export function parseFrameStatus(data: unknown): FrameStatus | null {
  if (data === null || typeof data !== "object") {
    return null;
  }
  const message = data as { jsonrpc?: unknown; method?: unknown; params?: unknown };
  if (message.jsonrpc !== "2.0" || message.method !== FRAME_STATUS_METHOD) {
    return null;
  }
  const params = message.params as {
    state?: unknown;
    reason?: unknown;
    status?: unknown;
    code?: unknown;
  } | null;
  if (params === null || typeof params !== "object") {
    return null;
  }
  if (params.state === "entering" || params.state === "open") {
    return { state: params.state };
  }
  if (params.state !== "blocked") {
    return null;
  }
  const reason = BLOCKS.includes(params.reason as FrameBlock)
    ? (params.reason as FrameBlock)
    : "error";
  return {
    state: "blocked",
    reason,
    ...(typeof params.status === "number" && Number.isInteger(params.status)
      ? { status: params.status }
      : {}),
    ...(typeof params.code === "string" && /^[a-z0-9-]{1,40}$/u.test(params.code)
      ? { code: params.code }
      : {}),
  };
}

/** Whether a message names the frame-status method, well formed or not. */
const namesFrameStatus = (data: unknown): boolean =>
  data !== null &&
  typeof data === "object" &&
  (data as { method?: unknown }).method === FRAME_STATUS_METHOD;

/** What the host is told of a frame status it didn't take (P124). */
export const UNTRUSTED_FRAME_STATUS =
  "A frame status (porthole/notifications/frame-status) came from the frame's content, not from a page of Porthole's server: not taken (P124)";

export interface OutcomeWatch {
  /** The frame finished its handshake. */
  initialized(): void;
  stop(): void;
}

export function watchOutcome(options: {
  readonly surface: Surface;
  readonly source: FrameSource;
  /** Whether the frame speaks for itself (a shell or a view): then its handshake is the proof. */
  readonly speaks: boolean;
  /**
   * The config nests its pages (P111): the frame holds Porthole's shell, on a label no content
   * runs on, whose first word may be a frame status. Any other served frame that speaks takes
   * none: its door told (P125).
   */
  readonly nested?: boolean;
  readonly timeoutMs: number;
  readonly onOutcome: (outcome: FrameOutcome) => void;
  /** A frame status that wasn't taken, once a run (P124): the host's to hear, never shown. */
  readonly refused?: (message: string) => void;
}): OutcomeWatch {
  const { surface, source, speaks } = options;
  const nested = options.nested === true;
  const reports = source.kind === "url" && source.reports === true;
  // The first outcome; after a load, only a later block (a status page, access revoked) is told.
  let decided: FrameOutcome["state"] | null = null;
  let heard = false;
  // Whether the frame said anything but a frame status in this run (P124).
  let spoke = false;
  let told = false;
  let entering = false;
  let loads = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };
  const clearTimers = () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
  };
  const stop = () => {
    clearTimers();
    unlisten();
    unload();
  };
  const decide = (outcome: FrameOutcome) => {
    if (decided === null) {
      decided = outcome.state;
      clearTimers();
      options.onOutcome(outcome);
    } else if (decided === "loaded" && outcome.state === "blocked") {
      decided = "blocked";
      options.onOutcome(outcome);
    }
  };
  // Whether a frame status may be the word of a page of Porthole's (P124, P125, above).
  const mayBePorthole = () => source.kind === "url" && (!speaks || (nested && !spoke));
  const unlisten = surface.transport.listen((data) => {
    heard = true;
    if (!namesFrameStatus(data)) {
      spoke = true;
      return;
    }
    if (!mayBePorthole()) {
      if (!told) {
        told = true;
        options.refused?.(UNTRUSTED_FRAME_STATUS);
      }
      return;
    }
    const status = parseFrameStatus(data);
    // `open` is a door's word (P125), never a frame's: nothing here.
    if (status?.state === "entering") {
      entering = true;
    } else if (status?.state === "blocked") {
      decide({
        state: "blocked",
        reason: status.reason ?? "error",
        ...(status.status === undefined ? {} : { status: status.status }),
        ...(status.code === undefined ? {} : { code: status.code }),
      });
    }
  });
  const neverRan = () =>
    later(SETTLE_MS, () => {
      if (!heard) {
        decide({ state: "blocked", reason: "framing" });
      }
    });
  // A served frame whose door told (P125): a load from which nothing spoke shows nothing, and
  // no one can say why (another display of its scope may have stopped or rewritten it): a timeout,
  // without waiting the whole of it, never `framing`.
  const silent = () =>
    later(SETTLE_MS, () => {
      if (!spoke) {
        decide({ state: "timeout" });
      }
    });
  const unload = surface.onLoad(() => {
    loads += 1;
    if (decided !== null) {
      return;
    }
    if (speaks) {
      // A served shell or view says something before its first load ends; a nested page's shell
      // that never did never ran. Any other served frame's silence tells nothing (P125). (An
      // opaque srcdoc frame always runs: its handshake decides.)
      if (source.kind === "url") {
        if (nested) {
          neverRan();
        } else {
          silent();
        }
      }
      return;
    }
    if (!reports) {
      later(SETTLE_MS, () => decide({ state: "loaded" }));
      return;
    }
    if (entering && loads >= 2) {
      decide({ state: "loaded" });
    } else if (!entering) {
      neverRan();
    }
  });
  later(options.timeoutMs, () => decide({ state: "timeout" }));
  return {
    initialized: () => decide({ state: "loaded" }),
    stop,
  };
}
