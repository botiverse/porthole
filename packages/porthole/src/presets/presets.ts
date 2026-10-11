import type { CapabilityName } from "../config/capabilities.ts";
import type {
  CapabilityConfig,
  CapabilityMap,
  EgressConfig,
  EmbedderConfig,
  GuideConfig,
  IsolationKind,
  LayoutConfig,
  Limits,
  PortholeConfig,
  ThemeValue,
  UrlSandboxExtra,
} from "../config/schema.ts";
import { validateConfig } from "../config/validate.ts";
import { DEFAULT_THEME_EVENT, DEFAULT_THEME_VARIABLES } from "../theme/variables.ts";

/**
 * The preset policy layer (P001): named configs with safe defaults. Every preset starts with
 * egress closed and only the capabilities that carry nothing out of the frame (its size, its
 * errors, both to the host only); a host declares the rest, and each gets its default gates
 * unless the host names its own. A preset returns a validated config.
 */

/** What a host may change about a preset. Anything else is the preset's. */
export interface PresetOptions {
  /** Capabilities to declare (merged over the preset's), or `false` to drop one the preset has. */
  readonly capabilities?: { readonly [N in CapabilityName]?: CapabilityConfig | false };
  /** Origins to open, added to the preset's (closed) egress. */
  readonly egress?: EgressConfig;
  /**
   * Theme defaults to change, variables to add, or (null) defaults to drop; the theme event's
   * name; and whether whole documents follow the person's scheme (`ThemeConfig.documents`).
   */
  readonly theme?: {
    readonly variables?: Readonly<Record<string, ThemeValue | null>>;
    readonly event?: string;
    readonly documents?: "declared" | "always";
  };
  readonly limits?: Partial<Limits>;
  readonly layout?: Partial<LayoutConfig>;
  readonly guide?: GuideConfig;
  /** `opaque` (default) or `domain` for a served document (needs `contentOrigins`). */
  readonly isolation?: Exclude<IsolationKind, "external">;
  readonly contentOrigins?: readonly string[];
  readonly embedder?: EmbedderConfig;
}

/** The url preset's options: where the app is served, and the embedding page's extra frames. */
export interface UrlPresetOptions {
  readonly contentOrigins: readonly string[];
  /** Sandbox tokens to add for the app (popups for an OAuth flow, modals, downloads; P037). */
  readonly sandbox?: readonly UrlSandboxExtra[];
  readonly limits?: Partial<Limits>;
  readonly layout?: Partial<LayoutConfig>;
  readonly embedder?: EmbedderConfig;
}

/**
 * Library CDNs a host may open with one line (`egress: LIBRARY_CDNS`): read-only package caches
 * for scripts, styles, fonts, images and data, plus Google Fonts. Not on by default: every preset
 * starts with egress closed.
 */
export const LIBRARY_CDNS: EgressConfig = {
  script: [
    "https://cdnjs.cloudflare.com",
    "https://cdn.jsdelivr.net",
    "https://unpkg.com",
    "https://esm.sh",
  ],
  style: [
    "https://cdnjs.cloudflare.com",
    "https://cdn.jsdelivr.net",
    "https://unpkg.com",
    "https://esm.sh",
    "https://fonts.googleapis.com",
  ],
  font: [
    "https://fonts.gstatic.com",
    "https://cdnjs.cloudflare.com",
    "https://cdn.jsdelivr.net",
    "https://unpkg.com",
    "https://esm.sh",
  ],
  img: [
    "https://cdnjs.cloudflare.com",
    "https://cdn.jsdelivr.net",
    "https://unpkg.com",
    "https://esm.sh",
  ],
  connect: [
    "https://cdnjs.cloudflare.com",
    "https://cdn.jsdelivr.net",
    "https://unpkg.com",
    "https://esm.sh",
  ],
};

const BASE_LIMITS: Limits = {
  maxHeightPx: 2_000,
  minHeightPx: 24,
  maxBytes: 200_000,
  maxLiveFrames: 8,
  declinesBeforeMute: 3,
  maxPromptChars: 8_000,
  maxErrorReports: 5,
};

const BASE_LAYOUT: LayoutConfig = { minWidthPx: 280, narrowWidthPx: 300, wideWidthPx: 750 };

