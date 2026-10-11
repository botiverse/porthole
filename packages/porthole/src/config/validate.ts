import { CAPABILITY_NAMES, isCapabilityName, type Gate } from "./capabilities.ts";
import { URL_PERMISSIONS, URL_SANDBOX_EXTRAS, type PortholeConfig } from "./schema.ts";

/**
 * Checks a config before anything is derived from it. Every string that ends up in a CSP, an
 * attribute or the shell is checked here, so a malformed origin can't inject a directive
 * (`https://a.com; script-src *`) and a typo can't widen a policy. A config that fails is refused
 * whole, never repaired.
 */

export class ConfigError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ConfigError";
    this.path = path;
  }
}

/** The built-in manual topics; a host's own topics may not reuse these names. */
export const BUILT_IN_TOPICS = ["widget", "chart", "interactive"] as const;

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/u;
const HOST =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/u;

/**
 * Whether `value` is a CSP host source Porthole accepts: a scheme, a host (optionally `*.` for
 * every subdomain) and an optional port, nothing else. Insecure schemes only for loopback names.
 */
export function isOriginSource(value: unknown): value is string {
  return originSourceProblem(value) === null;
}

/** Why `value` isn't an origin source Porthole accepts, in words to act on; null if it is. */
export function originSourceProblem(value: unknown): string | null {
  const shape = "is not an origin (scheme://host[:port], lowercase, no path)";
  if (typeof value !== "string" || value.length > 253 + 16) {
    return `${JSON.stringify(value)} ${shape}`;
  }
  const match = /^(https|http|wss|ws):\/\/([^/:]+|\[::1\])(:(\d{1,5}))?$/u.exec(value);
  if (match === null) {
    return `${JSON.stringify(value)} ${shape}`;
  }
  const [, scheme, host = "", , port] = match;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) {
    return `${JSON.stringify(value)} has no valid port`;
  }
  if (host !== "[::1]" && !HOST.test(host)) {
    return `${JSON.stringify(value)} ${shape}`;
  }
  if ((scheme === "http" || scheme === "ws") && !LOOPBACK.test(host.replace(/^\*\./u, "x."))) {
    return `${JSON.stringify(value)} uses ${scheme} off loopback: ${scheme} is allowed only for localhost, *.localhost, 127.0.0.1 and [::1] (loopback development); use ${scheme === "http" ? "https" : "wss"}`;
  }
  return null;
}

const fail = (path: string, message: string): never => {
  throw new ConfigError(path, message);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function object(value: unknown, path: string): Record<string, unknown> {
  return isObject(value) ? value : fail(path, "must be an object");
}

function only(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      fail(`${path}.${key}`, "is not a known field");
    }
  }
}

function sources(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    fail(path, "must be an array of origins");
    return;
  }
  value.forEach((source, index) => {
    const problem = originSourceProblem(source);
    if (problem !== null) {
      fail(`${path}[${index}]`, problem);
    }
  });
}

function positive(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    fail(path, `must be an integer from 1 to ${max}`);
  }
}

function gate(value: unknown, path: string): asserts value is Gate {
  if (value === "user-activation" || value === "confirm") {
    return;
  }
  const limit = isObject(value) && isObject(value.rateLimit) ? value.rateLimit : null;
  if (limit === null || Object.keys(value as object).length !== 1) {
    fail(path, 'must be "user-activation", "confirm" or { rateLimit: { perMinute } }');
    return;
  }
  only(limit, ["perMinute"], `${path}.rateLimit`);
  positive(limit.perMinute, `${path}.rateLimit.perMinute`, 10_000);
}

const MODES = ["inline", "artifact", "mcp-app", "url"];
const ISOLATIONS = ["opaque", "domain", "external"];

