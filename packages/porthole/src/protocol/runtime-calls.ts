import type { CallOutcome, HostFunctionBridge } from "../bridge/types.ts";
import { reasonFor, type RefusalReason } from "../bridge/refusal.ts";
import type { CapabilityName } from "../config/capabilities.ts";
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_EVENT_METHOD,
  isRuntimeCapabilityName,
  type RuntimeMethod,
} from "../runtime/contract.ts";
import { DB_LIMITS } from "../runtime/db.ts";
import { downloadContents } from "../runtime/requests.ts";

/**
 * The host side of the capability runtime's calls (P085): `porthole/call` with `{ capability,
 * method, args }` (and `watch`, a frame-chosen id, for a subscription), each turned into the host
 * function that serves it and passed through the bridge, which alone decides; `porthole/unwatch`
 * ends a watch. A watch's updates go to the frame as `porthole/event` with `{ watch, data }`.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A runtime call as the host function that serves it gets it, or null for none. */
export function runtimeCall(
  capability: unknown,
  method: unknown,
  args: unknown,
): { readonly serves: CapabilityName; readonly args: unknown; readonly watch: boolean } | null {
  if (!isRuntimeCapabilityName(capability) || typeof method !== "string") {
    return null;
  }
  const methods: Readonly<Record<string, RuntimeMethod>> = RUNTIME_CAPABILITIES[capability].methods;
  const spec = Object.hasOwn(methods, method) ? methods[method] : undefined;
  // `data.subscribe` is MCP's own subscription (resources/subscribe, P079), not a runtime call.
  if (spec === undefined || spec.serves === "subscribeData") {
    return null;
  }
  const given = isRecord(args) ? args : {};
  const watch = spec.watch === true;
  switch (spec.serves) {
    case "downloadFile":
      return {
        serves: spec.serves,
        args: { contents: downloadContents(given.file) ?? undefined },
        watch,
      };
    case "callTool":
      return { serves: spec.serves, args: { name: given.name, arguments: given.arguments }, watch };
    case "readData":
      return { serves: spec.serves, args: { uri: given.uri }, watch };
    case "artifact":
    case "assets":
    case "db":
      // One host function serves several methods: the method is its `op`.
      return { serves: spec.serves, args: { ...given, op: method }, watch };
    default:
      return { serves: spec.serves, args: given, watch };
  }
}

type Answer =
  | { readonly result: unknown }
  | { readonly error: { code: number; message: string; data?: RefusalReason } };

/** A runtime call's outcome, as the frame hears it: its value, or why it was refused (P080). */
export function runtimeAnswer(serves: CapabilityName, outcome: CallOutcome<unknown>): Answer {
  if (!outcome.ok) {
    return {
      error: {
        code: -32000,
        message: `Refused (${outcome.refusal})`,
        data: reasonFor(serves, outcome),
      },
    };
  }
  return { result: { value: outcome.value ?? null } };
}

const refused = (reason: RefusalReason): Answer => ({
  error: { code: -32000, message: `Refused (${reason.code})`, data: reason },
});

/** One frame's runtime calls: its watches, and their end. */
export function runtimeCalls(
  bridge: HostFunctionBridge,
  notify: (method: string, params: Record<string, unknown>) => void,
) {
  const watches = new Map<string, AbortController>();
  return {
    async call(params: Record<string, unknown>): Promise<Answer> {
      const mapped = runtimeCall(params.capability, params.method, params.args);
      if (mapped === null) {
        return refused({ code: "not_allowed", message: "This isn't available here." });
      }
      if (!mapped.watch) {
        return runtimeAnswer(mapped.serves, await bridge.call(mapped.serves, mapped.args));
      }
      const id = params.watch;
      if (typeof id !== "string" || !/^[\w-]{1,64}$/u.test(id) || watches.has(id)) {
        return refused({ code: "not_allowed", message: "The app can't take this request." });
      }
      if (watches.size >= DB_LIMITS.maxWatches) {
        return refused({ code: "too_large", message: "Too many things followed at once." });
      }
      const controller = new AbortController();
      watches.set(id, controller);
      const outcome = await bridge.call(mapped.serves, mapped.args, {
        subscription: {
          changed: (data?: unknown) => {
            if (!controller.signal.aborted) {
              notify(RUNTIME_EVENT_METHOD, { watch: id, data: data ?? null });
            }
          },
          signal: controller.signal,
        },
      });
      if (!outcome.ok) {
        controller.abort();
        watches.delete(id);
      }
      return outcome.ok ? { result: { value: null } } : runtimeAnswer(mapped.serves, outcome);
    },
    /** The frame stopped following (never gated). */
    unwatch(params: Record<string, unknown>): void {
      const id = params.watch;
      if (typeof id === "string") {
        watches.get(id)?.abort();
        watches.delete(id);
      }
    },
    close(): void {
      for (const controller of watches.values()) {
        controller.abort();
      }
      watches.clear();
    },
  };
}
