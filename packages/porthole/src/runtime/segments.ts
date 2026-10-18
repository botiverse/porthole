/** A db path's segment (P088): letters, digits and `_ . ~ : @ + -`, at most 128. */
export const SEGMENT = /^[A-Za-z0-9_.~:@+-]{1,128}$/u;

/**
 * Whether `value` is one path segment: what a viewer's id must be to name their own data
 * (`data/users/<id>`), and never `me`, which names them (after the review: an id `a/b` would
 * reach another person's tree).
 */
export function isDbSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SEGMENT.test(value) &&
    value !== "." &&
    value !== ".." &&
    value !== "me"
  );
}
