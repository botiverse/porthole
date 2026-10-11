import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import type {
  CallContext,
  CapabilityHandlers,
  Confirm,
  ConfirmRequest,
  Refusal,
} from "../bridge/types.ts";
import type { CapabilityName } from "../config/capabilities.ts";
import type { ColorScheme, PortholeConfig } from "../config/schema.ts";
import { createHost } from "../host/create-host.ts";
import type { DisplayEvents, DisplayHandle } from "../host/types.ts";
import type { InstanceLocator, InstanceRef } from "../isolation/types.ts";
import { ConfirmDialog } from "./dialog.tsx";
import { createLiveFrames, type FrameState, type LiveFrames } from "./live.ts";

/**
 * The React binding: a `<PortholeProvider>` near the root owns what is per page (which frames
 * run, the heights displays reported, and the default confirmation dialog); a `<PortholeFrame>` per
 * display mounts it when it nears the screen, streams its content, flips its theme, and remembers
 * its height. All the isolation is the core's (`createHost`); this is mounting and lifecycle.
 */

/** How far off screen a frame starts (and keeps) running. */
const NEAR_SCREEN = "800px 0px";
/** The height a display holds before it has reported its own. */
export const PLACEHOLDER_HEIGHT_PX = 96;

interface PageState {
  readonly live: LiveFrames;
  /** Heights displays reported, by display id: a frame mounting again starts at its last. */
  readonly heights: Map<string, number>;
  readonly confirm?: Confirm;
  readonly hostInfo?: { readonly name: string; readonly version: string };
  readonly locator?: InstanceLocator;
}

/** Without a provider: one registry for the page, and no one to confirm (gated calls refused). */
const PAGE: PageState = { live: createLiveFrames(), heights: new Map() };

const Page = createContext<PageState>(PAGE);

export interface PortholeProviderProps {
  /**
   * Who confirms gated calls for every frame below. Omitted: the default dialog (`ConfirmDialog`).
   * Pass your own function to replace it.
   */
  readonly confirm?: Confirm;
  /** How the host names itself in the handshake. */
  readonly hostInfo?: { readonly name: string; readonly version: string };
  /** Where domain and external frames load from (see `InstanceLocator`). */
  readonly locator?: InstanceLocator;
  /** A class for the default dialog, to restyle it. */
  readonly dialogClassName?: string;
  readonly children?: ReactNode;
}

interface Pending {
  readonly request: ConfirmRequest;
  readonly resolve: (accepted: boolean) => void;
}

export function PortholeProvider(props: PortholeProviderProps): ReactElement {
  const live = useMemo(() => createLiveFrames(), []);
  const heights = useMemo(() => new Map<string, number>(), []);
  const [queue, setQueue] = useState<readonly Pending[]>([]);
  // The host's confirm as of the last render, read when a frame asks (never during render).
  const own = useRef(props.confirm);
  useLayoutEffect(() => {
    own.current = props.confirm;
  });
  const confirm = useCallback<Confirm>(
    (request) =>
      own.current !== undefined
        ? own.current(request)
        : new Promise<boolean>((resolve) =>
            setQueue((waiting) => [...waiting, { request, resolve }]),
          ),
    [],
  );
  const { hostInfo, locator } = props;
  const value = useMemo<PageState>(
    () => ({
      live,
      heights,
      confirm,
      ...(hostInfo === undefined ? {} : { hostInfo }),
      ...(locator === undefined ? {} : { locator }),
    }),
    [live, heights, confirm, hostInfo, locator],
  );
  const current = queue[0] ?? null;
  return (
    <Page.Provider value={value}>
      {props.children}
      {props.confirm === undefined ? (
        <ConfirmDialog
          request={current?.request ?? null}
          {...(props.dialogClassName === undefined ? {} : { className: props.dialogClassName })}
          onAnswer={(accepted) => {
            current?.resolve(accepted);
            setQueue((waiting) => waiting.slice(1));
          }}
        />
      ) : null}
    </Page.Provider>
  );
}

/** What a placeholder shows: a display not yet running, loading, or stopped for others. */
export interface PlaceholderProps {
  readonly state: "waiting" | "loading" | "stopped";
  readonly title: string;
  /** Runs the display again (a stopped one), stopping another if the page is at its most. */
  readonly run: () => void;
}

