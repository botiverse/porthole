import { describe, expect, test } from "vitest";
import {
  atLeast,
  checkDeclaration,
  dbAccess,
  declareCapabilities,
  declaredMatch,
  dbRulesProblem,
  intersectDeclarations,
  methodLevel,
  tryIntersectDeclarations,
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

const COLLECTIONS = ["public", "Public", "__proto__", "constructor", "toString", "other"];

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
    // `public` is under the same rule as `*` on both sides now: no name of its own (review).
    expect(both.capabilities.db?.rules).toEqual({ "*": { read: "owner", write: "owner" } });
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
            ["*", "public", "Public", "PUBLIC", "__proto__", "constructor", "toString", "data"]
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

/** The independent review of P093's first cut: each finding's regression. */
describe("P093 review", () => {
  const many = (prefix: string, count: number, rule: Rule): [string, Rule][] =>
    Array.from({ length: count }, (_, index) => [`${prefix}${index}`, rule]);

  test("1: two declarations at the publish limits intersect into one a mount takes", () => {
    // 100 names each, none of them redundant: the union is 200 (the publish limit is 100).
    const version = declared({
      db: { rules: own(many("a", 100, { read: "admin" })) },
      data: {
        resources: [...many("app://x/a", 199, {}).map(([name]) => name), "app://x/*"],
        tools: [...many("a", 199, {}).map(([name]) => name), "*"],
      },
    });
    const current = declared({
      db: { rules: own([...many("b", 99, { write: "owner" }), ["*", { read: "interact" }]]) },
      data: {
        resources: [...many("app://x/b", 199, {}).map(([name]) => name), "app://x/*"],
        tools: [...many("b", 199, {}).map(([name]) => name), "*"],
      },
    });
    for (const each of [version, current]) {
      expect(() => mounted(each)).not.toThrow();
      expect(declareCapabilities({ given: each.capabilities, config }).ok).toBe(true);
    }
    const both = intersectDeclarations(version, current);
    expect(Object.keys(both.capabilities.db?.rules ?? {})).toHaveLength(200);
    expect(both.capabilities.data?.resources?.length).toBeGreaterThan(200);
    expect(() => mounted(both)).not.toThrow();
    expectBoth(version, current);
    expect(dbAllows(mounted(both), "interact", { op: "get", path: "a0/x" })).toBe(false);
    expect(dbAllows(mounted(both), "admin", { op: "set", path: "b0/x", data: {} })).toBe(false);
    expect(dbAllows(mounted(both), "admin", { op: "get", path: "a0/x" })).toBe(true);
    expect(dataAllows(mounted(both), "view", "read", "app://x/a0")).toBe(true);
    // The publish limits stay: one more name at publish is refused.
    const over = { db: { rules: own(many("c", 101, {})) } };
    expect(declareCapabilities({ given: over, config }).ok).toBe(false);
    const names = { data: { tools: many("t", 201, {}).map(([name]) => name) } };
    expect(declareCapabilities({ given: names, config }).ok).toBe(false);
  });

  test("1: property at the limits: 100 rule names and 200 data names a side, any case across sides", () => {
    const next = random(0x9301);
    const level = () => VIEWER_LEVELS[Math.floor(next() * 4)] as ViewerLevel;
    const shuffled = <T>(list: readonly T[]) =>
      list
        .map((each) => [next(), each] as const)
        .sort(([x], [y]) => x - y)
        .map(([, each]) => each);
    // Names distinct in any case within a side (publish refuses two that differ only in case).
    const pool = [
      ...COLLECTIONS.filter((name) => name !== "Public"),
      ...many("c", 150, {}).map(([name]) => name),
    ];
    const side = (upper: boolean): PageDeclaration => {
      const chosen = shuffled(pool).slice(0, next() < 0.5 ? 100 : 99);
      const rules = chosen.map((name): [string, Rule] => [
        upper && next() < 0.5 ? name.toUpperCase() : name,
        { ...(next() < 0.6 ? { read: level() } : {}), ...(next() < 0.6 ? { write: level() } : {}) },
      ]);
      if (chosen.length === 99) {
        rules.push(["*", { read: level() }]);
      }
      const resources = shuffled([
        ...RESOURCES,
        "app://tasks/*",
        "app://*",
        ...many("app://n/", 300, {}).map(([name]) => name),
      ]).slice(0, 200);
      const made = declared({ db: { rules: own(rules) }, data: { resources } });
      expect(declareCapabilities({ given: made.capabilities, config }).ok).toBe(true);
      return next() < 0.5 ? made : mounted(made);
    };
    for (let round = 0; round < 12; round += 1) {
      expectBoth(side(false), side(true));
    }
  }, 30_000);

  test("1: a name under the same rule as `*` on both sides gets none of its own", () => {
    const both = intersectDeclarations(
      declared({ db: { rules: { a: { read: "admin" }, b: { write: "admin" }, "*": {} } } }),
      declared({ db: { rules: { a: { read: "view" }, "*": { write: "admin" } } } }),
    );
    // a: { read: admin } (the current's own `a` rule, whole: its `*` doesn't reach `a`) differs
    // from * ({ write: admin }); b is { write: admin } on both sides, which `*` says.
    expect(both.capabilities.db?.rules).toEqual({ a: { read: "admin" }, "*": { write: "admin" } });
    expectBoth(
      declared({ db: { rules: { a: { read: "admin" }, b: { write: "admin" }, "*": {} } } }),
      declared({ db: { rules: { a: { read: "view" }, "*": { write: "admin" } } } }),
    );
  });

  test("2: a rule holds for its collection in any ASCII case", () => {
    const rules = { votes: { write: "owner" as const } };
    for (const path of ["votes/a", "Votes/a", "VOTES/a", "vOtEs/a"]) {
      expect(dbAccess({ op: "set", path, data: {} }, { level: "admin", id: ID }, rules).ok).toBe(
        false,
      );
      expect(dbAccess({ op: "set", path, data: {} }, { level: "owner", id: ID }, rules).ok).toBe(
        true,
      );
    }
    // A page from before (variants published under 0.7.0): the strictest of them, else `*`.
    const variants = own<Rule>([
      ["votes", { read: "admin" }],
      ["Votes", { write: "owner" }],
      ["*", { read: "owner" }],
    ]);
    const as = (level: ViewerLevel, request: DbRequest) =>
      dbAccess(request, { level, id: ID }, variants).ok;
    expect(as("interact", { op: "get", path: "VOTES/a" })).toBe(false);
    expect(as("admin", { op: "get", path: "vOtes/a" })).toBe(true);
    expect(as("admin", { op: "set", path: "votes/a", data: {} })).toBe(false);
    expect(as("owner", { op: "set", path: "votes/a", data: {} })).toBe(true);
    expect(as("admin", { op: "get", path: "other/a" })).toBe(false);
    // The path reaches the handler as the page wrote it (0.7.0's data keeps its names).
    const access = dbAccess({ op: "get", path: "Votes/a" }, { level: "owner", id: ID }, variants);
    expect(access).toEqual({ ok: true, request: { op: "get", path: "Votes/a" } });
  });

  test("2: names that differ only in case are refused at publish, still shown from a store", () => {
    const rules = own<Rule>([
      ["votes", { read: "admin" }],
      ["Votes", {}],
    ]);
    expect(dbRulesProblem(rules)).toMatch(/case/u);
    const published = declareCapabilities({ given: { db: { rules } }, config });
    expect(published.ok).toBe(false);
    expect(() => mounted(declared({ db: { rules } }))).not.toThrow();
    // Each side's own variants, and variants across the two: one name in the result.
    const both = intersectDeclarations(
      declared({ db: { rules } }),
      declared({ db: { rules: { VOTES: { write: "owner" } } } }),
    );
    expect(Object.keys(both.capabilities.db?.rules ?? {})).toEqual(["votes"]);
    expect(both.capabilities.db?.rules).toEqual({ votes: { read: "admin", write: "owner" } });
    expect(dbRulesProblem(both.capabilities.db?.rules)).toBeNull();
    expectBoth(
      declared({ db: { rules } }),
      declared({ db: { rules: { VOTES: { write: "owner" } } } }),
    );
  });

  test("3: tryIntersectDeclarations answers a problem instead of throwing", () => {
    const fine = declared({ db: { rules: { votes: { read: "admin" } } } });
    const bad = declared({ db: { rules: { "*": { read: "Owner" } } } });
    const refused = tryIntersectDeclarations(fine, bad);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : refused.problems.map((each) => each.path)).toEqual([
      "current.capabilities.db.rules",
    ]);
    const shown = tryIntersectDeclarations(fine, fine);
    expect(shown).toEqual({ ok: true, declaration: intersectDeclarations(fine, fine) });
    expect(() => intersectDeclarations(fine, bad)).toThrow(TypeError);
  });

  test("4: a stored declaration carried forward is a copy too", () => {
    const stored = checkDeclaration(
      JSON.parse(
        '{"capabilities":{"db":{"rules":{"__proto__":{"read":"owner"}}}},"runtime":"1"}',
      ) as unknown,
      config,
    );
    const plain = JSON.parse(JSON.stringify(stored)) as PageDeclaration;
    const result = declareCapabilities({ stored: plain, config });
    expect(result.ok).toBe(true);
    const declaration = (result as { declaration: PageDeclaration }).declaration;
    expect(declaration.capabilities).not.toBe(plain.capabilities);
    const rules = declaration.capabilities.db?.rules ?? {};
    expect(Object.getPrototypeOf(rules)).toBeNull();
    expect(Object.hasOwn(rules, "__proto__")).toBe(true);
  });

  test("6: a built-in both sides declare is refused, as the mount refuses it", () => {
    const builtIn = declared({ clipboard: {} });
    expect(() => mounted(builtIn)).toThrow(TypeError);
    expect(() => intersectDeclarations(builtIn, builtIn)).toThrow(TypeError);
  });
});
