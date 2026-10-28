import type { PageDeclaration } from "../runtime/declaration.ts";
import type { ViewerInfo } from "../runtime/levels.ts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import type { AnnotateMode, AnnotationMark, AnnotationReport } from "../annotate/types.ts";
import type {
  CallContext,
  CapabilityHandler,
  CapabilityHandlers,
  Confirm,
  ConfirmAnswer,
  ConfirmRequest,
  Consent,
  DataCache,
  Proceed,
  Refusal,
  Show,
} from "../bridge/types.ts";
import { isRefused, reasonOf, Refused, type RefusalReason } from "../bridge/refusal.ts";
import type { CapabilityName } from "../config/capabilities.ts";
import type { ColorScheme, PortholeConfig } from "../config/schema.ts";
import { writeClipboard } from "../host/clipboard.ts";
import { createHost } from "../host/create-host.ts";
import type { DisplayEvents, DisplayHandle, FrameOutcome, HostErrorKind } from "../host/types.ts";
import type { InstanceLocator, InstanceRef } from "../isolation/types.ts";
import { ConfirmDialog } from "./dialog.tsx";
import { ContextNotice, type ContextUpdate } from "./context-notice.tsx";
import { createLiveFrames, type FrameState, type LiveFrames } from "./live.ts";
import { CopyToast, type CopyNotice } from "./toast.tsx";
import type { PortholeClient } from "../host/client.ts";

/**
 * The React binding: a `<PortholeProvider>` near the root owns what is per page (which frames
 * run, the heights displays reported, and the default confirmation dialog); a `<PortholeFrame>` per
 * display mounts it when it nears the screen, streams its content, flips its theme, and remembers
 * its height. All the isolation is the core's (`createHost`); this is mounting and lifecycle.
 */

/** Why a model context update didn't go: it was never drawn (the review of P100). */
const REPLACED_UNSEEN = "a later update of this display replaced it before the person saw it";
const HIDDEN_UNSEEN = "the person hid this display's notice before the update was drawn";

/** How far off screen a frame starts (and keeps) running. */
const NEAR_SCREEN = "800px 0px";
/** The height a display holds before it has reported its own. */
export const PLACEHOLDER_HEIGHT_PX = 96;

interface PageState {
  readonly live: LiveFrames;
  /** The host kit's client (P072): the locator, configs by kind, links. */
  readonly client?: PortholeClient;
  /** Defaults every frame below takes unless it says its own (P072). */
  readonly scheme?: ColorScheme;
  readonly theme?: (scheme: ColorScheme) => Readonly<Record<string, string | null | undefined>>;
  readonly themeKey?: string | number;
  /** The provider's handlers as of now (its own over the default `openLink`). */
  readonly handlers?: () => CapabilityHandlers;
  /** Heights displays reported, by display id: a frame mounting again starts at its last. */
  readonly heights: Map<string, number>;
  readonly confirm?: Confirm;
  /** The provider's consent and cache (P079), read when a frame asks. */
  readonly consent?: Consent;
  /** The provider's consent is a `Refused` (P080): its reason, by value. */
  readonly refusesAll?: RefusalReason;
  readonly cached?: DataCache;
  readonly hostInfo?: { readonly name: string; readonly version: string };
  readonly nonce?: string;
  /** The provider's locator, read when a frame locates (so an inline one restarts nothing). */
  readonly locate?: InstanceLocator["locate"];
  /** The default `copyText`: copies on the host's page and shows the toast (P052). */
  readonly copyText?: CapabilityHandler<"copyText">;
  /** Who shows the person `show`-gated calls: the provider's own, or its notice (P100). */
  readonly show?: Show;
}

/** Without a provider: one registry for the page, and no one to confirm (gated calls refused). */
const PAGE: PageState = { live: createLiveFrames(), heights: new Map() };

const Page = createContext<PageState>(PAGE);

/** The provider's page state, for the binding's other components (`PortholeView`). */
export const PortholeContext = Page;

