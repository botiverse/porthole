import type { FrameLocation } from "./types.ts";

/**
 * Checks for served frames (domain and external isolation), shared by the host's mount and by
 * `/server`: a served origin must be one the config names, and never of the host's own site
 * (P016, P020). Pure, no DOM and no Node, so both sides run the same code.
 */

const EXACT_ORIGIN = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/u;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/u;

interface ParsedOrigin {
  readonly scheme: string;
  readonly host: string;
  readonly port: string;
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: "80", https: "443" };

/** `scheme://host[:port]`, lowercase, nothing else; null for anything that isn't exactly that. */
export function parseOrigin(origin: string): ParsedOrigin | null {
  const match = EXACT_ORIGIN.exec(origin);
  if (match === null) {
    return null;
  }
  const [, scheme = "", host = "", port] = match;
  return { scheme, host, port: port ?? DEFAULT_PORTS[scheme] ?? "" };
}

/**
 * The start of every label Porthole serves for itself on a content domain (P114): no host's naming
 * may make one (`content.name` is refused one, and `prefixedName` won't take the prefix).
 */
export const PORTHOLE_LABEL_PREFIX = "porthole-";

const NESTED_LABEL = /^porthole-[a-z2-7]{24}$/u;

/** Whether a label is a nested page's shell's own (P114, `nestedLabelOf`'s form). */
export const isNestedLabel = (label: string): boolean => NESTED_LABEL.test(label);

/**
 * Whether `origin` is on a nested page's shell's own label (P114): its host's first label is one.
 * The shell runs nowhere else (P121): the host's mount, the shell itself and `/server`'s helpers
 * each refuse any other origin, so a content Worker of a host's own can't put it beside other
 * content by mistake.
 */
export function onNestedLabel(origin: string): boolean {
  const parsed = parseOrigin(origin);
  return parsed !== null && isNestedLabel(parsed.host.split(".")[0] ?? "");
}

/** Whether `origin` is an exact origin (`https://host[:port]`, lowercase, no path). */
export function isExactOrigin(origin: unknown): origin is string {
  return typeof origin === "string" && parseOrigin(origin) !== null;
}

/**
 * A host page's origin, exactly as `location.origin` and a message's `event.origin` give it:
 * `scheme://host[:port]`, lowercase, any scheme (an Electron or Tauri app's own registered scheme,
 * `ferry://app`, `app://local`), never `"null"` (an opaque origin isn't one origin: every opaque
 * page says "null") and never a path. The shell takes messages only from these, exactly.
 */
const HOST_ORIGIN =
  /^[a-z][a-z0-9+.-]*:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(:\d{1,5})?$/u;

export function isHostOrigin(origin: unknown): origin is string {
  return typeof origin === "string" && origin.length <= 300 && HOST_ORIGIN.test(origin);
}

/** Why `origin` can't be a host origin, in words a host's developer can act on; null if it can. */
export function hostOriginProblem(origin: unknown): string | null {
  if (isHostOrigin(origin)) {
    return null;
  }
  if (origin === "null") {
    return 'the host page\'s origin is opaque ("null"): serve it from a real origin (an Electron custom protocol must be registered as standard, and file: pages have none)';
  }
  return `${JSON.stringify(origin)} is not an exact origin (scheme://host[:port], lowercase, no path)`;
}

/**
 * Whether two hosts may be the same site. Without the public-suffix list this errs one way only:
 * it says "same site" whenever the hosts are equal or share their last two labels, so a pair it
 * calls cross-site always is (a refused pair, like `a.github.io` and `b.github.io`, may not be:
 * a safe failure). An IP address is a site of its own; `localhost`'s subdomains are each one, as
 * browsers treat an unlisted top-level name as a public suffix.
 */
export function maybeSameSite(hostA: string, hostB: string): boolean {
  const a = hostA.toLowerCase().replace(/\.$/u, "");
  const b = hostB.toLowerCase().replace(/\.$/u, "");
  if (a === b) {
    return true;
  }
  if (IPV4.test(a) || IPV4.test(b) || a.startsWith("[") || b.startsWith("[")) {
    return false;
  }
  const labelsA = a.split(".").toReversed();
  const labelsB = b.split(".").toReversed();
  let shared = 0;
  while (
    shared < labelsA.length &&
    shared < labelsB.length &&
    labelsA[shared] === labelsB[shared]
  ) {
    shared += 1;
  }
  return shared >= 2;
}

/**
 * Whether `origin` matches a frame source as the config writes them (`https://*.example.com`,
 * `http://*.localhost:8790`, or an exact origin): same scheme and port; `*.` matches one or more
 * labels below the name, never the name itself.
 */
export function originMatchesSource(origin: string, source: string): boolean {
  const parsed = parseOrigin(origin);
  const wildcard = /^(https?):\/\/\*\.([a-z0-9.-]+)(?::(\d{1,5}))?$/u.exec(source);
  if (parsed === null) {
    return false;
  }
  if (wildcard === null) {
    const exact = parseOrigin(source);
    return (
      exact !== null &&
      exact.scheme === parsed.scheme &&
      exact.host === parsed.host &&
      exact.port === parsed.port
    );
  }
  const [, scheme = "", suffix = "", port] = wildcard;
  return (
    scheme === parsed.scheme &&
    (port ?? DEFAULT_PORTS[scheme]) === parsed.port &&
    parsed.host.endsWith(`.${suffix}`) &&
    parsed.host.length > suffix.length + 1
  );
}

/**
 * Throws unless `location` is a frame a host on `hostOrigin` may load for a config whose content
 * is served from `contentOrigins`: its URL is on its stated origin, that origin is one the config
 * names, and it is not of the host's own site (a same-site frame with `allow-same-origin` could
 * reach cookies and storage the host shares with its site).
 */
export function checkFrameLocation(
  location: FrameLocation,
  contentOrigins: readonly string[],
  hostOrigin: string,
  /** The config nests its pages (P111): the location must be on a shell's own label (P121). */
  nested = false,
): void {
  const origin = parseOrigin(location.origin);
  let url: URL;
  try {
    url = new URL(location.url);
  } catch {
    throw new TypeError("The located URL is not a URL");
  }
  if (origin === null || url.origin !== location.origin) {
    throw new TypeError(
      // Named by its origin only: a located URL carries a ticket, which never goes in a message.
      `The located URL is not on its origin ${JSON.stringify(location.origin)} (it is on ${JSON.stringify(safeOrigin(location.url))})`,
    );
  }
  if (!contentOrigins.some((source) => originMatchesSource(location.origin, source))) {
    throw new TypeError(
      `The located origin ${location.origin} is not one of the config's content origins`,
    );
  }
  if (nested && !onNestedLabel(location.origin)) {
    throw new TypeError(
      `The located origin ${location.origin} isn't a nested page's own: its shell is served on a label of its own alone (${PORTHOLE_LABEL_PREFIX}<24 base32>, nestedLabelOf(label), P114), never beside other content`,
    );
  }
  const host = parseOrigin(hostOrigin);
  if (host !== null && maybeSameSite(origin.host, host.host)) {
    throw new TypeError(
      `The located origin ${location.origin} may be the same site as the host (${hostOrigin}): content must be served from a registrable domain the host uses for nothing else`,
    );
  }
}

/** A URL's origin, for a message: never its path or query (a ticket). */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "an unparsable address";
  }
}
