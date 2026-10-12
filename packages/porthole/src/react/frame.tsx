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
import type { AnnotateMode, AnnotationMark, AnnotationReport } from "../annotate/types.ts";
import type {
  CallContext,
  CapabilityHandler,
  CapabilityHandlers,
  Confirm,
  ConfirmAnswer,
  ConfirmRequest,
  Proceed,
  Refusal,
} from "../bridge/types.ts";
import type { CapabilityName } from "../config/capabilities.ts";
import type { ColorScheme, PortholeConfig } from "../config/schema.ts";
import { writeClipboard } from "../host/clipboard.ts";
import { createHost } from "../host/create-host.ts";
import type { DisplayEvents, DisplayHandle, FrameOutcome, HostErrorKind } from "../host/types.ts";
import type { InstanceLocator, InstanceRef } from "../isolation/types.ts";
import { ConfirmDialog } from "./dialog.tsx";
import { createLiveFrames, type FrameState, type LiveFrames } from "./live.ts";
import { CopyToast, type CopyNotice } from "./toast.tsx";

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
  readonly nonce?: string;
  /** The provider's locator, read when a frame locates (so an inline one restarts nothing). */
  readonly locate?: InstanceLocator["locate"];
  /** The default `copyText`: copies on the host's page and shows the toast (P052). */
  readonly copyText?: CapabilityHandler<"copyText">;
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
  /** A class for the default copy toast, to restyle it. */
  readonly toastClassName?: string;
  /**
   * The page's CSP nonce, where its `script-src` is nonce-based: opaque frames inherit the page's
   * policy, so their shell carries it (P054).
   */
  readonly nonce?: string;
  readonly children?: ReactNode;
}

