import type { RuntimeVersion } from "../runtime/contract.ts";
import type { ViewerLevel } from "../runtime/levels.ts";
import type { CapabilityName, Gate } from "./capabilities.ts";

/**
 * One config per kind of display (PRINCIPLE 3). The compiler derives the frame's CSP, its sandbox
 * and `allow` attributes, the embedding page's frame policy, the shell's wiring, and the agent
 * manual and tool description from it, together. A preset is a config with safe defaults filled
 * in; hosts adopt one and override theme values and callbacks.
 */

/** What is shown. */
export type DisplayMode =
  /** An HTML fragment or SVG the host has (an agent wrote it), drawn by the shell. */
  | "inline"
  /** A whole HTML document: a standalone page. */
  | "artifact"
  /** A standard MCP Apps view: a `ui://` template, its tool input and result. */
  | "mcp-app"
  /** A running app by URL (a dev server's preview): frame, isolation and access auth only. */
  | "url";

/** How the content is kept away from the host. */
export type IsolationKind =
  /** A sandboxed `srcdoc` frame without `allow-same-origin`: an opaque origin, no storage. */
  | "opaque"
  /**
   * A document served on its own subdomain of a separate registrable domain (`/server`): a real,
   * stable origin per storage scope, its CSP in headers, private content behind a ticket.
   */
  | "domain"
  /** Someone else's origin (url mode): the frame loads it as is; there is no shell. */
  | "external";

export type ColorScheme = "light" | "dark";

/** A theme variable's value: one for both schemes, or one per scheme. */
export type ThemeValue = string | { readonly light: string; readonly dark: string };

export interface CapabilityConfig {
  /** Every gate must pass. Omitted: the capability's default gates. `[]`: ungated. */
  readonly gates?: readonly Gate[];
  /**
   * Says that `gates` leaves out the default `show` on purpose (P100: `setModelContext`): the
   * host's handler shows the person each update itself, or the content is its own. Without it,
   * such gates earn a warning (`configWarnings`); with `show` in the gates, or no gates named, it
   * is an error.
   */
  readonly withoutShow?: true;
  /** Extra `connect-src` origins this capability needs. */
  readonly connect?: readonly string[];
  /** Extra script/style/img/font/media origins this capability needs. */
  readonly resource?: readonly string[];
  /** Replaces the generated manual entry for this capability. */
  readonly guide?: string;
  /**
   * The least viewer level that may call each of the runtime methods it serves (P087), by method
   * name (`db: { levels: { set: "admin" } }`, `sendPrompt: { levels: { send: "admin" } }`): over
   * the contract's own, never below a method's floor (`RUNTIME_CAPABILITIES`). For
   * `assets.upload`, `admin` or above also lets the page run what was uploaded as scripts and
   * styles (P089); `interact` doesn't.
   */
  readonly levels?: Readonly<Record<string, ViewerLevel>>;
  /**
   * Gates of each runtime method it serves, by name, in place of the contract's own (after the
   * review: `artifact.publish` and `assets.delete` need a click and a yes; `assets.upload` a yes
   * where uploaded code may run). Every one applies on top of `gates`. `[]`: none of its own.
   * A call that runs other methods runs under theirs too (P094): a db `batch` under each of its
   * writes' (`set`, `update`, `delete`; one confirmation for the whole batch, a rate counting each
   * write), a `watch` under `get`'s (a document) or `query`'s (a collection), checked when it
   * starts: its updates are its answers, so a rate counts once per watch, not per update.
   */
  readonly methodGates?: Readonly<Record<string, readonly Gate[]>>;
}

/** The declared capabilities. Absent: not available, not wired, not in the CSP, not in the manual. */
export type CapabilityMap = { readonly [N in CapabilityName]?: CapabilityConfig };

/**
 * Where content may load from and talk to, as exact origins (`https://cdn.example.com`, or
 * `https://*.example.com` for every subdomain). Empty everywhere is the default: egress closed.
 * Capabilities add their own needs to these.
 */
