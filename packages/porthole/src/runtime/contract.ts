import type { CapabilityName, Gate } from "../config/capabilities.ts";
import type { PortholeConfig } from "../config/schema.ts";
import { atLeast, higher, type ViewerLevel } from "./levels.ts";

/**
 * The capability runtime's contract (P085): what a page reaches through its one global,
 * `porthole.use(name)`, by contract version. A version is pinned per artifact when it is published
 * (`declareCapabilities`) and served as pinned, so a page keeps the API it was written against.
 *
 * Each runtime capability is a namespace of methods; each method is served by one of the config's
 * host functions (PRINCIPLE 4: the config still says what the host offers, with its gates), needs
 * a viewer level (P087), and is either a call or a watch (a subscription). A built-in is reachable
 * by any page whose host offers it; every other one only by a page that declared it (P086).
 */

/** The contract versions this Porthole serves. */
export const RUNTIME_VERSIONS = ["1"] as const;

export type RuntimeVersion = (typeof RUNTIME_VERSIONS)[number];

/** The version a declaration is pinned to unless its author asks for another. */
export const RUNTIME_VERSION: RuntimeVersion = "1";

export function isRuntimeVersion(value: unknown): value is RuntimeVersion {
  return typeof value === "string" && (RUNTIME_VERSIONS as readonly string[]).includes(value);
}

/** The one global the shell defines for the runtime, with `use` its only member. */
export const RUNTIME_GLOBAL = "porthole";

/** Where the host's roster goes in the handshake: MCP Apps' experimental host capabilities. */
export const RUNTIME_EXPERIMENTAL_KEY = "porthole/runtime";

/** A runtime call (own-prefixed, P002): `{ capability, method, args }`. */
export const RUNTIME_CALL_METHOD = "porthole/call";

/** A watch's end, frame to host (a notification, never gated): `{ watch }`. */
export const RUNTIME_UNWATCH_METHOD = "porthole/unwatch";

/** A watch's update, host to frame: `{ watch, data }`. */
export const RUNTIME_EVENT_METHOD = "porthole/event";

export interface RuntimeMethod {
  /** The config's host function that serves it: declared there, gated as it says. */
  readonly serves: CapabilityName;
  /** The least level that may call it, unless the host's config or the page's says more. */
  readonly level: ViewerLevel;
  /** The least a host's config may set it to (`CapabilityConfig.levels`). */
  readonly floor: ViewerLevel;
  /** A subscription: the content passes callbacks and gets a function that stops it. */
  readonly watch?: true;
  /**
   * Gates of its own, over its host function's (after the review, P088): what changes the
   * artifact for everyone needs the person's click and their yes. A host's config may replace
   * them (`CapabilityConfig.methodGates`).
   */
  readonly gates?: readonly Gate[];
}

export interface RuntimeCapability {
  /**
   * Built in (P086): any page whose host offers it may use it without declaring it: the effect is
   * the host's own UI, shown to the person (a copy, a link, a download, the comment composer).
   */
  readonly builtIn: boolean;
  readonly methods: Readonly<Record<string, RuntimeMethod>>;
}

const method = (
  serves: CapabilityName,
  level: ViewerLevel,
  extra: {
    readonly floor?: ViewerLevel;
    readonly watch?: true;
    readonly gates?: readonly Gate[];
  } = {},
): RuntimeMethod => ({
  serves,
  level,
  floor: extra.floor ?? "view",
  ...(extra.watch === undefined ? {} : { watch: true }),
  ...(extra.gates === undefined ? {} : { gates: extra.gates }),
});

/** What changes the artifact for everyone: the person's click, then their yes. */
const CHANGES: readonly Gate[] = ["user-activation", "confirm"];

