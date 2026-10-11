import type { Confirm, CapabilityHandlers, Refusal } from "../bridge/types.ts";
import type { CompiledConfig } from "../compile/compile.ts";
import type { CapabilityName } from "../config/capabilities.ts";
import type { ColorScheme } from "../config/schema.ts";
import type { InstanceLocator, InstanceRef } from "../isolation/types.ts";
import type { PlatformHost } from "../platform/types.ts";
import type { AdapterConnection, ProtocolAdapter, ShellConnection } from "../protocol/adapter.ts";
import type { HostContext } from "../protocol/mcp-apps.ts";

/**
 * The host-side API (framework-agnostic; the web platform by default). A host compiles a config
 * once (`createHost`), then mounts a display per piece of content. Everything here is mechanism;
 * the host passes policy: its handlers, who confirms, its theme values.
 */

export interface HostOptions<C extends AdapterConnection = ShellConnection> {
  /** Handlers for the declared capabilities; a mount may pass its own over these. */
  readonly handlers?: CapabilityHandlers;
  /** Who confirms `confirm`-gated calls. Absent: those calls are refused. */
  readonly confirm?: Confirm;
  /**
   * The host's live values for the config's theme variables, for `scheme` (read from its own
   * design tokens). A name it leaves out, or answers empty, gets the config's default.
   */
  readonly theme?: (scheme: ColorScheme) => Readonly<Record<string, string | null | undefined>>;
  /** The host's own context fields (locale, time zone, platform): merged into the host context. */
  readonly hostContext?: () => Partial<HostContext>;
  /** How the host names itself in the handshake. */
  readonly hostInfo?: { readonly name: string; readonly version: string };
  /** The protocol adapter. Default: the core's shell adapter (inline and artifact modes). */
  readonly adapter?: ProtocolAdapter<C>;
  /** The platform host. Default: the web's iframe host. */
  readonly platform?: PlatformHost;
  /** Required for domain and external isolation: where an instance's frame loads from. */
  readonly locator?: InstanceLocator;
}

export interface MountOptions {
  /** The host's id for this display: what its height is remembered by, and calls name. */
  readonly displayId: string;
  /** The display's accessible name and the title its confirmations show (the host's words). */
  readonly title: string;
  readonly scheme: ColorScheme;
  /** Handlers for this display only, over the host's. */
  readonly handlers?: CapabilityHandlers;
  /** Domain and external isolation: the instance to locate. */
  readonly instance?: InstanceRef;
  /** A whole document the frame starts with (an MCP Apps view), hardened by the shell. */
  readonly document?: string;
  /** The height to start at, before the content reports its own. */
  readonly initialHeightPx?: number;
}

/** What a display reports, by event name. */
export interface DisplayEvents {
  /** The frame finished its handshake. */
  readonly initialized: undefined;
  /** The content's size, after the config's limits. */
  readonly resize: { readonly height: number; readonly width?: number };
  /** What the content threw, or what the sandbox blocked (its own words: untrusted). */
  readonly error: { readonly message: string };
  /** The content navigated its frame away; the frame was started again from its content. */
  readonly navigated: undefined;
  /** A call didn't run. */
  readonly refused: { readonly capability: CapabilityName; readonly refusal: Refusal };
  /** Too many declines: the display stops asking until it runs again. */
  readonly muted: undefined;
}

export interface DisplayControls {
  readonly displayId: string;
  /** The theme flipped: the frame is re-themed in place, without a reload. */
  setTheme(scheme: ColorScheme): void;
  on<E extends keyof DisplayEvents>(
    event: E,
    listener: (detail: DisplayEvents[E]) => void,
  ): () => void;
  /** Runs the content again from the start, in a new frame. */
  reload(): void;
  /** Tears the view down and removes the frame. */
  destroy(): void;
}

/** A mounted display: the framework's controls plus the adapter's own operations. */
export type DisplayHandle<C extends AdapterConnection = ShellConnection> = DisplayControls &
  Omit<C, keyof AdapterConnection>;

export interface PortholeHost<C extends AdapterConnection = ShellConnection> {
  readonly compiled: CompiledConfig;
  /**
   * Creates a display in `container`. Throws if a declared capability served by a handler has
   * none (here or in the host's options), so a manual never teaches a function nobody serves.
   */
  mount(container: HTMLElement, options: MountOptions): DisplayHandle<C>;
}
