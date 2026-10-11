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
};

describe("the package a host installs", () => {
  test("has no dependencies, and React only as an optional peer", () => {
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(["react"]);
    expect(manifest.peerDependenciesMeta?.react?.optional).toBe(true);
  });
});
