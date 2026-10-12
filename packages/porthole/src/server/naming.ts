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
/**
 * How scopes are named (`ContentDomain.name`). A naming that can say which scope a label names
 * (`scopeOf`) gives every scope clean addresses a redirect entry can open (P068).
 */
export interface Naming {
  (scope: string): string;
  /** The scope a label names, or null for a label this naming never makes. */
  readonly scopeOf?: (label: string) => string | null;
}

export function prefixedName(prefix: string): Naming & {
  readonly scopeOf: (label: string) => string | null;
} {
  if (!PREFIX.test(prefix)) {
    throw new TypeError(
      "A name prefix is a lowercase letter, then letters or digits, then '-' (a-)",
    );
  }
  const name = (scope: string): string => {
    const label = `${prefix}${scope}`;
    if (!ID.test(scope) || !isHostLabel(label)) {
      throw new TypeError(
        `Scope ${JSON.stringify(scope)} can't be named under ${prefix}: lowercase letters, digits and inner hyphens, ${63 - prefix.length} at most`,
      );
    }
    return label;
  };
  const scopeOf = (label: string): string | null => {
    if (!label.startsWith(prefix)) {
      return null;
    }
    const scope = label.slice(prefix.length);
    return ID.test(scope) && isHostLabel(label) ? scope : null;
  };
  return Object.assign(name, { scopeOf });
}

const PREFIX_ENTRY = /^[a-z0-9]([a-z0-9-]{0,61})?\*$/u;

/**
 * Whether a label is reserved (`ContentDomain.reserved`): a whole label, a prefix ending in `*`
 * (`p-*`), or the host's own function. Entries are checked once, here; a function that throws
 * reserves the label (fail closed: the request goes to the host's routes, never served as ours).
 */
export function reservedLabels(
  reserved: readonly string[] | ((label: string) => boolean) | undefined,
): (label: string) => boolean {
  if (reserved === undefined) {
    return () => false;
  }
  if (typeof reserved === "function") {
    return (label) => {
      try {
        return reserved(label);
      } catch {
        return true;
      }
    };
  }
  if (!Array.isArray(reserved)) {
    throw new TypeError("content.reserved: a list of labels and prefixes, or a function");
  }
  const whole = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of reserved) {
    if (typeof entry === "string" && PREFIX_ENTRY.test(entry)) {
      prefixes.push(entry.slice(0, -1));
    } else if (isHostLabel(entry)) {
      whole.add(entry);
    } else {
      throw new TypeError(
        `content.reserved: ${JSON.stringify(entry)} is not a lowercase DNS label or a prefix ending in *`,
      );
    }
  }
  return (label) => whole.has(label) || prefixes.some((prefix) => label.startsWith(prefix));
}
