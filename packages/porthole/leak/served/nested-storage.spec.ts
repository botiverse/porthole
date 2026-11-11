import { expect, test } from "@playwright/test";
import { seen, show, unique } from "./nested-pages.ts";

/**
 * A nested page's kept storage (P149): its scope's own `localStorage`, kept for it by the store
 * (a document of Porthole's own on the scope's origin), reached over a channel its shell hands
 * out. The page says what it reads over the console. Untraced, as nested.spec.ts.
 */
test.use({ trace: "off" });

const KEPT = "artifactNestedKept" as const;

test.describe("a nested page's kept storage (P149)", () => {
  test.setTimeout(90_000);

  test("a value the page wrote is there at its next load, and the host hears that this load's storage is kept", async ({
    page,
  }) => {
    const scope = unique("kept");
    const script = `say("had", { value: localStorage.getItem("k"), length: localStorage.length });
      localStorage.setItem("k", "v1");
      say("wrote", { value: localStorage.getItem("k") });`;
    const first = await show(page, script, undefined, {}, scope, KEPT);
    await expect.poll(() => first.said.find((each) => each.type === "wrote")?.value).toBe("v1");
    expect(first.said.find((each) => each.type === "had")?.value, "nothing kept yet").toBeNull();
    await expect.poll(async () => (await seen(page)).storage).toEqual([true]);
    expect((await seen(page)).kept, "probe: this load's storage is kept").toEqual([true]);
    // The write has to reach the store before the page goes.
    await page.waitForTimeout(500);
    const second = await show(page, script, undefined, {}, scope, KEPT);
    await expect.poll(() => second.said.some((each) => each.type === "wrote")).toBe(true);
    expect(
      second.said.find((each) => each.type === "had")?.value,
      "probe: the next load read what the last one wrote",
    ).toBe("v1");
  });
});
