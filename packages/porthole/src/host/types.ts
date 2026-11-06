import type { AnnotateMode, AnnotationMark, AnnotationReport } from "../annotate/types.ts";
import type { FindOptions, FindResult } from "../find/types.ts";
import type { Refused } from "../bridge/refusal.ts";
import type {
  Confirm,
  CapabilityHandlers,
  Consent,
  DataCache,
  Refusal,
  Show,
} from "../bridge/types.ts";
import type { CompiledConfig } from "../compile/compile.ts";
import type { CapabilityName } from "../config/capabilities.ts";
import type { ColorScheme } from "../config/schema.ts";
import type { InstanceLocator, InstanceRef } from "../isolation/types.ts";
import type { PlatformHost } from "../platform/types.ts";
import type { AdapterConnection, ProtocolAdapter, ShellConnection } from "../protocol/adapter.ts";
import type { HostContext } from "../protocol/mcp-apps.ts";
import type { PageDeclaration } from "../runtime/declaration.ts";
import type { ViewerInfo } from "../runtime/levels.ts";

/**
 * The host-side API (framework-agnostic; the web platform by default). A host compiles a config
 * once (`createHost`), then mounts a display per piece of content. Everything here is mechanism;
 * the host passes policy: its handlers, who confirms, its theme values.
 */

export interface HostOptions<C extends AdapterConnection = ShellConnection> {
  /** Handlers for the declared capabilities; a mount may pass its own over these. */
  readonly handlers?: CapabilityHandlers;
  /** Who confirms `confirm`-gated calls. Absent: those calls are refused. */
  readonly confirm?: Confirm;
  /**
   * Whether a display may make its `consent`-gated calls (read the viewer's data, P079): asked
   * once per display, before the first, and kept for the display's life (its reloads too).
   * Absent: those calls are refused. A `Refused` instead of a function refuses every one with its
   * reason, asking nothing, and those capabilities need no handler (a page where live data must
   * not run, P080).
   */
  readonly consent?: Consent | Refused;
  /**
   * Puts a `show`-gated call in front of the person, outside the frame, before its handler has it
   * (P100): by default, every `setModelContext` update, the content's text for the model's next
   * turns ("this content updated the agent's context: …", the latest per display). Absent: those
   * calls are refused.
   */
  readonly show?: Show;
  /**
   * What the host last had for a resource (P079): a read of one the content subscribes to is
   * answered with it at once, marked stale, then with the handler's fresh result.
   */
  readonly cached?: DataCache;
  /**
   * The host's live values for the config's theme variables, for `scheme` (read from its own
   * design tokens). A name it leaves out, or answers empty, gets the config's default.
   */
  readonly theme?: (scheme: ColorScheme) => Readonly<Record<string, string | null | undefined>>;
  /** The host's own context fields (locale, time zone, platform): merged into the host context. */
  readonly hostContext?: () => Partial<HostContext>;
  /** How the host names itself in the handshake. */
  readonly hostInfo?: { readonly name: string; readonly version: string };
  /** The protocol adapter. Default: the core's shell adapter (inline and artifact modes). */
  readonly adapter?: ProtocolAdapter<C>;
  /** The platform host. Default: the web's iframe host. */
  readonly platform?: PlatformHost;
  /** Required for domain and external isolation: where an instance's frame loads from. */
  readonly locator?: InstanceLocator;
  /**
   * The embedding page's CSP nonce, where its `script-src` is nonce-based (P054): an opaque frame
   * (`srcdoc`) inherits the page's policy, so the shell and the content's scripts carry it. A
   * function is read each time a frame starts (a page whose nonce changes). Served frames inherit
   * nothing and need none.
   */
  readonly nonce?: string | (() => string | undefined);
}

