import type { CallOutcome, HostFunctionBridge } from "../bridge/types.ts";
import { STALE_META } from "./mcp-apps.ts";

/**
 * Live data for one frame (P079), as both adapters speak it (MCP `resources/read`,
 * `resources/subscribe`, `resources/unsubscribe`, `notifications/resources/updated`): the frame's
 * subscriptions by URI, each ended by its controller, and a fresh result the host gave for one
 * (pushed through `changed(result)`, or read after a stale answer), kept for the frame's next read
 * of it. Every call goes through the bridge, which gates it, a read answered by a kept result too
 * (P094); the adapter only says what to send.
 */
export interface LiveData {
  /**
   * A read, past the read's gates whatever answers it: a fresh result kept for it, else the
   * host's (its cache first, when subscribed).
   */
  read(uri: unknown): Promise<CallOutcome<unknown>>;
  /** Starts the host's subscription; a second for a URI is a no-op. */
  subscribe(uri: unknown): Promise<CallOutcome<undefined>>;
  /** Ends one: never gated, it stops what the host was doing for this frame. */
  unsubscribe(uri: unknown): void;
  /** The frame is gone: every subscription ends. */
  close(): void;
}

/** Where MCP results carry their metadata. */
const META = "_meta";

/** A `resources/read` result marked as the host's cached copy (`STALE_META`). */
export function markedStale(value: unknown): unknown {
  const result =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const given = result[META];
  const meta =
    given !== null && typeof given === "object" ? (given as Record<string, unknown>) : {};
  return { ...result, [META]: { ...meta, [STALE_META]: true } };
}

/**
 * `updated(uri)` sends the frame `notifications/resources/updated`; it is called only for a URI
 * the frame subscribes to.
 */
export function liveData(
  bridge: HostFunctionBridge,
  updated: (uri: string) => void,
  options: { readonly userActivated?: () => boolean | undefined } = {},
): LiveData {
  const subscriptions = new Map<string, AbortController>();
  const fresh = new Map<string, unknown>();
  let closed = false;
  const tell = (uri: string) => {
    if (!closed && subscriptions.has(uri)) {
      updated(uri);
    }
  };
  const activation = () => {
    const userActivated = options.userActivated?.();
    return userActivated === undefined ? {} : { userActivated };
  };
  const end = (uri: string) => {
    subscriptions.get(uri)?.abort();
    subscriptions.delete(uri);
    fresh.delete(uri);
  };

  return {
    async read(uri) {
      if (typeof uri === "string" && fresh.has(uri)) {
        // A kept result is the host's answer to a read: it goes through the read's gates as any
        // read does (level, names, rate, gesture, consent, confirm), with no new upstream call
        // (P094). Used once; kept again if the gates refused it and nothing newer came.
        const value = fresh.get(uri);
        fresh.delete(uri);
        const outcome = await bridge.call(
          "readData",
          { uri },
          { ...activation(), held: { uri, value } },
        );
        if (!outcome.ok && !closed && subscriptions.has(uri) && !fresh.has(uri)) {
          fresh.set(uri, value);
        }
        return outcome;
      }
      const subscribed = typeof uri === "string" && subscriptions.has(uri);
      const outcome = await bridge.call(
        "readData",
        { uri },
        { ...activation(), stale: subscribed },
      );
      if (!outcome.ok || outcome.stale !== true || typeof uri !== "string") {
        return outcome;
      }
      // Answered from the host's cache: the fresh result, for the frame's next read, is told once
      // it is here.
      void bridge.call("readData", { uri }, activation()).then((next) => {
        if (next.ok && !closed && subscriptions.has(uri)) {
          fresh.set(uri, next.value);
          tell(uri);
        }
      });
      return { ok: true, value: markedStale(outcome.value) };
    },

    async subscribe(uri) {
      if (typeof uri === "string" && subscriptions.has(uri)) {
        return { ok: true, value: undefined };
      }
      const controller = new AbortController();
      if (typeof uri === "string") {
        subscriptions.set(uri, controller);
      }
      const outcome = await bridge.call(
        "subscribeData",
        { uri },
        {
          ...activation(),
          subscription: {
            signal: controller.signal,
            changed: (result?: unknown) => {
              if (controller.signal.aborted || closed || typeof uri !== "string") {
                return;
              }
              if (result !== undefined) {
                fresh.set(uri, result);
              }
              tell(uri);
            },
          },
        },
      );
      if (!outcome.ok) {
        controller.abort();
        if (typeof uri === "string" && subscriptions.get(uri) === controller) {
          subscriptions.delete(uri);
        }
      }
      return outcome;
    },

    unsubscribe(uri) {
      if (typeof uri === "string") {
        end(uri);
      }
    },

    close() {
      closed = true;
      for (const uri of subscriptions.keys()) {
        end(uri);
      }
    },
  };
}
