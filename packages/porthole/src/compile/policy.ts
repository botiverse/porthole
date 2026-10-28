import { CAPABILITIES, type CapabilityName, type Gate } from "../config/capabilities.ts";
import type { PortholeConfig } from "../config/schema.ts";
import { LIBRARY_PATH } from "../libraries/libraries.ts";
import { assetCodeRuns, familyOf, methodGates, methodsOfCall } from "../runtime/contract.ts";
import { ASSET_PATH } from "../runtime/requests.ts";

/**
 * The frame's policies, derived from the config: its CSP (in the shell's `<meta>` for opaque
 * frames, in headers for served ones), its `sandbox` and `allow` attributes, and the `frame-src`
 * the EMBEDDING page must send. Pure, so a test can tie each source back to the config.
 */

/** A CSP directive: its name, then its sources. */
export type CspDirective = readonly [name: string, ...sources: string[]];

export type EgressKind = "connect" | "script" | "style" | "img" | "font" | "media";

/** Whether `kind` loads from any https site (`EgressConfig.anyHttps`, P059): passive kinds only. */
export function anyHttps(config: PortholeConfig, kind: EgressKind): boolean {
  return (config.egress.anyHttps ?? []).some((each) => each === kind);
}

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

/**
 * The gates one call runs under: its host function's, and the own gates of each runtime method it
 * runs (after the review: `artifact.publish`, `assets.delete`, an upload whose code may run; P094:
 * a db batch's writes' and a watch's read's too, `methodsOfCall`), every one applying.
 */