export interface EgressConfig {
  readonly connect?: readonly string[];
  readonly script?: readonly string[];
  readonly style?: readonly string[];
  readonly img?: readonly string[];
  readonly font?: readonly string[];
  readonly media?: readonly string[];
  /**
   * Passive content that may load from any https site (P059): images, audio and video, fonts, for
   * pages that hotlink them. Never scripts, styles or data. It opens a channel out: a viewer's
   * address and a visit signal reach any site, and data can leave in the URL.
   */
  readonly anyHttps?: readonly PassiveKind[];
  /**
   * Porthole's own copies of a few libraries (`VENDORED_LIBRARIES`: Chart.js, D3), served from the
   * frame's own origin under `/__porthole/lib/` (P079): domain isolation only. They open no
   * channel out: the requests reach the content server, which serves fixed files, so a display
   * with no network of its own (`presets.liveWidget`) still draws charts.
   */
  readonly libraries?: boolean;
}

/** What `EgressConfig.anyHttps` may open: content that runs nothing (P059). */
export const PASSIVE_KINDS = ["img", "media", "font"] as const;

export type PassiveKind = (typeof PASSIVE_KINDS)[number];

export interface ThemeConfig {
  /**
   * Every CSS variable the content may read, with its default per scheme. The shell injects
   * exactly these names (the host supplies live values for them) and the manual teaches them.
   */
  readonly variables: Readonly<Record<string, ThemeValue>>;
  /** The window event the shell fires after the theme changed, for code that must redraw. */
  readonly event: string;
  /**
   * Whether a whole document (an artifact page) takes the person's light or dark scheme:
   * `declared` (default): only a page that declares it supports both
   * (`<meta name="color-scheme" content="light dark">`); any other page shows as its author
   * styled it, in light. `always`: every page. `never` (pages only, P065): the host has no
   * theme for it: it always gets the light values, its frame says light, and no theme change
   * reaches it. The variables are there in every case.
   */
  readonly documents?: "declared" | "always" | "never";
}

export interface Limits {
  /** The tallest the frame grows before its content scrolls inside it. */
  readonly maxHeightPx: number;
  /** The shortest the frame is once its content reported a size. */
  readonly minHeightPx: number;
  /** The largest content the manual allows (the host enforces it where it takes content in). */
  readonly maxBytes: number;
  /** The most frames of this kind a page runs at once (the React binding's live-frame cap). */
  readonly maxLiveFrames: number;
  /** Declined confirmations after which a display stops asking until it runs again. */
  readonly declinesBeforeMute: number;
  /** The longest prompt `sendPrompt` carries. */
  readonly maxPromptChars: number;
  /** The most errors one run of a display reports. */
  readonly maxErrorReports: number;
  /**
   * How long a display may take to load before its outcome is a timeout (ms). Optional; 15 s
   * when absent.
   */
  readonly loadTimeoutMs?: number;
  /**
   * A served page's files (P081): the most a version holds (default 1000), the largest one,
   * bytes (default 25 MiB), and all of them together, bytes (default 100 MiB: a host sets its
   * own). The manual states them; `checkFileSet` and `lintFiles` hold a version to them.
   */
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxVersionBytes?: number;
}

/**
 * Sandbox tokens a url-mode frame may add to its baseline, by the host's choice (P037): a
 * person's own running app (a dev server's preview) may need popups (an OAuth flow), modals and
 * downloads. Never top navigation, and nothing for other modes.
 */
export const URL_SANDBOX_EXTRAS = [
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-modals",
  "allow-downloads",
] as const;

export type UrlSandboxExtra = (typeof URL_SANDBOX_EXTRAS)[number];

/**
 * Powerful features a url-mode frame may be delegated, by the host's choice (P049): writing the
 * clipboard (a "copy" button in the person's app) and going full screen. Nothing for other modes.
 */
export const URL_PERMISSIONS = ["clipboard-write", "fullscreen"] as const;

export type UrlPermission = (typeof URL_PERMISSIONS)[number];

/** Where the host shows the content, for the manual's size rules. */
export interface LayoutConfig {
  /** The narrowest the frame ever is (a small phone). */
  readonly minWidthPx: number;
  /** A typical phone's width: what the content is designed for first. */
  readonly narrowWidthPx: number;
  /** The widest the frame is (a desktop column). */
  readonly wideWidthPx: number;
  /**
   * How the frame sits in the host (P065). `flow` (default): a card in a column, as tall as its
   * content (up to `maxHeightPx`). `fill`: it fills the viewer (the page itself): as tall as its
   * container, the content scrolling itself, `position: fixed` and `sticky` working. Every mount
   * then fills (`MountOptions.fill`), and the manual says so.
   */
  readonly kind?: "flow" | "fill";
}

