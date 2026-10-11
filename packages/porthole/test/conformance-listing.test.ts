import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A host registers the conformance tests in its own spec file (item 6 of 0.1.1): they are located
 * there, so a run filtered by that file or by a probe id finds them. Read from Playwright's own
 * listing of Porthole's spec, which registers them the way a host does.
 */

const root = path.resolve(import.meta.dirname, "..");

interface Listed {
  readonly suites?: readonly Listed[];
  readonly specs?: readonly { readonly title: string; readonly file: string }[];
}

function list(...args: string[]): { title: string; file: string }[] {
  const out = execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      "-c",
      "leak/playwright.config.ts",
      "--list",
      "--reporter=json",
      ...args,
    ],
    {
      cwd: root,
      env: { ...process.env, PORTHOLE_LEAK_ENGINES: "chromium" },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const specs: { title: string; file: string }[] = [];
  const walk = (suite: Listed) => {
    specs.push(...(suite.specs ?? []));
    (suite.suites ?? []).forEach(walk);
  };
  (JSON.parse(out) as Listed).suites?.forEach(walk);
  return specs;
}

describe("the conformance tests a host registers", () => {
  test("are located in the host's spec file, and filtered by it", () => {
    const specs = list("leak/leak.spec.ts");
    expect(specs.length).toBeGreaterThan(50);
    expect(new Set(specs.map((spec) => spec.file))).toEqual(new Set(["leak.spec.ts"]));
  }, 60_000);

  test("are selected by a probe id", () => {
    const specs = list("leak/leak.spec.ts", "--grep", "\\[1\\.connect\\]");
    expect(specs.map((spec) => spec.title)).toEqual([expect.stringMatching(/^\[1\.connect\] /u)]);
  }, 60_000);
});