export interface PortholeProviderProps {
  /**
   * The host kit's client (`portholeClient`, P072): it locates served frames (unless `locator` is
   * given), and `PortholeView` takes each kind's config and link from it.
   */
  readonly client?: PortholeClient;
  /** The color scheme every frame below shows in, unless it says its own. */
  readonly scheme?: ColorScheme;
  /**
   * The host's live values for the theme variables, for every frame below (`cssVariableTheme`
   * reads them from the page's own CSS variables). Change `themeKey` when they change.
   */
  readonly theme?: (scheme: ColorScheme) => Readonly<Record<string, string | null | undefined>>;
  readonly themeKey?: string | number;
  /** Handlers every frame below has, under its own (a frame's own win). */
  readonly handlers?: CapabilityHandlers;
  /**
   * How `openLink` opens a link where a frame has no handler of its own: a desktop app's
   * external browser. Default: a new tab, `noopener`.
   */
  readonly openLink?: (url: string) => void;
  /**
   * Shows what a copy button put on the clipboard, in the app's own toast (the words stay
   * Porthole's: `notice`); `copy` copies it again in a click where the first write failed.
   * Omitted: Porthole's `CopyToast`.
   */
  readonly notify?: (
    notice: CopyNotice,
    actions: { readonly copy: () => Promise<boolean> },
  ) => void;
  /**
   * Draws the confirmation in the app's own dialog, for the request at the head of the queue:
   * Porthole keeps the queue (one question at a time), runs `accept` inside the click, and counts
   * declines. `redirect`: the person took it elsewhere (edited a prompt first, P074): the call
   * doesn't go, and it neither counts toward muting the display nor resets the count. Omitted:
   * Porthole's `ConfirmDialog`. (`confirm` replaces the whole mechanism.)
   */
  readonly renderConfirm?: (request: ConfirmRequest, answer: ConfirmActions) => ReactNode;
  /**
   * Who confirms gated calls for every frame below. Omitted: the default dialog (`ConfirmDialog`).
   * Pass your own function to replace it.
   */
  readonly confirm?: Confirm;
  /**
   * Whether a frame below may make its `consent`-gated calls (read the viewer's data, P079):
   * asked once per display, before the first. Omitted: those calls are refused. A `Refused`
   * refuses them all with its reason, and their handlers may be left out (P080).
   */
  readonly consent?: Consent | Refused;
  /**
   * Shows the person each `show`-gated call, outside every frame, before its handler has it
   * (P100): by default, a frame's model context update (`setModelContext`), the content's text for
   * the agent's next turn. Omitted: Porthole's `ContextNotice`. A host that shows it its own way (a
   * chip by its composer) passes this; the update replaces the display's last.
   */
  readonly show?: Show;
  /** What the host last had for a resource, answered stale first (P079). */
  readonly cached?: DataCache;
  /** How the host names itself in the handshake. */
  readonly hostInfo?: { readonly name: string; readonly version: string };
  /** Where domain and external frames load from (see `InstanceLocator`). */
  readonly locator?: InstanceLocator;
  /** A class for the default dialog, to restyle it. */
  readonly dialogClassName?: string;
  /** A class for the default copy toast, to restyle it. */
  readonly toastClassName?: string;
  /** A class for the default model context notice, to restyle it. */
  readonly contextClassName?: string;
  /**
   * The page's CSP nonce, where its `script-src` is nonce-based: opaque frames inherit the page's
   * policy, so their shell carries it (P054). `"auto"`: read from the page (a `<meta
   * name="csp-nonce">`, else its first script's nonce).
   */
  readonly nonce?: string;
  readonly children?: ReactNode;
}

/** What an app's own confirmation dialog answers with (`renderConfirm`). */
export interface ConfirmActions {
  /** Yes: the call goes, run inside this click. */
  readonly accept: () => void;
  /** No: the call doesn't go, and it counts toward muting the display. */
  readonly decline: () => void;
  /** Elsewhere (the person edits the prompt first): the call doesn't go, and doesn't count. */
  readonly redirect: () => void;
}

