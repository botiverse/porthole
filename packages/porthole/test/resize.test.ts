import { afterEach, describe, expect, test } from "vitest";
import { createHost, presets, type DisplayHandle, type PlatformHost } from "../src/index.ts";

/**
 * P127 (audit 2026-10-29, C-1): `resize` has no gate, so the host takes a frame's size at most once
 * an animation frame, and only when it changed. On `createHost` over a stand-in platform whose
 * animation frames the test runs.
 */

const mounted: DisplayHandle[] = [];
afterEach(() => {
  for (const display of mounted.splice(0)) {
    display.destroy();
  }
});

function show() {
  const listeners = new Set<(message: unknown) => void>();
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const heights: number[] = [];
  const platform: PlatformHost = {
    name: "stand-in",
    createSurface: () => ({
      transport: {
        send: () => {},
        listen: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: () => listeners.clear(),
      },
      element: null,
      setHeight: (px) => heights.push(px),
      setColorScheme: () => {},
      userActivation: () => undefined,
      onNavigated: () => () => {},
      onLoad: () => () => {},
      destroy: () => {},
    }),
  };
  const container = {
    ownerDocument: {
      defaultView: {
        location: { origin: "https://app.example" },
        navigator: { language: "en" },
        requestAnimationFrame: (run: () => void) => {
          nextFrame += 1;
          frames.set(nextFrame, run);
          return nextFrame;
        },
        cancelAnimationFrame: (id: number) => frames.delete(id),
      },
    },
    getBoundingClientRect: () => ({ width: 600 }),
  } as unknown as HTMLElement;
  const display = createHost(presets.inlineWidget(), { platform }).mount(container, {
    displayId: "d1",
    title: "Chart",
    scheme: "light",
  });
  mounted.push(display);
  const resized: { height: number; width?: number }[] = [];
  display.on("resize", (size) => resized.push(size));
  return {
    display,
    heights,
    resized,
    frames,
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    size(height: number, width?: number) {
      for (const listener of listeners) {
        listener({
          jsonrpc: "2.0",
          method: "ui/notifications/size-changed",
          params: { height, ...(width === undefined ? {} : { width }) },
        });
      }
    },
    nextFrame() {
      const due = [...frames.values()];
      frames.clear();
      due.forEach((run) => run());
    },
  };
}

describe("a frame's size (P127)", () => {
  test("many sizes in one animation frame are one: the last", async () => {
    const t = show();
    for (let each = 0; each < 1_000; each += 1) {
      t.size(100 + (each % 2) * 300);
    }
    t.size(240, 300);
    await t.settle();
    expect(t.resized).toEqual([]);
    expect(t.frames.size).toBe(1);
    t.nextFrame();
    expect(t.resized).toEqual([{ height: 240, width: 300 }]);
    expect(t.heights).toEqual([240]);
  });

  test("a size the same as the last one shown is dropped; a new one is taken", async () => {
    const t = show();
    t.size(240);
    await t.settle();
    t.nextFrame();
    t.size(240);
    await t.settle();
    t.nextFrame();
    t.size(260);
    await t.settle();
    t.nextFrame();
    expect(t.resized).toEqual([{ height: 240 }, { height: 260 }]);
    expect(t.heights).toEqual([240, 260]);
  });

  test("a run started again tells its size again, and a frame still waiting is dropped", async () => {
    const t = show();
    t.size(240);
    await t.settle();
    t.nextFrame();
    t.size(400);
    await t.settle();
    t.display.reload();
    expect(t.frames.size).toBe(0);
    t.size(240);
    await t.settle();
    t.nextFrame();
    expect(t.resized).toEqual([{ height: 240 }, { height: 240 }]);
  });
});
