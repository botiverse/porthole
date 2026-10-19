import { atLeast, higher, isViewerLevel, type ViewerInfo, type ViewerLevel } from "./levels.ts";
import { SEGMENT, isDbSegment } from "./segments.ts";

export { isDbSegment };

/**
 * The `db` capability's contract (P088): a document store the host keeps for an artifact, which
 * its page reads and writes as the person viewing it. Porthole checks what crosses the frame (the
 * shape, the sizes, the paths), resolves `me`, keeps a viewer to their own per-user data
 * (`data/users/<id>`), and applies the page's per-level rules; the host stores, versions and
 * evaluates them again on its own side (`dbAccess`), since its API is the wall for its data.
 *
 * Paths are slash-separated: a collection is an odd number of segments (`votes`,
 * `rooms/r1/messages`), a document an even number (`votes/ada`). Every write to a document that
 * exists names the version it read (`ifVersion`); a mismatch is a `conflict`.
 */

export const DB_LIMITS = {
  /** The most a document's data holds, JSON bytes. */
  maxDocBytes: 1_048_576,
  /** The most writes one batch holds, and their bytes together. */
  maxBatchWrites: 50,
  maxBatchBytes: 1_048_576,
  /** The most documents one query answers. */
  maxQueryLimit: 500,
  maxWhere: 10,
  /** The most values an `in` holds. */
  maxIn: 30,
  /** The most segments a path holds (a document: 16; a collection: 15). */
  maxSegments: 16,
  /** The deepest a document's data nests. */
  maxDepth: 32,
  /** The most watches one frame keeps at once. */
  maxWatches: 50,
  /** The most values (objects, arrays, scalars) one document holds, and one batch. */
  maxNodes: 100_000,
  /** The most a `where` operand holds: values, and JSON bytes. */
  maxOperandNodes: 1_000,
  maxOperandBytes: 16_384,
} as const;

/** The per-user subtree: `data/users/<id>/…`, the viewer's own; `me` names the viewer. */
export const DB_USERS_PREFIX = "data/users/";

/** A path's segments, or null for one that names nothing (empty, dot segments, odd characters). */
export function dbSegments(path: unknown): string[] | null {
  if (typeof path !== "string" || path === "" || path.length > 2_048) {
    return null;
  }
  const segments = path.split("/");
  if (
    segments.length > DB_LIMITS.maxSegments ||
    segments.some((each) => !SEGMENT.test(each) || each === "." || each === "..")
  ) {
    return null;
  }
  return segments;
}

/** Whether `path` names a document (`even`) or a collection (`odd`). */
export function dbPathKind(segments: readonly string[]): "doc" | "collection" {
  return segments.length % 2 === 0 ? "doc" : "collection";
}

/** A JSON value Porthole passes on: plain data, no cycles, no deeper than `maxDepth`. */
export type DbValue =
  | null
  | boolean
  | number
  | string
  | readonly DbValue[]
  | { readonly [field: string]: DbValue };

export type DbData = { readonly [field: string]: DbValue };

/** Field names a document never holds: a host merging them could set a prototype (P088). */
const RESERVED_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Whether `value` is plain JSON data within `budget` nodes, no deeper than the limit, with no
 * object or array reached twice (P088, after the review: structured clone keeps shared
 * references, so a walk without this is exponential in a message of a few dozen objects). Each
 * node is visited once: linear in what was sent, and stopped at the budget.
 */
