import { ANNOTATE_METHODS, type AnnotationMark, type AnnotationReport } from "../annotate/types.ts";
import {
  annotateMode,
  checkMarks,
  clampRect,
  followsSelection,
  hasMarker,
  inViewport,
  parseReport,
  type StartedMode,
} from "../annotate/validate.ts";
import { FIND_LIMITS, FIND_METHODS, type FindReport, type FindResult } from "../find/types.ts";
import { blankQuery, checkFindQuery, parseFindReport, parseFindResult } from "../find/validate.ts";
import {
  createBridge,
  onceConsent,
  type BridgeEvent,
  type DisplayBridge,
} from "../bridge/bridge.ts";
import type { HostFunctionBridge } from "../bridge/types.ts";
import { compile } from "../compile/compile.ts";
import { servesFiles } from "../files/paths.ts";
import { pagesOfSet } from "./pages-of-set.ts";
import { declaredCapabilities, effectiveGates } from "../compile/policy.ts";
import { isRefused } from "../bridge/refusal.ts";
import { capabilitySpec } from "../config/capabilities.ts";
import type { ColorScheme, PortholeConfig } from "../config/schema.ts";
import { locateServed } from "./locate.ts";
import { mayPassOn } from "./pass-on.ts";
import { watchOutcome, type OutcomeWatch } from "./outcome.ts";
import { watchDoor, type DoorWatch } from "./door.ts";
import { outcomeOfRefusal } from "./locator.ts";
import { STORAGE_USED_METHOD, type FrameSource } from "../isolation/types.ts";
import { webPlatform } from "../platform/web.ts";
import type { DoorSurface, Surface } from "../platform/types.ts";
import type { AdapterConnection, ProtocolAdapter, ShellConnection } from "../protocol/adapter.ts";
import {
  MCP_APPS_STYLE_VARIABLES,
  PORTHOLE_STYLES,
  type HostContext,
} from "../protocol/mcp-apps.ts";
import { shellAdapter } from "../protocol/shell-adapter.ts";
import { resolveTheme } from "../theme/variables.ts";
import { checkDeclaration } from "../runtime/declaration.ts";
import { parseViewer } from "../runtime/levels.ts";
import type {
  AnnotationControls,
  FindControls,
  HostErrorKind,
  DisplayEvents,
  DisplayHandle,
  HostOptions,
  MountOptions,
  PortholeHost,
} from "./types.ts";

/** How long a display may take to load before its outcome is a timeout, by default. */
const DEFAULT_LOAD_TIMEOUT_MS = 15_000;

/** How many times a display is started again after its content navigated its frame away. */
const MAX_RESTARTS = 3;

/** What the host is told of a served display located without its door (P125), once a mount. */
export const NO_DOOR =
  "A served display needs a door from issue (FrameLocation.door, P125), and this location has none, so no frame was made: upgrade the server (or content Worker) that issues it, and pass the door on from a locator of your own. A clean address is for a tab: to frame what it names, resolve it with client.resolve(address) or <PortholeView address>";

/**
 * What the host is told when its locator gives a run the location an earlier run had (P125): its
 * tickets were taken by that run, so its door says `blocked: session`. A locator issues anew for
 * every run (a reload, a restart after the content navigated away).
 */
export const REUSED_LOCATION =
  "The locator gave this run a location an earlier run of this display already used (P125): its tickets are taken, so its door answers that the link has been used. A locator must issue anew for every run (InstanceLocator.locate is called for each one)";

/** What the host is told when its platform makes no doors (P125): no served frame is made. */
export const NO_DOOR_PLATFORM =
  "This platform makes no door frames (PlatformHost.createDoor, P125), so no served display is framed on it";

const BASE_KEYS = new Set(["hostContextChanged", "teardown", "close"]);

/** The frame's annotation reports, by method. */
const REPORTS: Readonly<Record<string, AnnotationReport["type"]>> = {
  [ANNOTATE_METHODS.selected]: "selected",
  [ANNOTATE_METHODS.unselected]: "unselected",
  [ANNOTATE_METHODS.cancelled]: "cancelled",
  [ANNOTATE_METHODS.anchored]: "anchored",
  [ANNOTATE_METHODS.activated]: "activated",
  [ANNOTATE_METHODS.tracked]: "tracked",
  [ANNOTATE_METHODS.selectionTracked]: "selectionTracked",
};

/** What the frame says of find in page unasked (P131), by method. */
const FIND_REPORTS: Readonly<Record<string, FindReport["type"]>> = {
  [FIND_METHODS.requested]: "requested",
  [FIND_METHODS.updated]: "updated",
};

/** The most `tracked` reports a second the host takes (P112): one per animation frame at 60 Hz. */
export const TRACKED_PER_SECOND = 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const STANDARD = new Set(MCP_APPS_STYLE_VARIABLES);

/**
 * Compiles `config` once and returns a host that mounts displays under it. Throws a `ConfigError`
 * for a bad config.
 */