interface Pending {
  readonly request: ConfirmRequest;
  readonly resolve: (answer: ConfirmAnswer) => void;
  readonly proceed: Proceed;
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
    (request, proceed) =>
      own.current !== undefined
        ? own.current(request, proceed)
        : new Promise<ConfirmAnswer>((resolve) =>
            setQueue((waiting) => [...waiting, { request, resolve, proceed }]),
          ),
    [],
  );
  // The default copyText: the host's page writes the clipboard (in the frame's click, which
  // activated this page too) and shows the person what went on it, or offers to copy it.
  const [notice, setNotice] = useState<CopyNotice | null>(null);
  const copyText = useCallback<CapabilityHandler<"copyText">>(async ({ text }, context) => {
    const copied = await writeClipboard(text, globalThis.document);
    setNotice({ text, copied, title: context.title });
    return copied;
  }, []);
  const closeNotice = useCallback(() => setNotice(null), []);
  // Compared by value, and read when used: an inline hostInfo or locator doesn't start every
  // frame again on each render.
  const hostInfo = useByValue(props.hostInfo);
  const ownLocator = useRef(props.locator);
  useLayoutEffect(() => {
    ownLocator.current = props.locator;
  });
  const locate = useCallback<InstanceLocator["locate"]>(
    (instance, signal) =>
      ownLocator.current === undefined
        ? Promise.reject(new Error("No locator (PortholeProvider.locator)"))
        : ownLocator.current.locate(instance, signal),
    [],
  );
  const locates = props.locator !== undefined;
  const { nonce } = props;
  const value = useMemo<PageState>(
    () => ({
      live,
      heights,
      confirm,
      copyText,
      ...(hostInfo === undefined ? {} : { hostInfo }),
      ...(locates ? { locate } : {}),
      ...(nonce === undefined ? {} : { nonce }),
    }),
    [live, heights, confirm, copyText, hostInfo, locates, locate, nonce],
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
            // A yes runs the effect inside this very click (a window it opens is the person's).
            if (accepted) {
              current?.proceed();
            }
            current?.resolve(accepted ? "accepted" : "declined");
            setQueue((waiting) => waiting.slice(1));
          }}
        />
      ) : null}
      <CopyToast
        notice={notice}
        {...(props.toastClassName === undefined ? {} : { className: props.toastClassName })}
        onClose={closeNotice}
        onCopy={(failed) => {
          // A click on the host's own page: the write has the gesture it needs now.
          void writeClipboard(failed.text, globalThis.document).then((copied) =>
            setNotice({ ...failed, copied }),
          );
        }}
      />
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
  /**
   * Fill the box (give it, or its parent, a height) instead of growing with the content.
   *
   * @deprecated Say it in the config, `layout: { kind: "fill" }`: every frame then fills, and the
   * manual tells the agent so. This prop sizes only this frame, so the manual keeps saying the
   * height follows the content (P071). A url-mode app always fills.
   */
  readonly fill?: boolean;
  readonly onInitialized?: () => void;
  readonly onResize?: (size: { readonly height: number; readonly width?: number }) => void;
  /**
   * What the content did wrong (what it threw, what the sandbox blocked, that it kept navigating
   * away): the agent's to hear and fix.
   */
  readonly onContentError?: (message: string) => void;
  /**
   * What failed on the host's side: its locator (`locate`), a display that couldn't be made
   * (`mount`), an annotation call refused (`annotations`). Never the agent's.
   */
  readonly onHostError?: (error: {
    readonly message: string;
    readonly kind: HostErrorKind;
  }) => void;
  /** Both, with their source (as before 0.1.4). Prefer `onContentError` and `onHostError`. */
  readonly onError?: (message: string, source: "content" | "host") => void;
  /** The content navigated its frame away; it was started again (or stopped, after a few). */
  readonly onNavigated?: () => void;
  readonly onRefused?: (capability: CapabilityName, refusal: Refusal) => void;
  /** Too many declines: the display stops asking until it runs again. */
  readonly onMuted?: () => void;
  /**
   * How the frame's first document went: loaded, blocked (and why), or a timeout. A host shows its
   * own fallback (a url-mode app "Open in a new tab") on anything but loaded.
   */
  readonly onOutcome?: (outcome: FrameOutcome) => void;
  /**
   * Other ids this display had (the call's id, before the display's own settled): its remembered
   * height is found under them, for a frame that mounts again under its new id.
   */
  readonly aliases?: readonly string[];
  /**
   * Change it when the host's theme values change without a scheme flip (or after an async
   * restyle): the running frame reads them again.
   */
  readonly themeKey?: string | number;
  /**
   * Annotations, where the config declares `annotate` (P053): what the person may point at now
   * (elements, text, or both), or null to stop. A picked element ends element picking: set it
   * again to pick again.
   */
  readonly annotating?: AnnotateMode | null;
  /** The anchors to mark in the frame (the host's comments). Keep it stable (memoized). */
  readonly annotations?: readonly AnnotationMark[];
  /**
   * The mark to bring into view and make the active one; each new id focuses it. To focus the
   * same mark again (a second click on its comment), give `{ id, key }` with a new key.
   */
  readonly focusedAnnotation?:
    | string
    | { readonly id: string; readonly key: string | number }
    | null;
  /**
   * What the frame reported: a selection (an anchor and where it is), its clearing, a cancelled
   * pick, where marks are. The content's word: UI hints, never permissions.
   */
  readonly onAnnotation?: (report: AnnotationReport) => void;
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