/** Only what reports to the host and carries nothing out: the frame's size and its errors. */
const BASE_CAPABILITIES: CapabilityMap = { resize: {}, reportError: {} };

const mergeEgress = (base: EgressConfig, extra: EgressConfig | undefined): EgressConfig => {
  const kinds = ["connect", "script", "style", "img", "font", "media"] as const;
  const merged: { -readonly [K in keyof EgressConfig]: EgressConfig[K] } = {};
  for (const kind of kinds) {
    const origins = [...new Set([...(base[kind] ?? []), ...(extra?.[kind] ?? [])])];
    if (origins.length > 0) {
      merged[kind] = origins;
    }
  }
  return merged;
};

/** The default variables, with the host's changes and additions, less those it dropped (null). */
function themeVariables(
  changes: Readonly<Record<string, ThemeValue | null>> | undefined,
): Record<string, ThemeValue> {
  const variables: Record<string, ThemeValue> = { ...DEFAULT_THEME_VARIABLES };
  for (const [name, value] of Object.entries(changes ?? {})) {
    if (value === null) {
      delete variables[name];
    } else {
      variables[name] = value;
    }
  }
  return variables;
}

function build(
  mode: PortholeConfig["mode"],
  defaults: { readonly limits?: Partial<Limits> },
  options: PresetOptions,
): PortholeConfig {
  const capabilities: { -readonly [N in CapabilityName]?: CapabilityConfig } = {
    ...BASE_CAPABILITIES,
  };
  for (const [name, value] of Object.entries(options.capabilities ?? {}) as [
    CapabilityName,
    CapabilityConfig | false,
  ][]) {
    if (value === false) {
      delete capabilities[name];
    } else {
      capabilities[name] = value;
    }
  }
  return validateConfig({
    mode,
    isolation: options.isolation ?? "opaque",
    capabilities,
    egress: mergeEgress({}, options.egress),
    theme: {
      variables: themeVariables(options.theme?.variables),
      event: options.theme?.event ?? DEFAULT_THEME_EVENT,
      ...(options.theme?.documents === undefined ? {} : { documents: options.theme.documents }),
    },
    limits: { ...BASE_LIMITS, ...defaults.limits, ...options.limits },
    layout: { ...BASE_LAYOUT, ...options.layout },
    guide: options.guide ?? {},
    contentOrigins: options.contentOrigins ?? [],
    embedder: options.embedder ?? {},
  });
}

export const presets = {
  /**
   * An HTML fragment or SVG an agent wrote, drawn inline (a card in a conversation): an opaque
   * frame with the shell, streamed as it is written.
   */
  inlineWidget: (options: PresetOptions = {}): PortholeConfig => build("inline", {}, options),

  /**
   * A whole HTML page: written into an opaque frame by the shell where the host has the page, or
   * served on its own origin (`isolation: "domain"`). A document scrolls inside past a shorter cap.
   */
  artifact: (options: PresetOptions = {}): PortholeConfig =>
    build("artifact", { limits: { maxHeightPx: 720, minHeightPx: 120 } }, options),

  /**
   * A standard MCP Apps view, through an MCP Apps adapter. The view's own `_meta.ui.csp` is
   * mapped into `egress` by that adapter; the host declares the capabilities it serves.
   */
  mcpApp: (options: PresetOptions = {}): PortholeConfig => build("mcp-app", {}, options),

  /**
   * A running app by URL (a dev server's preview): frame, isolation and access auth only. No
   * shell, no capabilities, no egress control: the app is someone else's, on its own origin.
   */
  url: (options: UrlPresetOptions): PortholeConfig =>
    validateConfig({
      mode: "url",
      isolation: "external",
      capabilities: {},
      egress: {},
      theme: { variables: {}, event: DEFAULT_THEME_EVENT },
      limits: { ...BASE_LIMITS, maxHeightPx: 4_000, minHeightPx: 120, ...options.limits },
      layout: { ...BASE_LAYOUT, ...options.layout },
      guide: {},
      contentOrigins: options.contentOrigins,
      embedder: options.embedder ?? {},
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    }),
} as const;

export type PresetName = keyof typeof presets;