export function createHost<C extends AdapterConnection = ShellConnection>(
  config: PortholeConfig,
  options: HostOptions<C> = {},
): PortholeHost<C> {
  const compiled = compile(config);
  if (
    (config.isolation === "domain" || config.isolation === "external") &&
    options.locator === undefined
  ) {
    throw new TypeError(`${config.isolation} isolation needs a locator (HostOptions.locator)`);
  }
  // A url frame is someone else's app: no shell, no protocol, and its navigations are its own.
  const speaks = config.mode !== "url";
  // A served display on its scope's origin, beside the scope's other content (P125): its door
  // says how loading went, before its frame is made.
  const hasDoor = config.isolation === "domain" && speaks;
  const adapter = (options.adapter ?? shellAdapter) as ProtocolAdapter<C>;
  const platform = options.platform ?? webPlatform;
  const hostInfo = options.hostInfo ?? { name: "porthole", version: "0" };

  return {
    compiled,
    mayPassOn: (declaration) => mayPassOn(config, declaration),
    mount(container: HTMLElement, mount: MountOptions): DisplayHandle<C> {
      const handlers = { ...options.handlers, ...mount.handlers };
      // A host whose consent is a Refused refuses every consent-gated call before its handler:
      // those need none (P080).
      const refusesAll = isRefused(options.consent);
      const missing = declaredCapabilities(config).filter(
        (name) =>
          capabilitySpec(name).served === "handler" &&
          (handlers as Record<string, unknown>)[name] === undefined &&
          !(refusesAll && effectiveGates(config, name).includes("consent")),
      );
      if (missing.length > 0) {
        throw new TypeError(`No handler for the declared capabilities: ${missing.join(", ")}`);
      }
      if (config.isolation !== "opaque" && mount.instance === undefined) {
        throw new TypeError(`${config.isolation} isolation needs MountOptions.instance`);
      }
      // The page's declaration and the viewer (P086, P087): the host's records, checked once.
      // Under a runtime every mount says what its page declared, or null for a page published
      // before 0.7, which then has 0.6's surface (after the review: never by omission).
      if (config.runtime !== undefined && mount.declaration === undefined) {
        throw new TypeError(
          "Under config.runtime a mount needs MountOptions.declaration: the page's stored declaration, or null for a page published before 0.7",
        );
      }
      if (
        config.runtime === undefined &&
        mount.declaration !== undefined &&
        mount.declaration !== null
      ) {
        throw new TypeError(
          "MountOptions.declaration needs config.runtime: nothing would hold the page to it",
        );
      }
      const declaration =
        mount.declaration === undefined || mount.declaration === null
          ? null
          : checkDeclaration(mount.declaration, config);
      const mountViewer = mount.viewer === undefined ? null : parseViewer(mount.viewer);
      if (mount.viewer !== undefined && mountViewer === null) {
        throw new TypeError(
          "MountOptions.viewer is { level: view | interact | admin | owner, id?, name? }",
        );
      }

      const listeners = new Map<keyof DisplayEvents, Set<(detail: never) => void>>();
      const emit = <E extends keyof DisplayEvents>(event: E, detail: DisplayEvents[E]) => {
        // An outcome ends a loading episode: the next run (a restart, a reload) gets a clock of
        // its own (P125).
        if (event === "outcome") {
          episodeBegan = null;
        }
        for (const listener of listeners.get(event) ?? []) {
          (listener as (detail: DisplayEvents[E]) => void)(detail);
        }
      };
      // What the content did wrong (the agent's to hear and fix), and what failed on the host's
      // side (its own to handle), each on its own event and on `error` with its source.
      const contentError = (message: string) => {
        emit("contentError", { message });
        emit("error", { message, source: "content" });
      };
      const hostError = (message: string, kind: HostErrorKind) => {
        emit("hostError", { message, kind });
        emit("error", { message, source: "host" });
      };

      // A page the host doesn't theme (`documents: "never"`, P065) is always given light.
      const themeless = config.theme.documents === "never";
      let scheme: ColorScheme = themeless ? "light" : mount.scheme;
      let height = mount.initialHeightPx ?? 0;
      let surface: Surface | null = null;
      let connection: C | null = null;
      let bridge: DisplayBridge | null = null;
      let destroyed = false;
      let restarts = 0;
      // When the loading episode that has no outcome yet began: its first run, not each restart's
      // (P125). However often a frame is started again (a sibling of its scope wiping or
      // navigating it, P125 S7), the display's time runs out and it has an outcome.
      let episodeBegan: number | null = null;
      let generation = 0;
      // The viewer's answer for this display (P079): asked once, kept across its frames; or the
      // host's refusal of them all (P080).
      const consent =
        options.consent === undefined || isRefused(options.consent)
          ? options.consent
          : onceConsent(options.consent);
      let abort: AbortController | null = null;
      let outcomeWatch: OutcomeWatch | null = null;
      let door: { readonly frame: DoorSurface; readonly watch: DoorWatch } | null = null;
      // The addresses earlier runs were located at (P125): a ticket opens once, so a run given one
      // again is told to the host (its outcome is the server's word, unchanged).
      const locatedAt = new Set<string>();
      let themeFrame: number | null = null;
      const view = container.ownerDocument.defaultView;
      // The adapter's own operations, the last call of each, replayed into every new frame.
      const replay = new Map<string, unknown[]>();
      // Annotations: the host's state, given to each frame once it finished its handshake.
      const annotates = config.capabilities.annotate !== undefined;
      let annotating: StartedMode | null = null;
      let marks: AnnotationMark[] = [];
      let activeMark: string | null = null;
      // The mark the host follows (P112), or whether it follows the selection instead (P138), and
      // when it took each `tracked` or `selectionTracked` in the last second: one followed thing
      // at a time, one rate for both.
      let tracking: string | null = null;
      let trackingSelection = false;
      const trackedTimes: number[] = [];
      // Find in page (P131): the query shown (for the content it was asked of only: a new run or
      // other content forgets it), whether the host takes the shortcut (kept for every frame the
      // display runs), and the queries asked and not yet answered.
      const finds = config.capabilities.find !== undefined;
      let findShown: { readonly query: string; readonly caseSensitive: boolean } | null = null;
      let takesShortcut = false;
      let nextFind = 1;
      const findsAsked = new Map<
        string,
        {
          readonly params: Record<string, unknown>;
          readonly resolve: (result: FindResult | "unsupported") => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      let handshaken = false;
      let storageTold = false;
      const toFrame = (method: string, params: Record<string, unknown>) => {
        if (handshaken && surface !== null) {
          surface.transport.send({ jsonrpc: "2.0", method, params });
        }
      };
      /** A query asked of the frame running now (once it finished its handshake). */
      const sendFind = (id: string, params: Record<string, unknown>) => {
        if (handshaken && surface !== null) {
          surface.transport.send({ jsonrpc: "2.0", id, method: FIND_METHODS.query, params });
        }
      };
      /** Answers a query asked, once; a later answer for it is dropped. */
      const settleFind = (id: string, result: FindResult | "unsupported") => {
        const asked = findsAsked.get(id);
        if (asked !== undefined) {
          findsAsked.delete(id);
          clearTimeout(asked.timer);
          asked.resolve(result);
        }
      };
      /**
       * Asks the frame a query: at once where one finished its handshake, else when one does
       * (its load's time and the answer's). No answer in time, an error (an older shell's "isn't
       * offered here"), or one malformed: `"unsupported"`.
       */
      const askFind = (params: Record<string, unknown>): Promise<FindResult | "unsupported"> =>
        new Promise((resolve) => {
          const id = `porthole-find-${nextFind++}`;
          const wait = handshaken ? FIND_LIMITS.timeoutMs : timeoutMs + FIND_LIMITS.timeoutMs;
          findsAsked.set(id, {
            params,
            resolve,
            timer: setTimeout(() => settleFind(id, "unsupported"), wait),
          });
          sendFind(id, params);
        });
      /**
       * A new frame's find (after its handshake): the shortcut, and the latest of the queries
       * asked while it loaded (those it superseded answered `"unsupported"`, never sent). A query
       * cleared since it was asked is answered as nothing found, unasked. The query shown before
       * this run is never given again: a run's frame may show other content (forgetFind).
       */
      const giveFind = () => {
        if (!finds) {
          return;
        }
        if (takesShortcut) {
          toFrame(FIND_METHODS.handled, { handled: true });
        }
        if (findShown === null) {
          for (const id of findsAsked.keys()) {
            settleFind(id, { total: 0, active: 0 });
          }
          return;
        }
        const waiting = [...findsAsked];
        for (const [id] of waiting.slice(0, -1)) {
          settleFind(id, "unsupported");
        }
        const last = waiting.at(-1);
        if (last !== undefined) {
          const [id, asked] = last;
          clearTimeout(asked.timer);
          asked.timer = setTimeout(() => settleFind(id, "unsupported"), FIND_LIMITS.timeoutMs);
          sendFind(id, asked.params);
        }
      };
      /**
       * The content the query was asked of is gone (P131): a new run (a reload, a restart after
       * the content navigated away, a new location) or other content. The query is forgotten and
       * what waits is answered `"unsupported"`, so a new page is never searched with the last
       * one's query unless the host asks it again; `clearFrame` also clears the frame running now.
       */
      const forgetFind = (clearFrame: boolean) => {
        if (!finds) {
          return;
        }
        const had = findShown !== null || findsAsked.size > 0;
        findShown = null;
        for (const id of findsAsked.keys()) {
          settleFind(id, "unsupported");
        }
        if (clearFrame && had) {
          toFrame(FIND_METHODS.clear, {});
        }
      };
      const giveAnnotations = () => {
        if (marks.length > 0) {
          toFrame(ANNOTATE_METHODS.show, {
            marks,
            ...(activeMark === null ? {} : { active: activeMark }),
          });
        }
        if (annotating !== null) {
          toFrame(ANNOTATE_METHODS.start, { ...annotating });
        }
        if (tracking !== null) {
          toFrame(ANNOTATE_METHODS.track, { id: tracking });
        }
        // A new frame has no selection: it answers `orphaned` (P138).
        if (trackingSelection) {
          toFrame(ANNOTATE_METHODS.track, { id: null, selection: true });
        }
      };
      /**
       * The frame's viewport as the platform tells it now; undefined where it can't (no
       * `viewport`, or one that answers no size or throws, P105): every box is then nothing at the
       * frame's corner, and nothing throws out of the frame's listener.
       */
      const frameViewport = (): { width: number; height: number } | undefined => {
        try {
          const viewport: unknown = surface?.viewport?.();
          if (viewport === null || typeof viewport !== "object") {
            return undefined;
          }
          const size = viewport as { width?: unknown; height?: unknown };
          const across = size.width;
          const down = size.height;
          return typeof across === "number" && typeof down === "number"
            ? { width: across, height: down }
            : undefined;
        } catch {
          return undefined;
        }
      };
      /**
       * Every box a report carries, clamped to the frame's viewport as it is now (P104): the page
       * places the host's own UI nowhere outside its frame. A mark's `documentRect` and the
       * document's `scroll` (P132) pass as they were checked: where a mark is in the document,
       * offscreen too, which a clamp would erase; the host clips what it draws from them.
       */
      const withinFrame = (report: AnnotationReport): AnnotationReport => {
        const viewport = frameViewport();
        switch (report.type) {
          case "selected":
          case "activated":
          case "tracked":
            return { ...report, rect: clampRect(report.rect, viewport) };
          case "selectionTracked":
            // In view only where the page says so and its box, as the host reads the viewport,
            // reaches into it (P138): a box the clamp puts on an edge is never in view.
            return report.state === "orphaned"
              ? report
              : {
                  ...report,
                  rect: clampRect(report.rect, viewport),
                  inView: report.inView && inViewport(report.rect, viewport),
                };
          case "anchored":
            return {
              ...report,
              results: report.results.map((result) =>
                result.rect === undefined
                  ? result
                  : { ...result, rect: clampRect(result.rect, viewport) },
              ),
            };
          default:
            return report;
        }
      };
      /**
       * A report from the frame: checked, taken only while the host asked for it (a selection
       * only in select mode, results only for its own marks, a marker's click only for a mark it
       * shows with one, a count's or a draft's), then through the bridge's gates. No proof of a
       * gesture is asked of a marker's click (0.16.0, P149): what a host opens for one takes no
       * focus and does nothing by itself (THREAT_MODEL §6), and a page that says it unasked only
       * shows that.
       */
      const onAnnotation = (raw: unknown, through: HostFunctionBridge) => {
        if (
          !isRecord(raw) ||
          raw.jsonrpc !== "2.0" ||
          "id" in raw ||
          typeof raw.method !== "string"
        ) {
          return;
        }
        // Its own entries only: `constructor` or `toString` is no report (P095).
        const type = Object.hasOwn(REPORTS, raw.method) ? REPORTS[raw.method] : undefined;
        if (type === undefined) {
          return;
        }
        // The followed selection (P138) only while the host follows it, and dropped unread
        // otherwise (P140): a host that doesn't follow it takes it as 0.14.14 took a method it
        // didn't know, so a malformed one is no refusal either.
        if (type === "selectionTracked" && !trackingSelection) {
          return;
        }
        let report = parseReport({ ...(isRecord(raw.params) ? raw.params : {}), type });
        if (report === null) {
          void through.call("annotate", null);
          return;
        }
        // The followed mark's box (P112): the mark the host follows and no other, while it is
        // shown, at most 60 a second; past the bridge's rate for reports, which a card that follows
        // its mark at every frame would spend at once.
        if (report.type === "tracked") {
          const { id } = report;
          if (id !== tracking || !marks.some((mark) => mark.id === id)) {
            return;
          }
          const at = Date.now();
          while (trackedTimes.length > 0 && at - (trackedTimes[0] as number) >= 1_000) {
            trackedTimes.shift();
          }
          if (trackedTimes.length >= TRACKED_PER_SECOND) {
            return;
          }
          trackedTimes.push(at);
          emit("annotation", withinFrame(report));
          return;
        }
        // The followed selection (P138): only while the host follows it (above), on the same 60 a
        // second (one followed thing at a time), past the bridge's rate as the followed mark's.
        if (report.type === "selectionTracked") {
          const at = Date.now();
          while (trackedTimes.length > 0 && at - (trackedTimes[0] as number) >= 1_000) {
            trackedTimes.shift();
          }
          if (trackedTimes.length >= TRACKED_PER_SECOND) {
            return;
          }
          trackedTimes.push(at);
          emit("annotation", withinFrame(report));
          return;
        }
        switch (report.type) {
          case "selected": {
            const kind = report.anchor.kind;
            if (
              annotating === null ||
              !(kind === "element" ? annotating.elements : annotating.text)
            ) {
              return;
            }
            // A pick ends with it; holding a block (P112) lasts until the host stops it.
            if (kind === "element" && annotating.elements === true) {
              annotating = annotating.text ? { ...annotating, elements: false } : null;
            }
            break;
          }
          case "unselected":
            if (annotating?.text !== true) {
              return;
            }
            break;
          case "cancelled":
            // While the host asked for a pick or for text (P112: Escape while selecting text);
            // a pick ends with it, text selection is the host's to stop.
            if (annotating === null) {
              return;
            }
            if (annotating.elements === true) {
              annotating = annotating.text ? { ...annotating, elements: false } : null;
            }
            break;
          case "anchored": {
            const known = new Set(marks.map((mark) => mark.id));
            const results = report.results.filter((result) => known.has(result.id));
            if (results.length === 0) {
              return;
            }
            report = { ...report, results };
            break;
          }
          case "activated": {
            const { id } = report;
            if (!marks.some((mark) => mark.id === id && hasMarker(mark))) {
              return;
            }
            break;
          }
        }
        void through.call("annotate", withinFrame(report));
      };
      /**
       * What the frame says of find (P131): an answer to a query asked (its own id only, checked,
       * its box clamped to the frame), or a report unasked, taken only while the host asked for it
       * (the shortcut while the host takes it and the page's focus is in the frame; a changed count
       * while a query is shown), then through the bridge's gates.
       */
      const onFind = (
        raw: unknown,
        through: HostFunctionBridge,
        focused: () => boolean | undefined,
      ) => {
        if (!isRecord(raw) || raw.jsonrpc !== "2.0") {
          return;
        }
        if (typeof raw.method !== "string") {
          // Its own entries only: an id the host never asked is no answer.
          const id = raw.id;
          if (typeof id !== "string" || !findsAsked.has(id)) {
            return;
          }
          const result = "error" in raw || !("result" in raw) ? null : parseFindResult(raw.result);
          settleFind(
            id,
            result === null
              ? "unsupported"
              : result.rect === undefined
                ? result
                : { ...result, rect: clampRect(result.rect, frameViewport()) },
          );
          return;
        }
        if ("id" in raw) {
          return;
        }
        const type = Object.hasOwn(FIND_REPORTS, raw.method) ? FIND_REPORTS[raw.method] : undefined;
        if (type === undefined) {
          return;
        }
        const report = parseFindReport({ ...(isRecord(raw.params) ? raw.params : {}), type });
        if (report === null) {
          void through.call("find", null);
          return;
        }
        if (report.type === "requested") {
          // The person's key in the frame: the page's focus is there (where the platform can tell),
          // so a page can't bring the host's find bar up while the person types beside it.
          let inFrame: boolean | undefined;
          try {
            inFrame = focused();
          } catch {
            inFrame = false;
          }
          if (!takesShortcut || inFrame === false) {
            return;
          }
        } else if (findShown === null) {
          return;
        }
        void through.call("find", report);
      };
      const find: FindControls = {
        query(query, given) {
          if (!finds) {
            return Promise.resolve("unsupported");
          }
          let checked: ReturnType<typeof checkFindQuery>;
          try {
            checked = checkFindQuery(query, given);
          } catch (error) {
            return Promise.reject(error);
          }
          if (blankQuery(checked.query)) {
            findShown = null;
            toFrame(FIND_METHODS.clear, {});
            return Promise.resolve({ total: 0, active: 0 });
          }
          findShown = { query: checked.query, caseSensitive: checked.caseSensitive };
          return askFind({ ...checked });
        },
        clear() {
          if (finds) {
            findShown = null;
            toFrame(FIND_METHODS.clear, {});
          }
        },
        takeShortcut(take) {
          if (finds) {
            takesShortcut = take;
            toFrame(FIND_METHODS.handled, { handled: takesShortcut });
          }
        },
      };
      const needsAnnotate = (operation: string) => {
        if (!annotates) {
          throw new TypeError(`annotations.${operation}: the config doesn't declare annotate`);
        }
      };
      const annotations: AnnotationControls = {
        start(mode) {
          needsAnnotate("start");
          annotating = annotateMode(mode);
          toFrame(ANNOTATE_METHODS.start, { ...annotating });
        },
        stop() {
          needsAnnotate("stop");
          annotating = null;
          toFrame(ANNOTATE_METHODS.stop, {});
        },
        show(next) {
          needsAnnotate("show");
          marks = checkMarks(next);
          if (activeMark !== null && !marks.some((mark) => mark.id === activeMark)) {
            activeMark = null;
          }
          // A followed selection (P138) isn't a mark: a show leaves it.
          if (tracking !== null && !marks.some((mark) => mark.id === tracking)) {
            tracking = null;
            toFrame(ANNOTATE_METHODS.track, { id: null });
          }
          toFrame(ANNOTATE_METHODS.show, {
            marks,
            ...(activeMark === null ? {} : { active: activeMark }),
          });
        },
        focus(id) {
          needsAnnotate("focus");
          if (!marks.some((mark) => mark.id === id)) {
            throw new TypeError(`annotations.focus: no mark ${JSON.stringify(id)} is shown`);
          }
          activeMark = id;
          toFrame(ANNOTATE_METHODS.focus, { id });
        },
        track(target) {
          needsAnnotate("track");
          // The selection (P138), under `id: null`: an older shell follows nothing.
          if (followsSelection(target)) {
            tracking = null;
            trackingSelection = true;
            trackedTimes.length = 0;
            toFrame(ANNOTATE_METHODS.track, { id: null, selection: true });
            return;
          }
          const id = target;
          if (id !== null && !marks.some((mark) => mark.id === id)) {
            throw new TypeError(`annotations.track: no mark ${JSON.stringify(id)} is shown`);
          }
          tracking = id;
          trackingSelection = false;
          trackedTimes.length = 0;
          toFrame(ANNOTATE_METHODS.track, { id });
        },
        clear() {
          needsAnnotate("clear");
          marks = [];
          activeMark = null;
          tracking = null;
          trackingSelection = false;
          toFrame(ANNOTATE_METHODS.clear, {});
        },
        clearSelection() {
          // Host → frame only, and kept for no later frame (P115).
          needsAnnotate("clearSelection");
          toFrame(ANNOTATE_METHODS.clearSelection, {});
        },
        focusMark(id) {
          // Host → frame only, and kept for no later frame (P134). A mark that has gone, or has no
          // marker, is nothing to ask for, and no fault: the host's card closed with the mark's.
          // Stamped as it is sent: a frame judges by that how old the word is as it takes it (P137).
          needsAnnotate("focusMark");
          if (marks.some((mark) => mark.id === id && hasMarker(mark))) {
            toFrame(ANNOTATE_METHODS.focusMark, { id, at: Date.now() });
          }
        },
      };

      const hostContext = (): HostContext => {
        const width = container.getBoundingClientRect().width;
        // The spec's names in `styles` (the App SDK refuses others there), the rest in our field.
        const variables = resolveTheme(config.theme, scheme, options.theme?.(scheme));
        const standard: Record<string, string> = {};
        const own: Record<string, string> = {};
        for (const [name, value] of Object.entries(variables)) {
          (STANDARD.has(name) ? standard : own)[name] = value;
        }
        return {
          theme: scheme,
          styles: { variables: standard },
          ...(Object.keys(own).length === 0 ? {} : { [PORTHOLE_STYLES]: { variables: own } }),
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          ...(width > 0 ? { containerDimensions: { maxWidth: Math.round(width) } } : {}),
          ...(view === null
            ? {}
            : {
                locale: view.navigator.language,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                platform: "web" as const,
              }),
          ...options.hostContext?.(),
        };
      };

      // A frame's size is taken at most once an animation frame after its run's first, and only
      // when it changed (P127): `resize` has no gate, and each one would reflow the host's page and
      // tell its listeners.
      let sizeFrame: number | null = null;
      let pendingSize: DisplayEvents["resize"] | null = null;
      let shownSize: DisplayEvents["resize"] | null = null;
      const applySize = () => {
        sizeFrame = null;
        const size = pendingSize;
        pendingSize = null;
        if (
          size === null ||
          (shownSize !== null && size.height === shownSize.height && size.width === shownSize.width)
        ) {
          return;
        }
        shownSize = size;
        height = size.height;
        surface?.setHeight(size.height);
        emit("resize", size);
      };

      const onBridge = (event: BridgeEvent) => {
        switch (event.type) {
          case "resize": {
            const next = Math.min(
              config.limits.maxHeightPx,
              Math.max(config.limits.minHeightPx, Math.ceil(event.height)),
            );
            pendingSize = {
              height: next,
              ...(event.width === undefined ? {} : { width: event.width }),
            };
            // A run's first size at once: until then its frame has no height of its own.
            if (view === null || shownSize === null) {
              applySize();
            } else if (sizeFrame === null) {
              sizeFrame = view.requestAnimationFrame(applySize);
            }
            return;
          }
          case "navigationBlocked":
            emit("navigationBlocked", { url: event.url });
            return;
          case "error":
            contentError(event.message);
            return;
          case "refused":
            emit("refused", { capability: event.capability, refusal: event.refusal });
            return;
          case "muted":
            emit("muted", undefined);
            return;
          case "annotation":
            emit("annotation", event.report);
            return;
          case "find":
            if (event.report.type === "requested") {
              emit("findRequested", undefined);
            } else {
              const { type: _type, ...result } = event.report;
              emit("findUpdated", result);
            }
            return;
        }
      };

      const closeDoor = () => {
        door?.watch.stop();
        door?.frame.destroy();
        door = null;
      };

      const stop = () => {
        // A run that ran a page with storage of its own making and never heard it used: no (P111).
        if (bridge !== null && handshaken && !storageTold && compiled.shell?.storage === "memory") {
          emit("storage", { used: false });
        }
        storageTold = false;
        // The run's bridge refuses what still waits for a confirmation: a yes to it runs nothing
        // (P095, after the review), and the next run's bridge starts its count again.
        bridge?.close();
        bridge = null;
        handshaken = false;
        // The next run's frame tells its own size, the same as this one's or not.
        if (sizeFrame !== null) {
          view?.cancelAnimationFrame(sizeFrame);
          sizeFrame = null;
        }
        pendingSize = null;
        shownSize = null;
        abort?.abort();
        abort = null;
        outcomeWatch?.stop();
        outcomeWatch = null;
        closeDoor();
        connection?.close();
        connection = null;
        surface?.destroy();
        surface = null;
      };

      const timeoutMs = config.limits.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;

      /**
       * A served display with a door (P125): its door first, alone, in a frame of the host's own;
       * its frame only once the door said `open`, within what is left of the run's time. A door
       * that said `blocked` (or never ran, or never answered) is the run's outcome, and nothing of
       * the content is framed. A location without a door (an older server, a locator that drops
       * it, a clean address someone framed) is refused before any frame is made: `blocked:
       * locate`, and the host hears why (`door`). Nothing infers a door's word from anything else.
       */
      const enter = (source: FrameSource, timeLeft = timeoutMs) => {
        if (!hasDoor || source.kind !== "url") {
          start(source, timeLeft);
          return;
        }
        if (source.door === undefined || platform.createDoor === undefined) {
          hostError(source.door === undefined ? NO_DOOR : NO_DOOR_PLATFORM, "door");
          emit("outcome", { state: "blocked", reason: "locate" });
          return;
        }
        const began = Date.now();
        const frame = platform.createDoor(container, { url: source.door });
        const watch = watchDoor({
          door: frame,
          timeoutMs: timeLeft,
          onOpen: () => {
            closeDoor();
            start(source, Math.max(0, timeLeft - (Date.now() - began)));
          },
          onOutcome: (outcome) => {
            closeDoor();
            emit("outcome", outcome);
          },
        });
        door = { frame, watch };
      };

      const start = (source: FrameSource, timeLeft: number) => {
        const navigatedAway = () => {
          emit("navigated", undefined);
          if (restarts < MAX_RESTARTS) {
            restarts += 1;
            run();
          } else {
            stop();
            contentError("The content kept navigating its frame away; it was stopped.");
            // Every display ends with an outcome (P125): a frame stopped after its restarts ran out
            // is one the host can draw a fallback for, never an empty box.
            emit("outcome", { state: "blocked", reason: "error" });
          }
        };
        const framed = platform.createSurface(container, {
          source,
          title: mount.title,
          sandbox: compiled.sandbox,
          allow: compiled.allow,
          referrerPolicy: compiled.referrerPolicy,
          colorScheme: scheme,
          // An app reports no size: its frame fills the host's container, at least the minimum;
          // so does any display the host mounts to fill, or whose layout fills (P065): its
          // content scrolls itself.
          ...(speaks && mount.fill !== true && config.layout.kind !== "fill"
            ? { initialHeightPx: height }
            : { fill: true, initialHeightPx: config.limits.minHeightPx }),
        });
        // A frame that speaks: another page of the content's own set (P084) is the same content,
        // still connected (the new page's shell says hello again on the same transport); any other
        // load after the first is the content navigating away (P031), and the display starts
        // again. `pagesOfSet` tells them apart at each load (P098): what a new page says before
        // its load is delivered as it comes, as P084 had it; from a load no notice explained until
        // a notice for the mounted version comes, nothing the frame says reaches the display. A
        // url-mode app's frame navigates as the app does (its entry page, then the app): never
        // started again.
        const mounted = mount.instance?.document;
        const created = speaks
          ? pagesOfSet({
              surface: framed,
              set:
                servesFiles(config) && mounted?.kind === "artifact"
                  ? { id: mounted.id, version: mounted.version }
                  : null,
              away: navigatedAway,
            })
          : framed;
        surface = created;
        const watch = watchOutcome({
          surface: created,
          source,
          speaks,
          timeoutMs: timeLeft,
          onOutcome: (outcome) => emit("outcome", outcome),
          // A frame status from the content (P124): never shown, the host's to hear.
          refused: (message) => hostError(message, "frame-status"),
        });
        outcomeWatch = watch;
        if (!speaks) {
          // No handshake in url mode: the app's first document loading is as ready as it gets.
          let ready = false;
          created.onLoad(() => {
            if (!ready) {
              ready = true;
              emit("initialized", undefined);
            }
          });
          return;
        }
        // The host's access at issue says who is viewing (P087); else the mount's word.
        const viewer =
          (source.kind === "url" ? source.viewer : undefined) ?? mountViewer ?? undefined;
        const opening = createBridge({
          config,
          display: {
            id: mount.displayId,
            title: mount.title,
            ...(mount.instance === undefined ? {} : { instance: mount.instance }),
          },
          handlers,
          ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
          ...(consent === undefined ? {} : { consent }),
          ...(options.show === undefined ? {} : { show: options.show }),
          ...(options.cached === undefined ? {} : { cached: options.cached }),
          userActivation: () => created.userActivation(),
          onEvent: onBridge,
          ...(declaration === null ? {} : { declaration }),
          ...(viewer === undefined ? {} : { viewer }),
        });
        if (annotates) {
          created.transport.listen((raw) => onAnnotation(raw, opening));
        }
        if (finds) {
          created.transport.listen((raw) => onFind(raw, opening, () => created.focused?.()));
        }
        // Whether the page used storage (P111): once per run, the page's word (a count, no more).
        created.transport.listen((raw) => {
          if (
            !storageTold &&
            isRecord(raw) &&
            raw.jsonrpc === "2.0" &&
            raw.method === STORAGE_USED_METHOD &&
            !("id" in raw)
          ) {
            storageTold = true;
            emit("storage", { used: true });
          }
        });
        bridge = opening;
        const opened = adapter.connect({
          display: { id: mount.displayId, title: mount.title },
          compiled,
          transport: created.transport,
          bridge: opening,
          hostInfo,
          hostContext,
          emit: (event) => {
            if (event.type === "navigating") {
              // Which loads are the set's own pages is the frame's surface's to tell (P084, P098:
              // `pagesOfSet`, from the frame's own words before any of them reach this display).
              return;
            }
            if (event.type === "initialized") {
              watch.initialized();
              if (!handshaken) {
                handshaken = true;
                giveAnnotations();
                giveFind();
              }
              emit("initialized", undefined);
            }
          },
          ...(mount.document === undefined ? {} : { document: mount.document }),
        });
        connection = opened;
        for (const [name, args] of replay) {
          (opened as unknown as Record<string, (...each: unknown[]) => unknown>)[name]?.(...args);
        }
      };

      const run = () => {
        stop();
        // Each run is a new frame, maybe of other content: it starts with no query (P131).
        forgetFind(false);
        if (destroyed) {
          return;
        }
        generation += 1;
        if (episodeBegan === null) {
          episodeBegan = Date.now();
        }
        // What is left of this episode's time: a restart doesn't start the clock again.
        const timeLeft = Math.max(0, timeoutMs - (Date.now() - episodeBegan));
        if (config.isolation === "opaque") {
          enter(
            {
              kind: "srcdoc",
              html: compiled.shellDocument({
                origins: [container.ownerDocument.defaultView?.location.origin ?? ""],
                title: mount.title,
                ...nonceOf(options.nonce),
                ...(mount.document === undefined ? {} : { document: mount.document }),
              }),
            },
            timeLeft,
          );
          return;
        }
        const mine = generation;
        const controller = new AbortController();
        abort = controller;
        const locator = options.locator;
        const instance = mount.instance;
        if (locator === undefined || instance === undefined) {
          return;
        }
        const hostOrigin = container.ownerDocument.defaultView?.location.origin ?? "";
        // The run's time covers locating too: a backend that never answers is a timeout.
        const began = Date.now();
        let settled = false;
        const late = setTimeout(() => {
          if (!settled && mine === generation && !destroyed) {
            settled = true;
            controller.abort();
            hostError("The host's backend didn't give a location in time", "locate");
            emit("outcome", { state: "timeout" });
          }
        }, timeLeft);
        // A run stopped (destroyed, started again) stops its clock too.
        controller.signal.addEventListener("abort", () => clearTimeout(late), { once: true });
        locateServed(locator, instance, config, hostOrigin, controller.signal).then(
          (source) => {
            clearTimeout(late);
            if (!settled && mine === generation && !destroyed) {
              settled = true;
              if (source.kind === "url") {
                const seen = [source.url, ...(source.door === undefined ? [] : [source.door])];
                if (seen.some((each) => locatedAt.has(each))) {
                  hostError(REUSED_LOCATION, "locate");
                }
                for (const each of seen) {
                  locatedAt.add(each);
                }
              }
              enter(source, Math.max(0, timeLeft - (Date.now() - began)));
            }
          },
          (error: unknown) => {
            clearTimeout(late);
            if (settled || mine !== generation || controller.signal.aborted) {
              return;
            }
            settled = true;
            // The host's own issue endpoint refused (signed out, denied, not found, P125): its
            // word, before any frame, never the content's. Anything else is the host's own failure
            // (its backend down, a network error, a malformed answer): `locate`, never `denied`.
            const refused = outcomeOfRefusal(error);
            if (refused !== null) {
              emit("outcome", refused);
              return;
            }
            hostError(error instanceof Error ? error.message : String(error), "locate");
            emit("outcome", { state: "blocked", reason: "locate" });
          },
        );
      };

      run();

      const controls = {
        displayId: mount.displayId,
        annotations,
        find,
        setTheme(next: ColorScheme) {
          if (themeless) {
            return;
          }
          scheme = next;
          surface?.setColorScheme(next);
          // Read the host's values two frames later: a host that restyles its page for the new
          // scheme on its next frame has done so by then.
          if (view === null) {
            connection?.hostContextChanged(hostContext());
            return;
          }
          if (themeFrame !== null) {
            view.cancelAnimationFrame(themeFrame);
          }
          themeFrame = view.requestAnimationFrame(() => {
            themeFrame = view.requestAnimationFrame(() => {
              themeFrame = null;
              connection?.hostContextChanged(hostContext());
            });
          });
        },
        refreshTheme() {
          connection?.hostContextChanged(hostContext());
        },
        on<E extends keyof DisplayEvents>(event: E, listener: (detail: DisplayEvents[E]) => void) {
          const set = listeners.get(event) ?? new Set();
          set.add(listener);
          listeners.set(event, set);
          return () => set.delete(listener);
        },
        reload() {
          restarts = 0;
          episodeBegan = null;
          run();
        },
        focus() {
          surface?.focus?.();
        },
        destroy() {
          destroyed = true;
          stop();
          listeners.clear();
          for (const id of findsAsked.keys()) {
            settleFind(id, "unsupported");
          }
        },
      };

      // The adapter's own operations (`setContent` for the shell adapter): forwarded to the frame
      // running now, and remembered (the last call of each) for a frame started again.
      return new Proxy(controls, {
        get(target, key, receiver) {
          if (typeof key === "string" && !(key in target) && !BASE_KEYS.has(key)) {
            return (...args: unknown[]) => {
              // Other content (not the content so far, continued): the query was the last one's.
              if (key === "setContent" && !continues(replay.get(key)?.[0], args[0])) {
                forgetFind(true);
              }
              replay.delete(key);
              replay.set(key, args);
              const operation = (connection as unknown as Record<string, unknown> | null)?.[key];
              return typeof operation === "function"
                ? (operation as (...each: unknown[]) => unknown).apply(connection, args)
                : undefined;
            };
          }
          return Reflect.get(target, key, receiver);
        },
      }) as unknown as DisplayHandle<C>;
    },
  };
}

/**
 * Whether `next` is the content `before` was, continued (P131): the same, or more of it (the next
 * part of a streamed page). Nothing given before: anything continues it.
 */
function continues(before: unknown, next: unknown): boolean {
  return (
    before === undefined ||
    (typeof before === "string" && typeof next === "string" && next.startsWith(before))
  );
}

/** The host's nonce option, read now (`HostOptions.nonce`). */
function nonceOf(nonce: HostOptions["nonce"]): { nonce?: string } {
  const value = typeof nonce === "function" ? nonce() : nonce;
  return value === undefined || value === "" ? {} : { nonce: value };
}
