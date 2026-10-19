import { expect, type Frame, type Page } from "@playwright/test";
import { embedderCsp } from "../src/index.ts";
import type { ConfirmRequest } from "../src/bridge/types.ts";
import type {
  ConformanceHost,
  LaunchedDisplay,
  LaunchSpec,
  RecordedCall,
  RecordedEvent,
} from "../src/conformance/index.ts";

/** The reference host's page-side API (`leak/host/reference.ts`). */
interface Reference {
  launch(spec: LaunchSpec): Promise<number>;
  calls(id: number): RecordedCall[];
  shown(id: number): ConfirmRequest[];
  events(id: number): RecordedEvent[];
  errors(id: number): string[];
  pendingConfirmations(id: number): number;
  answer(id: number, accept: boolean): ConfirmRequest | null;
  setTheme(id: number, scheme: "light" | "dark"): void;
  setContent(id: number, html: string, partial: boolean): void;
  annotate(id: number, operation: AnnotateOperation, argument?: unknown): string | null;
  destroy(id: number): void;
}

/** The annotation controls the reference host exposes (`DisplayHandle.annotations`). */
export type AnnotateOperation = "start" | "stop" | "show" | "focus" | "clear";

/** A reference display, with its annotations (`annotate`) to drive. */
export interface ReferenceDisplay extends LaunchedDisplay {
  /** Runs an annotation control; resolves with what it threw, or null. */
  annotate(operation: AnnotateOperation, argument?: unknown): Promise<string | null>;
}

type WithReference = Window & { reference: Reference };

/**
 * Porthole's own `ConformanceHost`: a page that mounts displays with the real core, served with
 * the embedding CSP `embedderCsp` derives from the display's config.
 */
export const referenceHost = referenceHostWith({});

/**
 * The reference host, optionally on a page with a strict, nonce-based `script-src` (`nonce`),
 * as a host with such a policy runs the suite on its real page (P054).
 */
export function referenceHostWith(setup: {
  readonly nonce?: boolean;
  /**
   * A page whose own policy closes images and fetches to its origin (with `nonce`); `"images"`:
   * data: images too.
   */
  readonly closed?: boolean | "images";
  /** A host that always has a confirm function (a default dialog): `confirms: false` is ignored. */
  readonly alwaysConfirms?: boolean;
}): Omit<ConformanceHost, "launch"> & {
  launch(page: Page, spec: LaunchSpec): Promise<ReferenceDisplay>;
} {
  return {
    name: setup.nonce === true ? "reference, strict CSP" : "reference",
    async launch(page: Page, spec: LaunchSpec): Promise<ReferenceDisplay> {
      if (!page.url().includes("/?csp=")) {
        await page.goto(
          `/?csp=${encodeURIComponent(embedderCsp([spec.config]))}${setup.nonce === true ? "&nonce=1" : ""}${setup.closed === true ? "&closed=1" : setup.closed === "images" ? "&closed=2" : ""}`,
        );
        await page.waitForFunction(() => "reference" in window);
      }
      // A host that always confirms has no way to show a display without a confirm function.
      const { confirms: _ignored, ...always } = spec;
      const id = await page.evaluate(
        (each) => (window as unknown as WithReference).reference.launch(each),
        setup.alwaysConfirms === true ? always : spec,
      );
      const frame = async (): Promise<Frame> => {
        let found: Frame | null = null;
        await expect
          .poll(async () => {
            const element = await page
              .locator(`#display-${id} iframe`)
              .elementHandle({ timeout: 2_000 })
              .catch(() => null);
            found = (await element?.contentFrame()) ?? null;
            return found !== null;
          })
          .toBe(true);
        return found as unknown as Frame;
      };
      return {
        frame,
        async box() {
          const element = await page.locator(`#display-${id} iframe`).elementHandle();
          const box = await element?.boundingBox();
          return { width: box?.width ?? 0, height: box?.height ?? 0 };
        },
        setContent: (html, options) =>
          page.evaluate(
            ([each, text, partial]) =>
              (window as unknown as WithReference).reference.setContent(each, text, partial),
            [id, html, options?.partial === true] as const,
          ),
        setTheme: (scheme) =>
          page.evaluate(
            ([each, next]) => (window as unknown as WithReference).reference.setTheme(each, next),
            [id, scheme] as const,
          ),
        async answerNextConfirmation(accept, options) {
          await expect
            .poll(
              () =>
                page.evaluate(
                  (each) =>
                    (window as unknown as WithReference).reference.pendingConfirmations(each),
                  id,
                ),
              {
                timeout: options?.timeoutMs ?? 5_000,
              },
            )
            .toBeGreaterThan(0);
          const request = await page.evaluate(
            ([each, yes]) => (window as unknown as WithReference).reference.answer(each, yes),
            [id, accept] as const,
          );
          if (request === null) {
            throw new Error("no confirmation was waiting");
          }
          return request;
        },
        calls: () =>
          page.evaluate((each) => (window as unknown as WithReference).reference.calls(each), id),
        shown: () =>
          page.evaluate((each) => (window as unknown as WithReference).reference.shown(each), id),
        errors: () =>
          page.evaluate((each) => (window as unknown as WithReference).reference.errors(each), id),
        events: () =>
          page.evaluate((each) => (window as unknown as WithReference).reference.events(each), id),
        destroy: () =>
          page.evaluate((each) => (window as unknown as WithReference).reference.destroy(each), id),
        annotate: (operation, argument) =>
          page.evaluate(
            ([each, what, given]) =>
              (window as unknown as WithReference).reference.annotate(each, what, given),
            [id, operation, argument] as const,
          ),
      };
    },
  };
}
