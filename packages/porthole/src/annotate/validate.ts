import {
  ANNOTATION_LIMITS as LIMITS,
  type AnchorResult,
  type AnnotateMode,
  type AnnotationAnchor,
  type AnnotationMark,
  type AnnotationRect,
  type AnnotationReport,
  type AnnotationSelector,
} from "./types.ts";
import { withoutUnseen } from "../bridge/unseen.ts";

/**
 * The host's checks on what a frame says about annotations (P053), and on anchors a host stores
 * and sends back. Each rebuilds what it accepts from known fields only, within `ANNOTATION_LIMITS`,
 * and answers null for anything else: a report is dropped whole, never repaired.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown, max: number, min = 0): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max;

const count = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

function selector(value: unknown): AnnotationSelector | null {
  if (!isRecord(value)) {
    return null;
  }
  switch (value.type) {
    case "CssSelector":
      return text(value.value, LIMITS.cssSelector, 1)
        ? { type: "CssSelector", value: value.value }
        : null;
    case "TextQuoteSelector": {
      const { exact, prefix, suffix } = value;
      if (
        !text(exact, LIMITS.exact, 1) ||
        (prefix !== undefined && !text(prefix, LIMITS.context)) ||
        (suffix !== undefined && !text(suffix, LIMITS.context))
      ) {
        return null;
      }
      return {
        type: "TextQuoteSelector",
        exact,
        ...(prefix === undefined || prefix === "" ? {} : { prefix }),
        ...(suffix === undefined || suffix === "" ? {} : { suffix }),
      };
    }
    case "TextPositionSelector":
      return count(value.start, LIMITS.position) &&
        count(value.end, LIMITS.position) &&
        value.start <= value.end
        ? { type: "TextPositionSelector", start: value.start, end: value.end }
        : null;
    default:
      return null;
  }
}

/**
 * An anchor, rebuilt from its known fields; null if any part is malformed or too large. Its label
 * is text for the person, so what they couldn't see is taken out of it (P105: a wordless element's
 * `alt`, `aria-label` or `title`, which the page never shows, can carry bidi controls or zero-width
 * characters); its selectors' words are kept as they are, to be found again.
 */
export function parseAnchor(value: unknown): AnnotationAnchor | null {
  if (!isRecord(value) || (value.kind !== "element" && value.kind !== "text")) {
    return null;
  }
  if (!Array.isArray(value.selectors) || value.selectors.length === 0) {
    return null;
  }
  if (value.selectors.length > 3 || !text(value.label, LIMITS.label)) {
    return null;
  }
  const selectors: AnnotationSelector[] = [];
  for (const each of value.selectors) {
    const parsed = selector(each);
    if (parsed === null || selectors.some((other) => other.type === parsed.type)) {
      return null;
    }
    selectors.push(parsed);
  }
  // A text anchor is found by its words; an element one needs a way to find the element.
  const quote = selectors.some((each) => each.type === "TextQuoteSelector");
  const css = selectors.some((each) => each.type === "CssSelector");
  if (value.kind === "text" ? !quote : !css && !quote) {
    return null;
  }
  return { kind: value.kind, selectors, label: withoutUnseen(value.label) };
}

const coordinate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= LIMITS.coordinate;

