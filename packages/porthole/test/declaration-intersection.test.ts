import { describe, expect, test } from "vitest";
import {
  atLeast,
  checkDeclaration,
  dbAccess,
  declareCapabilities,
  declaredMatch,
  intersectDeclarations,
  methodLevel,
  presets,
  VIEWER_LEVELS,
  type DbRequest,
  type PageDeclaration,
  type PortholeConfig,
  type ViewerLevel,
} from "../src/index.ts";
import { createBridge } from "../src/bridge/bridge.ts";
import { memoryRuntime } from "../leak/runtime/memory.ts";

/**
 * A version is shown with what it AND the artifact declare now (`intersectDeclarations`, P091),
 * after the 2026-10-19 audit (S02, P093): whatever the intersection allows, each side allows on
 * its own, and nothing either side allows together is lost. Each side is read as the bridge and
 * `dbAccess` read it: a collection's own rule object if it has one, else `*`'s.
 */

const config: PortholeConfig = presets.artifact({
  isolation: "domain",
  contentOrigins: ["https://*.example-usercontent.com"],
  runtime: "1",
  capabilities: { db: {}, readData: {}, callTool: {}, artifact: {} },
});

type Rule = { read?: ViewerLevel; write?: ViewerLevel };

/** A plain object with these own keys, `__proto__` included (as `JSON.parse` makes one). */
function own<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of entries) {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

const declared = (capabilities: Record<string, unknown>): PageDeclaration => ({
  capabilities,
  runtime: "1",
});

/** What a mount gives the bridge: the declaration, checked (and copied) against the config. */
const mounted = (declaration: PageDeclaration): PageDeclaration =>
  checkDeclaration(declaration, config);

const ID = "ada";

/** Whether a viewer at `level` may make this db call, as the bridge decides it (levels, rules). */
function dbAllows(declaration: PageDeclaration, level: ViewerLevel, request: DbRequest): boolean {
  const capabilities = declaration.capabilities as Record<string, unknown>;
  if (!Object.hasOwn(capabilities, "db")) {
    return false;
  }
  const db = declaration.capabilities.db ?? {};
  const ops = [request.op, ...(request.op === "batch" ? request.writes.map((w) => w.op) : [])];
  for (const op of ops) {
    const needed = methodLevel(config, "db", op, db);
    if (needed === null || !atLeast(level, needed)) {
      return false;
    }
  }
  return dbAccess(request, { level, id: ID }, db.rules).ok;
}

/** Whether a viewer at `level` may make this data call (levels, the declared names). */
function dataAllows(
  declaration: PageDeclaration,
  level: ViewerLevel,
  method: "read" | "call",
  name: string,
): boolean {
  const capabilities = declaration.capabilities as Record<string, unknown>;
  if (!Object.hasOwn(capabilities, "data")) {
    return false;
  }
  const data = declaration.capabilities.data ?? {};
  const needed = methodLevel(config, "data", method, data);
  return (
    needed !== null &&
    atLeast(level, needed) &&
    declaredMatch(method === "call" ? data.tools : data.resources, name)
  );
}

/** Whether a viewer at `level` may call `artifact.<method>`. */
function artifactAllows(
  declaration: PageDeclaration,
  level: ViewerLevel,
  method: "get" | "publish",
): boolean {
  const capabilities = declaration.capabilities as Record<string, unknown>;
  if (!Object.hasOwn(capabilities, "artifact")) {
    return false;
  }
  const needed = methodLevel(config, "artifact", method, declaration.capabilities.artifact);
  return needed !== null && atLeast(level, needed);
}

const COLLECTIONS = ["public", "__proto__", "constructor", "toString", "other"];

const DB_REQUESTS: readonly DbRequest[] = [
  ...COLLECTIONS.flatMap((name): DbRequest[] => [
    { op: "get", path: `${name}/item` },
    { op: "query", collection: name },
    { op: "watch", path: `${name}/item` },
    { op: "set", path: `${name}/item`, data: {} },
    { op: "update", path: `${name}/item`, data: {} },
    { op: "delete", path: `${name}/item` },
    { op: "batch", writes: [{ op: "set", path: `${name}/item`, data: {} }] },
  ]),
  { op: "get", path: "data/users/me/item" },
  { op: "set", path: "data/users/me/item", data: {} },
];

const RESOURCES = [
  "app://tasks/1",
  "app://tasks/2",
  "app://tasks/1/x",
  "app://mail/1",
  "app://mail/2",
  "app://tasks/../mail/1",
  "other://x",
];
const TOOLS = ["send", "search", "sx", "delete", "nope"];

/** Every question the oracles answer, named: each a decision for a declaration. */
const CHECKS: readonly {
  readonly asked: string;
  readonly allows: (d: PageDeclaration) => boolean;
}[] = VIEWER_LEVELS.flatMap((level) => [
  ...DB_REQUESTS.map((request) => ({
    asked: `${level} db ${JSON.stringify(request)}`,
    allows: (d: PageDeclaration) => dbAllows(d, level, request),
  })),
  ...RESOURCES.map((uri) => ({
    asked: `${level} data.read ${uri}`,
    allows: (d: PageDeclaration) => dataAllows(d, level, "read", uri),
  })),
  ...TOOLS.map((name) => ({
    asked: `${level} data.call ${name}`,
    allows: (d: PageDeclaration) => dataAllows(d, level, "call", name),
  })),
  ...(["get", "publish"] as const).map((method) => ({
    asked: `${level} artifact.${method}`,
    allows: (d: PageDeclaration) => artifactAllows(d, level, method),
  })),
]);

const known = new WeakMap<PageDeclaration, readonly boolean[]>();

/** Every decision the oracles make for `declaration`, in `CHECKS`' order. */
function decisions(declaration: PageDeclaration): readonly boolean[] {
  const cached = known.get(declaration);
  if (cached !== undefined) {
    return cached;
  }
  const out = CHECKS.map((each) => each.allows(declaration));
  known.set(declaration, out);
  return out;
}

/**
 * The property: the intersection (as returned, and as a mount checks and copies it) allows
 * exactly what both sides allow. "At most" is the security property (S02); "at least" keeps an
 * old version working where nothing was revoked.
 */
function expectBoth(version: PageDeclaration, current: PageDeclaration, orders = 2): void {
  const v = decisions(version);
  const c = decisions(current);
  const pairs = [
    [version, current],
    [current, version],
  ] as const;
  for (const [x, y] of pairs.slice(0, orders)) {
    const both = intersectDeclarations(x, y);
    for (const shown of [both, mounted(both)]) {
      const s = decisions(shown);
      CHECKS.forEach(({ asked }, index) => {
        const expected = v[index] === true && c[index] === true;
        if (s[index] !== expected) {
          throw new Error(
            `${asked}: the intersection ${s[index] === true ? "allows" : "refuses"}, the version ${v[index] === true ? "allows" : "refuses"}, the current ${c[index] === true ? "allows" : "refuses"}\nversion ${JSON.stringify(version)}\ncurrent ${JSON.stringify(current)}\nshown ${JSON.stringify(shown)}`,
          );
        }
      });
    }
  }
}

/** A small seeded PRNG (mulberry32): the same cases every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("S02: a version shown under the current declaration keeps nothing it revoked", () => {
  test("a version's own rule for a collection doesn't outlive the current wildcard (the audit's case)", () => {
    const version = declared({ db: { rules: { public: { read: "view", write: "interact" } } } });
    const current = declared({ db: { rules: { "*": { read: "owner", write: "owner" } } } });
    const both = intersectDeclarations(version, current);
    for (const level of ["view", "interact", "admin"] as const) {
      expect(dbAllows(current, level, { op: "get", path: "public/item" })).toBe(false);
      expect(dbAllows(both, level, { op: "get", path: "public/item" })).toBe(false);
      expect(dbAllows(both, level, { op: "set", path: "public/item", data: {} })).toBe(false);
    }
    expect(dbAllows(both, "owner", { op: "get", path: "public/item" })).toBe(true);
    expect(both.capabilities.db?.rules).toEqual({
      public: { read: "owner", write: "owner" },
      "*": { read: "owner", write: "owner" },
    });
  });

  test("and the other way: the version's wildcard holds the current's own rules", () => {
    const version = declared({ db: { rules: { "*": { write: "admin" } } } });
    const current = declared({ db: { rules: { votes: { read: "interact" } } } });
    const both = intersectDeclarations(version, current);
    expect(dbAllows(both, "interact", { op: "set", path: "votes/a", data: {} })).toBe(false);
    expect(dbAllows(both, "admin", { op: "set", path: "votes/a", data: {} })).toBe(true);
    expect(dbAllows(both, "view", { op: "get", path: "votes/a" })).toBe(false);
    expect(dbAllows(both, "interact", { op: "set", path: "other/a", data: {} })).toBe(false);
  });

  test("through the bridge: a mount of the intersection refuses a view viewer the current refuses", async () => {
    const version = declared({ db: { rules: { public: { read: "view", write: "interact" } } } });
    const current = declared({ db: { rules: { "*": { read: "owner", write: "owner" } } } });
    const memory = memoryRuntime();
    const bridge = createBridge({
      config,
      display: { id: "d", title: "t" },
      handlers: memory.handlers,
      declaration: mounted(intersectDeclarations(version, current)),
      viewer: { level: "view", id: ID },
      consent: () => true,
      userActivation: () => true,
      onEvent: () => {},
    });
    expect(await bridge.call("db", { op: "get", path: "public/item" })).toMatchObject({
      ok: false,
      refusal: "level",
    });
    expect(memory.calls).toEqual([]);
  });

  test("a collection named __proto__ keeps its rule (an own key of objects without a prototype)", () => {
    const rules = JSON.parse('{"__proto__":{"read":"owner","write":"owner"}}') as Record<
      string,
      Rule
    >;
    expect(Object.hasOwn(rules, "__proto__")).toBe(true);
    for (const current of [
      declared({ db: { rules: JSON.parse('{"__proto__":{"read":"admin"}}') as unknown } }),
      declared({ db: { rules: { votes: { write: "admin" } } } }),
      declared({ db: {} }),
    ]) {
      const both = intersectDeclarations(declared({ db: { rules } }), current);
      const shown = both.capabilities.db?.rules ?? {};
      expect(Object.getPrototypeOf(shown)).toBeNull();
      expect(Object.hasOwn(shown, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(shown, "__proto__")?.value).toEqual({
        read: "owner",
        write: "owner",
      });
      expect(dbAllows(both, "admin", { op: "get", path: "__proto__/item" })).toBe(false);
      expect(dbAllows(mounted(both), "admin", { op: "get", path: "__proto__/item" })).toBe(false);
    }
  });

  test("every object the intersection makes has no prototype", () => {
    const both = intersectDeclarations(
      declared({ db: { rules: { a: { read: "admin" } }, levels: { set: "admin" } }, data: {} }),
      declared({
        db: { rules: { "*": { write: "admin" } }, levels: { get: "interact" } },
        data: {},
      }),
    );
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return;
      }
      expect(Object.getPrototypeOf(value)).toBeNull();
      Object.values(value).forEach(walk);
    };
    walk(both.capabilities);
  });

  test("a declaration that isn't one is refused, not read as allowing more", () => {
    const fine = declared({ db: { rules: { votes: { read: "view" } } } });
    for (const bad of [
      declared({ db: { rules: { "*": { read: "Owner" } } } }),
      declared({ db: { rules: { "*": null } } }),
      declared({ db: { rules: "everyone" } }),
      declared({ db: { levels: { get: "root" } } }),
      declared({ data: { resources: ["app://a**"] } }),
      declared({ db: "all" }),
      { capabilities: [] as never, runtime: "1" as const },
      { capabilities: {}, runtime: "0" as never },
    ] satisfies PageDeclaration[]) {
      expect(() => intersectDeclarations(fine, bad)).toThrow(TypeError);
      expect(() => intersectDeclarations(bad, fine)).toThrow(TypeError);
    }
  });

  test("property, exhaustive: `*` and one collection, each absent, empty, or any of the rules", () => {
    const options: (Rule | undefined)[] = [
      undefined,
      {},
      { read: "owner" },
      { write: "owner" },
      { read: "view", write: "interact" },
      { read: "admin", write: "view" },
      { read: "interact", write: "admin" },
    ];
    const sides: PageDeclaration[] = [declared({ db: {} })];
    for (const wildcard of options) {
      for (const named of options) {
        const entries: [string, Rule][] = [];
        if (wildcard !== undefined) {
          entries.push(["*", wildcard]);
        }
        if (named !== undefined) {
          entries.push(["public", named]);
        }
        sides.push(declared({ db: { rules: own(entries) } }));
      }
    }
    // Every ordered pair: each order of the arguments is a pair of its own.
    for (const version of sides) {
      for (const current of sides) {
        expectBoth(version, current, 1);
      }
    }
  }, 30_000);

  test("property, random: rules, special keys, levels, names, missing capabilities, either side's shape", () => {
    const next = random(0x5302);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
    const chance = (p: number) => next() < p;
    const level = () => pick(VIEWER_LEVELS);
    const rule = (): Rule => ({
      ...(chance(0.5) ? { read: level() } : {}),
      ...(chance(0.5) ? { write: level() } : {}),
    });
    const sample = (pool: readonly string[]) => pool.filter(() => chance(0.4));
    const side = (): PageDeclaration => {
      const capabilities: [string, unknown][] = [];
      if (chance(0.9)) {
        const db: Record<string, unknown> = {};
        if (chance(0.85)) {
          db.rules = own(
            ["*", "public", "__proto__", "constructor", "toString", "data"]
              .filter(() => chance(0.5))
              .map((key) => [key, rule()] as const),
          );
        }
        if (chance(0.4)) {
          db.levels = own(
            ["get", "query", "watch", "set", "update", "delete", "batch"]
              .filter(() => chance(0.3))
              .map((method) => [method, level()] as const),
          );
        }
        capabilities.push(["db", db]);
      }
      if (chance(0.7)) {
        const data: Record<string, unknown> = {};
        if (chance(0.7)) {
          data.resources = sample([
            "app://tasks/*",
            "app://tasks/1",
            "app://tasks/1/*",
            "app://mail/1",
            "app://*",
            "*",
          ]);
        }
        if (chance(0.6)) {
          data.tools = sample(["send", "s*", "search", "delete", "*"]);
        }
        if (chance(0.3)) {
          data.levels = own([["read", level()] as const]);
        }
        capabilities.push(["data", data]);
      }
      if (chance(0.5)) {
        capabilities.push(["artifact", chance(0.5) ? { levels: { get: level() } } : {}]);
      }
      const made = declared(own(capabilities));
      // As a host has it: parsed from its store (plain objects), or as a mount checked it.
      return chance(0.5)
        ? (JSON.parse(JSON.stringify(made)) as PageDeclaration)
        : checkDeclaration(made, config);
    };
    for (let round = 0; round < 1_500; round += 1) {
      expectBoth(side(), side());
    }
  }, 30_000);
});

describe("P093: a checked declaration is its own copy", () => {
  test("declareCapabilities returns objects without a prototype, not the caller's", () => {
    const given = JSON.parse('{"db":{"rules":{"__proto__":{"read":"owner"}}}}') as Record<
      string,
      { rules: Record<string, Rule> }
    >;
    const result = declareCapabilities({ given, config });
    expect(result.ok).toBe(true);
    const declaration = (result as { declaration: PageDeclaration }).declaration;
    const rules = declaration.capabilities.db?.rules ?? {};
    expect(Object.getPrototypeOf(rules)).toBeNull();
    expect(Object.hasOwn(rules, "__proto__")).toBe(true);
    // A later change to what the caller passed isn't the declaration checked.
    (given.db as { rules: Record<string, unknown> }).rules = { "*": "anything" };
    expect(Object.hasOwn(declaration.capabilities.db?.rules ?? {}, "__proto__")).toBe(true);
  });
});
