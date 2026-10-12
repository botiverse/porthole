/**
 * The check page's script as a module (`@botiverse/porthole/check/page`), which `checkPage`
 * imports: from the sources, bundled now (Node, esbuild, Porthole's own development dependency);
 * the package ships it built (`dist/check/page-source.js`, a string and nothing else), so a
 * bundler takes it in like any module (P075).
 */
import { fileURLToPath } from "node:url";

const { build } = await import("esbuild");
const result = await build({
  entryPoints: [fileURLToPath(new URL("./page.ts", import.meta.url))],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
  logLevel: "silent",
});
const source: string = result.outputFiles[0]?.text ?? "";
export default source;
