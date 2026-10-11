/**
 * Names for content origins a host chooses itself (P047): flat labels like `a-<id>` under a
 * shared content domain, next to other servers' namespaces (`<instance>.f.<domain>`).
 */

/** One lowercase DNS label (a-z 0-9 -, at most 63, no hyphen at either end). */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * Whether a label is one a host may name a content origin with: one lowercase DNS label, and not
 * of the form IDNA reserves (`xn--`, any `??--`), so a name never displays as something else.
 */
export function isHostLabel(label: unknown): label is string {
  return typeof label === "string" && DNS_LABEL.test(label) && label.slice(2, 4) !== "--";
}

const PREFIX = /^[a-z][a-z0-9]{0,15}-$/u;
const ID = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u;

/**
 * A naming for `content.name` that puts each scope on `<prefix><scope>` (`prefixedName("a-")`:
 * scope `k3x9` is served on `a-k3x9.<domain>`). One-to-one, so no two scopes share an origin, and
 * no name it makes is a reserved one or a keyed default (those have no hyphen). Scopes must
 * already be label-safe (lowercase letters, digits, inner hyphens); anything else throws rather
 * than being folded into another scope's name.
 */
export function prefixedName(prefix: string): (scope: string) => string {
  if (!PREFIX.test(prefix)) {
    throw new TypeError(
      "A name prefix is a lowercase letter, then letters or digits, then '-' (a-)",
    );
  }
  return (scope) => {
    const label = `${prefix}${scope}`;
    if (!ID.test(scope) || !isHostLabel(label)) {
      throw new TypeError(
        `Scope ${JSON.stringify(scope)} can't be named under ${prefix}: lowercase letters, digits and inner hyphens, ${63 - prefix.length} at most`,
      );
    }
    return label;
  };
}
