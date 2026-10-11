/**
 * `@botiverse/porthole/conformance`: the leak/conformance suite (P008), runnable by any host
 * against its own integration. A host implements `ConformanceHost` (how to show one display in a
 * page and drive it), then registers the suite in its Playwright project:
 *
 *   import { test } from "@playwright/test";
 *   import { defineLeakSuite } from "@botiverse/porthole/conformance";
 *   defineLeakSuite(test, myHost);
 *
 * Each probe attempts one egress or escape channel (DESIGN.md § Egress hardening) and asserts,
 * with an out-of-band oracle where one exists (an HTTP canary that also counts connections, a UDP
 * listener for ICE), that nothing left. Each oracle has a positive control: where the engine
 * can't make the channel work even unsandboxed, the probe says so instead of passing silently.
 * Porthole runs it against its own reference host on every engine it supports.
 */
import type { Frame, Page } from "@playwright/test";
import type { ConfirmRequest } from "../bridge/types.ts";
import type { CapabilityName } from "../config/capabilities.ts";
import type { ColorScheme, PortholeConfig } from "../config/schema.ts";
import type { DisplayEvents } from "../host/types.ts";

export interface LaunchSpec {
  readonly config: PortholeConfig;
  /** The whole content (a fragment, or a document for artifact mode). */
  readonly content: string;
  /** Content to stream first, each step sent as partial, before the whole. */
  readonly partials?: readonly string[];
  /** A whole document the frame starts with instead (an MCP Apps view). */
  readonly document?: string;
  readonly title?: string;
  readonly scheme?: ColorScheme;
  /** The frame's width, px. */
  readonly widthPx?: number;
}

export interface RecordedCall {
  readonly capability: CapabilityName;
  readonly args: unknown;
}

export type RecordedEvent = {
  [E in keyof DisplayEvents]: { readonly type: E; readonly detail: DisplayEvents[E] };
}[keyof DisplayEvents];

export interface LaunchedDisplay {
  /** The display's frame as it is now (a restart makes a new one), to probe from inside. */
  frame(): Promise<Frame>;
  setTheme(scheme: ColorScheme): Promise<void>;
  /** Waits for the next confirmation the host is asked for, answers it, and returns it. */
  answerNextConfirmation(
    accept: boolean,
    options?: { readonly timeoutMs?: number },
  ): Promise<ConfirmRequest>;
  /** The calls that reached the host's handlers, in order. */
  calls(): Promise<readonly RecordedCall[]>;
  /** The errors the display reported. */
  errors(): Promise<readonly string[]>;
  /** Every event the display emitted, in order. */
  events(): Promise<readonly RecordedEvent[]>;
  destroy(): Promise<void>;
}

/** What a host implements to run the suite against its integration. */
export interface ConformanceHost {
  readonly name: string;
  /**
   * Shows one display in `page` and returns handles to drive it. The first call on a page loads
   * the host's page (sending its embedding CSP for `spec.config`); a later call on the same page
   * adds another display beside the first.
   */
  launch(page: Page, spec: LaunchSpec): Promise<LaunchedDisplay>;
}

export interface LeakSuiteOptions {
  /** Probe ids to skip, each with the reason (shown in the report). */
  readonly skip?: Readonly<Record<string, string>>;
}

export { defineLeakSuite, PROBES, type Probe } from "./probes.ts";
export { httpOracle, settle, udpOracle, type HttpOracle, type UdpOracle } from "./oracles.ts";

// The served modes' cases (domain and url mode), with their own host interface.
export {
  defineServedSuite,
  type ServedConformanceHost,
  type ServedDisplay,
  type ServedSuiteOptions,
} from "./served.ts";