export interface MountOptions {
  /** The host's id for this display: what its height is remembered by, and calls name. */
  readonly displayId: string;
  /** The display's accessible name and the title its confirmations show (the host's words). */
  readonly title: string;
  readonly scheme: ColorScheme;
  /** Handlers for this display only, over the host's. */
  readonly handlers?: CapabilityHandlers;
  /**
   * Domain and external isolation: the instance to locate. Opaque: the host's own name for what
   * the display shows, given back to the host in its confirmations (`ConfirmRequest.display`) and
   * never sent to the frame (P077).
   */
  readonly instance?: InstanceRef;
  /** A whole document the frame starts with (an MCP Apps view), hardened by the shell. */
  readonly document?: string;
  /** The height to start at, before the content reports its own. */
  readonly initialHeightPx?: number;
  /**
   * What the page declared (P086), as the host stored it with the artifact at publish
   * (`declareCapabilities`): its capabilities, and the runtime contract it is pinned to. The
   * bridge holds the page to it; a page reaches only the built-ins and what it declared. Required
   * under `config.runtime` (after the review): `null` says the page was published before 0.7 and
   * has 0.6's surface (built-ins through `porthole.use`, 0.6's globals and requests as before).
   * Checked against the config at mount (a `TypeError` for one that doesn't fit). For a version
   * older than the artifact's current one, `intersectDeclarations(version's, current)`.
   */
  readonly declaration?: PageDeclaration | null;
  /**
   * Who is viewing (P087): their level, and for `user` their public id and name. A served
   * display's issue answer (`FrameLocation.viewer`, from the host's access) takes precedence.
   * Absent everywhere: 0.6's functions run as before; the runtime's own are refused.
   */
  readonly viewer?: ViewerInfo;
  /**
   * Fill the container (give it a height) instead of taking the content's height.
   *
   * @deprecated Say it in the config, `layout: { kind: "fill" }`: every mount then fills, and the
   * manual tells the agent so (a page that scrolls itself, `position: fixed` works). This option
   * sizes only this frame, so the manual keeps saying the height follows the content (P071). A
   * url-mode app always fills.
   */
  readonly fill?: boolean;
}

/** What failed on the host's side (`hostError`). */
export type HostErrorKind =
  /** The locator rejected: the host's backend didn't give a location. */
  | "locate"
  /** A display couldn't be made (the React binding: a bad config, a missing handler). */
  | "mount"
  /** An annotation call was refused (an invalid mark, an unknown id). */
  | "annotations"
  /** A find call was refused (a query too long, options that aren't these: P131). */
  | "find"
  /**
   * A frame status (`porthole/notifications/frame-status`) the host didn't take, since it came
   * from the frame's content, not from a page of Porthole's server (P124): never shown, never an
   * outcome. Told once a run. A served display that isn't nested takes none from its frame at
   * all: its door says how loading went (P125).
   */
  | "frame-status"
  /**
   * A served display that has a door (P125: a served shell, a page that isn't nested, the sandbox
   * proxy) was located without one: the server is older than the host (upgrade it first), or a
   * locator dropped `FrameLocation.door`. The display shows, but no frame status is taken, so a
   * block is told as a timeout. Told once a mount.
   */
  | "door";

/** What a display reports, by event name. */
/** Why a display's frame showed nothing of its content (`FrameOutcome`). */
export type FrameBlock =
  /** The page that frames it isn't one its server allows (frame-ancestors), or it never ran. */
  | "framing"
  /** The browser keeps no cookie for it inside a frame (WebKit, P025): open it on a tab. */
  | "cookies"
  /** The person isn't signed in at the app, and its sign-in never shows in a frame: a tab (P068). */
  | "sign-in"
  /** Its ticket was used or its session ended. */
  | "session"
  /** Its app didn't answer. */
  | "upstream"
  /** The host's own check refused it (revoked, no longer a member): `code` says which. */
  | "denied"
  /** The host's locator failed (its backend down, access gone): see the `hostError` event. */
  | "locate"
  | "not-found"
  | "error";

/**
 * How a display's document went: it loaded (a shell or view finished its handshake; a url-mode
 * app's document loaded), it was blocked (and why), or nothing settled in
 * `limits.loadTimeoutMs`. Once per run, plus a later `blocked` if a url-mode app's frame shows a
 * status page after it loaded (access revoked mid-session). A host shows its own fallback ("Open in
 * a new tab") on anything but loaded. A `blocked` is the word of a page of Porthole's server (or a
 * host's gateway, or its own pages), never of a frame's content, except a url-mode app's (P124):
 * in a frame that speaks, only its run's first document says it; an opaque frame never does.
 */
export type FrameOutcome =
  | { readonly state: "loaded" }
  | {
      readonly state: "blocked";
      readonly reason: FrameBlock;
      readonly status?: number;
      /** The host's own reason code, for `denied` (`Authorizer`). */
      readonly code?: string;
    }
  | { readonly state: "timeout" };

