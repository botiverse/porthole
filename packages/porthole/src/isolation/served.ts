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

/** Whether `origin` is an exact origin (`https://host[:port]`, lowercase, no path). */
export function isExactOrigin(origin: unknown): origin is string {
  return typeof origin === "string" && parseOrigin(origin) !== null;
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
): void {
  const origin = parseOrigin(location.origin);
  let url: URL;
  try {
    url = new URL(location.url);
  } catch {
    throw new TypeError(`The located URL ${JSON.stringify(location.url)} is not a URL`);
  }
  if (origin === null || url.origin !== location.origin) {
    throw new TypeError(
      `The located URL ${JSON.stringify(location.url)} is not on its origin ${JSON.stringify(location.origin)}`,
    );
  }
  if (!contentOrigins.some((source) => originMatchesSource(location.origin, source))) {
    throw new TypeError(
      `The located origin ${location.origin} is not one of the config's content origins`,
    );
  }
  const host = parseOrigin(hostOrigin);
  if (host !== null && maybeSameSite(origin.host, host.host)) {
    throw new TypeError(
      `The located origin ${location.origin} may be the same site as the host (${hostOrigin}): content must be served from a registrable domain the host uses for nothing else`,
    );
  }
}
