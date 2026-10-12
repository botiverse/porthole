/**
 * Copies the design docs into the package (docs/, gitignored), so the npm package carries what
 * its code points to: DESIGN.md's host kit, DECISIONS.md's P-numbers (P070). Run by `pnpm build`.
 */
import { copyFile, mkdir } from "node:fs/promises";

const from = new URL("../../../docs/", import.meta.url);
const to = new URL("../docs/", import.meta.url);
await mkdir(to, { recursive: true });
for (const name of [
  "DESIGN.md",
  "DECISIONS.md",
  "ARCHITECTURE.md",
  "PRINCIPLES.md",
  "OBJECTIVES.md",
]) {
  await copyFile(new URL(name, from), new URL(name, to));
}
