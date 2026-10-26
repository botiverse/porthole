import {
  MAX_CONTEXT_CHARS,
  MAX_COPY_CHARS,
  capabilitySpec,
  type CapabilityArgs,
  type CapabilityName,
  type CapabilityResults,
} from "../config/capabilities.ts";
import type { AnnotationReport } from "../annotate/types.ts";
import { parseReport } from "../annotate/validate.ts";
import type { PortholeConfig } from "../config/schema.ts";
import { callGates, effectiveGates } from "../compile/policy.ts";
import { boundedText } from "./bounded-text.ts";
import { isJsonData } from "./json-data.ts";
import { unseen } from "./unseen.ts";
import { blockedNavigationMessage, cutText, withoutSealedAddresses } from "./navigation.ts";
import {
  RUNTIME_HOST_FUNCTIONS,
  familyOf,
  methodGates,
  methodLevel,
  methodOf,
  methodsOfCall,
  assetCodeRuns,
  rosterOf,
  runtimeCapability,
  type RuntimeCapabilityName,
} from "../runtime/contract.ts";
import {
  declaredMatch,
  type DeclaredCapability,
  type PageDeclaration,
} from "../runtime/declaration.ts";
import { dbAccess, parseDbRequest, withMe, type DbRequest } from "../runtime/db.ts";
import { atLeast, higher, type ViewerInfo, type ViewerLevel } from "../runtime/levels.ts";
import {
  isCodeAsset,
  parseArtifactRequest,
  parseAssetRequest,
  parseCommentRequest,
} from "../runtime/requests.ts";
import {
  defaultReason,
  isRefused,
  pendingReason,
  reasonOf,
  type Refused,
  type RefusalReason,
} from "./refusal.ts";
import type {
  CallOptions,
  CallOutcome,
  CapabilityHandler,
  CapabilityHandlers,
  Confirm,
  ConfirmAnswer,
  ConfirmDisplay,
  ConfirmRequest,
  Consent,
  DataCache,
  HostFunctionBridge,
  Refusal,
  Show,
} from "./types.ts";

/**
 * The host-function bridge: every capability call from a frame passes here, and nowhere else
 * reaches a host handler. In order (`call`): the run not stopped (`close`) → declared by the
 * config → declared by the page, where it has a declaration (P086) → before the arguments are
 * read (`precheck`): for the runtime's own, a method by its `op` and the viewer's level, then for
 * every capability its host function's own rate (P091, P095) → arguments well formed and within
 * their limits → who may (P087: the level of each method the call runs for the viewer, a page's
 * named data with or without a viewer, db's rules) → not muted, if confirm-gated → the own rate
 * of each method it runs (P094: a batch's writes count each) → a user gesture, if gated so (and
 * for `comments`, the host page's focus in the calling frame: P109) → the
 * viewer's consent, if gated so → a person's confirmation, if gated so (at most 10 waiting) →
 * shown to the person, if gated so (P100) → the handler (or, for a read, a result the host already
 * gave for it, or for a stale-allowed one the host's cache).
 */

export type BridgeEvent =
  | { readonly type: "resize"; readonly height: number; readonly width?: number }
  | { readonly type: "error"; readonly message: string }
  /** The shell cancelled a navigation of the frame to `url` (P080): the content's word. */
  | { readonly type: "navigationBlocked"; readonly url: string }
  | { readonly type: "annotation"; readonly report: AnnotationReport }
  | { readonly type: "refused"; readonly capability: CapabilityName; readonly refusal: Refusal }
  | { readonly type: "muted" };