export interface PortholeFrameProps {
  /** A preset's config. Keep it stable (module scope or memoized): a new one remounts the frame. */
  readonly config: PortholeConfig;
  /** The host's id for this display: what its height is remembered by, and calls name. */
  readonly displayId: string;
  /** The frame's accessible name, and the title its confirmations show (the host's words). */
  readonly title: string;
  /** The content so far (inline and artifact modes). */
  readonly content?: string;
  /** The content is still being written: drawn inert as it grows, run once when whole. */
  readonly partial?: boolean;
  /** A whole document to start with (an MCP Apps view). */
  readonly document?: string;
  /** Domain and external isolation: the instance to show. */
  readonly instance?: InstanceRef;
  readonly scheme: ColorScheme;
  /** The host's live values for the config's theme variables (from its design tokens). */
  readonly theme?: (scheme: ColorScheme) => Readonly<Record<string, string | null | undefined>>;
  /** Handlers for the declared capabilities (the latest ones are called). */
  readonly handlers?: CapabilityHandlers;
  /** Who confirms this frame's gated calls, over the provider's. */
  readonly confirm?: Confirm;
  /** Bump to run the content again from the start. */
  readonly generation?: number;
  /** Run at once, without waiting to near the screen (it still counts toward the page's most). */
  readonly eager?: boolean;
  readonly onInitialized?: () => void;
  readonly onResize?: (size: { readonly height: number; readonly width?: number }) => void;
  readonly onError?: (message: string) => void;
  /** The content navigated its frame away; it was started again (or stopped, after a few). */
  readonly onNavigated?: () => void;
  readonly onRefused?: (capability: CapabilityName, refusal: Refusal) => void;
  /** Too many declines: the display stops asking until it runs again. */
  readonly onMuted?: () => void;
  /** Draws the placeholder instead of the default one. */
  readonly renderPlaceholder?: (props: PlaceholderProps) => ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}

const PLACEHOLDER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  fontSize: "0.8em",
  opacity: 0.7,
};

function DefaultPlaceholder({ state, title, run }: PlaceholderProps): ReactElement {
  return (
    <div
      data-porthole-placeholder={state}
      style={{ ...PLACEHOLDER_STYLE, pointerEvents: state === "stopped" ? "auto" : "none" }}
    >
      <span>{state === "stopped" ? "Stopped while others run" : title}</span>
      {state === "stopped" ? (
        <button type="button" data-porthole-run="" onClick={run}>
          Run again
        </button>
      ) : null}
    </div>
  );
}

export function PortholeFrame(props: PortholeFrameProps): ReactElement {
  const page = useContext(Page);
  const key = useId();
  const box = useRef<HTMLDivElement>(null);
  const max = props.config.limits.maxLiveFrames;
  const state = useSyncExternalStore(
    (listener) => page.live.subscribe(listener),
    () => page.live.state(key),
    (): FrameState => "waiting",
  );
  const { eager } = props;

  useEffect(() => {
    const element = box.current;
    if (element === null) {
      return;
    }
    if (eager === true || typeof IntersectionObserver !== "function") {
      page.live.near(key, true);
      page.live.admit(key, max);
      return () => page.live.release(key);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry === undefined) {
          return;
        }
        page.live.near(key, entry.isIntersecting);
        if (entry.isIntersecting) {
          page.live.admit(key, max);
        }
      },
      { rootMargin: NEAR_SCREEN },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      page.live.release(key);
    };
  }, [page, key, max, eager]);

  const height = page.heights.get(props.displayId) ?? 0;
  const run = () => page.live.admit(key, max);
  const placeholder = props.renderPlaceholder ?? DefaultPlaceholder;
  return (
    <div
      ref={box}
      className={props.className}
      data-porthole-display={props.displayId}
      data-porthole-state={state}
      style={{
        position: "relative",
        width: "100%",
        ...(state === "running" ? {} : { minHeight: Math.max(height, PLACEHOLDER_HEIGHT_PX) }),
        ...props.style,
      }}
    >
      {state === "running" ? (
        <Mount
          key={String(props.generation ?? 0)}
          frame={props}
          page={page}
          initialHeightPx={height}
          placeholder={placeholder}
          run={run}
        />
      ) : (
        placeholder({ state, title: props.title, run })
      )}
    </div>
  );
}

interface MountProps {
  readonly frame: PortholeFrameProps;
  readonly page: PageState;
  readonly initialHeightPx: number;
  readonly placeholder: (props: PlaceholderProps) => ReactNode;
  readonly run: () => void;
}

type AnyHandler = (args: unknown, context: CallContext) => unknown;

