import type { PortholeConfig } from "../config/schema.ts";
import {
  RUNTIME_CAPABILITY_NAMES,
  RUNTIME_VERSION,
  isRuntimeCapabilityName,
  isRuntimeVersion,
  offeredCapabilities,
  runtimeCapability,
  type RuntimeCapabilityName,
  type RuntimeVersion,
} from "./contract.ts";
import {
  dbRuleLevel,
  dbRuleOf,
  dbRulesProblem,
  foldCollection,
  stricterDbRule,
  type DbRule,
  type DbRules,
  type DeclarationStage,
} from "./db.ts";
import { higher, isViewerLevel, type ViewerLevel } from "./levels.ts";

/**
 * A page's declaration (P086): the capabilities it uses, by name, each with its own config,
 * stored with the artifact when it is published and handed to `mount` when it is shown; and the
 * runtime contract it was written against, pinned. Built-ins are never declared.
 *
 * At publish (`declareCapabilities`): omitted carries the stored declaration forward (and its
 * pin); `{}` clears it; a non-empty object replaces it whole. A page can't change its own: a
 * publish from the page (`artifact.publish`) carries none.
 */

/** Every capability's config may raise its methods' levels (never lower them). */
export interface DeclaredCapability {
  readonly levels?: Readonly<Record<string, ViewerLevel>>;
}

/** `data`: which of the host's resources and tools the page uses (absent: all it serves). */
export interface DeclaredData extends DeclaredCapability {
  /** URIs, exact, or a prefix ending in `*` (`app://tasks/*`). */
  readonly resources?: readonly string[];
  readonly tools?: readonly string[];
}

/** `db`: the page's rules for its data, by top-level collection (`DbRules`). */
export interface DeclaredDb extends DeclaredCapability {
  readonly rules?: DbRules;
}

/** What a page declares, by runtime capability name. */
export interface CapabilityDeclaration {
  readonly user?: DeclaredCapability;
  readonly chat?: DeclaredCapability;
  readonly data?: DeclaredData;
  readonly context?: DeclaredCapability;
  readonly artifact?: DeclaredCapability;
  readonly assets?: DeclaredCapability;
  readonly db?: DeclaredDb;
}

/** A declaration as an artifact stores it and a mount is given it. */
export interface PageDeclaration {
  readonly capabilities: CapabilityDeclaration;
  readonly runtime: RuntimeVersion;
}

