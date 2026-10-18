/**
 * Viewer levels (P087): who the person viewing a display is to it, in the host's words, which
 * decides each capability method's audience. Ordered: `view` (see it, comment) < `interact` (use
 * what the page does: write its data, ask the agent) < `admin` (publish its versions, manage its
 * assets) < `owner`. The host says a viewer's level (its access, per request); Porthole carries it
 * and refuses a call whose method needs more, before any handler runs.
 */

export const VIEWER_LEVELS = ["view", "interact", "admin", "owner"] as const;

export type ViewerLevel = (typeof VIEWER_LEVELS)[number];

export function isViewerLevel(value: unknown): value is ViewerLevel {
  return typeof value === "string" && (VIEWER_LEVELS as readonly string[]).includes(value);
}

/** Whether `level` reaches `needed`. */
export function atLeast(level: ViewerLevel, needed: ViewerLevel): boolean {
  return VIEWER_LEVELS.indexOf(level) >= VIEWER_LEVELS.indexOf(needed);
}

/** The higher of two levels. */
export function higher(a: ViewerLevel, b: ViewerLevel): ViewerLevel {
  return atLeast(a, b) ? a : b;
}

/**
 * Who is viewing a display, as the host says (its access at issue, `Grant.level`, or a mount's
 * `viewer`): the level decides what the page may do; `id` and `name` are what the `user`
 * capability tells a page that declares it, and `id` is whose per-user data (`data/users/<id>`)
 * the page reaches. All the host's words, never the content's. `id` is the host's public id for
 * the person (not necessarily the `Grant.viewer` it keeps to itself).
 */
export interface ViewerInfo {
  readonly level: ViewerLevel;
  readonly id?: string;
  readonly name?: string;
}

const MAX_ID = 256;

/** A viewer as the host gave it (possibly over the network: an issue's answer), or null. */
export function parseViewer(value: unknown): ViewerInfo | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { level, id, name } = value as Record<string, unknown>;
  if (!isViewerLevel(level)) {
    return null;
  }
  const text = (each: unknown) =>
    typeof each === "string" && each !== "" && each.length <= MAX_ID && !/[\p{Cc}]/u.test(each);
  if ((id !== undefined && !text(id)) || (name !== undefined && !text(name))) {
    return null;
  }
  return {
    level,
    ...(id === undefined ? {} : { id: id as string }),
    ...(name === undefined ? {} : { name: name as string }),
  };
}