export interface DisplayEvents {
  /** The frame finished its handshake (url mode, which has none: its first document loaded). */
  readonly initialized: undefined;
  /** How the frame's first document went (`FrameOutcome`). */
  readonly outcome: FrameOutcome;
  /** The content's size, after the config's limits. */
  readonly resize: { readonly height: number; readonly width?: number };
  /**
   * What the content did wrong: what it threw, what the sandbox blocked (its own words:
   * untrusted), or that it kept navigating its frame away. The agent's to hear and fix.
   */
  readonly contentError: { readonly message: string };
  /**
   * What failed on the host's side (`kind`): its locator, for now. The host's to handle; never
   * the agent's. The display's `outcome` says `blocked: locate` too.
   */
  readonly hostError: { readonly message: string; readonly kind: HostErrorKind };
  /**
   * Both of the above, with their `source`: for a host that listened here before they were
   * split (0.1.3). Prefer `contentError` and `hostError`.
   */
  readonly error: { readonly message: string; readonly source: "content" | "host" };
  /** The content navigated its frame away; the frame was started again from its content. */
  readonly navigated: undefined;
  /**
   * The shell stopped the content navigating its frame to `url` (P079, P080): the address whole,
   * as the content gave it (its word: untrusted, may carry data in its query). Only where the
   * config declares `reportError` (it counts as one of the run's reports), and only in frames with
   * an origin of their own (served): an opaque frame's navigations get no events. A
   * `contentError` follows, naming the address without its query or fragment.
   */
  readonly navigationBlocked: { readonly url: string };
  /** A call didn't run. */
  readonly refused: { readonly capability: CapabilityName; readonly refusal: Refusal };
  /** Too many declines: the display stops asking until it runs again. */
  readonly muted: undefined;
  /**
   * The content moved the keyboard into its frame from one of the page's text fields without the
   * person (no press on the frame, no Tab, P109), and focus went back where it was; `typing`: the
   * person had pressed a key on the page within the last second. The content's doing. Three while
   * typing within 10 s, or five within 2 s, stop the display (`contentError` says so; `reload()`
   * runs it again).
   */
  readonly focusTaken: { readonly typing: boolean };
  /**
   * Whether the page touched `localStorage` or `sessionStorage` (the in-memory stand-in of a frame
   * without storage of its own: opaque, or a nested page, P111): once per run, `used: true` when
   * the page first did, else `used: false` as the run ends. Never what it kept: for a host to count
   * the pages that would need storage.
   */
  readonly storage: { readonly used: boolean };
  /**
   * What the frame reported about annotations (`annotate`, P053), checked and taken only while
   * the host asked for it: a selection, its clearing, a cancelled pick, where marks are. The
   * content's word: UI hints, never permissions.
   */
  readonly annotation: AnnotationReport;
  /**
   * The person pressed Cmd+F (Apple) or Ctrl+F (elsewhere) with the keyboard in the frame (`find`,
   * P131): open the host's find bar. Only while the host takes the shortcut
   * (`find.takeShortcut(true)`, which stops the browser's own find there) and the page's focus is
   * in the frame (where the platform can tell). The content's word: it can say it without the key,
   * or keep the key; open the bar, nothing more.
   */
  readonly findRequested: undefined;
  /**
   * The matches of the query shown changed without the host asking (`find`, P131): the content
   * changed (more of it, or the page's own changes). At most once a second, from an honest shell.
   * The content's word: a find bar's numbers.
   */
  readonly findUpdated: FindResult;
}

/**
 * Find in page on a display whose config declares `find` (P131): the host draws the find bar,
 * the frame finds and highlights. The query is posted into the frame, where the content can read
 * it. Where the config doesn't declare `find`, `query` answers `"unsupported"` and the rest do
 * nothing. The shortcut is kept and given to every frame the display runs. The query holds only for
 * the content it was asked of: a new run (`reload()`, a restart after the content navigated away,
 * a new location) or other content (`setContent` with content that doesn't continue what was
 * given) forgets it and answers what waits `"unsupported"`, and nothing is found there until the
 * host asks again: clear your find bar then.
 */
export interface FindControls {
  /**
   * Finds `query` in the content's text (case-insensitive by default, any spacing), highlights
   * every match, makes one current (the first in view for a new query; the next or previous one
   * with `direction`), scrolls it into view, and answers where they stand. An empty query (or
   * only spaces) clears, and answers no matches. `"unsupported"` where the frame can't find: the
   * config doesn't declare `find`, the frame's shell is older (it answered that it doesn't know
   * the request), it failed, it didn't answer in `FIND_LIMITS.timeoutMs` once it ran, a later
   * query superseded it before it ran (only the latest is searched: show the answer to your latest
   * query only), or the content it was asked of is gone (a new run, other content). Rejects
   * with a `TypeError` for a query longer than `FIND_LIMITS.query`, or options that aren't these.
   */
  query(query: string, options?: FindOptions): Promise<FindResult | "unsupported">;
  /** Removes the highlights and forgets the query (the find bar closed). */
  clear(): void;
  /**
   * Whether the host draws its own find bar for this display (default no): while it does, Cmd+F
   * or Ctrl+F in the frame doesn't open the browser's own find, and the display says
   * `findRequested` instead. A page that handles the key itself keeps it.
   */
  takeShortcut(take: boolean): void;
}

