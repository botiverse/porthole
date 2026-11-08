import {
  ANNOTATION_LIMITS as LIMITS,
  type AnchorResult,
  type AnnotateMode,
  type AnnotationAnchor,
  type AnnotationMark,
  type AnnotationRect,
  type AnnotationReport,
  type AnnotationScroll,
  type AnnotationSelector,
  type AnnotationTrackTarget,
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
 * How far the document is scrolled (P132): two finite numbers within the coordinate limit (either
 * may be negative: an engine's overscroll); null for anything else.
 */
export function parseScroll(value: unknown): AnnotationScroll | null {
  if (!isRecord(value) || !coordinate(value.x) || !coordinate(value.y)) {
    return null;
  }
  return { x: value.x, y: value.y };
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

/**
 * Whether a box the frame reported overlaps the frame's viewport (P138), before it is clamped: a
 * box of no width or height counts where it lies strictly inside. Where the viewport isn't known,
 * nothing is in it, as `clampRect` puts every box at the corner then.
 */
export function inViewport(
  rect: AnnotationRect,
  viewport: { readonly width: number; readonly height: number } | null | undefined,
): boolean {
  if (viewport === null || typeof viewport !== "object") {
    return false;
  }
  const { width, height } = viewport;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return false;
  }
  return rect.x < width && rect.x + rect.width > 0 && rect.y < height && rect.y + rect.height > 0;
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
    // Where it is in the document (P132): a box as `rect` is, never clamped.
    const documentRect = each.documentRect === undefined ? undefined : parseRect(each.documentRect);
    // Where its last line is in the document (P133), as `documentRect` is.
    const lastLineDocumentRect =
      each.lastLineDocumentRect === undefined ? undefined : parseRect(each.lastLineDocumentRect);
    if (rect === null || documentRect === null || lastLineDocumentRect === null) {
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
      ...(documentRect === undefined ? {} : { documentRect }),
      ...(lastLineDocumentRect === undefined ? {} : { lastLineDocumentRect }),
      ...(order === undefined ? {} : { order }),
    });
  }
  return out;
}

/**
 * A last line with nothing to read it by (P137): its place in the frame's viewport is its own less
 * the scroll it was read at, so a shell sends no last line without one, and a host needn't test for
 * both. The scroll alone is a shell's own: 0.14.10's `tracked` and `anchored` (P132, no last line yet),
 * and a newer one's where nothing of the mark is drawn.
 */
const lineWithoutScroll = (line: AnnotationRect | undefined, scroll: unknown): boolean =>
  line !== undefined && scroll === undefined;

/** A report from the frame, checked; null if malformed (it is then dropped). */
export function parseReport(value: unknown): AnnotationReport | null {
  if (!isRecord(value)) {
    return null;
  }
  switch (value.type) {
    case "selected": {
      const anchor = parseAnchor(value.anchor);
      const rect = parseRect(value.rect);
      // A newer shell's (P133): where its last line is in the document, and how far it is scrolled.
      const lastLineDocumentRect =
        value.lastLineDocumentRect === undefined
          ? undefined
          : parseRect(value.lastLineDocumentRect);
      const scroll = value.scroll === undefined ? undefined : parseScroll(value.scroll);
      if (anchor === null || rect === null || lastLineDocumentRect === null || scroll === null) {
        return null;
      }
      // A pair, here (P137): a selection has never had one without the other.
      if ((lastLineDocumentRect === undefined) !== (scroll === undefined)) {
        return null;
      }
      return {
        type: "selected",
        anchor,
        rect,
        ...(lastLineDocumentRect === undefined ? {} : { lastLineDocumentRect }),
        ...(scroll === undefined ? {} : { scroll }),
      };
    }
    case "unselected":
      return { type: "unselected" };
    case "cancelled":
      return { type: "cancelled" };
    case "anchored": {
      const checked = results(value.results);
      const scroll = value.scroll === undefined ? undefined : parseScroll(value.scroll);
      if (
        checked === null ||
        scroll === null ||
        checked.some((each) => lineWithoutScroll(each.lastLineDocumentRect, scroll))
      ) {
        return null;
      }
      return { type: "anchored", results: checked, ...(scroll === undefined ? {} : { scroll }) };
    }
    case "activated": {
      const rect = parseRect(value.rect);
      return !markId(value.id) || rect === null ? null : { type: "activated", id: value.id, rect };
    }
    case "tracked": {
      const rect = parseRect(value.rect);
      // A newer shell's (P132): where the mark is in the document, and how far it is scrolled.
      const documentRect =
        value.documentRect === undefined ? undefined : parseRect(value.documentRect);
      const lastLineDocumentRect =
        value.lastLineDocumentRect === undefined
          ? undefined
          : parseRect(value.lastLineDocumentRect);
      const scroll = value.scroll === undefined ? undefined : parseScroll(value.scroll);
      if (
        !markId(value.id) ||
        rect === null ||
        documentRect === null ||
        lastLineDocumentRect === null ||
        scroll === null ||
        lineWithoutScroll(lastLineDocumentRect, scroll)
      ) {
        return null;
      }
      return {
        type: "tracked",
        id: value.id,
        rect,
        ...(documentRect === undefined ? {} : { documentRect }),
        ...(lastLineDocumentRect === undefined ? {} : { lastLineDocumentRect }),
        ...(scroll === undefined ? {} : { scroll }),
      };
    }
    case "selectionTracked": {
      // The followed selection (P138): gone, or where it is. New with its shell, so every box but
      // the last line, and the scroll, are there; nothing about the page's words is.
      if (value.state === "orphaned") {
        return { type: "selectionTracked", state: "orphaned" };
      }
      if (value.state !== "attached" || typeof value.inView !== "boolean") {
        return null;
      }
      const rect = parseRect(value.rect);
      const documentRect = parseRect(value.documentRect);
      const scroll = parseScroll(value.scroll);
      const lastLineDocumentRect =
        value.lastLineDocumentRect === undefined
          ? undefined
          : parseRect(value.lastLineDocumentRect);
      if (
        rect === null ||
        documentRect === null ||
        scroll === null ||
        lastLineDocumentRect === null
      ) {
        return null;
      }
      return {
        type: "selectionTracked",
        state: "attached",
        rect,
        documentRect,
        ...(lastLineDocumentRect === undefined ? {} : { lastLineDocumentRect }),
        scroll,
        inView: value.inView,
      };
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

/**
 * Whether what `annotations.track` is given names the selection (P138): an object whose own
 * `selection` is `true`, and nothing else does (a mark's id is a string).
 */
export const followsSelection = (
  target: AnnotationTrackTarget | undefined,
): target is { readonly selection: true } =>
  typeof target === "object" &&
  target !== null &&
  Object.hasOwn(target, "selection") &&
  // A caller's word, untyped as JavaScript passes it: `true` and nothing else.
  (target as { readonly selection?: unknown }).selection === true;
