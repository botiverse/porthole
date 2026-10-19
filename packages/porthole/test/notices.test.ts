import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOTICES, generate } from "../scripts/notices.ts";
import { VENDORED_LIBRARIES } from "../src/index.ts";

/**
 * What the open-source release carries besides the code (P097, the 2026-10-19 audit's licenses and
 * materials): the notices of every third-party file in the repository and the package, the
 * license in the package itself, where to report a vulnerability, and where the package comes
 * from.
 */

const root = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(root, "../..");
const read = (file: string): Promise<string> => readFile(file, "utf8");
const manifest = async (file: string) =>
  JSON.parse(await read(file)) as {
    name: string;
    files?: string[];
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    repository?: { type: string; url: string; directory?: string };
    bugs?: { url: string };
    homepage?: string;
  };

describe("third-party notices", () => {
  it("the package's are what the vendored libraries' packages hold (node scripts/notices.ts)", async () => {
    expect(await read(NOTICES)).toBe(await generate());
  });

  it("the package's name every vendored library and what its file bundles", async () => {
    const notices = await read(NOTICES);
    for (const library of VENDORED_LIBRARIES) {
      expect(notices).toContain(`## ${library.title} ${library.version}`);
      expect(notices).toContain(`- ${library.name} ${library.version}: ${library.license}`);
    }
    // What the minified files carry inside them (their banners, and code checked by hand).
    for (const bundled of [
      "@kurkle/color",
      "d3-geo",
      "d3-ease",
      "delaunator",
      "robust-predicates",
    ]) {
      expect(notices).toContain(`- ${bundled} `);
    }
    // GeographicLib (in d3-geo), Robert Penner's easing (d3-ease), ColorBrewer (d3-scale-chromatic).
    for (const text of ["Charles Karney", "Robert Penner", "Cynthia Brewer"]) {
      expect(notices).toContain(text);
    }
  });

  it("ship with the package", async () => {
    const files = (await manifest(path.join(root, "package.json"))).files ?? [];
    expect(files).toContain("THIRD_PARTY_NOTICES.md");
  });

  it("the Vite + React fixture's name what its committed build bundles", async () => {
    const fixture = path.join(root, "leak/fixtures/vite-react");
    const notices = await read(path.join(fixture, "THIRD_PARTY_NOTICES.md"));
    const { dependencies = {}, devDependencies = {} } = await manifest(
      path.join(fixture, "package.json"),
    );
    // What runs in the page, and the build tool whose own code the build carries.
    for (const [name, version] of Object.entries({
      ...dependencies,
      vite: devDependencies["vite"],
    })) {
      expect(notices, name).toContain(`${name}@${version}`);
    }
    expect(notices).toContain("scheduler@");
    const bundle = await read(path.join(fixture, "out/assets/index-Dc-CZvvv.js"));
    // React says its version in the bundle (a string literal, whichever quotes the minifier chose).
    const version = dependencies["react"] ?? "";
    expect(["`", '"', "'"].some((quote) => bundle.includes(`${quote}${version}${quote}`))).toBe(
      true,
    );
    expect(notices).toContain("Copyright (c) Facebook, Inc. and its affiliates.");
  });
});

describe("the open-source materials", () => {
  it("the package carries the repository's license itself (npm pack doesn't look above it)", async () => {
    expect(await read(path.join(root, "LICENSE"))).toBe(await read(path.join(repo, "LICENSE")));
  });

  it("the package says where it comes from and where to report a problem", async () => {
    const pkg = await manifest(path.join(root, "package.json"));
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/botiverse/porthole.git",
      directory: "packages/porthole",
    });
    expect(pkg.bugs).toEqual({ url: "https://github.com/botiverse/porthole/issues" });
    expect(pkg.homepage).toBe("https://github.com/botiverse/porthole#readme");
  });

  it("SECURITY.md asks for private reports, and the READMEs point to it", async () => {
    const security = await read(path.join(repo, "SECURITY.md"));
    expect(security).toContain("https://github.com/botiverse/porthole/security/advisories/new");
    expect(security).toMatch(/supported versions/iu);
    expect(await read(path.join(repo, "README.md"))).toContain("](SECURITY.md)");
    expect(await read(path.join(root, "README.md"))).toContain(
      "https://github.com/botiverse/porthole/blob/main/SECURITY.md",
    );
  });

  it("the README's status is current, not a private phase 1", async () => {
    const readme = await read(path.join(repo, "README.md"));
    expect(readme).not.toMatch(/\*\*Private\./u);
    expect(readme).not.toContain("Phase 1 in progress");
  });
});
