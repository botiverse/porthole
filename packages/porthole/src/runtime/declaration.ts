import type { PortholeConfig } from "../config/schema.ts";
import {
  RUNTIME_CAPABILITY_NAMES,
  RUNTIME_VERSION,
  isRuntimeCapabilityName,
  isRuntimeVersion,
  offeredCapabilities,
  runtimeCapability,
  type RuntimeVersion,
} from "./contract.ts";
import { dbRulesProblem, type DbRules } from "./db.ts";
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

const names = (values: unknown, path: string, problems: DeclarationProblem[]): void => {
  if (
    !Array.isArray(values) ||
    values.length > 200 ||
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
      message: "must be a list of names (at most 200), each exact or a prefix ending in *",
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
    const spec = runtimeCapability(name);
    if (spec.builtIn) {
      problems.push({ path, message: "is built in: use it without declaring it" });
      continue;
    }
    if (!offered.includes(name)) {
      problems.push({ path, message: "isn't offered here" });
      continue;
    }
    if (!isRecord(value)) {
      problems.push({ path, message: "must be an object ({} for none of its own)" });
      continue;
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
        names(value.resources, `${path}.resources`, problems);
      }
      if (value.tools !== undefined) {
        names(value.tools, `${path}.tools`, problems);
      }
    }
    if (name === "db" && value.rules !== undefined) {
      const problem = dbRulesProblem(value.rules);
      if (problem !== null) {
        problems.push({ path: `${path}.rules`, message: problem });
      }
    }
  }
  return problems;
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
  const problems = declarationProblems(given.capabilities, config, runtime);
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
    const declaration = stored ?? { capabilities: {}, runtime };
    const pinned = { capabilities: declaration.capabilities, runtime };
    // A stored declaration still fits the host's offer (a host may have narrowed its config).
    const problems = declarationProblems(pinned.capabilities, config, runtime);
    return problems.length > 0
      ? { ok: false, problems }
      : {
          ok: true,
          declaration: pinned,
          changed: stored === undefined || stored === null || stored.runtime !== runtime,
        };
  }
  const problems = declarationProblems(given, config, runtime);
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const declaration = { capabilities: given as CapabilityDeclaration, runtime };
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

/** The stricter of two declared level maps. */
function stricterLevels(
  a: Readonly<Record<string, ViewerLevel>> | undefined,
  b: Readonly<Record<string, ViewerLevel>> | undefined,
): Readonly<Record<string, ViewerLevel>> | undefined {
  if (a === undefined || b === undefined) {
    return a ?? b;
  }
  const out: Record<string, ViewerLevel> = { ...a };
  for (const [method, level] of Object.entries(b)) {
    const other = Object.hasOwn(out, method) ? out[method] : undefined;
    out[method] = other === undefined ? level : higher(other, level);
  }
  return out;
}

/** The names both lists admit (absent: everything). */
function bothNames(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): readonly string[] | undefined {
  if (a === undefined || b === undefined) {
    return a ?? b;
  }
  return [
    ...new Set([
      ...a.filter((each) => declaredMatch(b, each)),
      ...b.filter((each) => declaredMatch(a, each)),
    ]),
  ];
}

/** The stricter of two pages' rules, by collection. */
function stricterRules(a: DbRules | undefined, b: DbRules | undefined): DbRules | undefined {
  if (a === undefined || b === undefined) {
    return a ?? b;
  }
  const out: Record<string, { read?: ViewerLevel; write?: ViewerLevel }> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = Object.hasOwn(a, key) ? a[key] : undefined;
    const y = Object.hasOwn(b, key) ? b[key] : undefined;
    const read =
      x?.read === undefined ? y?.read : y?.read === undefined ? x.read : higher(x.read, y.read);
    const write =
      x?.write === undefined
        ? y?.write
        : y?.write === undefined
          ? x.write
          : higher(x.write, y.write);
    out[key] = {
      ...(read === undefined ? {} : { read }),
      ...(write === undefined ? {} : { write }),
    };
  }
  return out;
}

/**
 * What a version may do when it is shown (after the review): what it declared when it was
 * published AND what the artifact declares now. A host stores each version's declaration with
 * it (`declareCapabilities` at its publish) and mounts a version with this, so an old version
 * never keeps what the artifact has since revoked, nor gains what it declared later. Each
 * capability only where both declare it, at the stricter levels, the narrower `data` names and
 * the stricter `db` rules; the version's own pinned runtime.
 */
export function intersectDeclarations(
  version: PageDeclaration,
  current: PageDeclaration,
): PageDeclaration {
  const capabilities: Record<string, DeclaredCapability & DeclaredData & DeclaredDb> = {};
  const a = version.capabilities as Readonly<Record<string, DeclaredData & DeclaredDb>>;
  const b = current.capabilities as Readonly<Record<string, DeclaredData & DeclaredDb>>;
  for (const name of Object.keys(a)) {
    if (!Object.hasOwn(b, name)) {
      continue;
    }
    const x = a[name] ?? {};
    const y = b[name] ?? {};
    const levels = stricterLevels(x.levels, y.levels);
    const resources = bothNames(x.resources, y.resources);
    const tools = bothNames(x.tools, y.tools);
    const rules = stricterRules(x.rules, y.rules);
    capabilities[name] = {
      ...(levels === undefined ? {} : { levels }),
      ...(resources === undefined ? {} : { resources }),
      ...(tools === undefined ? {} : { tools }),
      ...(rules === undefined ? {} : { rules }),
    };
  }
  return { capabilities, runtime: version.runtime };
}