export interface GuideConfig {
  /** The host's tool that shows this content, as the manual names it (`show_widget`). */
  readonly toolName?: string;
  /** The host's tool that answers this manual, as the tool description names it. */
  readonly guideToolName?: string;
  /**
   * The host's own topics, by name, appended to the manual when asked for (a host's file tool,
   * say). They may not name a built-in topic. Write them about the host's tools, not the sandbox:
   * the sandbox's rules are generated, so they always match it.
   */
  readonly topics?: Readonly<Record<string, string>>;
}

export interface EmbedderConfig {
  /**
   * Extra `frame-src` sources the embedding page allows, for frames it shows besides these:
   * origins, or `'self'` if it frames its own pages (which lets content navigate there too).
   */
  readonly frameSrc?: readonly string[];
}

export interface PortholeConfig {
  readonly mode: DisplayMode;
  readonly isolation: IsolationKind;
  readonly capabilities: CapabilityMap;
  readonly egress: EgressConfig;
  readonly theme: ThemeConfig;
  readonly limits: Limits;
  readonly layout: LayoutConfig;
  readonly guide: GuideConfig;
  /**
   * Where `domain` and `external` content is served from, as frame-src sources
   * (`https://*.example-usercontent.com`; dev `http://*.localhost:8790`): the embedding page frames
   * them, and the host takes messages only from a frame whose origin matches. Empty for `opaque`.
   */
  readonly contentOrigins: readonly string[];
  readonly embedder: EmbedderConfig;
  /** Url mode only: sandbox tokens added to its baseline (`URL_SANDBOX_EXTRAS`). */
  readonly sandbox?: readonly UrlSandboxExtra[];
  /** Url mode only: features delegated to the frame (`URL_PERMISSIONS`); none by default. */
  readonly permissions?: readonly UrlPermission[];
  /**
   * Domain isolation: how far a display's storage reaches, for the manual. Storage is per origin,
   * and the host picks each display's origin (`InstanceRef.scope`); a host that gives several
   * displays one scope (all of a conversation's widgets) names it here (`{ shared:
   * "conversation" }`), so the manual says storage is shared across it and keys need a prefix.
   */
  readonly storage?: StorageConfig;
  /**
   * Where the content's own errors go, for the manual (P065): `agent`, back to the agent that
   * wrote it; `host`, to the app only (the agent never sees them); `none`, nowhere (the config
   * declares no `reportError`). Absent: the manual says they are reported to the app.
   */
  readonly errors?: "agent" | "host" | "none";
  /**
   * The capability runtime (P085): content reaches capabilities through one global,
   * `porthole.use(name)`, under this contract version, and the manual teaches it (with declaring
   * them, `capabilities: { name: config }`, for pages that are published). Only with it may the
   * config declare the runtime's own host functions (`user`, `comments`, `artifact`, `assets`,
   * `db`). Absent: 0.6's frames, globals and manual, exactly.
   */
  readonly runtime?: RuntimeVersion;
  /**
   * Domain isolation, artifact pages (P111): the address the host frames serves Porthole's shell
   * alone, a document of Porthole's own with no content in it, and the page runs in a child frame
   * of the shell's, sandboxed without `allow-same-origin` (an opaque origin), served from the same
   * origin at its files' sealed address. The shell is then a realm the page can't reach, above the
   * page's frame: it relays the page's messages, and tells the host when its own transient
   * activation turns on (a press in the page activates its ancestors only), which is how the host
   * knows the person, not the page, moved the keyboard into the frame or opened a comment. The
   * page has no storage of its own (an in-memory stand-in) and fetches nothing with a cookie.
   */
  readonly nested?: true;
}

export interface StorageConfig {
  /**
   * What the displays sharing one origin at once have in common, as a noun ("conversation"):
   * the manual tells authors to prefix their keys.
   */
  readonly shared?: string;
  /**
   * What one display's storage is kept for, when only one display uses its origin at a time, in
   * words ("this artifact, across its versions", P065): the manual says so, with no prefix advice.
   */
  readonly scope?: string;
}
