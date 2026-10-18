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
import { isViewerLevel, type ViewerLevel } from "./levels.ts";

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
  return { capabilities: given.capabilities as CapabilityDeclaration, runtime };
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

/** Whether `name` matches a declared list's entry (exact, or a prefix ending in `*`). */
export function declaredMatch(list: readonly string[] | undefined, name: string): boolean {
  return (
    list === undefined ||
    list.some((each) => (each.endsWith("*") ? name.startsWith(each.slice(0, -1)) : each === name))
  );
}
