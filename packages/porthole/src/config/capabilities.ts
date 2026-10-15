import type { AnnotationReport } from "../annotate/types.ts";

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
  "subscribeData",
  "setModelContext",
  "reportError",
  "resize",
  "copyText",
  "annotate",
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
 * - `consent` (P079): the host's `consent` function is asked once per display, before the first
 *   call of any of its consent-gated capabilities, whether this content may have them (a viewer
 *   allowing a widget to read their data). A no refuses every such call for the display's life;
 *   no `consent` function refuses them all (fail closed).
 */
export type Gate =
  | "user-activation"
  | "confirm"
  | "consent"
  | { readonly rateLimit: { readonly perMinute: number } };

export interface CapabilitySpec {
  /** The gates a declared capability gets when its config names none. */
  readonly defaultGates: readonly Gate[];
  /** `handler`: the host passes a function that performs it. `event`: the framework emits it. */
  readonly served: "handler" | "event";
  /** The global the shell defines for it (sugar over the protocol message), if any. */
  readonly global?: string;
  /**
   * How content reaches it without the shell's global: the MCP Apps request (or Porthole's own,
   * `porthole/…`, where the standard has none), and the official App SDK's method for it, if any.
   * Absent for what the shell does by itself (sizes, errors, annotations).
   */
  readonly request?: { readonly method: string; readonly sdk?: string };
}

const rate = (perMinute: number): Gate => ({ rateLimit: { perMinute } });

/** The most text one `copyText` call carries. */
export const MAX_COPY_CHARS = 20_000;

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
    global: "readData",
    request: { method: "resources/read", sdk: "app.readServerResource" },
  },
  /**
   * Live data (P079): content subscribes to a resource and the host tells it when it changed
   * (MCP `resources/subscribe`, `resources/unsubscribe`, `notifications/resources/updated`);
   * it then reads it again (`readData`, which it needs). The App SDK has no method for it.
   */
  subscribeData: {
    defaultGates: [rate(60)],
    served: "handler",
    global: "subscribeData",
    request: { method: "resources/subscribe" },
  },
  setModelContext: {
    defaultGates: [rate(30)],
    served: "handler",
    request: { method: "ui/update-model-context", sdk: "app.updateModelContext" },
  },
  reportError: { defaultGates: [rate(10)], served: "event" },
  resize: { defaultGates: [], served: "event" },
  /**
   * Copies text to the person's clipboard, done by the host, which shows them what was copied
   * (P052). Content can't write the clipboard any other way (P051).
   */
  copyText: {
    defaultGates: ["user-activation", rate(30)],
    served: "handler",
    global: "copyText",
    request: { method: "porthole/copy-text" },
  },
  /**
   * Annotations (P053): the host asks the shell to let the person point at an element or select
   * text, and to mark anchors already made. What the frame reports back is the content's word
   * (it shares the realm): UI hints for the host, never permissions.
   */
  annotate: { defaultGates: [rate(120)], served: "event" },
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
  readonly subscribeData: { readonly uri: string };
  readonly setModelContext: {
    readonly content?: readonly unknown[];
    readonly structuredContent?: Readonly<Record<string, unknown>>;
  };
  readonly reportError: { readonly message: string };
  readonly resize: { readonly height: number; readonly width?: number };
  readonly copyText: { readonly text: string };
  /** What the frame reported, once checked (`AnnotationReport`). */
  readonly annotate: AnnotationReport;
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
  /** An MCP `resources/read` result (`{ contents }`), as the host answers it. */
  readonly readData: unknown;
  readonly subscribeData: undefined;
  readonly setModelContext: undefined;
  readonly reportError: undefined;
  readonly resize: undefined;
  /** Whether the text was copied. */
  readonly copyText: boolean;
  readonly annotate: undefined;
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
