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
  /** Extra `connect-src` origins this capability needs. */
  readonly connect?: readonly string[];
  /** Extra script/style/img/font/media origins this capability needs. */
  readonly resource?: readonly string[];
  /** Replaces the generated manual entry for this capability. */
  readonly guide?: string;
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
}

export interface ThemeConfig {
  /**
   * Every CSS variable the content may read, with its default per scheme. The shell injects
   * exactly these names (the host supplies live values for them) and the manual teaches them.
   */
  readonly variables: Readonly<Record<string, ThemeValue>>;
  /** The window event the shell fires after the theme changed, for code that must redraw. */
  readonly event: string;
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
}

/** Where the host shows the content, for the manual's size rules. */
export interface LayoutConfig {
  /** The narrowest the frame ever is (a small phone). */
  readonly minWidthPx: number;
  /** A typical phone's width: what the content is designed for first. */
  readonly narrowWidthPx: number;
  /** The widest the frame is (a desktop column). */
  readonly wideWidthPx: number;
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
}
