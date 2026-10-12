/**
 * The conformance harness as one browser script, as a module `defineHostConformance` imports: from
 * the sources, bundled now (Node, esbuild, Porthole's own development dependency); the package
 * ships it built (`dist/conformance/harness-source.js`, a string and nothing else), so a bundler
 * takes it in like any module and nothing is looked up beside it at run time (P075).
 */
import { fileURLToPath } from "node:url";

const { build } = await import("esbuild");
const result = await build({
  entryPoints: [fileURLToPath(new URL("./harness/page.ts", import.meta.url))],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
  logLevel: "silent",
});
const source: string = result.outputFiles[0]?.text ?? "";
if (source === "") {
  throw new Error("the conformance harness didn't build");
}
export default source;