function plainJson(
  value: unknown,
  budget: { nodes: number; readonly seen: WeakSet<object> },
  depth: number,
): boolean {
  budget.nodes -= 1;
  if (budget.nodes < 0 || depth > DB_LIMITS.maxDepth) {
    return false;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (budget.seen.has(value)) {
    return false;
  }
  budget.seen.add(value);
  if (Array.isArray(value)) {
    for (const each of value) {
      if (!plainJson(each, budget, depth + 1)) {
        return false;
      }
    }
    return true;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  for (const field of Object.keys(value)) {
    if (field === "" || field.length > 256 || RESERVED_FIELDS.has(field)) {
      return false;
    }
    if (!plainJson((value as Record<string, unknown>)[field], budget, depth + 1)) {
      return false;
    }
  }
  return true;
}

/** Whether `value` is plain JSON within `nodes` nodes (a document's, a `where` operand's). */
export function isPlainJson(value: unknown, nodes: number = DB_LIMITS.maxNodes): boolean {
  return plainJson(value, { nodes, seen: new WeakSet() }, 0);
}

const encoder = new TextEncoder();

/** The bytes `value` takes as JSON. */
export const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/** A document's data: a plain object, within the limits; "too_large" past them. */
function dbData(
  value: unknown,
  budget: { nodes: number; readonly seen: WeakSet<object> } = {
    nodes: DB_LIMITS.maxNodes,
    seen: new WeakSet(),
  },
): DbData | "too_large" | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (!plainJson(value, budget, 0)) {
    return null;
  }
  return jsonBytes(value) > DB_LIMITS.maxDocBytes ? "too_large" : (value as DbData);
}

const version = (value: unknown): number | null | undefined =>
  value === undefined
    ? undefined
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;

export type DbWhereOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "array-contains";

const WHERE_OPS: readonly DbWhereOp[] = ["==", "!=", "<", "<=", ">", ">=", "in", "array-contains"];

export type DbWhere = readonly [field: string, op: DbWhereOp, value: DbValue];

export type DbWrite =
  | {
      readonly op: "set";
      readonly path: string;
      readonly data: DbData;
      /** The version read (0: it must not exist yet). Needed to replace one that exists. */
      readonly ifVersion?: number;
    }
  | {
      readonly op: "update";
      readonly path: string;
      /** Fields merged over the document's (top level). */
      readonly data: DbData;
      readonly ifVersion?: number;
    }
  | { readonly op: "delete"; readonly path: string; readonly ifVersion?: number };

/** A `db` call, as the host's handler gets it (paths checked, `me` resolved). */
export type DbRequest =
  | { readonly op: "get"; readonly path: string }
  | DbWrite
  | {
      readonly op: "query";
      readonly collection: string;
      readonly where?: readonly DbWhere[];
      readonly orderBy?: { readonly field: string; readonly direction: "asc" | "desc" };
      readonly limit?: number;
    }
  | { readonly op: "batch"; readonly writes: readonly DbWrite[] }
  /** A document or a collection, kept current: the handler calls `changed` with each new state. */
  | { readonly op: "watch"; readonly path: string };

/** A document as the host answers it. `version` counts its writes (1 for the first). */
export interface DbSnapshot {
  readonly path: string;
  readonly id: string;
  readonly exists: boolean;
  readonly version: number;
  readonly data?: DbData;
}

/** What each op answers. */
export type DbResult =
  /** get */
  | DbSnapshot
  /** set, update */
  | { readonly version: number }
  /** query, a collection's watch */
  | { readonly docs: readonly DbSnapshot[] }
  /** batch: each write's new version (null for a delete) */
  | { readonly versions: readonly (number | null)[] }
  /** delete, watch */
  | undefined;

type Parsed<T> = T | "too_large" | null;

function parseWrite(
  value: unknown,
  op?: string,
  budget?: { nodes: number; readonly seen: WeakSet<object> },
): Parsed<DbWrite> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const kind = op ?? raw.op;
  const segments = dbSegments(raw.path);
  const ifVersion = version(raw.ifVersion);
  if (segments === null || dbPathKind(segments) !== "doc" || ifVersion === null) {
    return null;
  }
  const path = segments.join("/");
  const at = ifVersion === undefined ? {} : { ifVersion };
  if (kind === "delete") {
    return { op: "delete", path, ...at };
  }
  if (kind !== "set" && kind !== "update") {
    return null;
  }
  const data = dbData(raw.data, budget);
  if (data === null || data === "too_large") {
    return data;
  }
  return { op: kind, path, data, ...at };
}

function parseWhere(value: unknown): readonly DbWhere[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > DB_LIMITS.maxWhere) {
    return null;
  }
  const out: DbWhere[] = [];
  for (const each of value) {
    if (!Array.isArray(each) || each.length !== 3) {
      return null;
    }
    const [field, op, operand] = each as unknown[];
    if (
      typeof field !== "string" ||
      field === "" ||
      field.length > 256 ||
      !(WHERE_OPS as readonly unknown[]).includes(op) ||
      !isPlainJson(operand, DB_LIMITS.maxOperandNodes) ||
      jsonBytes(operand) > DB_LIMITS.maxOperandBytes ||
      (op === "in" && (!Array.isArray(operand) || operand.length > DB_LIMITS.maxIn))
    ) {
      return null;
    }
    out.push([field, op as DbWhereOp, operand as DbValue]);
  }
  return out;
}

