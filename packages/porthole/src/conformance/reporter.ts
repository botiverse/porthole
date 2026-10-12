import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * A Playwright reporter that says why each conformance case was skipped (P074): the list and line
 * reporters show a skipped case as "-" with no reason, and an inapplicable probe ("the page's own
 * CSP, which an opaque frame inherits, blocks … (connect-src)") is a fact worth reading.
 *
 *   reporter: [["list"], ["@botiverse/porthole/conformance/reporter"]],
 */
export default class SkipReasons implements Reporter {
  readonly #skipped = new Map<string, string>();

  printsToStdio(): boolean {
    return true;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== "skipped") {
      return;
    }
    const reason =
      [...result.annotations, ...test.annotations].find(
        (each) => each.type === "skip" && each.description !== undefined && each.description !== "",
      )?.description ?? "skipped";
    const title = test.title.length > 90 ? `${test.title.slice(0, 89)}…` : test.title;
    this.#skipped.set(`${title}\u0000${reason}`, `${title}: ${reason}`);
  }

  onEnd(_result: FullResult): void {
    if (this.#skipped.size === 0) {
      return;
    }
    const lines = [...this.#skipped.values()].toSorted();
    process.stdout.write(
      `\nSkipped (${lines.length}), and why:\n${lines.map((each) => `  - ${each}`).join("\n")}\n`,
    );
  }
}
