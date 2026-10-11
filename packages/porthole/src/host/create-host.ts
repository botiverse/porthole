import { createBridge, type BridgeEvent } from "../bridge/bridge.ts";
import { compile } from "../compile/compile.ts";
import { declaredCapabilities } from "../compile/policy.ts";
import { capabilitySpec } from "../config/capabilities.ts";
import type { ColorScheme, PortholeConfig } from "../config/schema.ts";
import { locateServed } from "./locate.ts";
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
  DisplayEvents,
  DisplayHandle,
  HostOptions,
  MountOptions,
  PortholeHost,
} from "./types.ts";

/** How many times a display is started again after its content navigated its frame away. */
const MAX_RESTARTS = 3;

const BASE_KEYS = new Set(["hostContextChanged", "teardown", "close"]);
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

      let scheme: ColorScheme = mount.scheme;
      let height = mount.initialHeightPx ?? 0;
      let surface: Surface | null = null;
      let connection: C | null = null;
      let destroyed = false;
      let restarts = 0;
      let generation = 0;
      let abort: AbortController | null = null;
      // The adapter's own operations, the last call of each, replayed into every new frame.
      const replay = new Map<string, unknown[]>();

      const hostContext = (): HostContext => {
        const width = container.getBoundingClientRect().width;
        const view = container.ownerDocument.defaultView;
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
            emit("error", { message: event.message });
            return;
          case "refused":
            emit("refused", { capability: event.capability, refusal: event.refusal });
            return;
          case "muted":
            emit("muted", undefined);
            return;
        }
      };

      const stop = () => {
        abort?.abort();
        abort = null;
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
          initialHeightPx: height,
        });
        surface = created;
        if (!speaks) {
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
        const opened = adapter.connect({
          display: { id: mount.displayId, title: mount.title },
          compiled,
          transport: created.transport,
          bridge,
          hostInfo,
          hostContext,
          emit: (event) => {
            if (event.type === "initialized") {
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
            emit("error", {
              message: "The content kept navigating its frame away; it was stopped.",
            });
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
              emit("error", { message: error instanceof Error ? error.message : String(error) });
            }
          },
        );
      };

      run();

      const controls = {
        displayId: mount.displayId,
        setTheme(next: ColorScheme) {
          scheme = next;
          surface?.setColorScheme(next);
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