/** One running display: created when mounted, torn down when unmounted, fed as props change. */
function Mount({ frame, page, initialHeightPx, placeholder, run }: MountProps): ReactElement {
  const holder = useRef<HTMLDivElement>(null);
  const handle = useRef<DisplayHandle | null>(null);
  const [ready, setReady] = useState(false);
  // The height this display started at: later reports don't make it start again.
  const [startHeight] = useState(initialHeightPx);
  const { config, document: view, instance, content, partial, scheme } = frame;

  // The latest props, read when the display calls back (never during render).
  const latest = useEffectEvent(() => frame);
  const notify = useEffectEvent(
    <E extends keyof DisplayEvents>(event: E, detail: DisplayEvents[E]): void => {
      switch (event) {
        case "initialized":
          setReady(true);
          frame.onInitialized?.();
          return;
        case "resize": {
          const size = detail as DisplayEvents["resize"];
          page.heights.set(frame.displayId, size.height);
          frame.onResize?.(size);
          return;
        }
        case "error":
          frame.onError?.((detail as DisplayEvents["error"]).message);
          return;
        case "navigated":
          frame.onNavigated?.();
          return;
        case "refused": {
          const { capability, refusal } = detail as DisplayEvents["refused"];
          frame.onRefused?.(capability, refusal);
          return;
        }
        case "muted":
          frame.onMuted?.();
          return;
      }
    },
  );

  useEffect(() => {
    const container = holder.current;
    if (container === null) {
      return;
    }
    const first = latest();
    // A display keeps running when the host renames it (a streamed display's id and title can
    // settle after it starts): calls and confirmations name it as the latest props do.
    const named = (context: CallContext): CallContext => ({
      ...context,
      displayId: latest().displayId,
      title: latest().title,
    });
    // The handlers present now (a declared one must be), each calling the latest prop's.
    const handlers: Record<string, AnyHandler> = {};
    for (const name of Object.keys(first.handlers ?? {})) {
      handlers[name] = (args, context) =>
        (latest().handlers as Record<string, AnyHandler | undefined> | undefined)?.[name]?.(
          args,
          named(context),
        );
    }
    const asks = first.confirm !== undefined || page.confirm !== undefined;
    let display: DisplayHandle;
    try {
      display = createHost(config, {
        handlers,
        ...(asks
          ? {
              confirm: (request: ConfirmRequest) =>
                (latest().confirm ?? page.confirm ?? (() => Promise.resolve(false)))({
                  ...request,
                  display: { id: latest().displayId, title: latest().title },
                }),
            }
          : {}),
        theme: (each) => latest().theme?.(each) ?? {},
        ...(page.hostInfo === undefined ? {} : { hostInfo: page.hostInfo }),
        ...(page.locator === undefined ? {} : { locator: page.locator }),
      }).mount(container, {
        displayId: first.displayId,
        title: first.title,
        scheme: first.scheme,
        initialHeightPx: startHeight,
        ...(view === undefined ? {} : { document: view }),
        ...(instance === undefined ? {} : { instance }),
      });
    } catch (error) {
      first.onError?.(error instanceof Error ? error.message : String(error));
      return;
    }
    handle.current = display;
    const events: (keyof DisplayEvents)[] = [
      "initialized",
      "resize",
      "error",
      "navigated",
      "refused",
      "muted",
    ];
    for (const event of events) {
      display.on(event, (detail) => notify(event, detail));
    }
    if (first.content !== undefined) {
      display.setContent(first.content, { partial: first.partial === true });
    }
    return () => {
      display.destroy();
      handle.current = null;
    };
    // A new display only for a new config, document, instance or page (or generation, by key);
    // content, theme, handlers, id and title are fed to the running one.
  }, [config, view, instance, page, startHeight]);

  useEffect(() => {
    if (content !== undefined) {
      handle.current?.setContent(content, { partial: partial === true });
    }
  }, [content, partial]);
  useEffect(() => {
    handle.current?.setTheme(scheme);
  }, [scheme]);

  return (
    <div
      data-porthole-ready={String(ready)}
      style={{
        position: "relative",
        ...(ready ? {} : { minHeight: Math.max(startHeight, PLACEHOLDER_HEIGHT_PX) }),
      }}
    >
      <div ref={holder} data-porthole-mount="" style={{ opacity: ready ? 1 : 0 }} />
      {ready ? null : placeholder({ state: "loading", title: frame.title, run })}
    </div>
  );
}