/** Contract 1's capabilities, by the name a page passes to `use`. */
export const RUNTIME_CAPABILITIES = {
  /** Who is viewing: `{ id, name, level }`, as the host says. Declared: the page learns who. */
  user: { builtIn: false, methods: { get: method("user", "view") } },
  /** Opens the host's comment composer at an anchor the page names. Write-only (P090). */
  comments: { builtIn: true, methods: { open: method("comments", "view") } },
  /** Copies text, done and shown by the host (P051, P052). */
  clipboard: { builtIn: true, methods: { copy: method("copyText", "view") } },
  /** Opens an http(s) link outside the frame. */
  links: { builtIn: true, methods: { open: method("openLink", "view") } },
  /** Hands the person a file to save. */
  downloads: { builtIn: true, methods: { save: method("downloadFile", "view") } },
  /** Sends text to the agent as the person's message. */
  chat: { builtIn: false, methods: { send: method("sendPrompt", "interact") } },
  /** The host's data (MCP resources and tools, P079): read, follow, call. */
  data: {
    builtIn: false,
    methods: {
      read: method("readData", "view"),
      subscribe: method("subscribeData", "view", { watch: true }),
      call: method("callTool", "interact"),
    },
  },
  /** Context for the agent's next turns. */
  context: { builtIn: false, methods: { set: method("setModelContext", "interact") } },
  /** This artifact itself: its current version, and a new version of it (P088). */
  artifact: {
    builtIn: false,
    methods: {
      get: method("artifact", "view"),
      publish: method("artifact", "admin", { floor: "admin", gates: CHANGES }),
    },
  },
  /** The artifact's asset library, served at `/_blob/<id>` (P089). */
  assets: {
    builtIn: false,
    methods: {
      list: method("assets", "view"),
      // In the frame alone (P091): the address that loads an asset in this page now.
      url: method("assets", "view"),
      // An upload's own gate depends on whether what is uploaded may run (`methodGates`).
      upload: method("assets", "admin", { floor: "interact" }),
      delete: method("assets", "admin", { floor: "admin", gates: CHANGES }),
    },
  },
  /** The artifact's shared document store (P088). */
  db: {
    builtIn: false,
    methods: {
      get: method("db", "view"),
      query: method("db", "view"),
      watch: method("db", "view", { watch: true }),
      set: method("db", "interact", { floor: "interact" }),
      update: method("db", "interact", { floor: "interact" }),
      delete: method("db", "interact", { floor: "interact" }),
      batch: method("db", "interact", { floor: "interact" }),
    },
  },
} as const satisfies Readonly<Record<string, RuntimeCapability>>;

export type RuntimeCapabilityName = keyof typeof RUNTIME_CAPABILITIES;

export const RUNTIME_CAPABILITY_NAMES = Object.keys(
  RUNTIME_CAPABILITIES,
) as readonly RuntimeCapabilityName[];

export function isRuntimeCapabilityName(value: unknown): value is RuntimeCapabilityName {
  return typeof value === "string" && Object.hasOwn(RUNTIME_CAPABILITIES, value);
}

/** A runtime capability's spec, as the general shape. */
export function runtimeCapability(name: RuntimeCapabilityName): RuntimeCapability {
  return RUNTIME_CAPABILITIES[name];
}

/** The host functions the runtime added in contract 1 (P085): the config needs `runtime` for them. */
export const RUNTIME_HOST_FUNCTIONS: readonly CapabilityName[] = [
  "user",
  "comments",
  "artifact",
  "assets",
  "db",
];

/**
 * Where a host function sits in the runtime: its capability and the methods it serves. Null for
 * the shell's own (`resize`, `reportError`, `annotate`), which content never calls by name.
 */
export function familyOf(
  serves: CapabilityName,
): { readonly name: RuntimeCapabilityName; readonly methods: readonly string[] } | null {
  for (const name of RUNTIME_CAPABILITY_NAMES) {
    const methods = Object.entries(runtimeCapability(name).methods)
      .filter(([, each]) => each.serves === serves)
      .map(([each]) => each);
    if (methods.length > 0) {
      return { name, methods };
    }
  }
  return null;
}

/**
 * The runtime method a host function's validated call is: the `op` of one that serves several
 * (`artifact`, `assets`, `db`), else its one method.
 */
export function methodOf(serves: CapabilityName, args: unknown): string | null {
  const family = familyOf(serves);
  if (family === null) {
    return null;
  }
  if (family.methods.length === 1) {
    return family.methods[0] ?? null;
  }
  const op =
    args !== null && typeof args === "object" ? (args as { readonly op?: unknown }).op : undefined;
  return typeof op === "string" && family.methods.includes(op) ? op : null;
}

/**
 * The runtime methods a validated call runs, each as often as it runs it: its own, and for a db
 * batch each of its writes' (`set`, `update`, `delete`), for a db watch the read it repeats (`get`
 * for a document, `query` for a collection). Each one's level and gates apply to the call (P091
 * item 4 for levels, P094 for gates): a batch is its writes, a watch its read.
 */
