import { expect, test } from "@playwright/test";

/**
 * The host's rule on a nested page's shell's activation and the person's keys (P122), driven
 * directly in the browser's own event loop, as nested.spec.ts drives the stall rule. Its own file:
 * the cases where a page takes the keyboard while the person types (nested.spec.ts's timer case,
 * nested-keyboard.spec.ts) stand on the same rule, but by a race with the shell's answer, so
 * they are no control's probes; this case is `key-press`'s.
 */

test.use({ trace: "off" });

test.describe("a nested page (P111)", () => {
  test("an activation that turned on within 250 ms of the person's key on the host's page is no gesture, where the pointer is never seen too (P122)", async ({
    page,
  }) => {
    // The host's rule, driven directly (as above), on a page whose host never saw the pointer over
    // a frame (as full Chromium never does): no press of the person's comes that soon after their
    // key, so it is their next key landing in the page.
    await page.goto("/");
    const rule = await page.evaluate(async (module) => {
      const { focusGuard } = (await import(module)) as {
        focusGuard: (view: Window) => {
          add(frame: HTMLIFrameElement, taken: () => void, options: { nested: boolean }): void;
          shell(
            frame: HTMLIFrameElement,
            said: { supported: boolean; ago: number | null; focused: boolean; gap: number },
          ): void;
          beat(frame: HTMLIFrameElement): void;
          gesture(frame: HTMLIFrameElement): boolean;
        };
      };
      const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
      const guard = focusGuard(window);
      const frameAt = () => {
        const frame = document.createElement("iframe");
        document.body.append(frame);
        guard.add(frame, () => {}, { nested: true });
        guard.shell(frame, { supported: true, ago: null, focused: false, gap: 16 });
        return frame;
      };
      const soon = frameAt();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      await wait(30);
      guard.beat(soon);
      guard.shell(soon, { supported: true, ago: 0, focused: true, gap: 16 });
      const afterKey = guard.gesture(soon);
      // The person's key on the host's page after they pressed the page, before the shell's word
      // came, says nothing of that press (after CI).
      const late = frameAt();
      await wait(1_100);
      const pressedAt = performance.now();
      await wait(40);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
      guard.beat(late);
      guard.shell(late, {
        supported: true,
        ago: Math.round(performance.now() - pressedAt),
        focused: true,
        gap: 16,
      });
      const keyAfter = guard.gesture(late);
      return { afterKey, keyAfter };
    }, "/src/platform/focus-guard.ts");
    expect(
      rule.afterKey,
      "probe: an activation 30 ms after the person's key on the host's page is no gesture",
    ).toBe(false);
    expect(
      rule.keyAfter,
      "a key typed after the press, before the shell's word, changes nothing",
    ).toBe(true);
  });
});
