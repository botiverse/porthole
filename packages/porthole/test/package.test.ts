import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * What a host installs with Porthole (item 5 of 0.1.1): nothing it doesn't use. Test-only tools
 * (Playwright, the MCP Apps SDK) are not declared at all, not even as optional peers, which some
 * installs add anyway; the conformance runner uses the host's own (P041).
 */
const manifest = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  files: string[];
};

describe("the package a host installs", () => {
  test("has no dependencies, and React only as an optional peer", () => {
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(["react"]);
    expect(manifest.peerDependenciesMeta?.react?.optional).toBe(true);
  });

  test("ships the CHANGELOG, copied from the repository's at build (porthole#32)", () => {
    expect(manifest.files).toContain("CHANGELOG.md");
    const copy = readFileSync(path.resolve(import.meta.dirname, "../scripts/copy-docs.ts"), "utf8");
    expect(copy).toContain('new URL("../../../CHANGELOG.md", import.meta.url)');
    expect(copy).toContain('new URL("../CHANGELOG.md", import.meta.url)');
  });
});

describe("the package's README", () => {
  test("links only to what the package ships", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    const files = (
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { files: string[] }
    ).files;
    const links = [...readme.matchAll(/\]\((?!https?:)([^)#]+)\)/gu)].map((each) => each[1] ?? "");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(
        files.some((each) => link === each || link.startsWith(`${each}/`)),
        link,
      ).toBe(true);
      // docs/ is copied from the repository's docs/ at build time (scripts/copy-docs.ts).
      const source = link.startsWith("docs/")
        ? path.resolve(root, "../..", link)
        : path.resolve(root, link);
      expect(() => readFileSync(source), link).not.toThrow();
    }
  });
});
