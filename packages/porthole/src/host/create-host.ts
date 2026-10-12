import {
  ANNOTATE_METHODS,
  type AnnotateMode,
  type AnnotationMark,
  type AnnotationReport,
} from "../annotate/types.ts";
import { annotateMode, checkMarks, parseReport } from "../annotate/validate.ts";
import { createBridge, type BridgeEvent } from "../bridge/bridge.ts";
import type { HostFunctionBridge } from "../bridge/types.ts";
import { compile } from "../compile/compile.ts";
import { declaredCapabilities } from "../compile/policy.ts";
import { capabilitySpec } from "../config/capabilities.ts";
import type { ColorScheme, PortholeConfig } from "../config/schema.ts";
import { locateServed } from "./locate.ts";
import { watchOutcome, type OutcomeWatch } from "./outcome.ts";
import type { FrameSource } from "../isolation/types.ts";
import { webPlatform } from "../platform/web.ts";
import type { Surface } from "../platform/types.ts";
import type { AdapterConnection, ProtocolAdapter, ShellConnection } from "../protocol/adapter.ts";
import {
  MCP_APPS_STYLE_VARIABLES,
  PORTHOLE_STYLES,
  type HostContext,
} from "../protocol/mcp-apps.ts";
import { shellAdapter } from "../protocol/shell-adapter.ts";
import { resolveTheme } from "../theme/variables.ts";
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
};

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
      const missing = declaredCapabilities(config).filter(
        (name) =>
          capabilitySpec(name).served === "handler" &&
          (handlers as Record<string, unknown>)[name] === undefined,
      );
      if (missing.length > 0) {
        throw new TypeError(`No handler for the declared capabilities: ${missing.join(", ")}`);
      }
      if (config.isolation !== "opaque" && mount.instance === undefined) {
        throw new TypeError(`${config.isolation} isolation needs MountOptions.instance`);
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
      let destroyed = false;
      let restarts = 0;
      let generation = 0;
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
      let handshaken = false;
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
      };
      /**
       * A report from the frame: checked, taken only while the host asked for it (a selection
       * only in select mode, results only for its own marks), then through the bridge's gates.
       */
      const onAnnotation = (raw: unknown, bridge: HostFunctionBridge) => {
        if (
          !isRecord(raw) ||
          raw.jsonrpc !== "2.0" ||
          "id" in raw ||
          typeof raw.method !== "string"
        ) {
          return;
        }
        const type = REPORTS[raw.method];
        if (type === undefined) {
          return;
        }
        let report = parseReport({ ...(isRecord(raw.params) ? raw.params : {}), type });
        if (report === null) {
          void bridge.call("annotate", null);
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
            if (annotating?.elements !== true) {
              return;
            }
            annotating = annotating.text ? { elements: false, text: true } : null;
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
        }
        void bridge.call("annotate", report);
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
        clear() {
          needsAnnotate("clear");
          marks = [];
          activeMark = null;
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
        const created = platform.createSurface(container, {
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
        surface = created;
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
        const bridge = createBridge({
          config,
          display: { id: mount.displayId, title: mount.title },
          handlers,
          ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
          userActivation: () => created.userActivation(),
          onEvent: onBridge,
        });
        if (annotates) {
          created.transport.listen((raw) => onAnnotation(raw, bridge));
        }
        const opened = adapter.connect({
          display: { id: mount.displayId, title: mount.title },
          compiled,
          transport: created.transport,
          bridge,
          hostInfo,
          hostContext,
          emit: (event) => {
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
        created.onNavigated(() => {
          emit("navigated", undefined);
          if (restarts < MAX_RESTARTS) {
            restarts += 1;
            run();
          } else {
            stop();
            contentError("The content kept navigating its frame away; it was stopped.");
          }
        });
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
