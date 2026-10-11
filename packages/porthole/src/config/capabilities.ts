/**
 * The capability vocabulary (PRINCIPLE 4): every power content has beyond drawing is one of these
 * host functions, named in the config. A capability the config doesn't declare is not wired into
 * the shell, not carried by the bridge, adds nothing to the CSP, and is absent from the manual.
 *
 * Each has default gates, applied when a config declares it without its own (PRINCIPLE 1: gates
 * are on by default), and is served either by a handler the host passes or as an event the
 * framework emits.
 */

export const CAPABILITY_NAMES = [
  "sendPrompt",
  "openLink",
  "downloadFile",
  "callTool",
  "readData",
  "setModelContext",
  "reportError",
  "resize",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/**
 * What must hold before a call reaches the host's handler. A capability's gates all apply.
 *
 * - `user-activation`: the call follows a real user gesture in the frame. The shell refuses a call
 *   without one, and the host checks its own page's activation (which a gesture in a child frame
 *   propagates to). It stops calls made on load or on a timer; it is not proof of intent.
 * - `confirm`: the host's `confirm` function shows a person the call's whole effect, and the call
 *   goes only if they accept. No `confirm` function means the call is refused (fail closed).
 * - `rateLimit`: at most `perMinute` calls per display per minute; the rest are refused.
 */
export type Gate =
  | "user-activation"
  | "confirm"
  | { readonly rateLimit: { readonly perMinute: number } };

export interface CapabilitySpec {
  /** The gates a declared capability gets when its config names none. */
  readonly defaultGates: readonly Gate[];
  /** `handler`: the host passes a function that performs it. `event`: the framework emits it. */
  readonly served: "handler" | "event";
  /** The global the shell defines for it (sugar over the protocol message), if any. */
  readonly global?: string;
  /**
   * How content reaches it without the shell's global: the MCP Apps request, and the official
   * App SDK's method for it. Absent for what the shell does by itself (sizes, errors).
   */
  readonly request?: { readonly method: string; readonly sdk: string };
}

const rate = (perMinute: number): Gate => ({ rateLimit: { perMinute } });

export const CAPABILITIES = {
  sendPrompt: {
    defaultGates: ["user-activation", "confirm"],
    served: "handler",
    global: "sendPrompt",
    request: { method: "ui/message", sdk: "app.sendMessage" },
  },
  openLink: {
    defaultGates: ["user-activation", "confirm"],
    served: "handler",
    global: "openLink",
    request: { method: "ui/open-link", sdk: "app.openLink" },
  },
  downloadFile: {
    defaultGates: ["user-activation", "confirm"],
    served: "handler",
    request: { method: "ui/download-file", sdk: "app.downloadFile" },
  },
  callTool: {
    defaultGates: ["confirm"],
    served: "handler",
    request: { method: "tools/call", sdk: "app.callServerTool" },
  },
  readData: {
    defaultGates: [rate(120)],
    served: "handler",
    request: { method: "resources/read", sdk: "app.readServerResource" },
  },
  setModelContext: {
    defaultGates: [rate(30)],
    served: "handler",
    request: { method: "ui/update-model-context", sdk: "app.updateModelContext" },
  },
  reportError: { defaultGates: [rate(10)], served: "event" },
  resize: { defaultGates: [], served: "event" },
} as const satisfies { readonly [N in CapabilityName]: CapabilitySpec };

/** The arguments a call carries, once the adapter has validated them. */
export interface CapabilityArgs {
  readonly sendPrompt: { readonly text: string };
  readonly openLink: { readonly url: string };
  /** MCP resource contents (embedded or linked), as the protocol carries them. */
  readonly downloadFile: { readonly contents: readonly unknown[] };
  readonly callTool: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  };
  readonly readData: { readonly uri: string };
  readonly setModelContext: {
    readonly content?: readonly unknown[];
    readonly structuredContent?: Readonly<Record<string, unknown>>;
  };
  readonly reportError: { readonly message: string };
  readonly resize: { readonly height: number; readonly width?: number };
}

/** What a call resolves to. Protocol-shaped results (a tool's result) stay opaque to the core. */
export interface CapabilityResults {
  /** Whether the prompt was sent. */
  readonly sendPrompt: boolean;
  /** Whether the link was opened. */
  readonly openLink: boolean;
  /** Whether the download started. */
  readonly downloadFile: boolean;
  readonly callTool: unknown;
  readonly readData: unknown;
  readonly setModelContext: undefined;
  readonly reportError: undefined;
  readonly resize: undefined;
}

/** The capabilities a host serves with a handler. */
export type HandledCapability = {
  [N in CapabilityName]: (typeof CAPABILITIES)[N]["served"] extends "handler" ? N : never;
}[CapabilityName];

/** A capability's spec, as the general shape (the table above keeps literal types). */
export function capabilitySpec(name: CapabilityName): CapabilitySpec {
  return CAPABILITIES[name];
}

export function isCapabilityName(value: unknown): value is CapabilityName {
  return typeof value === "string" && (CAPABILITY_NAMES as readonly string[]).includes(value);
}
