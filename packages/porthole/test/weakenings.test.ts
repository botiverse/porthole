import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { WEAKENINGS } from "../leak/weakenings.ts";

/**
 * Every negative control (P032) still finds the text it takes out: a control that matched nothing
 * would weaken nothing, and its probes would pass for the wrong reason.
 */
describe("the negative controls", () => {
  for (const [name, weakening] of Object.entries(WEAKENINGS)) {
    if (typeof weakening !== "object") {
      continue;
    }
    test(`${name} still matches its source`, () => {
      for (const edit of weakening) {
        const text = readFileSync(path.join(import.meta.dirname, "..", edit.file), "utf8");
        expect(text.includes(edit.find), `${name}: ${edit.file}`).toBe(true);
      }
    });
  }
});
