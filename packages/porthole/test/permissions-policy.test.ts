import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { FRAME_DENIED_FEATURES } from "../src/compile/policy.ts";

/**
 * The features a served page denies itself (P099), held to a checked-in copy of Chromium's own
 * list (`test/reference/permissions-policy-features.json`): every name denied is one a
 * cross-origin frame lacks by default, and every such feature a web page may have is denied or
 * kept here with its reason. A refreshed reference with a new feature fails until it is classified.
 */

interface Feature {
  readonly name: string;
  readonly default: "self" | "*";
  readonly web: boolean;
}

const reference = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "reference", "permissions-policy-features.json"),
    "utf8",
  ),
) as { readonly features: readonly Feature[] };

/** Features a frame lacks by default that a served page still doesn't deny, each with why. */
const KEPT: Readonly<Record<string, string>> = {
  "cross-origin-isolated": "a state the page never has (no COOP and COEP), not a power",
  frobulate: "Chromium's origin-trial sample feature",
};
/** Client hints: which device details request headers carry, not a power the page uses. */
const kept = (name: string): boolean => Object.hasOwn(KEPT, name) || name.startsWith("ch-");

const byName = new Map(reference.features.map((each) => [each.name, each]));

describe("the features a served page denies itself, against Chromium's list (P099)", () => {
  test("each is a feature a web page has, and a cross-origin frame lacks by default", () => {
    for (const name of FRAME_DENIED_FEATURES) {
      const feature = byName.get(name);
      expect(feature, `${name}: not in the reference`).toBeDefined();
      expect(feature?.default, `${name}: a frame has it by default`).toBe("self");
      expect(feature?.web, `${name}: no web page has it`).toBe(true);
    }
  });

  test("every feature a cross-origin frame lacks by default is denied, or kept with its reason", () => {
    const denied = new Set<string>(FRAME_DENIED_FEATURES);
    const unclassified = reference.features
      .filter((each) => each.default === "self" && each.web)
      .map((each) => each.name)
      .filter((name) => !denied.has(name) && !kept(name));
    expect(
      unclassified,
      "deny each (FRAME_DENIED_FEATURES) or keep it here with its reason",
    ).toEqual([]);
  });

  test("the list is sorted and has no repeats", () => {
    expect([...FRAME_DENIED_FEATURES]).toEqual([...new Set(FRAME_DENIED_FEATURES)].sort());
  });
});
