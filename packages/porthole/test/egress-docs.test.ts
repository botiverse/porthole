import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateGuide, generateToolDescription } from "../src/guide/guide.ts";
import { LIBRARY_CDNS, presets, type PortholeConfig } from "../src/index.ts";

/**
 * ADOPTING.md § "Choosing egress" (#7) against the code: each level's row quotes what the agent's
 * manual says under that level, links decision records that exist, and names probes that exist.
 */

const docs = (name: string) =>
  readFileSync(new URL(`../../../docs/${name}`, import.meta.url), "utf8");
const adopting = docs("ADOPTING.md");
const section = adopting.slice(
  adopting.indexOf("### Choosing egress"),
  adopting.indexOf("## 3. Opaque displays"),
);
const rows = section.split("\n").filter((line) => line.startsWith("| **"));
const cell = (row: string, column: number) => row.split(" | ")[column] ?? "";
const quotes = (text: string) => [...text.matchAll(/`([^`]+)`/gu)].map((each) => each[1] ?? "");

/** Each level as the section's snippet writes it. */
const LEVELS: Readonly<Record<string, PortholeConfig>> = {
  Closed: presets.artifact(),
  "Library CDNs": presets.artifact({ egress: LIBRARY_CDNS }),
  "Passive from any https site": presets.artifact({
    egress: { ...LIBRARY_CDNS, anyHttps: ["img"] },
  }),
  "Porthole's libraries": presets.liveWidget({
    isolation: "domain",
    contentOrigins: ["https://*.example-usercontent.com"],
  }),
};

describe('ADOPTING.md § "Choosing egress"', () => {
  it("has a row per level, each quoting what the manual says under it", () => {
    expect(rows.map((row) => /\*\*([^*]+)\*\*/u.exec(row)?.[1])).toEqual(Object.keys(LEVELS));
    for (const row of rows) {
      const level = /\*\*([^*]+)\*\*/u.exec(row)?.[1] ?? "";
      const config = LEVELS[level];
      expect(config, level).toBeDefined();
      const manual = `${generateGuide(config as PortholeConfig)}\n${generateToolDescription(config as PortholeConfig)}`;
      const said = quotes(cell(row, 5));
      expect(said.length, level).toBeGreaterThan(0);
      for (const words of said) {
        if (words.includes("for all three") || words.startsWith("fonts, images, audio")) {
          continue;
        }
        expect(manual, `${level}: "${words}"`).toContain(words);
      }
    }
    // The all-three wording, as the row gives it.
    const all = presets.artifact({ egress: { anyHttps: ["img", "media", "font"] } });
    expect(generateGuide(all)).toContain("fonts, images, audio and video from any https site");
    expect(generateToolDescription(all)).toContain(
      "fonts, images, audio and video from any https site",
    );
  });

  it("links decision records that exist", () => {
    const anchors = new Set(
      [...docs("DECISIONS.md").matchAll(/^## (.+)$/gmu)].map((each) =>
        (each[1] ?? "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\- _]/gu, "")
          .replaceAll(" ", "-"),
      ),
    );
    const links = [...section.matchAll(/\]\(DECISIONS\.md#([^)]+)\)/gu)].map((each) => each[1]);
    expect(links.length).toBeGreaterThanOrEqual(7);
    for (const link of links) {
      expect(anchors, link).toContain(link);
    }
  });

  it("names probes and test files that exist", () => {
    const probes = readFileSync(new URL("../src/conformance/probes.ts", import.meta.url), "utf8");
    const served = readFileSync(new URL("../src/conformance/served.ts", import.meta.url), "utf8");
    for (const row of rows) {
      for (const name of quotes(cell(row, 7))) {
        if (/^\d+\.[a-z-]+$/u.test(name)) {
          expect(probes, name).toContain(`"${name}"`);
        } else if (/^\d+\.\*$/u.test(name)) {
          expect(probes, name).toContain(`id: \`${name.slice(0, -1)}\${id}\``);
        } else if (name.startsWith("served.")) {
          expect(served, name).toContain(`"${name}"`);
        } else {
          expect(() => readFileSync(new URL(`../${name}`, import.meta.url)), name).not.toThrow();
        }
      }
    }
  });
});
