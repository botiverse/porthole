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
  events(id: number): RecordedEvent[];
  errors(id: number): string[];
  pendingConfirmations(id: number): number;
  answer(id: number, accept: boolean): ConfirmRequest | null;
  setTheme(id: number, scheme: "light" | "dark"): void;
  setContent(id: number, html: string, partial: boolean): void;
  destroy(id: number): void;
}

type WithReference = Window & { reference: Reference };

/**
 * Porthole's own `ConformanceHost`: a page that mounts displays with the real core, served with
 * the embedding CSP `embedderCsp` derives from the display's config.
 */
export const referenceHost: ConformanceHost = {
  name: "reference",
  async launch(page: Page, spec: LaunchSpec): Promise<LaunchedDisplay> {
    if (!page.url().includes("/?csp=")) {
      await page.goto(`/?csp=${encodeURIComponent(embedderCsp([spec.config]))}`);
      await page.waitForFunction(() => "reference" in window);
    }
    const id = await page.evaluate(
      (each) => (window as unknown as WithReference).reference.launch(each),
      spec,
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
                (each) => (window as unknown as WithReference).reference.pendingConfirmations(each),
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
      errors: () =>
        page.evaluate((each) => (window as unknown as WithReference).reference.errors(each), id),
      events: () =>
        page.evaluate((each) => (window as unknown as WithReference).reference.events(each), id),
      destroy: () =>
        page.evaluate((each) => (window as unknown as WithReference).reference.destroy(each), id),
    };
  },
};