export interface DeclarationProblem {
  /** Where, as `capabilities.db.rules.votes`. */
  readonly path: string;
  readonly message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const KEYS: Readonly<Record<string, readonly string[]>> = {
  data: ["levels", "resources", "tools"],
  db: ["levels", "rules"],
};

/** The most names `data` lists at publish; where shown (an intersection of two), twice that (P093). */
const MAX_NAMES = 200;

const names = (
  values: unknown,
  path: string,
  problems: DeclarationProblem[],
  stage: DeclarationStage,
): void => {
  const most = stage === "publish" ? MAX_NAMES : 2 * MAX_NAMES;
  if (
    !Array.isArray(values) ||
    values.length > most ||
    values.some(
      (each) =>
        typeof each !== "string" ||
        each === "" ||
        each.length > 512 ||
        /\p{Cc}/u.test(each) ||
        // A `*` only at the end: a prefix.
        (each.includes("*") && each.indexOf("*") !== each.length - 1),
    )
  ) {
    problems.push({
      path,
      message: `must be a list of names (at most ${most}), each exact or a prefix ending in *`,
    });
  }
};

/**
 * The problems with a declaration, against the host's offer (`config`): each name one the
 * runtime knows, the config offers and isn't built in; each config of its own shape. Empty: fine.
 */
export function declarationProblems(
  given: unknown,
  config: PortholeConfig,
  runtime: RuntimeVersion = RUNTIME_VERSION,
): DeclarationProblem[] {
  return stagedProblems(given, config, runtime, "publish");
}

/**
 * `declarationProblems` at a stage (P093): at publish, the limits a page is held to; where a
 * declaration is shown (a mount), an intersection of two such (`intersectDeclarations`) fits too.
 */
function stagedProblems(
  given: unknown,
  config: PortholeConfig,
  runtime: RuntimeVersion,
  stage: DeclarationStage,
): DeclarationProblem[] {
  const problems: DeclarationProblem[] = [];
  if (!isRuntimeVersion(runtime)) {
    return [{ path: "runtime", message: `is not a runtime version Porthole serves` }];
  }
  if (!isRecord(given)) {
    return [{ path: "capabilities", message: "must be an object: { name: config }" }];
  }
  const offered = offeredCapabilities(config);
  for (const [name, value] of Object.entries(given)) {
    const path = `capabilities.${name}`;
    if (!isRuntimeCapabilityName(name)) {
      problems.push({
        path,
        message: `is not a capability (${RUNTIME_CAPABILITY_NAMES.filter((each) => !runtimeCapability(each).builtIn).join(", ")})`,
      });
      continue;
    }
    if (runtimeCapability(name).builtIn) {
      problems.push({ path, message: "is built in: use it without declaring it" });
      continue;
    }
    if (!offered.includes(name)) {
      problems.push({ path, message: "isn't offered here" });
      continue;
    }
    configProblems(name, value, path, problems, stage);
  }
  return problems;
}

/** The problems with one capability's config, its shape alone (no host's offer needed). */
function configProblems(
  name: RuntimeCapabilityName,
  value: unknown,
  path: string,
  problems: DeclarationProblem[],
  stage: DeclarationStage,
): void {
  const spec = runtimeCapability(name);
  if (!isRecord(value)) {
    problems.push({ path, message: "must be an object ({} for none of its own)" });
    return;
  }
  const allowed = KEYS[name] ?? ["levels"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      problems.push({ path: `${path}.${key}`, message: `is not a field of ${name}'s config` });
    }
  }
  if (value.levels !== undefined) {
    if (!isRecord(value.levels)) {
      problems.push({ path: `${path}.levels`, message: "must be an object of levels by method" });
    } else {
      for (const [method, level] of Object.entries(value.levels)) {
        if (!Object.hasOwn(spec.methods, method)) {
          problems.push({
            path: `${path}.levels.${method}`,
            message: `is not a method of ${name} (${Object.keys(spec.methods).join(", ")})`,
          });
        } else if (!isViewerLevel(level)) {
          problems.push({
            path: `${path}.levels.${method}`,
            message: "must be view, interact, admin or owner",
          });
        }
      }
    }
  }
  if (name === "data") {
    if (value.resources !== undefined) {
      names(value.resources, `${path}.resources`, problems, stage);
    }
    if (value.tools !== undefined) {
      names(value.tools, `${path}.tools`, problems, stage);
    }
  }
  if (name === "db" && value.rules !== undefined) {
    const problem = dbRulesProblem(value.rules, stage);
    if (problem !== null) {
      problems.push({ path: `${path}.rules`, message: problem });
    }
  }
}

/** A declaration checked (a host's stored one, given to `mount`); throws a `TypeError` naming its problems. */
export function checkDeclaration(given: unknown, config: PortholeConfig): PageDeclaration {
  if (!isRecord(given)) {
    throw new TypeError("A declaration is { capabilities, runtime }");
  }
  const runtime = given.runtime;
  if (!isRuntimeVersion(runtime)) {
    throw new TypeError(
      `A declaration's runtime ${JSON.stringify(runtime)} is not one this Porthole serves`,
    );
  }
  const problems = stagedProblems(given.capabilities, config, runtime, "shown");
  if (problems.length > 0) {
    throw new TypeError(
      `The declaration doesn't fit this config: ${problems.map((each) => `${each.path} ${each.message}`).join("; ")}`,
    );
  }
  return { capabilities: copied(given.capabilities) as CapabilityDeclaration, runtime };
}

/**
 * A declaration's own copy, every object without a prototype (after the review): a rule or a
 * level looked up by a name like `constructor` finds nothing but what the page wrote.
 */
function copied(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copied);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, each] of Object.entries(value)) {
    out[key] = copied(each);
  }
  return out;
}

/**
 * At publish (P086): the declaration a new version leaves the artifact with.
 * - `given` undefined: the stored one, unchanged (its pin too); none stored: an empty one.
 * - `given` `{}`: cleared.
 * - `given` non-empty: it replaces the stored one whole (anything not restated is revoked).
 * The pin moves only when the author asks (`runtime`). Checked against the host's offer.
 */
