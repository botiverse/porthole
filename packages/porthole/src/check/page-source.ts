/**
 * The check page's script as a module (`@botiverse/porthole/check/page`): from the sources, bundled
 * now (Node, esbuild); the package ships it built (`dist/check/page-source.js`), for a Worker to
 * import and pass to `checkPage` as `page`.
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
