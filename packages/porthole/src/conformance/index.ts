/**
 * `@botiverse/porthole/conformance`: the leak/conformance suite (P008), runnable by any host
 * against its own integration. A host implements `ConformanceHost` (how to show one display in a
 * fresh page and drive it), then registers the suite in its Playwright project:
 *
 *   import { test } from "@playwright/test";
 *   import { defineLeakSuite } from "@botiverse/porthole/conformance";
 *   defineLeakSuite(test, myHost);
 *
 * Each probe attempts one egress or escape channel (DESIGN.md § Egress hardening) and asserts,
 * with an out-of-band oracle where one exists (an HTTP canary server, a UDP listener for ICE),
 * that nothing left. Porthole runs it against its own reference host on every engine it supports.
 */
import type { Frame, Page, TestType } from "@playwright/test";
import type { ConfirmRequest } from "../bridge/types.ts";
import type { CapabilityName } from "../config/capabilities.ts";
import type { ColorScheme, PortholeConfig } from "../config/schema.ts";
import { NotBuiltYet } from "../internal/not-built.ts";

export interface LaunchSpec {
  readonly config: PortholeConfig;
  /** The whole content. */
  readonly content: string;
  /** Content to stream first, each step sent as partial, before the whole. */
  readonly partials?: readonly string[];
  readonly title?: string;
  readonly scheme?: ColorScheme;
  /** The frame's width, px. */
  readonly widthPx?: number;
}

export interface RecordedCall {
  readonly capability: CapabilityName;
  readonly args: unknown;
}

export interface LaunchedDisplay {
  /** The display's frame, to probe from inside. */
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
  destroy(): Promise<void>;
}

/** What a host implements to run the suite against its integration. */
export interface ConformanceHost {
  readonly name: string;
  /** Shows one display in `page` (a fresh page per test) and returns handles to drive it. */
  launch(page: Page, spec: LaunchSpec): Promise<LaunchedDisplay>;
}

export interface LeakSuiteOptions {
  /** Probe ids to skip, each with the reason (shown in the report). */
  readonly skip?: Readonly<Record<string, string>>;
}

/** Registers every probe as a test. */
export function defineLeakSuite(
  _test: TestType<object, object>,
  _host: ConformanceHost,
  _options?: LeakSuiteOptions,
): void {
  throw new NotBuiltYet("defineLeakSuite", "M2");
}
