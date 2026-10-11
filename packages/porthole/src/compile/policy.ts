import { CAPABILITIES, type CapabilityName, type Gate } from "../config/capabilities.ts";
import type { EgressConfig, PortholeConfig } from "../config/schema.ts";

/**
 * The frame's policies, derived from the config: its CSP (in the shell's `<meta>` for opaque
 * frames, in headers for served ones), its `sandbox` and `allow` attributes, and the `frame-src`
 * the EMBEDDING page must send. Pure, so a test can tie each source back to the config.
 */

/** A CSP directive: its name, then its sources. */
export type CspDirective = readonly [name: string, ...sources: string[]];

export type EgressKind = keyof EgressConfig;

/** The capabilities a config declares, in vocabulary order. */
export function declaredCapabilities(config: PortholeConfig): CapabilityName[] {
  return (Object.keys(CAPABILITIES) as CapabilityName[]).filter(
    (name) => config.capabilities[name] !== undefined,
  );
}

/** The gates a declared capability runs under: its own, else the vocabulary's defaults. */
export function effectiveGates(config: PortholeConfig, name: CapabilityName): readonly Gate[] {
  return config.capabilities[name]?.gates ?? CAPABILITIES[name].defaultGates;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/** The origins content may reach for `kind`: the base allowlist plus every declared capability's. */
export function egressOrigins(config: PortholeConfig, kind: EgressKind): string[] {
  const fromCapabilities = declaredCapabilities(config).flatMap((name) => {
    const capability = config.capabilities[name];
    return (kind === "connect" ? capability?.connect : capability?.resource) ?? [];
  });
  return unique([...(config.egress[kind] ?? []), ...fromCapabilities]);
}

/** Every origin content may reach, of any kind. */
export function allEgressOrigins(config: PortholeConfig): string[] {
  const kinds: EgressKind[] = ["connect", "script", "style", "img", "font", "media"];
  return unique(kinds.flatMap((kind) => egressOrigins(config, kind)));
}

const list = (sources: readonly string[]): string[] =>
  sources.length === 0 ? ["'none'"] : [...sources];

/**
 * The frame's CSP directives. Closed by default: `default-src 'none'`, and each kind opened only
 * to the config's origins. Inline code runs (agent content is inline), so the walls are origin
 * isolation and egress, not script provenance. No `'self'` anywhere: an opaque frame has nothing
 * of its own to load, and its `'self'` may be the embedding page's origin. Empty for url mode,
 * whose app serves its own policy.
 */
export function frameCspDirectives(config: PortholeConfig): CspDirective[] {
  if (config.mode === "url") {
    return [];
  }
  const origins = (kind: EgressKind) => egressOrigins(config, kind);
  return [
    ["default-src", "'none'"],
    ["script-src", "'unsafe-inline'", "'unsafe-eval'", "blob:", ...origins("script")],
    ["style-src", "'unsafe-inline'", ...origins("style")],
    ["font-src", "data:", ...origins("font")],
    ["img-src", "data:", "blob:", ...origins("img")],
    ["media-src", "data:", "blob:", ...origins("media")],
    ["connect-src", ...list(origins("connect"))],
    ["worker-src", "blob:"],
    ["child-src", "blob:"],
    ["frame-src", "'none'"],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
    ["form-action", "'none'"],
    // WebRTC reaches the network outside connect-src (ICE gathering against a STUN/TURN server).
    // Engines that honor this token block it; the shell removes the RTC constructors for the rest.
    ["webrtc", "'block'"],
  ];
}

export function serializeCsp(directives: readonly CspDirective[]): string {
  return directives.map((directive) => directive.join(" ")).join("; ");
}

/**
 * The frame's `sandbox` tokens. Opaque: scripts only, so the frame is an opaque origin and gets
 * no forms, popups, downloads, modals or top navigation. Domain: its own origin as well, which is
 * safe only because that origin is a separate site from the host's (the mount refuses one that
 * isn't). External (url mode): what a running web app needs to work on its own origin.
 */
export function sandboxTokens(config: PortholeConfig): string[] {
  switch (config.isolation) {
    case "opaque":
      return ["allow-scripts"];
    case "domain":
      return ["allow-scripts", "allow-same-origin"];
    case "external":
      return ["allow-scripts", "allow-same-origin", "allow-forms"];
  }
}

/**
 * The frame's `allow` attribute (Permissions Policy). Empty: no camera, microphone, geolocation,
 * clipboard, fullscreen or other powerful feature is delegated to the frame.
 */
export function allowAttribute(_config: PortholeConfig): string {
  return "";
}

/**
 * The `frame-src` sources the EMBEDDING page must allow, and nothing else: a frame's own CSP can't
 * stop it navigating itself to an external URL with data in the query, but the embedding page's
 * `frame-src` governs every navigation of its frames, including self-initiated ones. `'self'`
 * covers `srcdoc` frames; served and external content adds its own origins.
 */
export function embedderFrameSources(config: PortholeConfig): string[] {
  return unique(["'self'", ...config.contentOrigins, ...(config.embedder.frameSrc ?? [])]);
}

/**
 * The CSP the embedding page sends (a header, or the host's own document's policy), for every kind
 * of display it shows. It sets no `default-src`: it restricts frames only, leaving the host's own
 * scripts, styles and fetches to the host's policy. `child-src` repeats `frame-src` for engines
 * that read frames from it.
 */
export function embedderCsp(configs: readonly PortholeConfig[]): string {
  const sources = unique(configs.flatMap(embedderFrameSources));
  const all = sources.length === 0 ? ["'self'"] : sources;
  return serializeCsp([
    ["frame-src", ...all],
    ["child-src", ...all],
  ]);
}
