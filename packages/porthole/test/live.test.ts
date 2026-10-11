import { describe, expect, test } from "vitest";
import { admitFrame, createLiveFrames } from "../src/react/live.ts";

describe("admitFrame", () => {
  test("admits under the most, and moves a frame admitted again to the end", () => {
    expect(admitFrame([], new Set(), "a", 3)).toEqual(["a"]);
    expect(admitFrame(["a", "b"], new Set(), "a", 3)).toEqual(["b", "a"]);
  });

  test("past the most, the frames off screen stop first, oldest first", () => {
    expect(admitFrame(["a", "b", "c"], new Set(["a", "c"]), "d", 3)).toEqual(["a", "c", "d"]);
    expect(admitFrame(["a", "b", "c"], new Set(["b"]), "d", 2)).toEqual(["b", "d"]);
  });

  test("when every frame is near, the oldest stops; the admitted one always runs", () => {
    expect(admitFrame(["a", "b"], new Set(["a", "b", "c"]), "c", 2)).toEqual(["b", "c"]);
    expect(admitFrame(["a"], new Set(), "b", 0)).toEqual(["b"]);
  });
});

describe("createLiveFrames", () => {
  test("tracks waiting, running and stopped, and tells subscribers", () => {
    const live = createLiveFrames();
    let told = 0;
    live.subscribe(() => (told += 1));
    expect(live.state("a")).toBe("waiting");
    live.admit("a", 1);
    expect(live.state("a")).toBe("running");
    live.admit("b", 1);
    expect([live.state("a"), live.state("b")]).toEqual(["stopped", "running"]);
    live.release("b");
    expect(live.state("b")).toBe("waiting");
    expect(told).toBe(3);
  });
});