/** Returns `input` as a config once every field checks out; throws a `ConfigError` otherwise. */
export function validateConfig(input: unknown): PortholeConfig {
  const config = object(input, "config");
  only(
    config,
    [
      "mode",
      "isolation",
      "capabilities",
      "egress",
      "theme",
      "limits",
      "layout",
      "guide",
      "contentOrigins",
      "embedder",
      "sandbox",
      "permissions",
      "storage",
    ],
    "config",
  );

  if (!MODES.includes(config.mode as string)) {
    fail("config.mode", `must be one of ${MODES.join(", ")}`);
  }
  if (!ISOLATIONS.includes(config.isolation as string)) {
    fail("config.isolation", `must be one of ${ISOLATIONS.join(", ")}`);
  }
  if ((config.mode === "url") !== (config.isolation === "external")) {
    fail("config.isolation", 'url mode, and only url mode, is "external"');
  }

  const capabilities = object(config.capabilities, "config.capabilities");
  for (const [name, value] of Object.entries(capabilities)) {
    const path = `config.capabilities.${name}`;
    if (!isCapabilityName(name)) {
      fail(path, `is not a capability (${CAPABILITY_NAMES.join(", ")})`);
    }
    const capability = object(value, path);
    only(capability, ["gates", "connect", "resource", "guide"], path);
    if (capability.gates !== undefined) {
      if (!Array.isArray(capability.gates)) {
        fail(`${path}.gates`, "must be an array");
      }
      (capability.gates as unknown[]).forEach((each, index) =>
        gate(each, `${path}.gates[${index}]`),
      );
    }
    sources(capability.connect, `${path}.connect`);
    sources(capability.resource, `${path}.resource`);
    if (capability.guide !== undefined && typeof capability.guide !== "string") {
      fail(`${path}.guide`, "must be a string");
    }
  }
  if (config.mode === "url" && Object.keys(capabilities).length > 0) {
    fail("config.capabilities", "url mode has no shell, so it can declare no capabilities");
  }

  const egress = object(config.egress, "config.egress");
  const kinds = ["connect", "script", "style", "img", "font", "media"];
  only(egress, kinds, "config.egress");
  for (const kind of kinds) {
    sources(egress[kind], `config.egress.${kind}`);
  }

  const theme = object(config.theme, "config.theme");
  only(theme, ["variables", "event", "documents"], "config.theme");
  if (
    theme.documents !== undefined &&
    theme.documents !== "declared" &&
    theme.documents !== "always"
  ) {
    fail("config.theme.documents", 'must be "declared" or "always"');
  }
  const variables = object(theme.variables, "config.theme.variables");
  for (const [name, value] of Object.entries(variables)) {
    const path = `config.theme.variables[${JSON.stringify(name)}]`;
    if (!/^--[a-z0-9]+(-[a-z0-9]+)*$/u.test(name)) {
      fail(path, "must be a CSS custom property name (--lowercase-words)");
    }
    const values = isObject(value) ? [value.light, value.dark] : [value];
    if (isObject(value)) {
      only(value, ["light", "dark"], path);
    }
    for (const each of values) {
      if (
        typeof each !== "string" ||
        each.length === 0 ||
        each.length > 500 ||
        /[;{}<>]/u.test(each)
      ) {
        fail(
          path,
          "must be a CSS value (1–500 characters, no ; { } < >), or { light, dark } of them",
        );
      }
    }
  }
  if (typeof theme.event !== "string" || !/^[a-z][a-z0-9]*([:.-][a-z0-9]+)*$/u.test(theme.event)) {
    fail("config.theme.event", 'must be an event name such as "porthole:theme"');
  }

  const limits = object(config.limits, "config.limits");
  const limitNames = [
    "maxHeightPx",
    "minHeightPx",
    "maxBytes",
    "maxLiveFrames",
    "declinesBeforeMute",
    "maxPromptChars",
    "maxErrorReports",
  ];
  only(limits, [...limitNames, "loadTimeoutMs"], "config.limits");
  for (const name of limitNames) {
    positive(limits[name], `config.limits.${name}`);
  }
  if (limits.loadTimeoutMs !== undefined) {
    positive(limits.loadTimeoutMs, "config.limits.loadTimeoutMs", 600_000);
  }
  if ((limits.minHeightPx as number) > (limits.maxHeightPx as number)) {
    fail("config.limits.minHeightPx", "must not exceed maxHeightPx");
  }

  const layout = object(config.layout, "config.layout");
  only(layout, ["minWidthPx", "narrowWidthPx", "wideWidthPx"], "config.layout");
  for (const name of ["minWidthPx", "narrowWidthPx", "wideWidthPx"]) {
    positive(layout[name], `config.layout.${name}`, 10_000);
  }
  if (
    (layout.minWidthPx as number) > (layout.narrowWidthPx as number) ||
    (layout.narrowWidthPx as number) > (layout.wideWidthPx as number)
  ) {
    fail("config.layout", "must hold minWidthPx ≤ narrowWidthPx ≤ wideWidthPx");
  }

  const guide = object(config.guide, "config.guide");
  only(guide, ["toolName", "guideToolName", "topics"], "config.guide");
  for (const name of ["toolName", "guideToolName"]) {
    const value = guide[name];
    if (
      value !== undefined &&
      (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/u.test(value))
    ) {
      fail(`config.guide.${name}`, "must be a tool name (letters, digits, _ . -)");
    }
  }
  if (guide.topics !== undefined) {
    for (const [name, text] of Object.entries(object(guide.topics, "config.guide.topics"))) {
      const path = `config.guide.topics.${name}`;
      if (
        !/^[a-z][a-z0-9-]{0,31}$/u.test(name) ||
        (BUILT_IN_TOPICS as readonly string[]).includes(name)
      ) {
        fail(path, "must be a new topic name (lowercase), not a built-in one");
      }
      if (typeof text !== "string" || text.trim() === "") {
        fail(path, "must be the topic's text");
      }
    }
  }

  sources(config.contentOrigins, "config.contentOrigins");
  const served = config.isolation === "domain" || config.isolation === "external";
  const contentOrigins = config.contentOrigins as readonly string[];
  if (served !== contentOrigins.length > 0) {
    fail(
      "config.contentOrigins",
      served
        ? `${String(config.isolation)} isolation needs the origins its content is served from`
        : "opaque isolation serves nothing: leave it empty",
    );
  }

  const embedder = object(config.embedder, "config.embedder");
  only(embedder, ["frameSrc"], "config.embedder");
  // The host's own frames may include its own origin, by name.
  sources(
    Array.isArray(embedder.frameSrc)
      ? embedder.frameSrc.filter((source) => source !== "'self'")
      : embedder.frameSrc,
    "config.embedder.frameSrc",
  );

  if (config.sandbox !== undefined) {
    if (config.mode !== "url") {
      fail("config.sandbox", "only url mode may add sandbox tokens");
    }
    if (!Array.isArray(config.sandbox)) {
      fail("config.sandbox", "must be an array of sandbox tokens");
    }
    (config.sandbox as unknown[]).forEach((token, index) => {
      if (!(URL_SANDBOX_EXTRAS as readonly unknown[]).includes(token)) {
        fail(
          `config.sandbox[${index}]`,
          /top-navigation|same-origin/u.test(String(token))
            ? `${JSON.stringify(token)} is never granted (P037)`
            : `must be one of ${URL_SANDBOX_EXTRAS.join(", ")}`,
        );
      }
    });
  }

  if (config.storage !== undefined) {
    const storage = object(config.storage, "config.storage");
    only(storage, ["shared"], "config.storage");
    if (config.isolation !== "domain") {
      fail("config.storage", "only domain isolation keeps storage across displays");
    }
    if (
      storage.shared !== undefined &&
      (typeof storage.shared !== "string" || !/^[a-z][a-z -]{0,39}$/u.test(storage.shared))
    ) {
      fail("config.storage.shared", 'must be a short lowercase noun ("conversation")');
    }
  }

  if (config.permissions !== undefined) {
    if (config.mode !== "url") {
      fail("config.permissions", "only url mode may be delegated features");
    }
    if (!Array.isArray(config.permissions)) {
      fail("config.permissions", "must be an array of features");
    }
    (config.permissions as unknown[]).forEach((feature, index) => {
      if (!(URL_PERMISSIONS as readonly unknown[]).includes(feature)) {
        fail(`config.permissions[${index}]`, `must be one of ${URL_PERMISSIONS.join(", ")}`);
      }
    });
  }

  return input as PortholeConfig;
}