export function methodsOfCall(serves: CapabilityName, args: unknown): readonly string[] {
  const own = methodOf(serves, args);
  if (own === null) {
    return [];
  }
  if (serves !== "db") {
    return [own];
  }
  const request = args as {
    readonly op: string;
    readonly path?: string;
    readonly writes?: readonly { readonly op: string }[];
  };
  if (request.op === "batch") {
    return [own, ...(request.writes ?? []).map((write) => write.op)];
  }
  if (request.op === "watch") {
    return [own, (request.path ?? "").split("/").length % 2 === 0 ? "get" : "query"];
  }
  return [own];
}

/**
 * Whether a config's asset uploads are its admins' alone (`assets.upload` at admin or above,
 * P089): only then may scripts and styles an admin uploaded run from the library.
 */
export function assetCodeRuns(config: PortholeConfig): boolean {
  const level = methodLevel(config, "assets", "upload");
  return level !== null && atLeast(level, "admin");
}

/**
 * A runtime method's own gates (after the review): the config's (`CapabilityConfig.methodGates`),
 * else the contract's; an upload where uploaded code may run is confirmed (P089).
 */
export function methodGates(
  config: PortholeConfig,
  family: RuntimeCapabilityName,
  name: string,
): readonly Gate[] {
  const methods: Readonly<Record<string, RuntimeMethod>> = runtimeCapability(family).methods;
  const spec = Object.hasOwn(methods, name) ? methods[name] : undefined;
  if (spec === undefined) {
    return [];
  }
  const own = config.capabilities[spec.serves]?.methodGates;
  if (own !== undefined && Object.hasOwn(own, name)) {
    return own[name] ?? [];
  }
  if (family === "assets" && name === "upload") {
    return assetCodeRuns(config) ? ["confirm"] : [];
  }
  return spec.gates ?? [];
}

/** What a page declared for one capability, as far as levels go (P086). */
export interface DeclaredLevels {
  readonly levels?: Readonly<Record<string, ViewerLevel>>;
}

/**
 * The least level that may call `family.method` (P087): the contract's, or the host's config
 * (`CapabilityConfig.levels`, no lower than the floor), raised by the page's declaration.
 */
export function methodLevel(
  config: PortholeConfig,
  family: RuntimeCapabilityName,
  name: string,
  declared?: DeclaredLevels,
): ViewerLevel | null {
  const methods: Readonly<Record<string, RuntimeMethod>> = runtimeCapability(family).methods;
  const spec = Object.hasOwn(methods, name) ? methods[name] : undefined;
  if (spec === undefined) {
    return null;
  }
  const host = config.capabilities[spec.serves]?.levels?.[name];
  const base = host === undefined ? spec.level : higher(host, spec.floor);
  // The page's own names only (P093): a declaration a host passes unchecked may be a plain object.
  const levels = declared?.levels;
  const page = levels !== undefined && Object.hasOwn(levels, name) ? levels[name] : undefined;
  return page === undefined ? base : higher(base, page);
}

/**
 * What the host offers a display (P085): each runtime capability the config serves at least one
 * method of (with those methods), reachable when it is built in or the page declared it. Without
 * `config.runtime`, nothing: the display is 0.6's. `declared` is the page's declaration's names;
 * absent, the page declared nothing (built-ins only).
 */
export function rosterOf(
  config: PortholeConfig,
  declared?: readonly string[],
): Readonly<Partial<Record<RuntimeCapabilityName, readonly string[]>>> {
  if (config.runtime === undefined) {
    return {};
  }
  const roster: Partial<Record<RuntimeCapabilityName, readonly string[]>> = {};
  for (const name of RUNTIME_CAPABILITY_NAMES) {
    const spec = runtimeCapability(name);
    if (!spec.builtIn && !(declared ?? []).includes(name)) {
      continue;
    }
    const methods = Object.entries(spec.methods)
      .filter(([, each]) => config.capabilities[each.serves] !== undefined)
      .map(([each]) => each);
    if (methods.length > 0) {
      roster[name] = methods;
    }
  }
  return roster;
}

/** The capabilities a config offers to pages that declare them (for the manual and `declareCapabilities`). */
export function offeredCapabilities(config: PortholeConfig): RuntimeCapabilityName[] {
  if (config.runtime === undefined) {
    return [];
  }
  return RUNTIME_CAPABILITY_NAMES.filter((name) =>
    Object.values(runtimeCapability(name).methods).some(
      (each) => config.capabilities[each.serves] !== undefined,
    ),
  );
}
