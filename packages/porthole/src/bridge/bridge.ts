import {
  MAX_COPY_CHARS,
  capabilitySpec,
  type CapabilityArgs,
  type CapabilityName,
  type CapabilityResults,
} from "../config/capabilities.ts";
import type { AnnotationReport } from "../annotate/types.ts";
import { parseReport } from "../annotate/validate.ts";
import type { PortholeConfig } from "../config/schema.ts";
import { effectiveGates } from "../compile/policy.ts";
import type {
  CallOutcome,
  CapabilityHandler,
  CapabilityHandlers,
  Confirm,
  ConfirmAnswer,
  ConfirmDisplay,
  ConfirmRequest,
  HostFunctionBridge,
  Refusal,
} from "./types.ts";

/**
 * The host-function bridge: every capability call from a frame passes here, and nowhere else
 * reaches a host handler. In order: declared → arguments well formed → not muted → within its
 * rate → a user gesture, if gated so → a person's confirmation, if gated so → the handler.
 */

export type BridgeEvent =
  | { readonly type: "resize"; readonly height: number; readonly width?: number }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "annotation"; readonly report: AnnotationReport }
  | { readonly type: "refused"; readonly capability: CapabilityName; readonly refusal: Refusal }
  | { readonly type: "muted" };

export interface BridgeOptions {
  readonly config: PortholeConfig;
  readonly display: ConfirmDisplay;
  readonly handlers: CapabilityHandlers;
  readonly confirm?: Confirm;
  /** Whether the embedding page has user activation now; undefined where it can't tell. */
  readonly userActivation?: () => boolean | undefined;
  readonly onEvent: (event: BridgeEvent) => void;
  /** The clock, in milliseconds (tests pass their own). */
  readonly now?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const MAX_URL = 4_096;

/** An http(s) URL without credentials in it (`https://bank.example@evil.example` reads as a lie). */
export function linkTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return url.href;
}

type Validator<N extends CapabilityName> = (
  args: unknown,
  config: PortholeConfig,
) => CapabilityArgs[N] | null;

const VALIDATORS: { readonly [N in CapabilityName]: Validator<N> } = {
  sendPrompt: (args, config) => {
    const text = isRecord(args) ? args.text : undefined;
    return typeof text === "string" &&
      text.trim() !== "" &&
      text.length <= config.limits.maxPromptChars
      ? { text }
      : null;
  },
  openLink: (args) => {
    const url = linkTarget(isRecord(args) ? args.url : undefined);
    return url === null ? null : { url };
  },
  downloadFile: (args) => {
    const contents = isRecord(args) ? args.contents : undefined;
    return Array.isArray(contents) && contents.length > 0 && contents.length <= 100
      ? { contents }
      : null;
  },
  callTool: (args) => {
    if (
      !isRecord(args) ||
      typeof args.name !== "string" ||
      args.name === "" ||
      args.name.length > 256
    ) {
      return null;
    }
    const given = args.arguments ?? {};
    return isRecord(given) ? { name: args.name, arguments: given } : null;
  },
  readData: (args) => {
    const uri = isRecord(args) ? args.uri : undefined;
    return typeof uri === "string" && uri !== "" && uri.length <= MAX_URL ? { uri } : null;
  },
  setModelContext: (args) => {
    if (!isRecord(args)) {
      return null;
    }
    const { content, structuredContent } = args;
    if (
      (content !== undefined && !Array.isArray(content)) ||
      (structuredContent !== undefined && !isRecord(structuredContent))
    ) {
      return null;
    }
    return {
      ...(content === undefined ? {} : { content }),
      ...(structuredContent === undefined ? {} : { structuredContent }),
    };
  },
  reportError: (args) => {
    const message = isRecord(args) ? args.message : undefined;
    return typeof message === "string" && message !== ""
      ? { message: message.slice(0, 2_000) }
      : null;
  },
  copyText: (args) => {
    const text = isRecord(args) ? args.text : undefined;
    return typeof text === "string" && text !== "" && text.length <= MAX_COPY_CHARS
      ? { text }
      : null;
  },
  annotate: (args) => parseReport(args),
  resize: (args) => {
    if (
      !isRecord(args) ||
      typeof args.height !== "number" ||
      !Number.isFinite(args.height) ||
      args.height < 0
    ) {
      return null;
    }
    const width = args.width;
    return typeof width === "number" && Number.isFinite(width) && width >= 0
      ? { height: args.height, width }
      : { height: args.height };
  },
};

