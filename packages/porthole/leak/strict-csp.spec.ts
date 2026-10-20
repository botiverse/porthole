import { expect, test } from "@playwright/test";
import { leakTests } from "../src/conformance/index.ts";
import { inline } from "../src/conformance/kit.ts";
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

/**
 * The wall itself (P054, P096): the shell runs on such a page only with the host's nonce, so the
 * content it draws and runs shows. The `nonce` control fails this by its verdict (every other test
 * here fails with it, waiting on a shell that never ran).
 */
test("the shell runs on a host page whose script-src is its nonce alone (P054)", async ({
  page,
}) => {
  const display = await strict.launch(page, {
    config: inline(),
    content: `<p id="ran">not yet</p><script>document.getElementById("ran").textContent = "ran";</script>`,
  });
  const frame = await display.frame();
  await expect(frame.locator("#ran"), "probe: the shell drew and ran the content").toHaveText(
    "ran",
    { timeout: 10_000 },
  );
});
