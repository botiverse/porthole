import type { AnnotationRect } from "../annotate/types.ts";

/**
 * Find in page (P131): the host draws its own find bar (a query box, previous and next, "3/12")
 * and the shell finds the query in the content's text and highlights it, the current match apart,
 * in a layer of its own. The host drives it with Porthole's own messages (`porthole/find.*`); the
 * shell answers how many matches there are and which is current.
 *
 * Everything the frame says is the content's word: the shell shares its realm with the content,
 * which can read the query, change the count or hide the highlights. Use what it says for the
 * find bar (a count, where the current match is), never as a fact about the content.
 */

/** Which match becomes the current one: the next, the previous, or the same (a new query: the first in view). */
export type FindDirection = "next" | "prev" | "none";

export interface FindOptions {
  /** Default `"none"`: a new query's first match at or after where the person is reading. */
  readonly direction?: FindDirection;
  /** Default false: case-insensitive, as a browser's own find is. */
  readonly caseSensitive?: boolean;
}

/**
 * Where the matches stand. The content's word: a count for the find bar, nothing more.
 */
export interface FindResult {
  /** How many matches, at most `FIND_LIMITS.matches`. */
  readonly total: number;
  /** The current match, from 1; 0 when there is none. */
  readonly active: number;
  /** There may be more than `total`: the shell stopped at `FIND_LIMITS.matches` ("1000+"). */
  readonly capped?: true;
  /**
   * The current match's box in the frame's viewport, once it was scrolled into view, clamped to
   * the frame's viewport as an annotation's box is (P104): for a host whose frame doesn't scroll
   * itself (a display that grows with its content) to scroll its own page to it. A hint only.
   */
  readonly rect?: AnnotationRect;
}

/** What the frame says unasked, once the host has checked it. */
export type FindReport =
  /**
   * The person pressed Cmd+F (Apple) or Ctrl+F (elsewhere) with the keyboard in the frame, and the
   * page didn't take the key itself. Sent only while the host takes the shortcut
   * (`find.takeShortcut(true)`), which also stops the browser's own find. The page's word too: it
   * can send it, or keep the key from the shell. Open the host's find bar, nothing more.
   */
  | { readonly type: "requested" }
  /**
   * The matches changed while a query is shown, without the host asking: the content changed, or
   * a new frame of the display (a reload) found the query again. At most once a second.
   */
  | ({ readonly type: "updated" } & FindResult);

/** Porthole's own messages for find in page (own-prefixed, P002). */
export const FIND_METHODS = {
  /**
   * Host → frame, a request: `{ query, direction?, caseSensitive? }`, answered with a
   * `FindResult`. An empty query (or only spaces) clears, and answers no matches.
   */
  query: "porthole/find.query",
  /** Host → frame: remove the highlights and forget the query. */
  clear: "porthole/find.clear",
  /**
   * Host → frame: `{ handled: boolean }`, whether the host draws its own find bar: while it does,
   * the shell stops the browser's own find on Cmd+F or Ctrl+F in the frame and says `requested`.
   */
  handled: "porthole/find.handled",
  /** Frame → host. */
  requested: "porthole/find.requested",
  updated: "porthole/find.updated",
} as const;

/** The most of each part of a query or an answer. */
export const FIND_LIMITS = {
  /** The longest query, in UTF-16 code units. */
  query: 256,
  /** The most matches the shell finds and highlights; past it the answer says `capped`. */
  matches: 1_000,
  /** How long the host waits for an answer before it calls the display's find unsupported, ms. */
  timeoutMs: 3_000,
} as const;