/** A `db` call's arguments as content sent them, checked: null (malformed), "too_large", or the call. */
export function parseDbRequest(args: unknown): Parsed<DbRequest> {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const raw = args as Record<string, unknown>;
  switch (raw.op) {
    case "get":
    case "watch": {
      const segments = dbSegments(raw.path);
      if (segments === null || (raw.op === "get" && dbPathKind(segments) !== "doc")) {
        return null;
      }
      return { op: raw.op, path: segments.join("/") };
    }
    case "set":
    case "update":
    case "delete":
      return parseWrite(raw, raw.op);
    case "query": {
      const segments = dbSegments(raw.collection);
      const where = parseWhere(raw.where);
      if (segments === null || dbPathKind(segments) !== "collection" || where === null) {
        return null;
      }
      let orderBy: { field: string; direction: "asc" | "desc" } | undefined;
      if (raw.orderBy !== undefined) {
        const order = raw.orderBy as Record<string, unknown> | null;
        if (
          order === null ||
          typeof order !== "object" ||
          typeof order.field !== "string" ||
          order.field === "" ||
          order.field.length > 256 ||
          (order.direction !== undefined && order.direction !== "asc" && order.direction !== "desc")
        ) {
          return null;
        }
        orderBy = { field: order.field, direction: order.direction === "desc" ? "desc" : "asc" };
      }
      const limit = raw.limit;
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > DB_LIMITS.maxQueryLimit)
      ) {
        return null;
      }
      return {
        op: "query",
        collection: segments.join("/"),
        ...(where === undefined ? {} : { where }),
        ...(orderBy === undefined ? {} : { orderBy }),
        ...(limit === undefined ? {} : { limit }),
      };
    }
    case "batch": {
      const writes = raw.writes;
      if (!Array.isArray(writes) || writes.length === 0) {
        return null;
      }
      if (writes.length > DB_LIMITS.maxBatchWrites) {
        return "too_large";
      }
      const parsed: DbWrite[] = [];
      // One budget for the whole batch, and one write a path: a batch is checked against one
      // state, so two writes to a path would both pass it.
      const budget = { nodes: DB_LIMITS.maxNodes, seen: new WeakSet<object>() };
      const paths = new Set<string>();
      for (const each of writes) {
        const write = parseWrite(each, undefined, budget);
        if (write === null || write === "too_large") {
          return write;
        }
        if (paths.has(write.path)) {
          return null;
        }
        paths.add(write.path);
        parsed.push(write);
      }
      if (jsonBytes(parsed) > DB_LIMITS.maxBatchBytes) {
        return "too_large";
      }
      return { op: "batch", writes: parsed };
    }
    default:
      return null;
  }
}

/**
 * The page's rules for its data (its `db` declaration, P086): by top-level collection (or `*`),
 * the least level that may read and write it. They only raise the contract's (read: view, write:
 * interact); the host evaluates them again on its side (`dbAccess`).
 */
export type DbRules = Readonly<Record<string, DbRule>>;

/** One collection's rule: the least level that may read it, and write it (absent: the contract's). */
export interface DbRule {
  readonly read?: ViewerLevel;
  readonly write?: ViewerLevel;
}

/**
 * The rule a top-level collection is under (P086, P093): its own rule object if the rules name it,
 * else `*`'s, whole; never field by field (a collection's `{}` is the contract's levels, whatever
 * `*` says). Own names only: a collection named `constructor` or `__proto__` is no rule unless
 * the rules name it (P091). `dbAccess` and `intersectDeclarations` both read rules through this.
 */
export function dbRuleOf(rules: DbRules | undefined, collection: string): DbRule | undefined {
  const own = (key: string) =>
    rules !== undefined && Object.hasOwn(rules, key) ? rules[key] : undefined;
  return own(collection) ?? own("*");
}

/** A rules object's problem, or null. */
export function dbRulesProblem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "must be an object of { read?, write } levels by collection";
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) {
    return "may name at most 100 collections";
  }
  for (const [collection, rule] of entries) {
    if (collection !== "*" && !SEGMENT.test(collection)) {
      return `${JSON.stringify(collection)} is not a collection name (or "*")`;
    }
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
      return `${collection}: must be { read?, write? }`;
    }
    for (const [key, level] of Object.entries(rule as Record<string, unknown>)) {
      if ((key !== "read" && key !== "write") || !isViewerLevel(level)) {
        return `${collection}.${key}: must be read or write, a level (view, interact, admin, owner)`;
      }
    }
  }
  return null;
}