export function createBridge(options: BridgeOptions): HostFunctionBridge {
  const { config, display, handlers, onEvent } = options;
  const now = options.now ?? (() => Date.now());
  const calls = new Map<CapabilityName, number[]>();
  let declines = 0;
  let muted = false;

  const refuse = <T>(
    capability: CapabilityName,
    refusal: Refusal,
    message?: string,
  ): CallOutcome<T> => {
    onEvent({ type: "refused", capability, refusal });
    return { ok: false, refusal, ...(message === undefined ? {} : { message }) };
  };

  const withinRate = (capability: CapabilityName, perMinute: number): boolean => {
    const at = now();
    const recent = (calls.get(capability) ?? []).filter((time) => at - time < 60_000);
    if (recent.length >= perMinute) {
      calls.set(capability, recent);
      return false;
    }
    recent.push(at);
    calls.set(capability, recent);
    return true;
  };

  return {
    declared: (capability) => config.capabilities[capability] !== undefined,

    async call<N extends CapabilityName>(
      capability: N,
      raw: unknown,
      callOptions?: { readonly userActivated?: boolean },
    ): Promise<CallOutcome<CapabilityResults[N]>> {
      type Result = CapabilityResults[N];
      if (config.capabilities[capability] === undefined) {
        return refuse<Result>(capability, "not-declared");
      }
      const args = (VALIDATORS[capability] as Validator<N>)(raw, config);
      if (args === null) {
        return refuse<Result>(capability, "invalid");
      }
      const gates = effectiveGates(config, capability);
      const confirms = gates.includes("confirm");
      if (confirms && muted) {
        return refuse<Result>(capability, "muted");
      }
      for (const gate of gates) {
        if (typeof gate === "object" && !withinRate(capability, gate.rateLimit.perMinute)) {
          return refuse<Result>(capability, "rate-limited");
        }
      }
      if (gates.includes("user-activation")) {
        const activated = callOptions?.userActivated ?? options.userActivation?.();
        if (activated === false) {
          return refuse<Result>(capability, "no-user-activation");
        }
      }
      // The effect, run once: when the person's "yes" calls `proceed` (inside its own click, so an
      // effect that needs a gesture gets one), or after `confirm` resolves accepted.
      let effect: Promise<CallOutcome<Result>> | null = null;
      const run = (): Promise<CallOutcome<Result>> => (effect ??= perform(capability, args));
      if (confirms) {
        if (options.confirm === undefined) {
          return refuse<Result>(capability, "no-confirm");
        }
        let answer: ConfirmAnswer = false;
        try {
          answer = await options.confirm(
            { capability, args, display } as ConfirmRequest,
            () => void run(),
          );
        } catch {
          answer = effect === null ? false : "accepted";
        }
        if (effect === null && answer !== true && answer !== "accepted") {
          if (answer === "redirected") {
            return refuse<Result>(capability, "redirected");
          }
          // Declines in a row mute the display; a yes starts the count again.
          declines += 1;
          if (declines >= config.limits.declinesBeforeMute && !muted) {
            muted = true;
            onEvent({ type: "muted" });
          }
          return refuse<Result>(capability, "declined");
        }
        declines = 0;
      }
      return run();
    },
  };

  async function perform<N extends CapabilityName>(
    capability: N,
    args: CapabilityArgs[N],
  ): Promise<CallOutcome<CapabilityResults[N]>> {
    type Result = CapabilityResults[N];
    {
      if (capabilitySpec(capability).served === "event") {
        if (capability === "resize") {
          const size = args as CapabilityArgs["resize"];
          onEvent({ type: "resize", ...size });
        } else if (capability === "annotate") {
          onEvent({ type: "annotation", report: args as CapabilityArgs["annotate"] });
        } else {
          onEvent({ type: "error", message: (args as CapabilityArgs["reportError"]).message });
        }
        return { ok: true, value: undefined as Result };
      }
      const handler = (handlers as Record<string, CapabilityHandler<N> | undefined>)[capability];
      if (handler === undefined) {
        return refuse<Result>(capability, "not-declared");
      }
      try {
        const value = await handler(args, {
          displayId: display.id,
          title: display.title,
          capability,
        });
        return { ok: true, value };
      } catch (error) {
        return refuse<Result>(
          capability,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}
