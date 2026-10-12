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

// The check page (P073), as a module exporting its script: a Worker imports it and passes it to
// checkPage. It replaces the source-only page-source the build compiled.
const page = await build({
  entryPoints: [new URL("../src/check/page.ts", import.meta.url).pathname],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  write: false,
  logLevel: "warning",
});
const { writeFile } = await import("node:fs/promises");
await writeFile(
  new URL("../dist/check/page-source.js", import.meta.url),
  `const source = ${JSON.stringify(page.outputFiles[0]?.text ?? "")};\nexport default source;\n`,
);
await writeFile(
  new URL("../dist/check/page-source.d.ts", import.meta.url),
  "declare const source: string;\nexport default source;\n",
);