export function declareCapabilities(options: {
  readonly stored?: PageDeclaration | null;
  readonly given?: unknown;
  readonly config: PortholeConfig;
  readonly runtime?: unknown;
}):
  | {
      readonly ok: true;
      readonly declaration: PageDeclaration;
      /** Whether it differs from the stored one. */
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly problems: readonly DeclarationProblem[] } {
  const { stored, given, config } = options;
  if (options.runtime !== undefined && !isRuntimeVersion(options.runtime)) {
    return {
      ok: false,
      problems: [{ path: "runtime", message: "is not a runtime version Porthole serves" }],
    };
  }
  const runtime: RuntimeVersion = options.runtime ?? stored?.runtime ?? RUNTIME_VERSION;
  if (given === undefined) {
    const capabilities = stored?.capabilities ?? {};
    // A stored declaration still fits the host's offer (a host may have narrowed its config); as
    // stored, a page's from before P093 too (rule names in more than one case).
    const problems = stagedProblems(capabilities, config, runtime, "shown");
    return problems.length > 0
      ? { ok: false, problems }
      : {
          ok: true,
          // Its own copy, as at a publish that gives one (P093, after its review).
          declaration: { capabilities: copied(capabilities) as CapabilityDeclaration, runtime },
          changed: stored === undefined || stored === null || stored.runtime !== runtime,
        };
  }
  const problems = declarationProblems(given, config, runtime);
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  // Its own copy, without prototypes (P093): what was checked, not the caller's object.
  const declaration = { capabilities: copied(given) as CapabilityDeclaration, runtime };
  return {
    ok: true,
    declaration,
    changed:
      stored === undefined ||
      stored === null ||
      stored.runtime !== runtime ||
      JSON.stringify(stored.capabilities) !== JSON.stringify(declaration.capabilities),
  };
}

/**
 * A name a prefix can't vouch for (after the review): a dot segment, or one written with an
 * escape or a backslash, may resolve outside the prefix (`app://tasks/../secrets`).
 */
