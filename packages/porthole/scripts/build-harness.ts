/**
 * Bundles the browser scripts the package serves into modules that export each as a string,
 * replacing the source-only modules tsc compiled (which build them with esbuild when run from the
 * sources): the conformance harness (P066), which `defineHostConformance` serves on the app's
 * page, and the check page (P073). A bundler then takes them in like any module: nothing is looked
 * up beside a module at run time (P075). Run by `pnpm build`, after tsc.
 */
import { writeFile } from "node:fs/promises";
import { build } from "esbuild";

/** `entry`, bundled for a browser, as `dist/<module>.js` exporting it (and its .d.ts). */
async function asModule(entry: string, module: string): Promise<void> {
  const bundled = await build({
    entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    write: false,
    logLevel: "warning",
  });
  const text = bundled.outputFiles[0]?.text ?? "";
  if (text === "") {
    throw new Error(`${entry} built to nothing`);
  }
  await writeFile(
    new URL(`../dist/${module}.js`, import.meta.url),
    `const source = ${JSON.stringify(text)};\nexport default source;\n`,
  );
  await writeFile(
    new URL(`../dist/${module}.d.ts`, import.meta.url),
    "declare const source: string;\nexport default source;\n",
  );
}

await asModule("conformance/harness/page.ts", "conformance/harness-source");
await asModule("check/page.ts", "check/page-source");