export interface BridgeOptions {
  readonly config: PortholeConfig;
  readonly display: ConfirmDisplay;
  readonly handlers: CapabilityHandlers;
  readonly confirm?: Confirm;
  /**
   * Asked before a `consent`-gated call (P079). The host's, made to ask once per display by the
   * caller (`createHost` keeps the answer across the display's frames). A `Refused` refuses every
   * such call with it, asking nothing (P080).
   */
  readonly consent?: Consent | Refused;
  /**
   * Puts a `show`-gated call's whole effect in front of the person before its handler runs (P100).
   * Absent: those calls are refused.
   */
  readonly show?: Show;
  /** The host's cache, for reads that may be answered stale (`CallOptions.stale`, P079). */
  readonly cached?: DataCache;
  /** Whether the embedding page has user activation now; undefined where it can't tell. */
  readonly userActivation?: () => boolean | undefined;
  /**
   * Whether the embedding page's focus is in this display's frame now (P109); undefined where it
   * can't tell. A capability whose gesture must be in its frame (`inFrame`: `comments`) is refused
   * without it.
   */
  readonly focused?: () => boolean | undefined;
  readonly onEvent: (event: BridgeEvent) => void;
  /** The clock, in milliseconds (tests pass their own). */
  readonly now?: () => number;
  /**
   * Who is viewing (P087), as the host said: each runtime method's level is checked against it,
   * and the runtime's own host functions need it. Absent: 0.6's functions run unchecked, as before.
   */
  readonly viewer?: ViewerInfo;
  /**
   * What the display's page declared (P086), checked against the config (`checkDeclaration`).
   * Absent: a page without one (0.6's): built-ins only through the runtime, and 0.6's globals and
   * requests as before.
   */
  readonly declaration?: PageDeclaration | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether `capability`'s gesture must be in its own frame (P109: the host page's focus there). */
const inFrame = (capability: CapabilityName): boolean =>
  capabilitySpec(capability).inFrame === true;

const MAX_URL = 4_096;

/**
 * The most confirmations one display has waiting at once (P095): past it a call is refused as
 * rate-limited, asking no one (and counted as no decline).
 */
const MAX_WAITING_CONFIRMS = 10;

/** The most of an error report the host is told. */
const MAX_ERROR_CHARS = 2_000;

/** An http(s) URL without credentials in it (`https://bank.example@evil.example` reads as a lie). */
export function linkTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return url.href;
}

/** A resource's URI, as `resources/read` and `resources/subscribe` carry it. */
function resourceUri(args: unknown): { uri: string } | null {
  const uri = isRecord(args) ? args.uri : undefined;
  return typeof uri === "string" && uri !== "" && uri.length <= MAX_URL ? { uri } : null;
}

/** The most text blocks one model context update holds. */
const MAX_CONTEXT_BLOCKS = 100;

/** Whether any string in `value`, a key or a value, holds what can't be seen (bounded JSON data). */
function holdsUnseen(value: unknown): boolean {
  if (typeof value === "string") {
    return unseen(value);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).some(holdsUnseen);
  }
  return Object.entries(value).some(([key, each]) => unseen(key) || holdsUnseen(each));
}

/**
 * A model context update (P100), as the person is shown it and the model reads it: text blocks
 * only (what the host offers, `updateModelContext: { text, structuredContent }`), each rebuilt as
 * `{ type, text }` so nothing rides along unshown (`_meta`, `annotations`); structured content
 * JSON data by P095's one rule (`isJsonData`: each object once, no cycles, bounded); at most
 * `MAX_CONTEXT_CHARS` together as the person is shown it, its JSON measured only once that walk
 * has bounded it; nothing in a text or a string they can't see (`UNSEEN`).
 */
