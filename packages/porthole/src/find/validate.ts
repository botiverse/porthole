import { parseRect } from "../annotate/validate.ts";
import {
  FIND_LIMITS as LIMITS,
  type FindDirection,
  type FindOptions,
  type FindReport,
  type FindResult,
} from "./types.ts";

/**
 * The host's checks on find in page (P131): what it sends (a query and its options) and what a
 * frame says back. A frame's word is rebuilt from known fields only, within `FIND_LIMITS`, and is
 * null for anything else: dropped whole, never repaired.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const whole = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

/** An answer to `porthole/find.query`, or an `updated`'s numbers; null if malformed. */
export function parseFindResult(value: unknown): FindResult | null {
  if (!isRecord(value)) {
    return null;
  }
  const { total, active, capped, rect } = value;
  if (!whole(total, LIMITS.matches) || !whole(active, total)) {
    return null;
  }
  if ((total === 0) !== (active === 0)) {
    return null;
  }
  if (capped !== undefined && capped !== true && capped !== false) {
    return null;
  }
  // Capped only at the limit: fewer matches were all of them.
  if (capped === true && total !== LIMITS.matches) {
    return null;
  }
  const box = rect === undefined || active === 0 ? undefined : parseRect(rect);
  if (box === null) {
    return null;
  }
  return {
    total,
    active,
    ...(capped === true ? { capped: true as const } : {}),
    ...(box === undefined ? {} : { rect: box }),
  };
}

/** A report from the frame, checked; null if malformed (it is then dropped). */
export function parseFindReport(value: unknown): FindReport | null {
  if (!isRecord(value)) {
    return null;
  }
  switch (value.type) {
    case "requested":
      return { type: "requested" };
    case "updated": {
      // No box: where the current match is goes only with an answer to the host's own query.
      const { rect: _rect, ...numbers } = value;
      const result = parseFindResult(numbers);
      return result === null ? null : { type: "updated", ...result };
    }
    default:
      return null;
  }
}

const DIRECTIONS: readonly FindDirection[] = ["next", "prev", "none"];

/**
 * A query and its options as the host gives them, checked before they go to the frame; throws a
 * `TypeError` for a query that isn't text, is longer than `FIND_LIMITS.query`, or options that
 * aren't these. The query goes as it is (the shell trims it and loosens its spacing).
 */
export function checkFindQuery(
  query: unknown,
  options: FindOptions | undefined,
): { query: string; direction: FindDirection; caseSensitive: boolean } {
  if (typeof query !== "string" || query.length > LIMITS.query) {
    throw new TypeError(`find.query: the query is text, at most ${LIMITS.query} characters`);
  }
  if (options !== undefined && !isRecord(options)) {
    throw new TypeError("find.query: options are { direction?, caseSensitive? }");
  }
  const direction: unknown = options?.direction ?? "none";
  if (!(DIRECTIONS as readonly unknown[]).includes(direction)) {
    throw new TypeError('find.query: direction is "next", "prev" or "none"');
  }
  const caseSensitive: unknown = options?.caseSensitive ?? false;
  if (typeof caseSensitive !== "boolean") {
    throw new TypeError("find.query: caseSensitive is true or false");
  }
  return { query, direction: direction as FindDirection, caseSensitive };
}

/** Whether a query finds nothing by its words alone: empty, or only spaces (it clears). */
export const blankQuery = (query: string): boolean => query.trim() === "";
