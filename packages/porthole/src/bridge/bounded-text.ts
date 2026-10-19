import { cutText } from "./navigation.ts";

/**
 * What content said, as text a host can show (S05, P095), at a cost bounded whatever the frame
 * sent. A frame's messages come structured-cloned, which keeps cycles and shared references (13
 * objects each holding the next twice are 2^13 nodes written as a tree) and carries BigInt, Maps
 * and nesting of any depth: `JSON.stringify` throws on the first and the second, and is
 * exponential in the third.
 *
 * A string is as it is, cut. Anything else is written the way JSON writes it, with each object
 * read once (`"[Circular]"` where it is inside itself, `"[Repeated]"` where it was written
 * already), at most `nodes` values (`…` where it stops) and `depth` levels (`"[Object]"`,
 * `"[Array]"` below), a BigInt as `"5n"` (`"[BigInt]"` past 2,000 digits), a Date as its time,
 * an Error as its name and message, any other object as its kind (`"[Map]"`), and anything that
 * throws when read as `"[unreadable]"`. Every cut is `cutText`'s: no part of a sealed address's
 * access is left at one. Never throws.
 */

export interface TextLimits {
  /** The longest the text is. */
  readonly chars: number;
  /** The most values read. */
  readonly nodes: number;
  /** The deepest an object or array is read. */
  readonly depth: number;
}

/** An error report's: read past what the bridge keeps (2,000 characters, after the scrub). */
export const REPORT_TEXT_LIMITS: TextLimits = { chars: 8_000, nodes: 1_000, depth: 16 };

/** The text, and whether it is all of the value (nothing cut, stopped or left below the depth). */
export interface BoundedText {
  readonly text: string;
  readonly whole: boolean;
}

/** A BigInt past this has more digits than a report shows; its decimal text is superlinear. */
const BIGGEST = 10n ** 2_000n;

/** A field whose read threw (a getter, a proxy: what structured clone never delivers). */
const UNREADABLE: unique symbol = Symbol("unreadable");

/** `value` as bounded text (above); with `indent`, as `JSON.stringify(value, null, indent)` lays it out. */
export function boundedText(
  value: unknown,
  limits: TextLimits = REPORT_TEXT_LIMITS,
  indent = 0,
): string {
  return formatBounded(value, limits, indent).text;
}

export function formatBounded(value: unknown, limits: TextLimits, indent = 0): BoundedText {
  if (typeof value === "string") {
    const text = cutText(value, limits.chars);
    return { text, whole: text === value };
  }
  let out = "";
  let nodes = limits.nodes;
  let stopped = false;
  let whole = true;
  const written = new WeakSet<object>();
  const inside = new WeakSet<object>();
  const colon = indent > 0 ? ": " : ":";
  const quoted = (text: string) => {
    const room = Math.max(0, limits.chars - out.length);
    if (text.length > room) {
      whole = false;
    }
    return JSON.stringify(cutText(text, room));
  };
  /** Where a nested value starts, at `depth`: a new line, indented, when laid out. */
  const line = (depth: number) => (indent > 0 ? `\n${" ".repeat(indent * depth)}` : "");

  /** Whether there is room for another value; if not, `…` once (after `separator`), then none. */
  const room = (separator: string): boolean => {
    nodes -= 1;
    if (!stopped && (nodes < 0 || out.length >= limits.chars)) {
      stopped = true;
      whole = false;
      out += `${separator}…`;
    }
    return !stopped;
  };

  /** What JSON leaves out of an object (and writes as null in an array). */
  const unwritten = (each: unknown): boolean =>
    each === undefined || typeof each === "function" || typeof each === "symbol";

  function write(each: unknown, depth: number): void {
    switch (typeof each) {
      case "string":
        out += quoted(each);
        return;
      case "number":
        out += Number.isFinite(each) ? String(each) : "null";
        return;
      case "boolean":
        out += each ? "true" : "false";
        return;
      case "bigint":
        if (each < BIGGEST && each > -BIGGEST) {
          out += `"${String(each)}n"`;
        } else {
          whole = false;
          out += '"[BigInt]"';
        }
        return;
      case "object":
        break;
      default:
        out += "null";
        return;
    }
    if (each === null) {
      out += "null";
      return;
    }
    if (inside.has(each)) {
      out += '"[Circular]"';
      return;
    }
    if (written.has(each)) {
      out += '"[Repeated]"';
      return;
    }
    written.add(each);
    if (Array.isArray(each)) {
      if (depth >= limits.depth) {
        whole = false;
        out += '"[Array]"';
        return;
      }
      const list = each as readonly unknown[];
      inside.add(list);
      out += "[";
      const inner = line(depth + 1);
      for (
        let index = 0;
        index < list.length && room(index === 0 ? inner : `,${inner}`);
        index += 1
      ) {
        out += index === 0 ? inner : `,${inner}`;
        guarded(list[index], depth + 1);
      }
      out += list.length === 0 ? "]" : `${line(depth)}]`;
      inside.delete(list);
      return;
    }
    const kind = Object.prototype.toString.call(each).slice(8, -1);
    const proto: unknown = Object.getPrototypeOf(each);
    if (kind === "Date") {
      const time = Date.prototype.getTime.call(each);
      out += quoted(Number.isFinite(time) ? new Date(time).toISOString() : "Invalid Date");
      return;
    }
    if (kind === "Error") {
      const { name, message } = each as { name?: unknown; message?: unknown };
      out += quoted(
        `${typeof name === "string" ? cutText(name, 100) : "Error"}: ${typeof message === "string" ? cutText(message, limits.chars) : ""}`,
      );
      return;
    }
    if (proto !== Object.prototype && proto !== null) {
      out += quoted(`[${kind}]`);
      return;
    }
    if (depth >= limits.depth) {
      whole = false;
      out += '"[Object]"';
      return;
    }
    inside.add(each);
    out += "{";
    const inner = line(depth + 1);
    let first = true;
    for (const key of Object.keys(each)) {
      if (!room(first ? inner : `,${inner}`)) {
        first = false;
        break;
      }
      let field: unknown;
      try {
        field = (each as Record<string, unknown>)[key];
      } catch {
        field = UNREADABLE;
      }
      if (field !== UNREADABLE && unwritten(field)) {
        continue;
      }
      out += `${first ? inner : `,${inner}`}${quoted(key)}${colon}`;
      first = false;
      guarded(field, depth + 1);
    }
    out += first ? "}" : `${line(depth)}}`;
    inside.delete(each);
  }

  /** One value, or `"[unreadable]"` where reading it throws (a getter, a proxy: never cloned). */
  function guarded(each: unknown, depth: number): void {
    if (each === UNREADABLE) {
      out += '"[unreadable]"';
      return;
    }
    const before = out.length;
    try {
      write(each, depth);
    } catch {
      whole = false;
      out = `${out.slice(0, before)}"[unreadable]"`;
    }
  }

  nodes -= 1;
  guarded(value, 0);
  // Cut past the length, it still ends in `…`.
  const text = out.length <= limits.chars ? out : `${cutText(out, limits.chars - 1)}…`;
  return { text, whole: whole && text === out };
}