/** A display's remembered height: under its id, else under the first of its other ids that has one. */
function rememberedHeight(
  heights: ReadonlyMap<string, number>,
  displayId: string,
  aliases: readonly string[] | undefined,
): number {
  for (const id of [displayId, ...(aliases ?? [])]) {
    const height = heights.get(id);
    if (height !== undefined) {
      return height;
    }
  }
  return 0;
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

  const height = rememberedHeight(page.heights, props.displayId, props.aliases);
  // A display renamed while it runs (its id settled) keeps its height under its new id.
  const previousId = useRef(props.displayId);
  useLayoutEffect(() => {
    const before = previousId.current;
    previousId.current = props.displayId;
    const kept = page.heights.get(before);
    if (before !== props.displayId && kept !== undefined && !page.heights.has(props.displayId)) {
      page.heights.set(props.displayId, kept);
    }
  }, [page, props.displayId]);
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
        // A display that fills takes its parent's height (the host sizes the parent, or this box).
        ...(props.fill === true ||
        props.config.mode === "url" ||
        props.config.layout.kind === "fill"
          ? { height: "100%" }
          : {}),
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
  const { document: view, content, partial, scheme } = frame;
  // By value: a config or instance made inline (each render) is the same display.
  const config = useByValue(frame.config);
  const instance = useByValue(frame.instance);
  const fills = config.mode === "url" || frame.fill === true || config.layout.kind === "fill";

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
        case "contentError":
          frame.onContentError?.((detail as DisplayEvents["contentError"]).message);
          return;
        case "hostError":
          frame.onHostError?.(detail as DisplayEvents["hostError"]);
          return;
        case "error": {
          const { message, source } = detail as DisplayEvents["error"];
          frame.onError?.(message, source);
          return;
        }
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
        case "outcome":
          frame.onOutcome?.(detail as DisplayEvents["outcome"]);
          return;
        case "annotation":
          frame.onAnnotation?.(detail as DisplayEvents["annotation"]);
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
    // Copy buttons without a handler of the host's: the provider's, which shows a toast.
    if (config.capabilities.copyText !== undefined && handlers.copyText === undefined) {
      const fallback = page.copyText;
      if (fallback !== undefined) {
        handlers.copyText = (args, context) =>
          fallback(args as { readonly text: string }, named(context));
      }
    }
    const asks = first.confirm !== undefined || page.confirm !== undefined;
    let display: DisplayHandle;
    try {
      display = createHost(config, {
        handlers,
        ...(asks
          ? {
              confirm: (request: ConfirmRequest, proceed: Proceed) =>
                (latest().confirm ?? page.confirm ?? (() => Promise.resolve(false)))(
                  { ...request, display: { id: latest().displayId, title: latest().title } },
                  proceed,
                ),
            }
          : {}),
        theme: (each) => latest().theme?.(each) ?? {},
        ...(page.hostInfo === undefined ? {} : { hostInfo: page.hostInfo }),
        ...(page.locate === undefined ? {} : { locator: { locate: page.locate } }),
        ...(page.nonce === undefined ? {} : { nonce: page.nonce }),
      }).mount(container, {
        displayId: first.displayId,
        title: first.title,
        scheme: first.scheme,
        initialHeightPx: startHeight,
        ...(view === undefined ? {} : { document: view }),
        ...(instance === undefined ? {} : { instance }),
        ...(fills ? { fill: true } : {}),
      });
    } catch (error) {
      hostFailed(first, error, "mount");
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
      "outcome",
      "annotation",
      "contentError",
      "hostError",
    ];
    for (const event of events) {
      display.on(event, (detail) => notify(event, detail));
    }
    if (config.capabilities.annotate !== undefined) {
      applyAnnotations(display, first);
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
  }, [config, view, instance, page, startHeight, fills]);

  useEffect(() => {
    if (content !== undefined) {
      handle.current?.setContent(content, { partial: partial === true });
    }
  }, [content, partial]);
  // Annotations follow their props (a new display gets them all when it is made, above).
  const annotates = config.capabilities.annotate !== undefined;
  const { annotating } = frame;
  const focusedAnnotation = focusOf(frame.focusedAnnotation);
  const focusToken =
    focusedAnnotation === null
      ? ""
      : typeof frame.focusedAnnotation === "object" && frame.focusedAnnotation !== null
        ? JSON.stringify([frame.focusedAnnotation.id, frame.focusedAnnotation.key])
        : JSON.stringify([focusedAnnotation]);
  // By value: the same marks given again don't mark them again.
  const annotations = useByValue(frame.annotations);
  const mode =
    annotating === undefined || annotating === null
      ? ""
      : JSON.stringify([annotating.elements ?? true, annotating.text ?? true]);
  useEffect(() => {
    const display = handle.current;
    if (!annotates || display === null) {
      return;
    }
    const wanted = mode === "" ? null : (JSON.parse(mode) as [boolean, boolean]);
    attempt(
      () =>
        wanted === null
          ? display.annotations.stop()
          : display.annotations.start({ elements: wanted[0], text: wanted[1] }),
      latest(),
    );
  }, [annotates, mode]);
  useEffect(() => {
    const display = handle.current;
    if (annotates && display !== null) {
      attempt(() => display.annotations.show(annotations ?? []), latest());
    }
  }, [annotates, annotations]);
  useEffect(() => {
    const display = handle.current;
    const id = focusOf(latest().focusedAnnotation);
    if (annotates && display !== null && focusToken !== "" && id !== null) {
      attempt(() => display.annotations.focus(id), latest());
    }
  }, [annotates, focusToken]);
  // A flip or a restyle after the display was made: its first scheme and values went with it.
  const [mountScheme] = useState(scheme);
  const flipped = useRef(false);
  useEffect(() => {
    if (flipped.current || scheme !== mountScheme) {
      flipped.current = true;
      handle.current?.setTheme(scheme);
    }
  }, [scheme, mountScheme]);
  const { themeKey } = frame;
  const [mountThemeKey] = useState(themeKey);
  useEffect(() => {
    if (themeKey !== undefined && themeKey !== mountThemeKey) {
      handle.current?.refreshTheme();
    }
  }, [themeKey, mountThemeKey]);

  return (
    <div
      data-porthole-ready={String(ready)}
      style={{
        position: "relative",
        // A url-mode app fills the frame's box (give PortholeFrame a height); the rest size to content.
        ...(fills ? { height: "100%" } : {}),
        ...(ready ? {} : { minHeight: Math.max(startHeight, PLACEHOLDER_HEIGHT_PX) }),
      }}
    >
      <div
        ref={holder}
        data-porthole-mount=""
        style={{ opacity: ready ? 1 : 0, ...(fills ? { height: "100%" } : {}) }}
      />
      {ready ? null : placeholder({ state: "loading", title: frame.title, run })}
    </div>
  );
}

