import { describe, expect, test } from "vitest";
import {
  ACTIVATION_SPAN_MS,
  personMoved,
  takesText,
  TAB_MS,
  type FocusMove,
} from "../src/platform/focus-guard.ts";

/**
 * The focus guard's rule (P109): whether a move of the keyboard from one of the host page's text
 * fields into a display's frame was the person's. The DOM half is held in real browsers
 * (leak/served/runtime.spec.ts "the person at the keyboard").
 */

// The person typed in the composer at 10 s; it got focus at 9 s; the pointer came over the frame at
// 8 s (a selection in it, which opened the composer); the page has activation.
const typing: FocusMove = {
  now: 10_200,
  seen: true,
  pressed: false,
  over: true,
  overSince: 8_000,
  lastKey: { key: "e", at: 10_000 },
  typedAt: 10_000,
  focusedAt: 9_000,
  gestureAt: 10_000,
  activation: true,
  hostMoved: false,
};

describe("personMoved (P109)", () => {
  test("a page's focus() while the person types beside the frame is the page's, on every engine kind", () => {
    expect(personMoved(typing)).toBe(false);
    expect(personMoved({ ...typing, seen: false })).toBe(false);
  });

  test("before the first key: the composer that opened on a selection in the frame keeps focus", () => {
    const opened = { ...typing, lastKey: null, typedAt: -Infinity, gestureAt: -Infinity };
    expect(personMoved(opened)).toBe(false);
    // On Firefox the pointer resting over the frame came over it before the composer had focus.
    expect(personMoved({ ...opened, seen: false })).toBe(false);
  });

  test("a press on the frame: :active where the engine tells the move, the pointer coming over it where it doesn't", () => {
    expect(personMoved({ ...typing, pressed: true })).toBe(true);
    // Firefox: the pointer came over the frame after the person last typed and the field got focus.
    expect(personMoved({ ...typing, seen: false, overSince: 10_100 })).toBe(true);
    expect(personMoved({ ...typing, seen: false, overSince: 10_100, over: false })).toBe(false);
    // :hover alone is no press where the engine tells the move.
    expect(personMoved({ ...typing, overSince: 10_100 })).toBe(false);
  });

  test("a Tab just before, and the host's own move", () => {
    expect(personMoved({ ...typing, lastKey: { key: "Tab", at: 10_100 } })).toBe(true);
    expect(personMoved({ ...typing, lastKey: { key: "Tab", at: 10_200 - TAB_MS - 1 } })).toBe(
      false,
    );
    expect(personMoved({ ...typing, hostMoved: true })).toBe(true);
  });

  test("a gesture the host's own events don't explain: activation with no gesture of its own and the field focused for longer than activation lasts", () => {
    const later = 10_000 + ACTIVATION_SPAN_MS + 1;
    expect(personMoved({ ...typing, now: later, lastKey: null })).toBe(true);
    expect(personMoved({ ...typing, now: later, lastKey: null, activation: false })).toBe(false);
    expect(personMoved({ ...typing, now: later, lastKey: null, activation: undefined })).toBe(
      false,
    );
    // The field got focus within that time: the activation may be the gesture that opened it.
    expect(personMoved({ ...typing, now: later, lastKey: null, focusedAt: later - 100 })).toBe(
      false,
    );
  });
});

describe("takesText", () => {
  const element = (localName: string, extra: Record<string, unknown> = {}) =>
    ({ localName, ...extra }) as unknown as Element;

  test("text areas, text-taking inputs and editable regions; not buttons, checkboxes or frames", () => {
    expect(takesText(element("textarea"))).toBe(true);
    for (const type of ["text", "search", "url", "tel", "email", "password", "number"]) {
      expect(takesText(element("input", { type })), type).toBe(true);
    }
    expect(takesText(element("div", { isContentEditable: true }))).toBe(true);
    expect(takesText(element("input", { type: "checkbox" }))).toBe(false);
    expect(takesText(element("button"))).toBe(false);
    expect(takesText(element("iframe"))).toBe(false);
    expect(takesText(null)).toBe(false);
  });
});
