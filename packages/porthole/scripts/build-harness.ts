/**
 * Bundles the conformance harness (src/conformance/harness/page.ts) into one browser script,
 * dist/conformance/harness.js, which `defineHostConformance` serves on the app's page (P066).
 * Run by `pnpm build`, after tsc.
 */
import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/conformance/harness/page.ts", import.meta.url).pathname],
  outfile: new URL("../dist/conformance/harness.js", import.meta.url).pathname,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});
