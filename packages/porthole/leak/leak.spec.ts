import { test } from "@playwright/test";
import { leakTests } from "../src/conformance/index.ts";
import { referenceHost } from "./reference-host.ts";

/** The leak suite against Porthole's reference host, registered here as a host registers it. */
test.describe(`Porthole leak suite (${referenceHost.name})`, () => {
  for (const each of leakTests(referenceHost)) {
    test(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
  }
});