const ESCAPES_PREFIX = /(^|[/\\])\.{1,2}([/\\?#]|$)|%2e|%2f|%5c|\\/iu;

/** Whether `name` matches a declared list's entry (exact, or a prefix ending in `*`). */
export function declaredMatch(list: readonly string[] | undefined, name: string): boolean {
  return (
    list === undefined ||
    list.some((each) =>
      each.endsWith("*")
        ? name.startsWith(each.slice(0, -1)) && !ESCAPES_PREFIX.test(name)
        : each === name,
    )
  );
}

/**
 * An object without a prototype (P093): a name the page wrote (`__proto__`, a collection's) is an
 * own key of it when set, never a prototype's setter or a prototype's name when read.
 */
const bare = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** The stricter of two declared level maps (absent: the contract's, everywhere). */
function stricterLevels(
  a: Readonly<Record<string, ViewerLevel>> | undefined,
  b: Readonly<Record<string, ViewerLevel>> | undefined,
): Readonly<Record<string, ViewerLevel>> | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  const out = bare<ViewerLevel>();
  for (const method of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const x = a !== undefined && Object.hasOwn(a, method) ? a[method] : undefined;
    const y = b !== undefined && Object.hasOwn(b, method) ? b[method] : undefined;
    const level = x === undefined ? y : y === undefined ? x : higher(x, y);
    if (level !== undefined) {
      out[method] = level;
    }
  }
  return out;
}

/** The names both lists admit (absent: everything). */
function bothNames(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): readonly string[] | undefined {
  if (a === undefined || b === undefined) {
    return a === undefined ? b?.slice() : a.slice();
  }
  return [
    ...new Set([
      ...a.filter((each) => declaredMatch(b, each)),
      ...b.filter((each) => declaredMatch(a, each)),
    ]),
  ];
}

/**
 * The stricter of two pages' rules, by collection (P093, the 2026-10-19 audit's S02): each name
 * either side's rules give, in any case, and `*`, is under the stricter of the rule EACH side
 * puts it under, as `dbAccess` reads that side (`dbRuleOf`). A collection neither names is under
 * both sides' `*`, the output's `*`. So the output allows a level at most what both allow it (an
 * old version's `public` doesn't outlive the current `*`, nor the other way), and exactly that
 * where both spell each collection alike; where they spell one differently it may be stricter
 * (after the re-review). One name for each name in any case (as the first side spells it); none
 * for a name whose rule is the output's `*`'s (after the review: it says nothing `*` doesn't).
 */
function stricterRules(a: DbRules | undefined, b: DbRules | undefined): DbRules | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  const wildcard = stricterDbRule(dbRuleOf(a, "*"), dbRuleOf(b, "*"));
  const same = (rule: DbRule) =>
    dbRuleLevel(rule, false) === dbRuleLevel(wildcard, false) &&
    dbRuleLevel(rule, true) === dbRuleLevel(wildcard, true);
  const out = bare<DbRule>();
  const seen = new Set<string>();
  for (const name of [...Object.keys(a ?? {}), ...Object.keys(b ?? {})]) {
    const folded = foldCollection(name);
    if (name === "*" || seen.has(folded)) {
      continue;
    }
    seen.add(folded);
    const rule = stricterDbRule(dbRuleOf(a, name), dbRuleOf(b, name));
    if (!same(rule)) {
      out[name] = rule;
    }
  }
  if ((a !== undefined && Object.hasOwn(a, "*")) || (b !== undefined && Object.hasOwn(b, "*"))) {
    out["*"] = wildcard;
  }
  return out;
}

/**
 * The problems with a declaration's shape where it is shown (no host's offer: the mount checks
 * that), each path under `which`: what would be read as allowing anything could loosen the other
 * side (`higher` with a level that isn't one returns the other).
 */
function shapeProblems(declaration: unknown, which: string): DeclarationProblem[] {
  const problems: DeclarationProblem[] = [];
  if (!isRecord(declaration) || !isRecord(declaration.capabilities)) {
    return [{ path: `${which}.capabilities`, message: "must be an object: { name: config }" }];
  }
  if (!isRuntimeVersion(declaration.runtime)) {
    problems.push({
      path: `${which}.runtime`,
      message: "is not a runtime version Porthole serves",
    });
  }
  for (const [name, value] of Object.entries(declaration.capabilities)) {
    const path = `${which}.capabilities.${name}`;
    if (!isRuntimeCapabilityName(name)) {
      problems.push({ path, message: "is not a capability" });
    } else if (runtimeCapability(name).builtIn) {
      problems.push({ path, message: "is built in: use it without declaring it" });
    } else {
      configProblems(name, value, path, problems, "shown");
    }
  }
  return problems;
}

/**
 * What a version may do when it is shown (after the review): what it declared when it was
 * published AND what the artifact declares now. A host stores each version's declaration with
 * it (`declareCapabilities` at its publish) and mounts a version with this, so an old version
 * never keeps what the artifact has since revoked, nor gains what it declared later. Each
 * capability only where both declare it, at the stricter levels, the narrower `data` names and
 * the stricter `db` rules (each side read as `dbAccess` reads it, P093); the version's own pinned
 * runtime. Whatever the result allows, each side allows alone; a mount takes it (two pages at
 * the publish limits make one within a mount's). Objects without a prototype.
 *
 * Answers its problems (P093, after its review) where either side isn't a declaration's shape
 * (or the two make one past a mount's limits): show the version as an error, never with `null`
 * (that is 0.6's surface) or with either side alone.
 */
export function tryIntersectDeclarations(
  version: PageDeclaration,
  current: PageDeclaration,
):
  | { readonly ok: true; readonly declaration: PageDeclaration }
  | { readonly ok: false; readonly problems: readonly DeclarationProblem[] } {
  const problems = [...shapeProblems(version, "version"), ...shapeProblems(current, "current")];
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const a = version.capabilities as Readonly<Record<string, DeclaredData & DeclaredDb>>;
  const b = current.capabilities as Readonly<Record<string, DeclaredData & DeclaredDb>>;
  const capabilities = bare<DeclaredCapability & DeclaredData & DeclaredDb>();
  for (const name of Object.keys(a)) {
    if (!Object.hasOwn(b, name)) {
      continue;
    }
    const x = a[name] ?? {};
    const y = b[name] ?? {};
    const out = Object.create(null) as {
      levels?: Readonly<Record<string, ViewerLevel>>;
      resources?: readonly string[];
      tools?: readonly string[];
      rules?: DbRules;
    };
    const levels = stricterLevels(x.levels, y.levels);
    const resources = bothNames(x.resources, y.resources);
    const tools = bothNames(x.tools, y.tools);
    const rules = stricterRules(x.rules, y.rules);
    if (levels !== undefined) {
      out.levels = levels;
    }
    if (resources !== undefined) {
      out.resources = resources;
    }
    if (tools !== undefined) {
      out.tools = tools;
    }
    if (rules !== undefined) {
      out.rules = rules;
    }
    capabilities[name] = out;
  }
  const declaration: PageDeclaration = { capabilities, runtime: version.runtime };
  // Within a mount's limits: sides that were themselves intersections could make one past them.
  const past = shapeProblems(declaration, "intersection");
  return past.length > 0 ? { ok: false, problems: past } : { ok: true, declaration };
}

/** `tryIntersectDeclarations`, a `TypeError` naming the problems where it answers some. */
export function intersectDeclarations(
  version: PageDeclaration,
  current: PageDeclaration,
): PageDeclaration {
  const result = tryIntersectDeclarations(version, current);
  if (!result.ok) {
    throw new TypeError(
      `The declarations don't intersect: ${result.problems.map((each) => `${each.path} ${each.message}`).join("; ")}`,
    );
  }
  return result.declaration;
}
