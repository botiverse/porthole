import { maybeSameSite, parseOrigin } from "../isolation/served.ts";
import type { ContentDomain } from "./types.ts";

/**
 * A content domain from deployment settings (P066): `content.example.com`, `content.localhost:8790`
 * or `https://content.example.com`, parsed, and checked against the app's own origins. Porthole
 * never serves a content domain that holds an app origin or may share its site: the host kit
 * either throws at startup or (with its opaque fallback) reports it as permanently unhealthy.
 */

export interface ContentDomainInfo {
  /** The registrable domain content is served under (`content.example.com`). */
  readonly domain: string;
  /** `http` only on loopback (`localhost`, `*.localhost`). */
  readonly scheme: "https" | "http";
  /** A port other than the scheme's default. */
  readonly port?: number;
  /** The frame source every content origin matches (`https://*.content.example.com`). */
  readonly source: string;
  /** The origin a label is served on. */
  originOf(label: string): string;
  /** Whether a host (or hostname) is under the content domain (the apex included). */
  isContentHost(host: string): boolean;
  /** The part of a hostname under the content domain (`a-1`, `x.f`), or null. */
  labelOf(host: string): string | null;
}

export type ContentDomainProblem = "invalid" | "clash" | "same-site";

/** Why a content domain can't be served; `code` says which rule (P066). */
export class ContentDomainError extends Error {
  readonly code: ContentDomainProblem;

  constructor(code: ContentDomainProblem, message: string) {
    super(message);
    this.name = "ContentDomainError";
    this.code = code;
  }
}

const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const LOOPBACK = (host: string) => host === "localhost" || host.endsWith(".localhost");
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/u;

/** A hostname as it compares: lowercase, no port, no trailing dot. */
export function hostnameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  const bare = lower.startsWith("[")
    ? lower.replace(/(\])(:\d+)?$/u, "$1")
    : lower.replace(/:\d+$/u, "");
  return bare.replace(/\.$/u, "");
}

/**
 * Parses a content domain. `null` for an empty setting (content off). Throws a
 * `ContentDomainError` for one that isn't a domain, or that holds or may share a site with one of
 * `appOrigins` (the clash rules, named in the message).
 */
export function contentDomain(
  input: string | null | undefined,
  options: { readonly appOrigins: readonly string[] },
): ContentDomainInfo | null {
  const raw = (input ?? "").trim().toLowerCase().replace(/\/+$/u, "");
  if (raw === "") {
    return null;
  }
  const match = /^(?:(https?):\/\/)?([^/:]+)(?::(\d{1,5}))?$/u.exec(raw);
  const host = match?.[2]?.replace(/^\.+|\.+$/gu, "") ?? "";
  if (
    match === null ||
    !HOST.test(host) ||
    IPV4.test(host) ||
    (!host.includes(".") && host !== "localhost")
  ) {
    throw new ContentDomainError(
      "invalid",
      `The content domain ${JSON.stringify(input)} isn't a domain: give host[:port] (content.example.com, content.localhost:8790)`,
    );
  }
  const loopback = LOOPBACK(host);
  const scheme =
    match[1] === undefined ? (loopback ? "http" : "https") : (match[1] as "http" | "https");
  if (scheme === "http" && !loopback) {
    throw new ContentDomainError(
      "invalid",
      `The content domain ${host} is served over http, which only loopback may use: serve it over https`,
    );
  }
  const portNumber = match[3] === undefined ? undefined : Number(match[3]);
  if (portNumber !== undefined && (portNumber < 1 || portNumber > 65_535)) {
    throw new ContentDomainError("invalid", `The content domain's port ${match[3]} isn't a port`);
  }
  const port = portNumber === (scheme === "https" ? 443 : 80) ? undefined : portNumber;
  const portPart = port === undefined ? "" : `:${port}`;
  const info: ContentDomainInfo = {
    domain: host,
    scheme,
    ...(port === undefined ? {} : { port }),
    source: `${scheme}://*.${host}${portPart}`,
    originOf: (label) => `${scheme}://${label}.${host}${portPart}`,
    isContentHost: (each) => {
      const name = hostnameOf(each);
      return name === host || name.endsWith(`.${host}`);
    },
    labelOf: (each) => {
      const name = hostnameOf(each);
      return name.endsWith(`.${host}`) ? name.slice(0, -host.length - 1) : null;
    },
  };
  const problem = clashOf(info, options.appOrigins);
  if (problem !== null) {
    throw problem;
  }
  return info;
}

/** The first clash between a content domain and the app's origins, as an error; null if none. */
export function clashOf(
  info: ContentDomainInfo,
  appOrigins: readonly string[],
): ContentDomainError | null {
  // A label of the content domain, as a scope's would be: what "same site" is judged against.
  const sample = `a1b2c3d4e5f6g7h8i9j0k1l2.${info.domain}`;
  for (const origin of appOrigins) {
    // A desktop app's own scheme (ferry://app) is never the same site as web content.
    const parsed = parseOrigin(origin);
    if (parsed === null) {
      continue;
    }
    if (info.isContentHost(parsed.host)) {
      return new ContentDomainError(
        "clash",
        `The content domain ${info.domain} holds the app's own origin ${origin}: content there could read the app's cookies and storage. Serve content from a domain the app uses for nothing else`,
      );
    }
    if (maybeSameSite(parsed.host, sample)) {
      return new ContentDomainError(
        "same-site",
        `The content domain ${info.domain} may be the same site as the app's origin ${origin}: serve content from a registrable domain the app uses for nothing else`,
      );
    }
  }
  return null;
}

/** The `ContentDomain` `createServer` takes, from parsed settings. */
export function serverDomain(
  info: ContentDomainInfo,
  naming: Pick<ContentDomain, "name" | "reserved">,
): ContentDomain {
  return {
    domain: info.domain,
    scheme: info.scheme,
    ...(info.port === undefined ? {} : { port: info.port }),
    ...(naming.name === undefined ? {} : { name: naming.name }),
    ...(naming.reserved === undefined ? {} : { reserved: naming.reserved }),
  };
}