/** Tells the frame's props what failed on the host's side. */
function hostFailed(frame: PortholeFrameProps, error: unknown, kind: HostErrorKind): void {
  const message = error instanceof Error ? error.message : String(error);
  frame.onHostError?.({ message, kind });
  frame.onError?.(message, "host");
}

/** Runs an annotation call, telling the frame's props what it threw (a bad anchor, say). */
function attempt(run: () => void, frame: PortholeFrameProps): void {
  try {
    run();
  } catch (error) {
    hostFailed(frame, error, "annotations");
  }
}

/** A new display's annotations, from the props as they are. */
function applyAnnotations(display: DisplayHandle, frame: PortholeFrameProps): void {
  attempt(() => {
    if (frame.annotations !== undefined && frame.annotations.length > 0) {
      display.annotations.show(frame.annotations);
    }
    const focused = focusOf(frame.focusedAnnotation);
    if (focused !== null) {
      display.annotations.focus(focused);
    }
    if (frame.annotating !== undefined && frame.annotating !== null) {
      display.annotations.start(frame.annotating);
    }
  }, frame);
}

/**
 * `value` as long as it is equal by value (as JSON): plain data a host builds inline on each
 * render (a config, an instance, marks, hostInfo) keeps one identity, so effects keyed on it run
 * only when it really changes.
 */
function useByValue<T>(value: T): T {
  const key = value === undefined ? "" : JSON.stringify(value);
  return useMemo(() => (key === "" ? undefined : JSON.parse(key)) as T, [key]);
}

/** The id `focusedAnnotation` names, if any. */
function focusOf(value: PortholeFrameProps["focusedAnnotation"]): string | null {
  return typeof value === "string"
    ? value
    : value === null || value === undefined
      ? null
      : value.id;
}
