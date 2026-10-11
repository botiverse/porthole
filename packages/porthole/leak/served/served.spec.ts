import { test } from "@playwright/test";
import { servedTests } from "../../src/conformance/served.ts";
import { servedHost } from "./harness.ts";

/** The served-mode cases against Porthole's reference serving, registered as a host would. */
test.describe(`served modes (${servedHost.name})`, () => {
  for (const each of servedTests(servedHost)) {
    test(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
  }
});
