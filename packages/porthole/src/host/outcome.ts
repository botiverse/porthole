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
 */

/** How long after a load the frame's word may still arrive. */
const SETTLE_MS = 400;

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
  readonly state: "entering" | "blocked";
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
  if (params.state === "entering") {
    return { state: "entering" };
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
  readonly timeoutMs: number;
  readonly onOutcome: (outcome: FrameOutcome) => void;
}): OutcomeWatch {
  const { surface, source, speaks } = options;
  const reports = source.kind === "url" && source.reports === true;
  // The first outcome; after a load, only a later block (a status page, access revoked) is told.
  let decided: FrameOutcome["state"] | null = null;
  let heard = false;
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
  const unlisten = surface.transport.listen((data) => {
    heard = true;
    const status = parseFrameStatus(data);
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
  const unload = surface.onLoad(() => {
    loads += 1;
    if (decided !== null) {
      return;
    }
    if (speaks) {
      // A served shell or view says something before its first load ends; one that never did
      // never ran. (An opaque srcdoc frame always runs: its handshake decides.)
      if (source.kind === "url") {
        neverRan();
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
