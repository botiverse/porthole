import { test } from "@playwright/test";
import { servedTests, TAB_CASES } from "../../src/conformance/served.ts";
import { servedHost } from "./harness.ts";

/**
 * The served-mode cases against Porthole's reference serving, registered as a host would; those
 * on a tab of its own in `tab.spec.ts` (P099), with the rest of the tab's cases.
 */
test.describe(`served modes (${servedHost.name})`, () => {
  for (const each of servedTests(servedHost).filter((one) => !TAB_CASES.includes(one.id))) {
    test(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
  }
});
