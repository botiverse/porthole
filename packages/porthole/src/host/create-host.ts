import {
  ANNOTATE_METHODS,
  type AnnotateMode,
  type AnnotationMark,
  type AnnotationReport,
} from "../annotate/types.ts";
import {
  annotateMode,
  checkMarks,
  clampRect,
  hasMarker,
  parseReport,
} from "../annotate/validate.ts";
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
import { watchOutcome, type OutcomeWatch } from "./outcome.ts";
import { STORAGE_USED_METHOD, type FrameSource } from "../isolation/types.ts";
import { webPlatform } from "../platform/web.ts";
import { TAKES } from "../platform/focus-guard.ts";
import type { Surface } from "../platform/types.ts";
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

const BASE_KEYS = new Set(["hostContextChanged", "teardown", "close"]);

/** The frame's annotation reports, by method. */
const REPORTS: Readonly<Record<string, AnnotationReport["type"]>> = {
  [ANNOTATE_METHODS.selected]: "selected",
  [ANNOTATE_METHODS.unselected]: "unselected",
  [ANNOTATE_METHODS.cancelled]: "cancelled",
  [ANNOTATE_METHODS.anchored]: "anchored",
  [ANNOTATE_METHODS.activated]: "activated",
  [ANNOTATE_METHODS.tracked]: "tracked",
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
  const adapter = (options.adapter ?? shellAdapter) as ProtocolAdapter<C>;
  const platform = options.platform ?? webPlatform;
  const hostInfo = options.hostInfo ?? { name: "porthole", version: "0" };

  return {
    compiled,
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
      let generation = 0;
      // The viewer's answer for this display (P079): asked once, kept across its frames; or the
      // host's refusal of them all (P080).
      const consent =
        options.consent === undefined || isRefused(options.consent)
          ? options.consent
          : onceConsent(options.consent);
      let abort: AbortController | null = null;
      let outcomeWatch: OutcomeWatch | null = null;
      let themeFrame: number | null = null;
      const view = container.ownerDocument.defaultView;
      // The adapter's own operations, the last call of each, replayed into every new frame.
      const replay = new Map<string, unknown[]>();
      // Annotations: the host's state, given to each frame once it finished its handshake.
      const annotates = config.capabilities.annotate !== undefined;
      let annotating: Required<AnnotateMode> | null = null;
      let marks: AnnotationMark[] = [];
      let activeMark: string | null = null;
      // The mark the host follows (P112), and when it took each `tracked` in the last second.
      let tracking: string | null = null;
      const trackedTimes: number[] = [];
      let handshaken = false;
      let storageTold = false;
      const toFrame = (method: string, params: Record<string, unknown>) => {
        if (handshaken && surface !== null) {
          surface.transport.send({ jsonrpc: "2.0", method, params });
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
       * Whether the person is known to have made no gesture just now (P105): the platform says the
       * page has no transient activation, or fails to say. Where it can't tell (undefined), as for
       * the gesture gate, a report passes.
       */
      const noGesture = (): boolean => {
        try {
          return surface?.userActivation() === false;
        } catch {
          return true;
        }
      };
      /**
       * Every box a report carries, clamped to the frame's viewport as it is now (P104): the page
       * places the host's own UI nowhere outside its frame.
       */
      const withinFrame = (report: AnnotationReport): AnnotationReport => {
        const viewport = frameViewport();
        switch (report.type) {
          case "selected":
          case "activated":
          case "tracked":
            return { ...report, rect: clampRect(report.rect, viewport) };
          case "anchored":
            return {
              type: "anchored",
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
       * shows with one, a count's or a draft's, within a gesture), then through the bridge's gates.
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
        switch (report.type) {
          case "selected": {
            const kind = report.anchor.kind;
            if (
              annotating === null ||
              !(kind === "element" ? annotating.elements : annotating.text)
            ) {
              return;
            }
            if (kind === "element") {
              annotating = annotating.text ? { elements: false, text: true } : null;
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
            if (annotating.elements) {
              annotating = annotating.text ? { elements: false, text: true } : null;
            }
            break;
          case "anchored": {
            const known = new Set(marks.map((mark) => mark.id));
            const results = report.results.filter((result) => known.has(result.id));
            if (results.length === 0) {
              return;
            }
            report = { type: "anchored", results };
            break;
          }
          case "activated": {
            const { id } = report;
            if (!marks.some((mark) => mark.id === id && hasMarker(mark))) {
              return;
            }
            // A marker's real click gives the host's page transient activation (measured on all
            // three engines, P105); a click a page posts at load, on a timer or on a scroll has
            // none and is dropped. One posted on the person's own press in the content passes: the
            // host's view guards itself against that (THREAT_MODEL §6).
            if (noGesture()) {
              return;
            }
            break;
          }
        }
        void through.call("annotate", withinFrame(report));
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
        track(id) {
          needsAnnotate("track");
          if (id !== null && !marks.some((mark) => mark.id === id)) {
            throw new TypeError(`annotations.track: no mark ${JSON.stringify(id)} is shown`);
          }
          tracking = id;
          trackedTimes.length = 0;
          toFrame(ANNOTATE_METHODS.track, { id });
        },
        clear() {
          needsAnnotate("clear");
          marks = [];
          activeMark = null;
          tracking = null;
          toFrame(ANNOTATE_METHODS.clear, {});
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

      const onBridge = (event: BridgeEvent) => {
        switch (event.type) {
          case "resize": {
            const next = Math.min(
              config.limits.maxHeightPx,
              Math.max(config.limits.minHeightPx, Math.ceil(event.height)),
            );
            height = next;
            surface?.setHeight(next);
            emit("resize", {
              height: next,
              ...(event.width === undefined ? {} : { width: event.width }),
            });
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
        }
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
        abort?.abort();
        abort = null;
        outcomeWatch?.stop();
        outcomeWatch = null;
        connection?.close();
        connection = null;
        surface?.destroy();
        surface = null;
      };

      const start = (source: FrameSource) => {
        const navigatedAway = () => {
          emit("navigated", undefined);
          if (restarts < MAX_RESTARTS) {
            restarts += 1;
            run();
          } else {
            stop();
            contentError("The content kept navigating its frame away; it was stopped.");
          }
        };
        const framed = platform.createSurface(container, {
          source,
          title: mount.title,
          sandbox: compiled.sandbox,
          allow: compiled.allow,
          referrerPolicy: compiled.referrerPolicy,
          colorScheme: scheme,
          // A nested page's shell (P111): the config's word, never the frame's.
          ...(config.nested === true ? { nested: true } : {}),
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
        // The focus guard undid a move of the keyboard into this frame (P109): heard each time,
        // and a frame that keeps taking it is stopped, as one that keeps navigating away is.
        const takes: { at: number; counts: boolean }[] = [];
        created.onFocusTaken?.(({ typing, failed }) => {
          const at = Date.now();
          // While the person typed, or a take-back that failed (the keys then go to the frame and
          // the page sees no typing): either counts toward the first rule.
          takes.push({ at, counts: typing || failed });
          const within = (ms: number) => takes.filter((take) => at - take.at <= ms);
          emit("focusTaken", { typing });
          if (
            surface === created &&
            (within(TAKES.typing.withinMs).filter((take) => take.counts).length >=
              TAKES.typing.most ||
              within(TAKES.any.withinMs).length >= TAKES.any.most)
          ) {
            stop();
            contentError("The content kept taking the keyboard from the page; it was stopped.");
          }
          while (takes.length > 0 && at - (takes[0] as { at: number }).at > TAKES.typing.withinMs) {
            takes.shift();
          }
        });
        const watch = watchOutcome({
          surface: created,
          source,
          speaks,
          timeoutMs: config.limits.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
          onOutcome: (outcome) => emit("outcome", outcome),
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
          // The person in this frame (P109): the page's focus in it, after the focus guard.
          focused: () => created.focused?.(),
          onEvent: onBridge,
          ...(declaration === null ? {} : { declaration }),
          ...(viewer === undefined ? {} : { viewer }),
        });
        if (annotates) {
          created.transport.listen((raw) => onAnnotation(raw, opening));
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
        if (destroyed) {
          return;
        }
        generation += 1;
        if (config.isolation === "opaque") {
          start({
            kind: "srcdoc",
            html: compiled.shellDocument({
              origins: [container.ownerDocument.defaultView?.location.origin ?? ""],
              title: mount.title,
              ...nonceOf(options.nonce),
              ...(mount.document === undefined ? {} : { document: mount.document }),
            }),
          });
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
        locateServed(locator, instance, config, hostOrigin, controller.signal).then(
          (source) => {
            if (mine === generation && !destroyed) {
              start(source);
            }
          },
          (error: unknown) => {
            if (mine === generation && !controller.signal.aborted) {
              // The host's own failure (its backend down, access gone): never the content's.
              hostError(error instanceof Error ? error.message : String(error), "locate");
              emit("outcome", { state: "blocked", reason: "locate" });
            }
          },
        );
      };

      run();

      const controls = {
        displayId: mount.displayId,
        annotations,
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
          run();
        },
        focus() {
          surface?.focus?.();
        },
        destroy() {
          destroyed = true;
          stop();
          listeners.clear();
        },
      };

      // The adapter's own operations (`setContent` for the shell adapter): forwarded to the frame
      // running now, and remembered (the last call of each) for a frame started again.
      return new Proxy(controls, {
        get(target, key, receiver) {
          if (typeof key === "string" && !(key in target) && !BASE_KEYS.has(key)) {
            return (...args: unknown[]) => {
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

/** The host's nonce option, read now (`HostOptions.nonce`). */
function nonceOf(nonce: HostOptions["nonce"]): { nonce?: string } {
  const value = typeof nonce === "function" ? nonce() : nonce;
  return value === undefined || value === "" ? {} : { nonce: value };
}
