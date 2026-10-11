import { expect, test, type Page } from "@playwright/test";
import { embedderCsp, presets } from "../src/index.ts";

/**
 * The embedding page's CSP restricts frames and nothing else (P038): the host's own workers, from
 * a blob or a file of its own, still start under it.
 */

async function workers(page: Page, csp: string): Promise<{ blob: string; file: string }> {
  await page.goto(`/?csp=${encodeURIComponent(csp)}`);
  return page.evaluate(async () => {
    const ask = (make: () => Worker) =>
      new Promise<string>((resolve) => {
        let worker: Worker;
        try {
          worker = make();
        } catch {
          resolve("blocked");
          return;
        }
        worker.addEventListener("message", (event) => resolve(String(event.data)));
        worker.addEventListener("error", () => resolve("blocked"));
        setTimeout(() => resolve("blocked"), 3_000);
        worker.postMessage("hi", []);
      });
    const source =
      'self.addEventListener("message", (event) => self.postMessage("echo:" + event.data, []));';
    return {
      blob: await ask(
        () => new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" }))),
      ),
      file: await ask(() => new Worker("/leak/host/worker.js")),
    };
  });
}

test("the host's own workers start under the embedding CSP", async ({ page, browserName }) => {
  const csp = embedderCsp([
    presets.inlineWidget(),
    presets.artifact(),
    presets.mcpApp(),
    presets.url({ contentOrigins: ["https://*.preview.example.com"] }),
  ]);
  expect(csp).not.toContain("child-src");
  expect(await workers(page, csp)).toEqual({ blob: "echo:hi", file: "echo:hi" });
  // Measured: the 0.1.0 policy (with child-src 'none') blocked the host's workers.
  const before = await workers(page, "frame-src 'none'; child-src 'none'");
  test.info().annotations.push({
    type: "measured",
    description: `${browserName}: under child-src 'none' the host's blob worker was ${before.blob === "blocked" ? "blocked" : "allowed"}, its file worker ${before.file === "blocked" ? "blocked" : "allowed"}`,
  });
});
