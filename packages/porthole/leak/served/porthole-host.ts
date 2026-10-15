import { expect, type Frame, type Page } from "@playwright/test";
import type { PortholeConfig } from "../../src/index.ts";
import type { FrameOutcome } from "../../src/host/types.ts";
import type { FrameLocation, InstanceRef } from "../../src/isolation/types.ts";

/**
 * The harness's host page on Porthole's own `createHost` (`/porthole-host`): mounts a served
 * instance at a location the test issued, and records the display's outcomes (P040).
 */

export interface DisplayRecord {
  readonly outcomes: FrameOutcome[];
  readonly initialized: boolean;
  /** `<source>: <message>`, from the `error` event. */
  readonly errors: string[];
  readonly contentErrors: string[];
  readonly hostErrors: { readonly message: string; readonly kind: string }[];
  /** The addresses the shell stopped the frame navigating to (`navigationBlocked`, P080). */
  readonly navigationsBlocked: string[];
}

interface PortholeHostPage {
  records: DisplayRecord[];
  mount(
    config: PortholeConfig,
    location: FrameLocation | null,
    instance: InstanceRef,
    options?: MountExtras,
  ): number;
}

/**
 * What else a mount is given: content to send a shell, whether the frame fills its box, and
 * whether the host serves it live data (`window.liveData` on the host page, P079), or refuses it
 * all (P080).
 */
export interface MountExtras {
  readonly content?: string;
  readonly fill?: boolean;
  /** `"refused"`: the host refuses every data call, with no handlers (P080). */
  readonly live?: boolean | "refused";
}

export const app = (scope: string): InstanceRef => ({
  scope,
  document: { kind: "external", url: "http://app.test/" },
});

export interface Mounted {
  readonly read: () => Promise<DisplayRecord>;
  /** The frame's current document. */
  readonly frame: () => Promise<Frame>;
}

export async function mount(
  page: Page,
  origin: string,
  config: PortholeConfig,
  /** Null: the host's locator fails. */
  location: FrameLocation | null,
  instance: InstanceRef,
  extras: MountExtras = {},
): Promise<Mounted> {
  if (!page.url().startsWith(`${origin}/porthole-host`)) {
    await page.goto(`${origin}/porthole-host`);
    await page.waitForFunction(() => "portholeHost" in window);
  }
  const index = await page.evaluate(
    ([each, where, what, more]) =>
      (window as unknown as { portholeHost: PortholeHostPage }).portholeHost.mount(
        each,
        where,
        what,
        more,
      ),
    [config, location, instance, extras] as const,
  );
  const element = page.locator("#displays iframe").nth(index);
  return {
    read: () =>
      page.evaluate(
        (each) =>
          (window as unknown as { portholeHost: PortholeHostPage }).portholeHost.records[
            each
          ] as DisplayRecord,
        index,
      ),
    async frame() {
      const frame = await (await element.elementHandle())?.contentFrame();
      if (frame === null || frame === undefined) {
        throw new Error("the display has no frame");
      }
      return frame;
    },
  };
}

/** The display's outcomes once there are `count` of them. */
export async function outcomesOf(
  read: () => Promise<DisplayRecord>,
  count: number,
  timeout = 10_000,
): Promise<FrameOutcome[]> {
  await expect.poll(async () => (await read()).outcomes.length, { timeout }).toBe(count);
  return (await read()).outcomes;
}

export const outcomeOf = async (
  read: () => Promise<DisplayRecord>,
  timeout = 10_000,
): Promise<FrameOutcome> => (await outcomesOf(read, 1, timeout))[0] as FrameOutcome;
