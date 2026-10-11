import { expect, test, type TestInfo } from "@playwright/test";
import { leakTests } from "../src/conformance/index.ts";
import { referenceHostWith } from "./reference-host.ts";

/**
 * The suite on hosts where a case can't be observed (P058): it reports the case inapplicable on
 * that host, with the reason, instead of failing it. A page whose own policy closes images and
 * fetches (opaque frames inherit it), and a host that always confirms.
 */

class Skipped extends Error {}

/** Runs one suite entry, returning the reason it was skipped, or null if it ran through. */
async function skipReason(
  entry: ReturnType<typeof leakTests>[number] | undefined,
  page: Parameters<Parameters<typeof test>[2]>[0]["page"],
  browserName: string,
): Promise<string | null> {
  if (entry === undefined) {
    throw new Error("no such case");
  }
  const info = {
    annotations: [] as { type: string; description?: string }[],
    skip(condition: boolean, reason?: string) {
      if (condition) {
        throw new Skipped(reason ?? "");
      }
    },
  };
  try {
    await entry.run({ page, browserName }, info as unknown as TestInfo);
    return null;
  } catch (error) {
    if (error instanceof Skipped) {
      return error.message;
    }
    throw error;
  }
}

const closed = referenceHostWith({ nonce: true, closed: true });
const always = referenceHostWith({ alwaysConfirms: true });

for (const id of ["1.connect", "2.resources"]) {
  test(`[${id}] on a page whose own policy closes it: inapplicable, not failed`, async ({
    page,
    browserName,
  }) => {
    const entry = leakTests(closed).find((each) => each.id === id);
    expect(await skipReason(entry, page, browserName)).toMatch(
      /^inapplicable on this host: the page's own CSP, which an opaque frame inherits, blocks http:\/\/127\.0\.0\.1:\d+ \((connect|img)-src\)/u,
    );
  });
}

test("[12.no-confirm] on a host that always confirms: inapplicable, not failed", async ({
  page,
  browserName,
}) => {
  const entry = leakTests(always).find((each) => each.id === "12.no-confirm");
  expect(await skipReason(entry, page, browserName)).toMatch(
    /^inapplicable on this host: this host always has a confirm function/u,
  );
});