/** Whether an op reads or writes. */
const writes = (op: DbRequest["op"]): boolean =>
  op === "set" || op === "update" || op === "delete" || op === "batch";

/** The paths a call touches. */
function pathsOf(request: DbRequest): string[] {
  switch (request.op) {
    case "query":
      return [request.collection];
    case "batch":
      return request.writes.map((each) => each.path);
    default:
      return [request.path];
  }
}

/** `path` with `me` resolved to the viewer, or null where it names someone else's data. */
function ownPath(path: string, viewer: ViewerInfo | undefined): string | null {
  const segments = path.split("/");
  // `data`, however a store folds its case (after the review: `Data/users/<id>` is no way round).
  if (segments[0]?.toLowerCase() !== "data") {
    return path;
  }
  if (segments[0] !== "data") {
    return null;
  }
  // `data` holds only per-user trees: `data/users/<id>/…`, the viewer's own.
  if (segments[1] !== "users" || segments.length < 3) {
    return null;
  }
  if (!isDbSegment(viewer?.id)) {
    return null;
  }
  const id = segments[2] === "me" ? viewer?.id : segments[2];
  if (id === undefined || viewer?.id === undefined || id !== viewer.id) {
    return null;
  }
  segments[2] = id;
  return segments.join("/");
}

/** The least level a rule asks for `path`. */
function ruleLevel(rules: DbRules | undefined, path: string, write: boolean): ViewerLevel {
  const base: ViewerLevel = write ? "interact" : "view";
  const rule = dbRuleOf(rules, path.split("/")[0] ?? "");
  const asked = write ? rule?.write : rule?.read;
  return asked === undefined ? base : higher(base, asked);
}

/**
 * Whether `viewer` may make `request` under `rules` (P088), and the call with `me` resolved:
 * someone else's per-user data is refused at every level, and so is any path under `data` that
 * isn't `data/users/<own id>/…`; then each path's rule. The bridge applies it before the host's
 * handler; a host applies it again in its own API (its data's wall).
 */
export function dbAccess(
  request: DbRequest,
  viewer: ViewerInfo | undefined,
  rules?: DbRules,
): { readonly ok: true; readonly request: DbRequest } | { readonly ok: false } {
  if (viewer === undefined) {
    return { ok: false };
  }
  const resolve = (path: string): string | null => ownPath(path, viewer);
  for (const path of pathsOf(request)) {
    const own = resolve(path);
    if (own === null || !atLeast(viewer.level, ruleLevel(rules, own, writes(request.op)))) {
      return { ok: false };
    }
  }
  switch (request.op) {
    case "query":
      return { ok: true, request: { ...request, collection: resolve(request.collection) ?? "" } };
    case "batch":
      return {
        ok: true,
        request: {
          op: "batch",
          writes: request.writes.map((each) => ({ ...each, path: resolve(each.path) ?? "" })),
        },
      };
    default:
      return { ok: true, request: { ...request, path: resolve(request.path) ?? "" } };
  }
}

/**
 * A `db` answer as content gets it (P088, after the review): every path in the viewer's own tree
 * says `data/users/me`, never their id, so a page that didn't declare `user` doesn't learn who is
 * viewing from its own data's paths. Snapshots and `{ docs }`; anything else as it is.
 */
export function withMe(value: unknown, viewer: ViewerInfo | undefined): unknown {
  const id = viewer?.id;
  if (id === undefined || value === null || typeof value !== "object") {
    return value;
  }
  const own = `${DB_USERS_PREFIX}${id}`;
  const path = (each: unknown): unknown => {
    if (each === null || typeof each !== "object" || Array.isArray(each)) {
      return each;
    }
    const snapshot = each as { readonly path?: unknown };
    if (
      typeof snapshot.path === "string" &&
      (snapshot.path === own || snapshot.path.startsWith(`${own}/`))
    ) {
      return { ...snapshot, path: `${DB_USERS_PREFIX}me${snapshot.path.slice(own.length)}` };
    }
    return each;
  };
  const docs = (value as { readonly docs?: unknown }).docs;
  if (Array.isArray(docs)) {
    return { ...value, docs: docs.map(path) };
  }
  return path(value);
}