/**
 * Annotations on a display whose config declares `annotate` (P053). The host's state is kept and
 * given to every frame the display runs (a reload, a navigation recovered from).
 */
export interface AnnotationControls {
  /** Lets the person point at elements, select text, or both (default both). */
  start(mode?: AnnotateMode): void;
  stop(): void;
  /** Marks these anchors (replacing the marks before); the frame reports where they are. */
  show(marks: readonly AnnotationMark[]): void;
  /** Brings a mark into view in the frame and makes it the active one. */
  focus(id: string): void;
  /**
   * Follows one shown mark (P112): while it moves (a scroll, a layout change) the display reports
   * `{ type: "tracked", id, rect }` at most once per animation frame (60 a second), its box clamped
   * to the frame, for that mark only; `null` stops. One at a time: a new id replaces the last.
   * Throws for an id no shown mark has; a `show` without it, or `clear`, stops it. From a newer
   * shell (P132) each also carries the mark's `documentRect` and the document's `scroll`, so
   * following one mark tells how far the document scrolled, for every mark placed by `documentRect`.
   */
  track(id: string | null): void;
  /** Removes every mark. */
  clear(): void;
  /**
   * Takes the page's text selection away (P115), its highlight with it: for when the host has
   * used it (a comment posted, a draft added). No `unselected` follows; marks (posted and drafts),
   * the mode and a followed mark stay as they are. Nothing selected: nothing happens. Not kept for
   * a frame that runs later (it has no selection to clear).
   */
  clearSelection(): void;
  /**
   * Puts the keyboard back on a mark's marker in the frame (P134): for after Escape closed the
   * host's own view of that mark, and for nothing else. No content goes with it, and no report
   * comes of it. Nothing happens, and nothing throws, for an id no mark with a marker is shown
   * under, or if the frame has no such marker now (its words are gone, elements are being picked):
   * the display's own `focus()` isn't used, so the frame takes no focus for a marker it hasn't got.
   * Call it once the view is closed: from one of the page's text fields that still has focus, the
   * move is the frame's own to the focus guard, undone and counted (P109). The page can take the
   * focus back at once. Not kept for a frame that runs later.
   *
   * On a calm page it lands at once, from anywhere on the host's page. While the frame is finding
   * its marks (a `show` just sent, the content just changed) it waits, and is then dropped unless
   * the focus is in the frame by then (P135), so a word that comes late takes no keyboard from a
   * person who moved on. Nothing says it was dropped: if the frame isn't your page's
   * `document.activeElement` soon after and the person hasn't moved on, call `focus()` and then
   * `focusMark(id)` again.
   */
  focusMark(id: string): void;
}

export interface DisplayControls {
  readonly displayId: string;
  /**
   * The theme flipped: the frame is re-themed in place, without a reload. The host's values are
   * read two animation frames later, once a host that restyles its page asynchronously has.
   */
  setTheme(scheme: ColorScheme): void;
  /** The host's theme values changed (same scheme): read them now and re-theme the frame. */
  refreshTheme(): void;
  on<E extends keyof DisplayEvents>(
    event: E,
    listener: (detail: DisplayEvents[E]) => void,
  ): () => void;
  /** Annotations (`annotate`): throws on use where the config doesn't declare it. */
  readonly annotations: AnnotationControls;
  /** Find in page (`find`, P131): `"unsupported"` where the config doesn't declare it. */
  readonly find: FindControls;
  /** Runs the content again from the start, in a new frame. */
  reload(): void;
  /**
   * Moves focus into the display's frame, as the host's own move: from one of the page's text
   * fields, a frame's own `focus()` is taken for the content's and undone (P109).
   */
  focus(): void;
  /** Tears the view down and removes the frame. */
  destroy(): void;
}

/** A mounted display: the framework's controls plus the adapter's own operations. */
export type DisplayHandle<C extends AdapterConnection = ShellConnection> = DisplayControls &
  Omit<C, keyof AdapterConnection>;

export interface PortholeHost<C extends AdapterConnection = ShellConnection> {
  readonly compiled: CompiledConfig;
  /**
   * Creates a display in `container`. Throws if a declared capability served by a handler has
   * none (here or in the host's options), so a manual never teaches a function nobody serves.
   */
  mount(container: HTMLElement, options: MountOptions): DisplayHandle<C>;
  /**
   * Whether a page with `declaration` may pass on what it is given (`mayPassOn`, P112): true where
   * it can store what others read (`db` and `user`) or reaches the network beyond the library CDNs.
   * A host shows such a page none of a person's drafts.
   */
  mayPassOn(declaration: PageDeclaration | null): boolean;
}
