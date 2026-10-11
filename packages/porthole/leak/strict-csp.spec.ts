import { test } from "@playwright/test";
import { leakTests } from "../src/conformance/index.ts";
import { referenceHostWith } from "./reference-host.ts";

/**
 * The whole leak suite again, on a host page with a strict, nonce-based `script-src` (no
 * 'unsafe-inline', no 'strict-dynamic'), as such a host runs it on its real page (P054): opaque
 * frames inherit the page's policy, so the shell runs only because the host gave it its nonce.
 */
const strict = referenceHostWith({ nonce: true });

test.describe(`Porthole leak suite (${strict.name})`, () => {
  for (const each of leakTests(strict)) {
    test(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
  }
});