/** A box in the frame's viewport; null unless every number is finite and sizes aren't negative. */
export function parseRect(value: unknown): AnnotationRect | null {
  if (!isRecord(value)) {
    return null;
  }
  const { x, y, width, height } = value;
  if (!coordinate(x) || !coordinate(y) || !coordinate(width) || !coordinate(height)) {
    return null;
  }
  if (width < 0 || height < 0) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * A box the frame reported, clamped to the frame's viewport (`width` by `height`, CSS px, P104):
 * each side is held within it, so what overlaps the viewport keeps the part inside, and what lies
 * wholly outside becomes a box of no size on the nearest edge. Where the viewport isn't known, a
 * box of no size at the frame's corner. The page still chooses any point inside its own frame.
 */
export function clampRect(
  rect: AnnotationRect,
  viewport: { readonly width: number; readonly height: number } | null | undefined,
): AnnotationRect {
  const known = viewport !== null && typeof viewport === "object";
  const width = known && Number.isFinite(viewport.width) ? viewport.width : 0;
  const height = known && Number.isFinite(viewport.height) ? viewport.height : 0;
  const within = (value: number, most: number) => Math.min(Math.max(value, 0), Math.max(0, most));
  const left = within(rect.x, width);
  const top = within(rect.y, height);
  const right = within(rect.x + rect.width, width);
  const bottom = within(rect.y + rect.height, height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const markId = (value: unknown): value is string => text(value, LIMITS.id, 1);

function results(value: unknown): AnchorResult[] | null {
  if (!Array.isArray(value) || value.length > LIMITS.marks) {
    return null;
  }
  const out: AnchorResult[] = [];
  for (const each of value) {
    if (!isRecord(each) || !markId(each.id)) {
      return null;
    }
    if (each.state === "orphaned") {
      out.push({ id: each.id, state: "orphaned" });
      continue;
    }
    if (each.state !== "attached") {
      return null;
    }
    const rect = each.rect === undefined ? undefined : parseRect(each.rect);
    if (rect === null) {
      return null;
    }
    // A place among the marks (P112): a whole number below the most marks a show carries.
    const order = each.order;
    if (
      order !== undefined &&
      !(typeof order === "number" && Number.isInteger(order) && order >= 0 && order < LIMITS.marks)
    ) {
      return null;
    }
    out.push({
      id: each.id,
      state: "attached",
      ...(rect === undefined ? {} : { rect }),
      ...(order === undefined ? {} : { order }),
    });
  }
  return out;
}

/** A report from the frame, checked; null if malformed (it is then dropped). */
export function parseReport(value: unknown): AnnotationReport | null {
  if (!isRecord(value)) {
    return null;
  }
  switch (value.type) {
    case "selected": {
      const anchor = parseAnchor(value.anchor);
      const rect = parseRect(value.rect);
      return anchor === null || rect === null ? null : { type: "selected", anchor, rect };
    }
    case "unselected":
      return { type: "unselected" };
    case "cancelled":
      return { type: "cancelled" };
    case "anchored": {
      const checked = results(value.results);
      return checked === null ? null : { type: "anchored", results: checked };
    }
    case "activated": {
      const rect = parseRect(value.rect);
      return !markId(value.id) || rect === null ? null : { type: "activated", id: value.id, rect };
    }
    case "tracked": {
      const rect = parseRect(value.rect);
      return !markId(value.id) || rect === null ? null : { type: "tracked", id: value.id, rect };
    }
    default:
      return null;
  }
}

/** What the host may start with: elements, text, or both (default both). */
export function annotateMode(mode: AnnotateMode | undefined): Required<AnnotateMode> {
  const elements = mode?.elements ?? true;
  const words = mode?.text ?? true;
  if (
    (typeof elements !== "boolean" && elements !== "hold") ||
    typeof words !== "boolean" ||
    (elements === false && !words)
  ) {
    throw new TypeError("annotations.start: elements, text, or both");
  }
  return { elements, text: words };
}

/**
 * Whether a mark gets a marker, the one thing a person can click (P104): one with a `count`, and
 * every draft (P107).
 */
export const hasMarker = (mark: AnnotationMark): boolean =>
  mark.count !== undefined || mark.kind === "draft";

/**
 * The host's marks, checked before they go to the frame; throws on the first bad one (a count above
 * `ANNOTATION_LIMITS.count` isn't bad: it is clamped to it, P116). Each is
 * rebuilt as the frame gets it: a posted mark as 0.10.0 sent it (no `kind`), a draft with
 * `kind: "draft"` and without its count (P107: a draft's marker shows no number, so the page isn't
 * told one).
 */
export function checkMarks(marks: readonly AnnotationMark[]): AnnotationMark[] {
  if (!Array.isArray(marks) || marks.length > LIMITS.marks) {
    throw new TypeError(`annotations.show: at most ${LIMITS.marks} marks`);
  }
  const seen = new Set<string>();
  return marks.map((mark, index) => {
    const anchor = parseAnchor(mark?.anchor);
    if (!markId(mark?.id) || seen.has(mark.id) || anchor === null) {
      throw new TypeError(
        `annotations.show: mark ${index} needs a unique id (1 to ${LIMITS.id} characters) and a valid anchor`,
      );
    }
    // A count above the limit is clamped to it (P116): the marker reads "99+" either way, and a
    // count is data anyone can grow (a thread's replies), so it mustn't reject the whole list.
    if (mark.count !== undefined && !count(mark.count, Infinity)) {
      throw new TypeError(`annotations.show: mark ${index}'s count is a whole number, 0 or more`);
    }
    const kind: unknown = mark.kind;
    if (kind !== undefined && kind !== "posted" && kind !== "draft") {
      throw new TypeError(`annotations.show: mark ${index}'s kind is "posted" or "draft"`);
    }
    seen.add(mark.id);
    if (kind === "draft") {
      return { id: mark.id, anchor, kind };
    }
    return {
      id: mark.id,
      anchor,
      ...(mark.count === undefined ? {} : { count: Math.min(mark.count, LIMITS.count) }),
    };
  });
}
