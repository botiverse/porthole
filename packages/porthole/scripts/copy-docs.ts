/**
 * Copies the docs into the package (docs/, gitignored), so the npm package carries what its README
 * and code point to: ADOPTING.md, DESIGN.md's host kit, DECISIONS.md's P-numbers (P070, P071).
 * Every Markdown file in docs/, so a new one can't be left out. And the repository's CHANGELOG.md
 * (CHANGELOG.md, gitignored), so an adopter reading node_modules finds what to act on when
 * upgrading (porthole#32). Run by `pnpm build`.
 */
import { copyFile, mkdir, readdir } from "node:fs/promises";

const from = new URL("../../../docs/", import.meta.url);
const to = new URL("../docs/", import.meta.url);
await mkdir(to, { recursive: true });
for (const name of await readdir(from)) {
  if (name.endsWith(".md")) {
    await copyFile(new URL(name, from), new URL(name, to));
  }
}
await copyFile(
  new URL("../../../CHANGELOG.md", import.meta.url),
  new URL("../CHANGELOG.md", import.meta.url),
);
