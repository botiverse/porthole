/**
 * JSON data, as a host function carries it to a host's handler and its dialog (P095, after the
 * review): what `callTool`'s arguments, `setModelContext`'s content and a download's contents are
 * in MCP, and what a host forwards to a server or a model as JSON. A frame's messages come
 * structured-cloned, so they can hold what JSON can't say or says otherwise: a cycle, an object
 * reached twice (a graph of 30 is 2^30 nodes as a tree), a BigInt, NaN, a boxed `String` (JSON
 * writes its value; a handler gets an object), a Map, a typed array, a Date.
 *
 * Plain data only: null, booleans, finite numbers, strings, arrays and objects whose prototype is
 * Object's or none, each object reached once (MCP's arguments are JSON: an object in two places is
 * refused, the simple bound), at most `nodes` values (a field left `undefined`, allowed as JSON
 * leaves it out, counts as one), `depth` levels, and `chars` characters of strings and keys
 * together (after the re-review: neither a field without a value nor a long string is free).
 * Each node is visited once: linear in what was sent, stopped at the budget. Never throws (a
 * value whose read throws is no data).
 */

export interface JsonDataLimits {
  readonly nodes: number;
  readonly depth: number;
  /** The characters of every string and every key, together. */
  readonly chars: number;
}

/**
 * A call's: as many values as one db document holds (P091), nested deeper than any real one, and
 * 4 MiB of text.
 */
export const JSON_DATA_LIMITS: JsonDataLimits = { nodes: 100_000, depth: 64, chars: 4_194_304 };

export function isJsonData(value: unknown, limits: JsonDataLimits = JSON_DATA_LIMITS): boolean {
  let nodes = limits.nodes;
  let chars = limits.chars;
  const seen = new WeakSet<object>();
  /** Takes `length` characters from the budget: whether it still holds. */
  const text = (length: number): boolean => {
    chars -= length;
    return chars >= 0;
  };

  function plain(each: unknown, depth: number): boolean {
    nodes -= 1;
    if (nodes < 0 || depth > limits.depth) {
      return false;
    }
    if (typeof each === "string") {
      return text(each.length);
    }
    if (each === null || typeof each === "boolean") {
      return true;
    }
    if (typeof each === "number") {
      return Number.isFinite(each);
    }
    if (typeof each !== "object" || seen.has(each)) {
      return false;
    }
    seen.add(each);
    if (Array.isArray(each)) {
      const list = each as readonly unknown[];
      for (let index = 0; index < list.length; index += 1) {
        if (!plain(list[index], depth + 1)) {
          return false;
        }
      }
      return true;
    }
    const proto: unknown = Object.getPrototypeOf(each);
    if (proto !== Object.prototype && proto !== null) {
      return false;
    }
    for (const key of Object.keys(each)) {
      if (!text(key.length)) {
        return false;
      }
      const field = (each as Record<string, unknown>)[key];
      if (field === undefined) {
        // No value, but a field: it counts.
        nodes -= 1;
        if (nodes < 0) {
          return false;
        }
      } else if (!plain(field, depth + 1)) {
        return false;
      }
    }
    return true;
  }

  try {
    return plain(value, 0);
  } catch {
    return false;
  }
}
