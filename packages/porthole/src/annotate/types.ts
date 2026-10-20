/**
 * Annotations (P053): a person points at part of a display (an element, or text they select) to
 * comment on it, and the host marks the anchors already made, each with a clickable marker and a
 * number where it gives a count (P104). The host drives the shell with
 * Porthole's own messages (`porthole/annotate.*`); the shell answers with anchors and where they
 * are. An anchor is a set of W3C Web Annotation selectors, so it can be found again after the
 * content changes; finding it is best-effort, and says so (`orphaned`).
 *
 * Everything the frame reports is the content's word: the shell shares its realm with the
 * content, which can interfere or fake a report. The host checks each report's shape and size
 * and takes reports only while it asked for them. Use them as UI hints (where to draw a comment,
 * what to quote), never as permissions.
 */

/** The element a CSS selector matches (W3C `CssSelector`). */
export interface CssSelector {
  readonly type: "CssSelector";
  readonly value: string;
}

/** Text, with a little of what comes before and after it (W3C `TextQuoteSelector`). */
export interface TextQuoteSelector {
  readonly type: "TextQuoteSelector";
  readonly exact: string;
  readonly prefix?: string;
  readonly suffix?: string;
}

/**
 * Offsets into the document's text: the text of the body's text nodes, in order, without
 * scripts, styles and templates (W3C `TextPositionSelector`).
 */
export interface TextPositionSelector {
  readonly type: "TextPositionSelector";
  readonly start: number;
  readonly end: number;
}

export type AnnotationSelector = CssSelector | TextQuoteSelector | TextPositionSelector;

export interface AnnotationAnchor {
  /** What the person pointed at: an element, or a text selection. */
  readonly kind: "element" | "text";
  /** At most one of each type; tried in turn when the anchor is found again. */
  readonly selectors: readonly AnnotationSelector[];
  /** A short description for the host to show ("h2#revenue Revenue grew 12%"); the content's. */
  readonly label: string;
}

/**
 * A box in the frame's viewport, CSS px: add the frame element's position to place it on the page.
 * The page's word: the host clamps each it reports to the frame's viewport (P104), so one wholly
 * outside is a box of no size on the nearest edge. A positioning hint only.
 */
export interface AnnotationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What the person may point at while the host is asking. */
export interface AnnotateMode {
  /** Elements, picked with a click or tap (the one under the pointer is outlined); one pick. */
  readonly elements?: boolean;
  /** Text, by selecting it: each settled selection is reported, and its clearing. */
  readonly text?: boolean;
}

/**
 * An anchor the host marks in the frame, under its own id. Everything here is sent into the
 * frame, so the content can read it: give ids that say nothing (never a person's name or the
 * comment's words).
 */
export interface AnnotationMark {
  readonly id: string;
  readonly anchor: AnnotationAnchor;
  /**
   * A marker (P104): with a count, the shell also draws a small bubble with this number (0 to
   * `ANNOTATION_LIMITS.count`; above 99 it reads "99+", 0 draws the bubble alone) at the end of a
   * text anchor and the top right of an element. The person can click it: the frame reports
   * `activated`. The content can read the number; give one only where the page may know it.
   */
  readonly count?: number;
}

/** Whether a mark's anchor was found in the content as it is now. */
export type AnchorState = "attached" | "orphaned";

export interface AnchorResult {
  readonly id: string;
  readonly state: AnchorState;
  /** Where it is now, when attached. */
  readonly rect?: AnnotationRect;
}

/** What the frame reports, once the host has checked it. */
export type AnnotationReport =
  /** The person pointed at an element or settled a text selection. */
  | {
      readonly type: "selected";
      readonly anchor: AnnotationAnchor;
      readonly rect: AnnotationRect;
    }
  /** The text selection went away. */
  | { readonly type: "unselected" }
  /** The person pressed Escape while picking an element. */
  | { readonly type: "cancelled" }
  /**
   * Where the marked anchors are now: every mark after `show`, the focused one after `focus`,
   * every mark when the content changed one's state, and, while any mark has a `count`, once a
   * scroll, a resize or a change of the content has settled, only the marks that moved since the
   * host was last told, at most once a second (P104).
   */
  | { readonly type: "anchored"; readonly results: readonly AnchorResult[] }
  /**
   * The person clicked the marker of a mark the host shows with a `count` (P104); `rect` is the
   * marker's box, to open the host's own UI beside it. The content can fake it for any mark the
   * host shows with a count, and can tell a real one happened: open the host's own view of that
   * mark, never act on it.
   */
  | { readonly type: "activated"; readonly id: string; readonly rect: AnnotationRect };

/** Porthole's own messages for annotations (own-prefixed, P002). */
export const ANNOTATE_METHODS = {
  /** Host → frame: let the person point (`AnnotateMode`). */
  start: "porthole/annotate.start",
  /** Host → frame: stop. */
  stop: "porthole/annotate.stop",
  /** Host → frame: mark these anchors (replacing what was marked). */
  show: "porthole/annotate.show",
  /** Host → frame: bring one mark into view and make it the active one. */
  focus: "porthole/annotate.focus",
  /** Host → frame: remove every mark. */
  clear: "porthole/annotate.clear",
  /** Frame → host. */
  selected: "porthole/annotate.selected",
  unselected: "porthole/annotate.unselected",
  cancelled: "porthole/annotate.cancelled",
  anchored: "porthole/annotate.anchored",
  /** Frame → host: a mark's marker was clicked (P104). */
  activated: "porthole/annotate.activated",
} as const;

/** The most of each part of an anchor or report the host takes. */
export const ANNOTATION_LIMITS = {
  label: 120,
  cssSelector: 1_000,
  exact: 4_000,
  context: 64,
  /** The most marks one `show` carries, and results one report. */
  marks: 500,
  id: 128,
  position: 50_000_000,
  coordinate: 10_000_000,
  /** The largest `count` a mark's marker takes (P104). */
  count: 999,
} as const;