export function callGates(
  config: PortholeConfig,
  name: CapabilityName,
  args: unknown,
): readonly Gate[] {
  const gates = [...effectiveGates(config, name)];
  const family = familyOf(name);
  if (family === null) {
    return gates;
  }
  for (const method of new Set(methodsOfCall(name, args))) {
    for (const gate of methodGates(config, family.name, method)) {
      if (!gates.includes(gate)) {
        gates.push(gate);
      }
    }
  }
  return gates;
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

/**
 * Where Porthole's vendored libraries load from (`egress.libraries`, P079): their path on the
 * content origins, so the frame's own, path-limited (nothing else served there runs as a script).
 */
export function librarySources(config: PortholeConfig): string[] {
  return config.egress.libraries === true && config.isolation === "domain"
    ? config.contentOrigins.map((origin) => `${origin}${LIBRARY_PATH}`)
    : [];
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
  // Any https site, for passive kinds a host opened so (P059); never for what runs or talks.
  const https = (kind: "img" | "media" | "font") => (anyHttps(config, kind) ? ["https:"] : []);
  return [
    ["default-src", "'none'"],
    [
      "script-src",
      "'unsafe-inline'",
      "'unsafe-eval'",
      "blob:",
      ...origins("script"),
      ...librarySources(config),
    ],
    ["style-src", "'unsafe-inline'", ...origins("style")],
    ["font-src", "data:", ...https("font"), ...origins("font")],
    ["img-src", "data:", "blob:", ...https("img"), ...origins("img")],
    ["media-src", "data:", "blob:", ...https("media"), ...origins("media")],
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

/** The directives a page of a file set loads its own files under (P082): everything that loads. */
export const FILE_SET_DIRECTIVES = [
  "script-src",
  "style-src",
  "font-src",
  "img-src",
  "media-src",
  "connect-src",
  "worker-src",
] as const;

/**
 * A served page's CSP when it comes with files (P082): the frame's, with its version's own files
 * opened for each kind that loads (`FILE_SET_DIRECTIVES`), by `source`, the files' path on the
 * content origin (`https://a-x.example-usercontent.com/v/3/`). Never `'self'`: the origin's other
 * paths (other versions, Porthole's own) stay closed, and frames, plugins, forms and `<base>` stay
 * `'none'`. Opaque frames have no files, and keep P022's rule whole.
 */
export function fileSetCspDirectives(
  directives: readonly CspDirective[],
  source: string,
): CspDirective[] {
  const opened = new Set<string>(FILE_SET_DIRECTIVES);
  return directives.map(([name, ...sources]) => {
    if (!opened.has(name)) {
      return [name, ...sources];
    }
    const kept = sources.filter((each) => each !== "'none'");
    return [name, ...kept, source];
  });
}

/**
 * The directives a page opens its artifact's asset library to (P089), at `/_blob/` on its own
 * origin: what loads without running, always; what runs (scripts, styles) only where uploads are
 * the admins' alone, who publish the page's code anyway.
 */
export const ASSET_DIRECTIVES = ["img-src", "media-src", "font-src", "connect-src"] as const;
export const ASSET_CODE_DIRECTIVES = ["script-src", "style-src"] as const;

export { assetCodeRuns };

/**
 * A served page's CSP with its asset library opened (P089), on `origin` (the page's own, exact:
 * never a sibling's): only where the config declares `assets`. Never `'self'`.
 */
export function assetCspDirectives(
  config: PortholeConfig,
  directives: readonly CspDirective[],
  origin: string,
): CspDirective[] {
  if (config.capabilities.assets === undefined || config.isolation !== "domain") {
    return [...directives];
  }
  const source = `${origin}${ASSET_PATH}`;
  const opened = new Set<string>([
    ...ASSET_DIRECTIVES,
    ...(assetCodeRuns(config) ? ASSET_CODE_DIRECTIVES : []),
  ]);
  return directives.map(([name, ...sources]) => {
    if (!opened.has(name)) {
      return [name, ...sources];
    }
    const kept = sources.filter((each) => each !== "'none'");
    return [name, ...kept, source];
  });
}

/**
 * The CSP of a file of a set that is neither a page nor a script (P081): nothing loads from it,
 * and opened as a document (an SVG, an XML file) it runs nothing, on an opaque origin.
 */
export const INERT_FILE_CSP = "default-src 'none'; sandbox";

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
      // Nested (P111), this frame holds Porthole's shell, on a label of its own where no content
      // runs with this origin (P114), and the page is the shell's child (`PAGE_SANDBOX_TOKENS`).
      return ["allow-scripts", "allow-same-origin"];
    case "external":
      // The host may add a documented few (popups, modals, downloads), never top navigation.
      return ["allow-scripts", "allow-same-origin", "allow-forms", ...(config.sandbox ?? [])];
  }
}

/**
 * The `sandbox` a served document's CSP header carries (P099): the frame's own tokens, so a page
 * opened on a tab of its own (a public link, a new tab, a bookmark, a frame's address opened
 * outside it) holds no power it lacks in its frame: scripts on its own origin, and no popups,
 * forms, downloads, modals, or navigation of another window (its opener's included). In a frame
 * it repeats the frame's attribute, so it changes nothing there; it is sent on every served page,
 * not only on a `Sec-Fetch-Dest: document` request, so a client that sends no fetch metadata is
 * sandboxed too and one address needs no `Vary`. Domain isolation only: url mode serves the app's
 * own documents, and opaque content is never served. Never in a `<meta>` (browsers ignore it there).
 */
export function servedSandboxDirective(config: PortholeConfig): CspDirective | null {
  if (config.isolation !== "domain") {
    return null;
  }
  return ["sandbox", ...(config.nested === true ? PAGE_SANDBOX_TOKENS : sandboxTokens(config))];
}

/**
 * A nested page's sandbox (P111): its frame's attribute, set by Porthole's shell, and its own CSP
 * header's, so it is an opaque origin in the shell's child frame and on a tab of its own. Scripts
 * only: never `allow-same-origin`, which would give the page its served origin, the shell's, and
 * so the shell's realm (a test holds every sandbox Porthole writes to this).
 */
export const PAGE_SANDBOX_TOKENS: readonly string[] = ["allow-scripts"];

/** A served page's CSP header: the page's directives, then its sandbox (P099). */
export function servedDocumentCsp(
  config: PortholeConfig,
  directives: readonly CspDirective[],
): string {
  const sandbox = servedSandboxDirective(config);
  return serializeCsp(sandbox === null ? directives : [...directives, sandbox]);
}

/**
 * The features a cross-origin frame never has unless its `allow` names them (each one's default
 * allowlist is `'self'`), and a served page denies itself (P099): devices, location, full screen,
 * the clipboard, payments, credentials, sharing, the built-in AI models, WebMCP's `tools`, the
 * local network, autofill. Every such feature Chromium lists for web pages
 * (`test/reference/permissions-policy-features.json`), but client hints, `cross-origin-isolated`
 * and Chromium's sample (`test/permissions-policy.test.ts` says why). Features whose default is
 * `*` (a video's picture-in-picture, gamepads) are left out: a frame has them, so denying them on
 * a tab would change the frame too. An engine that doesn't know a name ignores it.
 */
export const FRAME_DENIED_FEATURES = [
  "accelerometer",
  "ambient-light-sensor",
  "autofill",
  "autoplay",
  "bluetooth",
  "camera",
  "captured-surface-control",
  "clipboard-read",
  "clipboard-write",
  "compute-pressure",
  "deferred-fetch",
  "device-attributes",
  "digital-credentials-create",
  "digital-credentials-get",
  "display-capture",
  "encrypted-media",
  "fullscreen",
  "geolocation",
  "gyroscope",
  "haptics",
  "hid",
  "identity-credentials-get",
  "idle-detection",
  "keyboard-map",
  "language-detector",
  "language-model",
  "local-fonts",
  "local-network",
  "local-network-access",
  "loopback-network",
  "magnetometer",
  "manual-text",
  "microphone",
  "midi",
  "on-device-speech-recognition",
  "otp-credentials",
  "payment",
  "publickey-credentials-create",
  "publickey-credentials-get",
  "publickey-credentials-remote-client-data-json",
  "rewriter",
  "screen-wake-lock",
  "serial",
  "speaker-selection",
  "summarizer",
  "tools",
  "translator",
  "unbounded-element",
  "usb",
  "web-app-installation",
  "web-share",
  "webnn",
  "window-management",
  "writer",
  "xr-spatial-tracking",
] as const;

/** The features a frame's `allow` attribute grants (`allowAttribute`): none but url mode's. */
export function delegatedFeatures(config: PortholeConfig): string[] {
  return config.mode === "url" ? [...(config.permissions ?? [])] : [];
}

/**
 * The `Permissions-Policy` header of a served page (P099): every feature of
 * `FRAME_DENIED_FEATURES` its frame's `allow` doesn't grant, denied (`camera=()`), so a page on
 * a tab of its own (no `allow` there) can't ask for the camera, the microphone, location or full
 * screen under the content origin's name. In a frame it changes nothing: the frame's `allow`
 * grants none of them, and a frame's features are the intersection of the two. Domain isolation
 * only, as `servedSandboxDirective`.
 */
export function servedPermissionsPolicy(config: PortholeConfig): string | null {
  if (config.isolation !== "domain") {
    return null;
  }
  const granted = new Set(delegatedFeatures(config));
  return FRAME_DENIED_FEATURES.filter((feature) => !granted.has(feature))
    .map((feature) => `${feature}=()`)
    .join(", ");
}

/**
 * The frame's `allow` attribute (Permissions Policy). No camera, microphone, geolocation,
 * fullscreen or other powerful feature is delegated to the frame, and the clipboard is denied by
 * name (P051): content never writes it, the host does (`copyText`). A url-mode config may
 * delegate clipboard writes and full screen to the app's own origin (P049).
 */
export function allowAttribute(config: PortholeConfig): string {
  return config.mode === "url"
    ? (config.permissions ?? []).join("; ")
    : "clipboard-read 'none'; clipboard-write 'none'";
}

/**
 * The `frame-src` sources the EMBEDDING page must allow, and nothing else: a frame's own CSP can't
 * stop it navigating itself to an external URL with data in the query, but the embedding page's
 * `frame-src` governs every navigation of its frames, including self-initiated ones. `srcdoc`
 * frames need no source (measured: they load under `frame-src 'none'`), so opaque content gets
 * none, and can't navigate its frame even to the host's own origin (P033); served and external
 * content adds its own origins, and a host its own frames (`'self'` only if it names it).
 */
export function embedderFrameSources(config: PortholeConfig): string[] {
  return unique([...config.contentOrigins, ...(config.embedder.frameSrc ?? [])]);
}

/**
 * The CSP the embedding page sends (a header, or the host's own document's policy), for every kind
 * of display it shows. Frames only: no `default-src`, so the host's own scripts, styles and
 * fetches stay its policy's; and no `child-src`, which the host's workers would fall back to (every
 * engine Porthole supports reads frames from `frame-src`, P038).
 */
export function embedderCsp(configs: readonly PortholeConfig[]): string {
  const sources = embedderFrameSourcesOf(configs);
  return serializeCsp([["frame-src", ...(sources.length === 0 ? ["'none'"] : sources)]]);
}

/**
 * The `frame-src` sources the embedding page must allow for every kind of display it shows, as a
 * list, for a host that writes its own policy around them (empty: it frames nothing of
 * Porthole's but `srcdoc`, which needs none).
 */
export function embedderFrameSourcesOf(configs: readonly PortholeConfig[]): string[] {
  return unique(configs.flatMap(embedderFrameSources));
}
