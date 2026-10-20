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

/** An anchor, rebuilt from its known fields; null if any part is malformed or too large. */
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
  return { kind: value.kind, selectors, label: value.label };
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
    out.push({ id: each.id, state: "attached", ...(rect === undefined ? {} : { rect }) });
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
    default:
      return null;
  }
}

/** What the host may start with: elements, text, or both (default both). */
export function annotateMode(mode: AnnotateMode | undefined): Required<AnnotateMode> {
  const elements = mode?.elements ?? true;
  const words = mode?.text ?? true;
  if (typeof elements !== "boolean" || typeof words !== "boolean" || (!elements && !words)) {
    throw new TypeError("annotations.start: elements, text, or both");
  }
  return { elements, text: words };
}

/** The host's marks, checked before they go to the frame; throws on the first bad one. */
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
    if (mark.count !== undefined && !count(mark.count, LIMITS.count)) {
      throw new TypeError(
        `annotations.show: mark ${index}'s count is a whole number from 0 to ${LIMITS.count}`,
      );
    }
    seen.add(mark.id);
    return { id: mark.id, anchor, ...(mark.count === undefined ? {} : { count: mark.count }) };
  });
}