function modelContext(args: unknown): CapabilityArgs["setModelContext"] | "too_large" | null {
  if (!isRecord(args)) {
    return null;
  }
  const { content, structuredContent } = args;
  let chars = 0;
  let blocks: { type: "text"; text: string }[] | undefined;
  if (content !== undefined) {
    if (!Array.isArray(content) || content.length > MAX_CONTEXT_BLOCKS) {
      return null;
    }
    blocks = [];
    for (const block of content as unknown[]) {
      if (
        !isRecord(block) ||
        block.type !== "text" ||
        typeof block.text !== "string" ||
        unseen(block.text)
      ) {
        return null;
      }
      chars += block.text.length;
      if (chars > MAX_CONTEXT_CHARS) {
        return "too_large";
      }
      blocks.push({ type: "text", text: block.text });
    }
  }
  if (structuredContent !== undefined) {
    // P095's one rule for JSON data; then this update's own size, as the person is shown it.
    if (!isRecord(structuredContent) || !isJsonData(structuredContent)) {
      return null;
    }
    chars += JSON.stringify(structuredContent).length;
    if (chars > MAX_CONTEXT_CHARS) {
      return "too_large";
    }
    // Within the size now: each string, value or key, is walked once.
    if (holdsUnseen(structuredContent)) {
      return null;
    }
  }
  return {
    ...(blocks === undefined ? {} : { content: blocks }),
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

/** A call's arguments checked: the capability's, or null (malformed), or "too_large". */
type Validator<N extends CapabilityName> = (
  args: unknown,
  config: PortholeConfig,
) => CapabilityArgs[N] | "too_large" | null;

const VALIDATORS: { readonly [N in CapabilityName]: Validator<N> } = {
  sendPrompt: (args, config) => {
    const text = isRecord(args) ? args.text : undefined;
    return typeof text === "string" &&
      text.trim() !== "" &&
      text.length <= config.limits.maxPromptChars
      ? { text }
      : null;
  },
  openLink: (args) => {
    const url = linkTarget(isRecord(args) ? args.url : undefined);
    return url === null ? null : { url };
  },
  downloadFile: (args) => {
    const contents = isRecord(args) ? args.contents : undefined;
    // Plain, bounded JSON only (P095): what reaches the dialog and the handler is what MCP says.
    return Array.isArray(contents) &&
      contents.length > 0 &&
      contents.length <= 100 &&
      isJsonData(contents)
      ? { contents }
      : null;
  },
  callTool: (args) => {
    if (
      !isRecord(args) ||
      typeof args.name !== "string" ||
      args.name === "" ||
      args.name.length > 256
    ) {
      return null;
    }
    const given = args.arguments ?? {};
    return isRecord(given) && isJsonData(given) ? { name: args.name, arguments: given } : null;
  },
  readData: (args) => resourceUri(args),
  subscribeData: (args) => resourceUri(args),
  setModelContext: (args) => modelContext(args),
  reportError: (args, config) => {
    // A navigation the shell cancelled (P080): Porthole words it, naming the address without its
    // query; the address itself goes to the host whole.
    // A frame's sealed files' address never reaches the host from here (P083): `./` instead.
    const blocked = isRecord(args) ? args.navigationBlocked : undefined;
    if (blocked !== undefined) {
      if (typeof blocked !== "string" || blocked === "" || blocked.length > MAX_URL) {
        return null;
      }
      const url = withoutSealedAddresses(blocked);
      return { message: blockedNavigationMessage(url, config), navigationBlocked: url };
    }
    // What content said (S05, P095): any value, read only now, after its rate (`precheck`), into
    // bounded text, then scrubbed, then cut to what the host is told.
    const message = isRecord(args) ? args.message : undefined;
    if (message === undefined) {
      return null;
    }
    const text = cutText(withoutSealedAddresses(boundedText(message)), MAX_ERROR_CHARS);
    return text === "" ? null : { message: text };
  },
  copyText: (args) => {
    const text = isRecord(args) ? args.text : undefined;
    return typeof text === "string" && text !== "" && text.length <= MAX_COPY_CHARS
      ? { text }
      : null;
  },
  annotate: (args) => parseReport(args),
  // The runtime's own (P088-P090): their shapes and limits, before any gate.
  user: (args) => (args === undefined || isRecord(args) ? {} : null),
  comments: (args) => parseCommentRequest(args),
  artifact: (args, config) => parseArtifactRequest(args, config.limits),
  // Code-typed names only where uploaded code may run (P089, after the review).
  assets: (args, config) => parseAssetRequest(args, config.limits, assetCodeRuns(config)),
  db: (args) => parseDbRequest(args),
  resize: (args) => {
    if (
      !isRecord(args) ||
      typeof args.height !== "number" ||
      !Number.isFinite(args.height) ||
      args.height < 0
    ) {
      return null;
    }
    const width = args.width;
    return typeof width === "number" && Number.isFinite(width) && width >= 0
      ? { height: args.height, width }
      : { height: args.height };
  },
};

/**
 * The host's `consent`, asked once (P079): the first call asks, every later one gets that answer,
 * for as long as the returned function is kept (`createHost` keeps one per display). A `Refused`
 * it throws is an answer, kept and thrown again at every call (P080); anything else it throws is
 * no answer: thrown for that call, and the next asks again.
 */
export function onceConsent(consent: Consent): Consent {
  let answer: Promise<boolean | Refused> | null = null;
  return async (request) => {
    const asked = (answer ??= Promise.resolve()
      .then(() => consent(request))
      .then(
        // Only a real yes: anything else a host's function gives is a no (fail closed).
        (allowed: unknown) => allowed === true,
        (error: unknown) => {
          if (isRefused(error)) {
            return error;
          }
          answer = null;
          throw error;
        },
      ));
    const given = await asked;
    if (typeof given !== "boolean") {
      throw given;
    }
    return given;
  };
}

/** Whether a page's `data` names the resource or tool a data call is for (P086). */
function dataNamed(
  declaration: PageDeclaration,
  capability: CapabilityName,
  args: unknown,
): boolean {
  const data = declaration.capabilities.data;
  return capability === "callTool"
    ? declaredMatch(data?.tools, (args as CapabilityArgs["callTool"]).name)
    : declaredMatch(data?.resources, (args as CapabilityArgs["readData"]).uri);
}

/** What the page declared for one runtime capability, if it declared it. */
function declaredOf(
  declaration: PageDeclaration | undefined,
  family: RuntimeCapabilityName,
): DeclaredCapability | undefined {
  const capabilities = declaration?.capabilities as
    | Readonly<Record<string, DeclaredCapability>>
    | undefined;
  return capabilities !== undefined && Object.hasOwn(capabilities, family)
    ? capabilities[family]
    : undefined;
}

/** A display's bridge: `close()` when its run stops (a restart, its end; P095, after the review). */
export interface DisplayBridge extends HostFunctionBridge {
  /**
   * The run is over: every call waiting for a confirmation is refused at once, a yes that comes
   * later (or its `proceed`) runs nothing, and no new call is taken.
   */
  close(): void;
}

/** What a stopped display's calls are refused with (the host's words; its frame is gone). */
const STOPPED = "the display stopped before this was answered";

export function createBridge(options: BridgeOptions): DisplayBridge {
  const { config, display, handlers, onEvent } = options;
  const now = options.now ?? (() => Date.now());
  const calls = new Map<string, number[]>();
  let declines = 0;
  let muted = false;
  /** Confirmations asked and not yet answered: a frame's calls can't queue without end (P095). */
  let waiting = 0;
  /** Closed (`close`): its run stopped. What each waiting confirmation's wait is ended by. */
  let closed = false;
  const ending = new Set<() => void>();

  const refuse = <T>(
    capability: CapabilityName,
    refusal: Refusal,
    message?: string,
    reason?: RefusalReason,
  ): CallOutcome<T> => {
    onEvent({ type: "refused", capability, refusal });
    return {
      ok: false,
      refusal,
      ...(message === undefined ? {} : { message }),
      reason: reason ?? defaultReason(capability, refusal),
    };
  };

  /** Counts `times` calls against `key`'s rate, unless they would pass it (then none). */
  const withinRate = (key: string, perMinute: number, times = 1): boolean => {
    const at = now();
    const recent = (calls.get(key) ?? []).filter((time) => at - time < 60_000);
    if (recent.length + times > perMinute) {
      calls.set(key, recent);
      return false;
    }
    for (let each = 0; each < times; each += 1) {
      recent.push(at);
    }
    calls.set(key, recent);
    return true;
  };

  /**
   * The least level a call needs: the highest of the methods it runs (its own, a db batch's
   * writes', a watch's read's: after the review, neither escapes the levels of what it does).
   */
  function levelOf(
    capability: CapabilityName,
    family: RuntimeCapabilityName,
    args: unknown,
  ): ViewerLevel | null {
    const declared = declaredOf(options.declaration ?? undefined, family);
    const [own, ...inner] = methodsOfCall(capability, args);
    const level = own === undefined ? null : methodLevel(config, family, own, declared);
    if (level === null) {
      return null;
    }
    return inner.reduce<ViewerLevel>(
      (most, method) => higher(most, methodLevel(config, family, method, declared) ?? most),
      level,
    );
  }

  /**
   * Whether this viewer may make this call (P087), and the call as the handler gets it: the
   * call's level (the contract's, the host's, the page's; a batch's writes', a watch's read's),
   * the resources and tools a page's `data` names, and a `db` call's paths (another person's data
   * refused, `me` resolved, the page's rules). Without a viewer: the runtime's own are refused,
   * and under a runtime anything above view; a 0.6 config's functions run as before. The names a
   * page's declaration gives are held whether or not there is a viewer (P094).
   */
  function checkAudience<N extends CapabilityName>(
    capability: N,
    family: RuntimeCapabilityName,
    args: CapabilityArgs[N],
  ): CapabilityArgs[N] | "undeclared" | "level" {
    const { viewer } = options;
    const declaration = options.declaration ?? undefined;
    if (methodOf(capability, args) === null) {
      return args;
    }
    const needed = levelOf(capability, family, args);
    // What the page's `data` names (P086): the declaration's word, not the viewer's, so it holds
    // without a viewer too (P094). A page with no declaration is 0.6's: the host's handlers decide.
    const named =
      family !== "data" || declaration === undefined || dataNamed(declaration, capability, args);
    if (viewer === undefined) {
      if (RUNTIME_HOST_FUNCTIONS.includes(capability)) {
        return "level";
      }
      // Under a runtime, a level the host set is never skipped for want of a viewer.
      if (config.runtime !== undefined && needed !== null && needed !== "view") {
        return "level";
      }
      return named ? args : "undeclared";
    }
    if (needed !== null && !atLeast(viewer.level, needed)) {
      return "level";
    }
    if (!named) {
      return "undeclared";
    }
    if (capability === "db") {
      const rules = declaration?.capabilities.db?.rules;
      const access = dbAccess(args as DbRequest, viewer, rules);
      return access.ok ? (access.request as CapabilityArgs[N]) : "level";
    }
    if (capability === "assets" && (args as CapabilityArgs["assets"]).op === "upload") {
      // What an upload may become (P089): code only an admin added where uploaded code may run.
      const upload = args as CapabilityArgs["assets"] & { readonly op: "upload" };
      return {
        ...upload,
        trusted:
          isCodeAsset(upload.name) && assetCodeRuns(config) && atLeast(viewer.level, "admin"),
      } as CapabilityArgs[N];
    }
    return args;
  }

  /**
   * The cheap checks, before a call's arguments are read (after the review: a malformed call
   * costs nothing but its rate): for the runtime's own, a method by its `op` and a viewer at its
   * level; for every capability, its host function's rate (P095: what content says, in any shape,
   * is read only within it).
   */
  function precheck(capability: CapabilityName, raw: unknown): Refusal | null {
    if (!RUNTIME_HOST_FUNCTIONS.includes(capability)) {
      return withinOwnRates(capability) ? null : "rate-limited";
    }
    const family = familyOf(capability);
    const method = methodOf(capability, raw);
    if (family === null || method === null) {
      return "invalid";
    }
    const viewer = options.viewer;
    const needed = methodLevel(
      config,
      family.name,
      method,
      declaredOf(options.declaration ?? undefined, family.name),
    );
    if (viewer === undefined || (needed !== null && !atLeast(viewer.level, needed))) {
      return "level";
    }
    return withinOwnRates(capability) ? null : "rate-limited";
  }

  /** Whether a call is within its host function's own rates, each counted. */
  function withinOwnRates(capability: CapabilityName): boolean {
    for (const gate of effectiveGates(config, capability)) {
      if (typeof gate === "object" && !withinRate(capability, gate.rateLimit.perMinute)) {
        return false;
      }
    }
    return true;
  }

  return {
    close() {
      closed = true;
      // Each ends a wait; the wait leaves the set later, in its own `finally`.
      for (const end of ending) {
        end();
      }
    },

    declared: (capability) => config.capabilities[capability] !== undefined,

    roster: () =>
      rosterOf(
        config,
        options.declaration === undefined || options.declaration === null
          ? []
          : Object.keys(options.declaration.capabilities),
      ),

    async call<N extends CapabilityName>(
      capability: N,
      raw: unknown,
      callOptions?: CallOptions,
    ): Promise<CallOutcome<CapabilityResults[N]>> {
      type Result = CapabilityResults[N];
      if (closed) {
        return refuse<Result>(capability, "failed", STOPPED);
      }
      if (config.capabilities[capability] === undefined) {
        return refuse<Result>(capability, "not-declared");
      }
      // The page's declaration (P086): a built-in needs none; any other runtime capability only
      // a page that declared it reaches; a page with no declaration, none of the runtime's own.
      const family = familyOf(capability);
      // No declaration, or the host's explicit null for a page from before 0.7 (P086).
      const declaration = options.declaration ?? undefined;
      if (
        family !== null &&
        !runtimeCapability(family.name).builtIn &&
        (declaration === undefined
          ? RUNTIME_HOST_FUNCTIONS.includes(capability)
          : !Object.hasOwn(declaration.capabilities, family.name))
      ) {
        return refuse<Result>(capability, "undeclared");
      }
      const early = precheck(capability, raw);
      if (early !== null) {
        return refuse<Result>(capability, early);
      }
      const parsed = (VALIDATORS[capability] as Validator<N>)(raw, config);
      if (parsed === null) {
        return refuse<Result>(capability, "invalid");
      }
      if (parsed === "too_large") {
        return refuse<Result>(capability, "too-large");
      }
      let args: CapabilityArgs[N] = parsed;
      // Who may (P087): the method's level against the viewer's, the page's own narrowing.
      if (family !== null) {
        const audience = checkAudience(capability, family.name, args);
        if (audience === "undeclared" || audience === "level") {
          return refuse<Result>(capability, audience as Refusal);
        }
        args = audience;
      }
      // Its host function's gates, and the own gates of each method it runs (after the review;
      // P094: a db batch's writes', a watch's read's): all apply.
      const gates = callGates(config, capability, args);
      const own = new Set(effectiveGates(config, capability));
      const confirms = gates.includes("confirm");
      if (confirms && muted) {
        return refuse<Result>(capability, "muted");
      }
      // Its host function's own rate was counted before its arguments were read (`precheck`).
      // A method's rate counts each time the call runs it, with its direct calls: a batch of
      // three sets is three sets (P094).
      if (family !== null) {
        const times = new Map<string, number>();
        for (const method of methodsOfCall(capability, args)) {
          times.set(method, (times.get(method) ?? 0) + 1);
        }
        for (const [method, count] of times) {
          for (const gate of methodGates(config, family.name, method)) {
            if (
              typeof gate === "object" &&
              !own.has(gate) &&
              !withinRate(`${capability}.${method}`, gate.rateLimit.perMinute, count)
            ) {
              return refuse<Result>(capability, "rate-limited");
            }
          }
        }
      }
      if (gates.includes("user-activation")) {
        const activated = callOptions?.userActivated ?? options.userActivation?.();
        if (activated === false) {
          return refuse<Result>(capability, "no-user-activation");
        }
        // A gesture in this frame, not anywhere on the host's page (P109): the person typing in
        // the host's composer gives its page activation, which a frame's call would borrow.
        if (inFrame(capability) && options.focused?.() === false) {
          return refuse<Result>(capability, "no-user-activation");
        }
      }
      if (gates.includes("consent")) {
        const consent = options.consent;
        if (consent === undefined) {
          return refuse<Result>(capability, "no-consent");
        }
        // The host's policy, known before any call: every one refused with its reason (P080).
        if (isRefused(consent)) {
          return refuse<Result>(capability, "denied", undefined, reasonOf(consent));
        }
        let answer: unknown = false;
        try {
          answer = await consent({ capability, args, display } as ConfirmRequest);
        } catch (error) {
          // A Refused is the host's no, with its reason; any other failure is no answer yet.
          return refuse<Result>(
            capability,
            "denied",
            undefined,
            isRefused(error) ? reasonOf(error) : pendingReason(capability),
          );
        }
        if (answer !== true) {
          return refuse<Result>(capability, "denied");
        }
      }
      // The run may have stopped while the viewer's consent was awaited: then no one is asked.
      if (closed) {
        return refuse<Result>(capability, "failed", STOPPED);
      }
      // Shown to the person first (P100): only a call that will go, so after their yes; nobody
      // shown it (no `show`, one that failed, a run that stopped meanwhile), it doesn't go.
      const shows = gates.includes("show");
      if (shows && options.show === undefined) {
        return refuse<Result>(capability, "no-show");
      }
      const shown = async (): Promise<CallOutcome<Result>> => {
        let end = () => {};
        const ended = new Promise<typeof STOPPED>((resolve) => {
          end = () => resolve(STOPPED);
          ending.add(end);
        });
        try {
          // Called now (inside a confirm's click, where it runs from `proceed`); a show that never
          // ends is ended by `close`, like a confirmation.
          await Promise.race([
            (async () => options.show?.({ capability, args, display } as ConfirmRequest))(),
            ended,
          ]);
        } catch (error) {
          return refuse<Result>(
            capability,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          ending.delete(end);
        }
        if (closed) {
          return refuse<Result>(capability, "failed", STOPPED);
        }
        return perform(capability, args, callOptions);
      };
      // The effect, run once: when the person's "yes" calls `proceed` (inside its own click, so an
      // effect that needs a gesture gets one), or after `confirm` resolves accepted.
      let effect: Promise<CallOutcome<Result>> | null = null;
      // Never once the bridge is closed: a yes to a stopped run's request does nothing.
      const run = (): Promise<CallOutcome<Result>> =>
        (effect ??= closed
          ? Promise.resolve(refuse<Result>(capability, "failed", STOPPED))
          : shows
            ? shown()
            : perform(capability, args, callOptions));
      if (confirms) {
        if (options.confirm === undefined) {
          return refuse<Result>(capability, "no-confirm");
        }
        if (waiting >= MAX_WAITING_CONFIRMS) {
          return refuse<Result>(capability, "rate-limited", undefined, {
            code: "rate_limited",
            message: "Too many confirmations are waiting: try again once they are answered.",
          });
        }
        let answer: ConfirmAnswer | typeof STOPPED = false;
        waiting += 1;
        let end = () => {};
        const ended = new Promise<typeof STOPPED>((resolve) => {
          end = () => resolve(STOPPED);
          ending.add(end);
        });
        try {
          // Which of the methods the call runs asked for this yes (P094): a batch's gated writes.
          const askedBy =
            family === null
              ? []
              : [...new Set(methodsOfCall(capability, args))].filter((each) =>
                  methodGates(config, family.name, each).includes("confirm"),
                );
          answer = await Promise.race([
            options.confirm(
              {
                capability,
                args,
                display,
                ...(askedBy.length === 0 ? {} : { askedBy }),
              } as ConfirmRequest,
              () => void run(),
            ),
            ended,
          ]);
        } catch {
          answer = effect === null ? false : "accepted";
        } finally {
          waiting -= 1;
          ending.delete(end);
        }
        if (closed && effect === null) {
          return refuse<Result>(capability, "failed", STOPPED);
        }
        if (effect === null && answer !== true && answer !== "accepted") {
          if (answer === "redirected") {
            return refuse<Result>(capability, "redirected");
          }
          // Declines in a row mute the display; a yes starts the count again.
          declines += 1;
          if (declines >= config.limits.declinesBeforeMute && !muted) {
            muted = true;
            onEvent({ type: "muted" });
          }
          return refuse<Result>(capability, "declined");
        }
        declines = 0;
      }
      return run();
    },
  };

  async function perform<N extends CapabilityName>(
    capability: N,
    args: CapabilityArgs[N],
    callOptions: CallOptions | undefined,
  ): Promise<CallOutcome<CapabilityResults[N]>> {
    type Result = CapabilityResults[N];
    {
      if (capabilitySpec(capability).served === "event") {
        if (capability === "resize") {
          const size = args as CapabilityArgs["resize"];
          onEvent({ type: "resize", ...size });
        } else if (capability === "annotate") {
          onEvent({ type: "annotation", report: args as CapabilityArgs["annotate"] });
        } else {
          const report = args as CapabilityArgs["reportError"];
          if (report.navigationBlocked !== undefined) {
            onEvent({ type: "navigationBlocked", url: report.navigationBlocked });
          }
          onEvent({ type: "error", message: report.message });
        }
        return { ok: true, value: undefined as Result };
      }
      if (capabilitySpec(capability).served === "viewer") {
        // `user` (P087): the viewer the host gave the display, and nothing else.
        const viewer = options.viewer;
        if (viewer === undefined) {
          return refuse<Result>(capability, "level");
        }
        return {
          ok: true,
          value: {
            id: viewer.id ?? null,
            name: viewer.name ?? null,
            level: viewer.level,
          } as Result,
        };
      }
      // A result the host already gave for this read (a subscription's `changed(result)`, the
      // fresh read after a stale answer), past every gate a read has (P094): no handler is asked,
      // and none is needed (P079).
      if (capability === "readData" && callOptions?.held !== undefined) {
        // Kept for another URI (an adapter that mixed its keys): no answer, never that one's data.
        return callOptions.held.uri === (args as CapabilityArgs["readData"]).uri
          ? { ok: true, value: callOptions.held.value as Result }
          : refuse<Result>(capability, "invalid");
      }
      const handler = (handlers as Record<string, CapabilityHandler<N> | undefined>)[capability];
      if (handler === undefined) {
        return refuse<Result>(capability, "not-declared");
      }
      const family = familyOf(capability);
      const declared =
        family === null ? undefined : declaredOf(options.declaration ?? undefined, family.name);
      const context = {
        displayId: display.id,
        title: display.title,
        capability,
        ...(display.instance === undefined ? {} : { instance: display.instance }),
        ...(options.viewer === undefined ? {} : { viewer: options.viewer }),
        ...(declared === undefined ? {} : { declared }),
      };
      // A read the content subscribes to may be answered from the host's cache, marked stale; the
      // fresh one follows as an update (the adapter asks for it). A cache that fails is no answer.
      if (capability === "readData" && callOptions?.stale === true && options.cached) {
        try {
          const cached = await options.cached(args as CapabilityArgs["readData"], context);
          if (cached !== undefined) {
            return { ok: true, value: cached as Result, stale: true };
          }
        } catch {
          // Read it fresh instead.
        }
      }
      const subscription = callOptions?.subscription;
      // A subscription (`subscribeData`, a `db` watch) needs its channel back.
      const watches =
        capability === "subscribeData" ||
        (capability === "db" && (args as CapabilityArgs["db"]).op === "watch");
      if (watches && subscription === undefined) {
        return refuse<Result>(capability, "invalid");
      }
      // A db answer names the viewer's own tree `me`, never their id (after the review, P088).
      const viewer = options.viewer;
      const channel =
        watches && subscription !== undefined && capability === "db"
          ? {
              changed: (state?: unknown) => subscription.changed(withMe(state, viewer)),
              signal: subscription.signal,
            }
          : subscription;
      try {
        const answered = await (handler as (args: unknown, context: unknown) => unknown)(
          args,
          watches ? { ...context, ...channel } : context,
        );
        const value = capability === "db" ? withMe(answered, viewer) : answered;
        // Comments are write-only (P090): content hears whether the composer opened, never what
        // the host answered beyond that (a thread, its text).
        if (capability === "comments") {
          return { ok: true, value: (value === true) as Result };
        }
        return { ok: true, value: value as Result };
      } catch (error) {
        // A host's Refused tells content its reason (P080); any other error stays the host's.
        return refuse<Result>(
          capability,
          "failed",
          error instanceof Error ? error.message : String(error),
          isRefused(error) ? reasonOf(error) : undefined,
        );
      }
    }
  }
}
