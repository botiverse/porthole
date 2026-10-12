/**
 * `@botiverse/porthole/conformance`: the leak/conformance suite (P008), runnable by any host
 * against its own integration. A host implements `ConformanceHost` (how to show one display in a
 * page and drive it), then registers the tests in a spec file of its own, so they are located
 * there (`playwright test conformance.spec.ts`, `--grep "\[1\.connect\]"`):
 *
 *   import { test } from "@playwright/test";
 *   import { leakTests } from "@botiverse/porthole/conformance";
 *   for (const each of leakTests(myHost)) {
 *     test(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
 *   }
 *
 * The host's own `@playwright/test` (and, for the App SDK probes, `@modelcontextprotocol/ext-apps`)
 * is what runs it: Porthole declares neither (P041).
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
  /**
   * The whole content (a fragment, or a document for artifact mode). Omitted: nothing is sent,
   * and the test drives the content with `LaunchedDisplay.setContent`.
   */
  readonly content?: string;
  /** Content to stream first, each step sent as partial, before the whole. */
  readonly partials?: readonly string[];
  /** A whole document the frame starts with instead (an MCP Apps view). */
  readonly document?: string;
  readonly title?: string;
  readonly scheme?: ColorScheme;
  /** The frame's width, px. */
  readonly widthPx?: number;
  /** The height of the box the frame sits in, px: for a layout that fills it (`layout.kind`). */
  readonly heightPx?: number;
  /** The host's live values for theme variables, per scheme (as `HostOptions.theme` answers). */
  readonly hostTheme?: {
    readonly light?: Readonly<Record<string, string>>;
    readonly dark?: Readonly<Record<string, string>>;
  };
  /** Whether the host has a `confirm` function (default true): without one, gated calls are refused. */
  readonly confirms?: boolean;
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
  /** The frame element's size on the host's page, px. */
  box(): Promise<{ readonly width: number; readonly height: number }>;
  /** Sends content: partial (drawn inert) any number of times, then whole (runs once). */
  setContent(html: string, options?: { readonly partial?: boolean }): Promise<void>;
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

export {
  defineLeakSuite,
  leakTests,
  PROBES,
  type ConformanceFixtures,
  type ConformanceTest,
  type Probe,
} from "./probes.ts";
export { httpOracle, settle, udpOracle, type HttpOracle, type UdpOracle } from "./oracles.ts";

// The served modes' cases (domain and url mode), with their own host interface.
export {
  defineServedSuite,
  servedTests,
  type ServedConformanceHost,
  type ServedDisplay,
  type ServedSuiteOptions,
} from "./served.ts";