/** The page's own nonce: `<meta name="csp-nonce" content>`, else the first `script[nonce]`'s. */
function pageNonce(): string | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
  const script = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
  return meta !== undefined && meta !== ""
    ? meta
    : script !== undefined && script !== ""
      ? script
      : undefined;
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
  // The host's consent and cache as of the last render (P079), read when a frame asks.
  const ownConsent = useRef(props.consent);
  const ownCached = useRef(props.cached);
  useLayoutEffect(() => {
    ownConsent.current = props.consent;
    ownCached.current = props.cached;
  });
  const consent = useCallback<Consent>((request) => {
    const given = ownConsent.current;
    if (isRefused(given)) {
      throw given;
    }
    return given?.(request) ?? false;
  }, []);
  // A Refused for every frame below, by value (an inline one starts nothing again).
  const refusesAll = useByValue(isRefused(props.consent) ? reasonOf(props.consent) : undefined);
  const cached = useCallback<DataCache>((args, context) => ownCached.current?.(args, context), []);
  const consents = props.consent !== undefined;
  const caches = props.cached !== undefined;
  // The default copyText: the host's page writes the clipboard (in the frame's click, which
  // activated this page too) and shows the person what went on it, or offers to copy it.
  const [notice, setNotice] = useState<CopyNotice | null>(null);
  const ownNotify = useRef(props.notify);
  useLayoutEffect(() => {
    ownNotify.current = props.notify;
  });
  const copyText = useCallback<CapabilityHandler<"copyText">>(async ({ text }, context) => {
    const copied = await writeClipboard(text, globalThis.document);
    const said = { text, copied, title: context.title };
    if (ownNotify.current === undefined) {
      setNotice(said);
    } else {
      ownNotify.current(said, { copy: () => writeClipboard(text, globalThis.document) });
    }
    return copied;
  }, []);
  const closeNotice = useCallback(() => setNotice(null), []);
  // The default show (P100): each display's latest model context update, in the notice, outside
  // every frame; the host's own `show` replaces it.
  const [contexts, setContexts] = useState<readonly ContextUpdate[]>([]);
  // Each show waiting for its own update to be on the page (after the review: React may draw two
  // updates of a display in one render, the latest only). The number orders a display's shows.
  const unseen = useRef<
    { entry: ContextUpdate; seq: number; resolve: () => void; reject: (error: Error) => void }[]
  >([]);
  const latest = useRef(new Map<string, number>());
  const sequence = useRef(0);
  useLayoutEffect(() => {
    unseen.current = unseen.current.filter((each) => {
      const drawn = contexts.find((one) => one.displayId === each.entry.displayId);
      if (drawn === each.entry) {
        each.resolve();
        return false;
      }
      // A later update of the display replaced it before it was drawn: never seen, never sent.
      if ((latest.current.get(each.entry.displayId) ?? 0) > each.seq) {
        each.reject(new Error(REPLACED_UNSEEN));
        return false;
      }
      return true;
    });
  }, [contexts]);
  const ownShow = useRef(props.show);
  useLayoutEffect(() => {
    ownShow.current = props.show;
  });
  const show = useCallback<Show>((request) => {
    if (ownShow.current !== undefined) {
      return ownShow.current(request);
    }
    if (request.capability !== "setModelContext") {
      // The notice words model context only: anything else it would show unworded, so it isn't
      // shown, and doesn't go (fail closed).
      throw new Error(`Porthole's notice shows model context only, not ${request.capability}`);
    }
    const entry: ContextUpdate = {
      displayId: request.display.id,
      title: request.display.title,
      update: request.args,
    };
    sequence.current += 1;
    const seq = sequence.current;
    latest.current.set(entry.displayId, seq);
    // The call goes once this very update is on the page, so the handler never has it first.
    return new Promise<void>((resolve, reject) => {
      unseen.current.push({ entry, seq, resolve, reject });
      setContexts((each) => [...each.filter((one) => one.displayId !== entry.displayId), entry]);
    });
  }, []);
  const hideContext = useCallback((displayId: string) => {
    // Hidden by the person: an update of the display not drawn yet never will be.
    unseen.current = unseen.current.filter((each) => {
      if (each.entry.displayId !== displayId) {
        return true;
      }
      each.reject(new Error(HIDDEN_UNSEEN));
      return false;
    });
    setContexts((each) => each.filter((one) => one.displayId !== displayId));
  }, []);
  // Compared by value, and read when used: an inline hostInfo or locator doesn't start every
  // frame again on each render.
  const hostInfo = useByValue(props.hostInfo);
  const ownLocator = useRef(props.locator);
  useLayoutEffect(() => {
    ownLocator.current = props.locator;
  });
  const ownClient = useRef(props.client);
  useLayoutEffect(() => {
    ownClient.current = props.client;
  });
  const locate = useCallback<InstanceLocator["locate"]>(
    (instance, signal) =>
      ownLocator.current !== undefined
        ? ownLocator.current.locate(instance, signal)
        : ownClient.current !== undefined
          ? ownClient.current.locate(instance, signal)
          : Promise.reject(new Error("No locator (PortholeProvider.locator or client)")),
    [],
  );
  const locates = props.locator !== undefined || props.client !== undefined;
  // `"auto"`: the page's own nonce, read once.
  const [autoNonce] = useState(() => (props.nonce === "auto" ? pageNonce() : undefined));
  const nonce = props.nonce === "auto" ? autoNonce : props.nonce;
  const { client, scheme, theme, themeKey } = props;
  // openLink without a frame handler: the provider's, or a new tab.
  const ownOpen = useRef(props.openLink);
  useLayoutEffect(() => {
    ownOpen.current = props.openLink;
  });
  const handlers = useMemo<CapabilityHandlers>(
    () => ({
      openLink: ({ url }) => {
        if (ownOpen.current === undefined) {
          globalThis.open?.(url, "_blank", "noopener");
        } else {
          ownOpen.current(url);
        }
        return true;
      },
    }),
    [],
  );
  const ownHandlers = useRef(props.handlers);
  useLayoutEffect(() => {
    ownHandlers.current = props.handlers;
  });
  const merged = useCallback<() => CapabilityHandlers>(
    () => ({ ...handlers, ...ownHandlers.current }),
    [handlers],
  );
  const value = useMemo<PageState>(
    () => ({
      live,
      heights,
      confirm,
      copyText,
      show,
      ...(consents ? { consent } : {}),
      ...(refusesAll === undefined ? {} : { refusesAll }),
      ...(caches ? { cached } : {}),
      ...(hostInfo === undefined ? {} : { hostInfo }),
      ...(locates ? { locate } : {}),
      ...(nonce === undefined ? {} : { nonce }),
      ...(client === undefined ? {} : { client }),
      ...(scheme === undefined ? {} : { scheme }),
      ...(theme === undefined ? {} : { theme }),
      ...(themeKey === undefined ? {} : { themeKey }),
      handlers: merged,
    }),
    [
      live,
      heights,
      confirm,
      copyText,
      show,
      consents,
      consent,
      refusesAll,
      caches,
      cached,
      hostInfo,
      locates,
      locate,
      nonce,
      client,
      scheme,
      theme,
      themeKey,
      merged,
    ],
  );
  const current = queue[0] ?? null;
  return (
    <Page.Provider value={value}>
      {props.children}
      {props.confirm === undefined && props.renderConfirm !== undefined && current !== null
        ? props.renderConfirm(current.request, {
            accept: () => {
              // Inside the app's own click: the effect is the person's (a window it opens).
              current.proceed();
              current.resolve("accepted");
              setQueue((waiting) => waiting.slice(1));
            },
            decline: () => {
              current.resolve("declined");
              setQueue((waiting) => waiting.slice(1));
            },
            redirect: () => {
              current.resolve("redirected");
              setQueue((waiting) => waiting.slice(1));
            },
          })
        : null}
      {props.confirm === undefined && props.renderConfirm === undefined ? (
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
      {props.show !== undefined ? null : (
        <ContextNotice
          updates={contexts}
          onHide={hideContext}
          {...(props.contextClassName === undefined ? {} : { className: props.contextClassName })}
        />
      )}
      {props.notify !== undefined ? null : (
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
      )}
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

/**
 * What a `ref` on `PortholeFrame` or `PortholeView` holds (P118): the display's few imperative
 * calls, never the display itself. The same handle for the frame's whole life: its calls do
 * nothing while no display runs (waiting to near the screen, stopped, a fallback drawn).
 */
export interface PortholeFrameHandle {
  /**
   * Takes the page's text selection away, and its highlight (`annotations.clearSelection()`,
   * P115), once the host has used it (a comment posted, a draft added). No `unselected` follows.
   * Nothing runs: nothing happens. A config without `annotate`: `onHostError`, kind
   * `"annotations"` (the core's call throws; this never does).
   */
  clearSelection(): void;
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
  /**
   * Domain and external isolation: the instance to show. Opaque: the host's own name for what it
   * shows, for its confirmations only, never sent to the frame (P077).
   */
  readonly instance?: InstanceRef;
  /**
   * What the page declared (P086), as the host stored it with the artifact: the capabilities it
   * reaches through `porthole.use`, and its pinned runtime. Under `config.runtime`, `null` says
   * the page was published before 0.7 and has 0.6's surface (`MountOptions.declaration`). By
   * value: a change makes the display again.
   */
  readonly declaration?: PageDeclaration | null;
  /**
   * Who is viewing (P087), for an opaque frame or one whose issue gave none. By value: a change
   * makes the display again.
   */
  readonly viewer?: ViewerInfo;
  /** The color scheme it shows in. Default: the provider's `scheme`, else light. */
  readonly scheme?: ColorScheme;
  /** The host's live values for the config's theme variables (from its design tokens). */
  readonly theme?: (scheme: ColorScheme) => Readonly<Record<string, string | null | undefined>>;
  /** Handlers for the declared capabilities (the latest ones are called). */
  readonly handlers?: CapabilityHandlers;
  /** Who confirms this frame's gated calls, over the provider's. */
  readonly confirm?: Confirm;
  /**
   * Whether this frame may make its `consent`-gated calls, over the provider's (P079). A `Refused`
   * refuses them all with its reason, and their handlers may be left out (P080).
   */
  readonly consent?: Consent | Refused;
  /** This frame's data cache, over the provider's (P079). */
  readonly cached?: DataCache;
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
  /**
   * The shell stopped the content navigating its frame to `url` (P080): the address whole, the
   * content's word. Served frames only, where the config declares `reportError`; `onContentError`
   * hears it too, without the address's query.
   */
  readonly onNavigationBlocked?: (blocked: { readonly url: string }) => void;
  readonly onRefused?: (capability: CapabilityName, refusal: Refusal) => void;
  /** Too many declines: the display stops asking until it runs again. */
  readonly onMuted?: () => void;
  /**
   * The content moved the keyboard into its frame from one of the page's text fields without the
   * person, and focus went back (P109); `typing`: the person was typing on the page. A display
   * that keeps doing it is stopped (`onContentError` says so).
   */
  readonly onFocusTaken?: (taken: { readonly typing: boolean }) => void;
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
  /**
   * The anchors to mark in the frame (the host's comments). A mark with a `count` gets a
   * clickable marker (P104); a draft (`kind: "draft"`, the author's own frame only) a hollow one
   * with no number (P107). Compared by value.
   */
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
   * The mark to follow (`annotations.track`, P112, P118): while it moves, `onAnnotation` gets
   * `{ type: "tracked", id, rect }` at most once per animation frame, for it alone. `null` (or
   * leaving it out once set) stops. By value: given when it changes, and when the display is made.
   * Only a shown mark (`annotations`) is followed: another id, or a config without `annotate`, is
   * `onHostError` (kind `"annotations"`), as the core's call throws. `annotations` without it
   * stop the following, as the core's `show` does; it starts again once they have it back.
   */
  readonly trackedAnnotation?: string | null;
  /** The display's imperative calls (`PortholeFrameHandle`, P118): React 19's `ref` prop. */
  readonly ref?: Ref<PortholeFrameHandle>;
  /**
   * What the frame reported: a selection (an anchor and where it is), its clearing, a cancelled
   * pick, where marks are (again once a scroll settles: those that moved), a marker clicked
   * (`activated`). The content's word: UI hints, never permissions.
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
  // The provider's registry and heights: stable, unlike the context value, which a scheme flip
  // or a new themeKey renews (an effect keyed on it would let the frame go and make it again, #9).
  const { live, heights } = page;
  const key = useId();
  const box = useRef<HTMLDivElement>(null);
  const max = props.config.limits.maxLiveFrames;
  const state = useSyncExternalStore(
    (listener) => live.subscribe(listener),
    () => live.state(key),
    (): FrameState => "waiting",
  );
  const { eager, ref: handleRef } = props;
  // The running display (the Mount's), for the handle's calls; null while none runs.
  const display = useRef<DisplayHandle | null>(null);
  const running = useCallback((each: DisplayHandle | null) => {
    display.current = each;
  }, []);
  // The props as of the last render, read when the handle is called (never during render).
  const own = useRef(props);
  useLayoutEffect(() => {
    own.current = props;
  });
  useImperativeHandle(
    handleRef,
    (): PortholeFrameHandle => ({
      clearSelection() {
        const now = display.current;
        if (now !== null) {
          attempt(() => now.annotations.clearSelection(), own.current);
        }
      },
    }),
    [],
  );

  useEffect(() => {
    const element = box.current;
    if (element === null) {
      return;
    }
    if (eager === true || typeof IntersectionObserver !== "function") {
      live.near(key, true);
      live.admit(key, max);
      return () => live.release(key);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry === undefined) {
          return;
        }
        live.near(key, entry.isIntersecting);
        if (entry.isIntersecting) {
          live.admit(key, max);
        }
      },
      { rootMargin: NEAR_SCREEN },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      live.release(key);
    };
  }, [live, key, max, eager]);

  const height = rememberedHeight(heights, props.displayId, props.aliases);
  // A display renamed while it runs (its id settled) keeps its height under its new id.
  const previousId = useRef(props.displayId);
  useLayoutEffect(() => {
    const before = previousId.current;
    previousId.current = props.displayId;
    const kept = heights.get(before);
    if (before !== props.displayId && kept !== undefined && !heights.has(props.displayId)) {
      heights.set(props.displayId, kept);
    }
  }, [heights, props.displayId]);
  const run = () => live.admit(key, max);
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
          running={running}
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
  /** Tells the frame which display runs now (null: none), for its handle. */
  readonly running: (display: DisplayHandle | null) => void;
  readonly initialHeightPx: number;
  readonly placeholder: (props: PlaceholderProps) => ReactNode;
  readonly run: () => void;
}

type AnyHandler = (args: unknown, context: CallContext) => unknown;

/** One running display: created when mounted, torn down when unmounted, fed as props change. */
function Mount({
  frame,
  page,
  running,
  initialHeightPx,
  placeholder,
  run,
}: MountProps): ReactElement {
  const holder = useRef<HTMLDivElement>(null);
  const handle = useRef<DisplayHandle | null>(null);
  // The mark the display follows now, as the core keeps it (P118), and the prop as last seen.
  const following = useRef<string | null>(null);
  const asked = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  // The height this display started at: later reports don't make it start again.
  const [startHeight] = useState(initialHeightPx);
  const { document: view, content, partial } = frame;
  const scheme = frame.scheme ?? page.scheme ?? "light";
  // A run's content errors, told once each (a loop throwing the same error says it once).
  const told = useRef(new Set<string>());
  // By value: a config or instance made inline (each render) is the same display.
  const config = useByValue(frame.config);
  const instance = useByValue(frame.instance);
  const declaration = useByValue(frame.declaration);
  const viewer = useByValue(frame.viewer);
  const fills = config.mode === "url" || frame.fill === true || config.layout.kind === "fill";
  // A consent that refuses everything (P080), this frame's or else the provider's, by value: a
  // display made with it needs no data handlers, so a change makes the display again.
  const ownRefusal = useByValue(isRefused(frame.consent) ? reasonOf(frame.consent) : undefined);
  const refusesAll = frame.consent === undefined ? page.refusesAll : ownRefusal;

  // The latest props, read when the display calls back (never during render).
  const latest = useEffectEvent(() => frame);
  // The provider's scheme and theme, read when used: a flip or a new themeKey (a new context
  // value) re-themes the running display, never makes it again (#9, P074). What a display is
  // made with comes from the provider's stable parts below.
  const latestPage = useEffectEvent(() => page);
  const {
    handlers: pageHandlers,
    copyText: pageCopyText,
    confirm: pageConfirm,
    consent: pageConsent,
    show: pageShow,
    cached: pageCached,
    hostInfo,
    locate,
    nonce,
  } = page;
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
        case "contentError": {
          const { message } = detail as DisplayEvents["contentError"];
          if (!told.current.has(message)) {
            told.current.add(message);
            frame.onContentError?.(message);
          }
          return;
        }
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
        case "navigationBlocked":
          frame.onNavigationBlocked?.(detail as DisplayEvents["navigationBlocked"]);
          return;
        case "refused": {
          const { capability, refusal } = detail as DisplayEvents["refused"];
          frame.onRefused?.(capability, refusal);
          return;
        }
        case "muted":
          frame.onMuted?.();
          return;
        case "focusTaken":
          frame.onFocusTaken?.(detail as DisplayEvents["focusTaken"]);
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
    // The handlers present now (a declared one must be), each calling the latest prop's, else
    // the provider's (P072).
    const handlers: Record<string, AnyHandler> = {};
    const declared = new Set(Object.keys(config.capabilities));
    for (const name of new Set([
      ...Object.keys(first.handlers ?? {}),
      ...Object.keys(pageHandlers?.() ?? {}).filter((each) => declared.has(each)),
    ])) {
      handlers[name] = (args, context) =>
        (
          (latest().handlers as Record<string, AnyHandler | undefined> | undefined)?.[name] ??
          (pageHandlers?.() as Record<string, AnyHandler | undefined> | undefined)?.[name]
        )?.(args, named(context));
    }
    // Copy buttons without a handler of the host's: the provider's, which shows a toast.
    if (config.capabilities.copyText !== undefined && handlers.copyText === undefined) {
      const fallback = pageCopyText;
      if (fallback !== undefined) {
        handlers.copyText = (args, context) =>
          fallback(args as { readonly text: string }, named(context));
      }
    }
    const asks = first.confirm !== undefined || pageConfirm !== undefined;
    const asksConsent = first.consent !== undefined || pageConsent !== undefined;
    const caches = first.cached !== undefined || pageCached !== undefined;
    let display: DisplayHandle;
    try {
      display = createHost(config, {
        handlers,
        ...(asks
          ? {
              confirm: (request: ConfirmRequest, proceed: Proceed) =>
                (latest().confirm ?? pageConfirm ?? (() => Promise.resolve(false)))(
                  {
                    ...request,
                    display: {
                      ...request.display,
                      id: latest().displayId,
                      title: latest().title,
                    },
                  },
                  proceed,
                ),
            }
          : {}),
        ...(refusesAll !== undefined
          ? { consent: new Refused(refusesAll.code, refusesAll.message) }
          : asksConsent
            ? {
                consent: (request: ConfirmRequest) => {
                  const given = latest().consent ?? pageConsent ?? (() => false);
                  if (isRefused(given)) {
                    throw given;
                  }
                  return given({
                    ...request,
                    display: { ...request.display, id: latest().displayId, title: latest().title },
                  });
                },
              }
            : {}),
        // Shown as the latest props name the display (P100).
        ...(pageShow === undefined
          ? {}
          : {
              show: (request: ConfirmRequest) =>
                pageShow({
                  ...request,
                  display: { ...request.display, id: latest().displayId, title: latest().title },
                }),
            }),
        ...(caches
          ? {
              cached: (args: { readonly uri: string }, context: CallContext) =>
                (latest().cached ?? pageCached)?.(args, named(context)),
            }
          : {}),
        theme: (each) => (latest().theme ?? latestPage().theme)?.(each) ?? {},
        ...(hostInfo === undefined ? {} : { hostInfo }),
        ...(locate === undefined ? {} : { locator: { locate } }),
        ...(nonce === undefined ? {} : { nonce }),
      }).mount(container, {
        displayId: first.displayId,
        title: first.title,
        scheme: first.scheme ?? latestPage().scheme ?? "light",
        initialHeightPx: startHeight,
        ...(view === undefined ? {} : { document: view }),
        ...(instance === undefined ? {} : { instance }),
        ...(declaration === undefined ? {} : { declaration }),
        ...(viewer === undefined ? {} : { viewer }),
        ...(fills ? { fill: true } : {}),
      });
    } catch (error) {
      hostFailed(first, error, "mount");
      return;
    }
    handle.current = display;
    running(display);
    const events: (keyof DisplayEvents)[] = [
      "initialized",
      "resize",
      "error",
      "navigated",
      "navigationBlocked",
      "refused",
      "muted",
      "focusTaken",
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
    // The followed mark, once the marks are shown; without `annotate`, the core's error.
    following.current = null;
    const wanted = first.trackedAnnotation ?? null;
    asked.current = wanted;
    if (wanted !== null) {
      attempt(() => {
        display.annotations.track(wanted);
        following.current = wanted;
      }, first);
    }
    if (first.content !== undefined) {
      display.setContent(first.content, { partial: first.partial === true });
    }
    return () => {
      display.destroy();
      handle.current = null;
      running(null);
      following.current = null;
    };
    // A new display only for a new config, document or instance, or what the provider makes
    // displays with (its nonce, hostInfo by value, whether it locates or confirms; generation, by
    // key). Content, scheme, theme, handlers, id and title are fed to the running one.
  }, [
    config,
    view,
    instance,
    declaration,
    viewer,
    startHeight,
    fills,
    pageHandlers,
    pageCopyText,
    pageConfirm,
    pageConsent,
    pageShow,
    pageCached,
    refusesAll,
    hostInfo,
    locate,
    nonce,
    running,
  ]);

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
      attempt(() => {
        display.annotations.show(annotations ?? []);
        // A show without the followed mark stops the following (the core's own).
        if (following.current !== null && !shown(annotations, following.current)) {
          following.current = null;
        }
      }, latest());
    }
  }, [annotates, annotations]);
  // The followed mark follows its prop (after the marks above, so the two can change together).
  const trackedAnnotation = frame.trackedAnnotation ?? null;
  useEffect(() => {
    const display = handle.current;
    const changed = trackedAnnotation !== asked.current;
    asked.current = trackedAnnotation;
    if (display === null || trackedAnnotation === following.current) {
      return;
    }
    // Its mark was taken off (the error, if any, was told when the prop said it): followed again
    // once the marks have it back.
    if (!changed && trackedAnnotation !== null && !shown(annotations, trackedAnnotation)) {
      return;
    }
    attempt(() => {
      display.annotations.track(trackedAnnotation);
      following.current = trackedAnnotation;
    }, latest());
  }, [trackedAnnotation, annotations]);
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
  const themeKey = frame.themeKey ?? page.themeKey;
  const [mountThemeKey] = useState(themeKey);
  useEffect(() => {
    if (themeKey !== undefined && themeKey !== mountThemeKey) {
      handle.current?.refreshTheme();
    }
  }, [themeKey, mountThemeKey]);
  // A new theme function (tokens a host passes inline): its values reach the running display
  // where they changed for the scheme it shows (a flip re-reads them itself), P074.
  const themeOf = frame.theme ?? page.theme;
  const themed = useRef<string | null>(null);
  useEffect(() => {
    if (themeOf === undefined) {
      return;
    }
    const now = `${scheme}\n${JSON.stringify(themeOf(scheme))}`;
    const before = themed.current;
    themed.current = now;
    if (before !== null && before !== now && before.startsWith(`${scheme}\n`)) {
      handle.current?.refreshTheme();
    }
  }, [themeOf, scheme]);

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

/** Whether `marks` has a mark `id`. */
function shown(marks: readonly AnnotationMark[] | undefined, id: string): boolean {
  return (marks ?? []).some((mark) => mark.id === id);
}

/** The id `focusedAnnotation` names, if any. */
function focusOf(value: PortholeFrameProps["focusedAnnotation"]): string | null {
  return typeof value === "string"
    ? value
    : value === null || value === undefined
      ? null
      : value.id;
}
