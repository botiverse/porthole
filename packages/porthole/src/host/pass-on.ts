import type { CapabilityName } from "../config/capabilities.ts";
import type { PortholeConfig } from "../config/schema.ts";
import { egressOrigins, type EgressKind } from "../compile/policy.ts";
import { LIBRARY_CDNS } from "../presets/presets.ts";
import { familyOf, runtimeCapability } from "../runtime/contract.ts";
import type { PageDeclaration } from "../runtime/declaration.ts";

/** Every kind a page reaches the network by. */
const KINDS: readonly EgressKind[] = ["connect", "script", "style", "img", "font", "media"];

/**
 * The host functions that carry what a page puts in them to someone other than the person viewing
 * it (P112, after the review, porthole#54): stores others read (`db`, a new version through
 * `artifact`, the asset library through `assets`), a URL the person opens (`openLink`), the agent's
 * conversation and context (`sendPrompt`, `setModelContext`), and the host's data services, which
 * may be someone else's (`callTool`, `readData`, `subscribeData`: their arguments are the page's).
 * Not here: the person's own clipboard and disk (`copyText`, `downloadFile`), the host's own UI
 * (`annotate`, `resize`, `comments`: the composer is the person's, under the host's duties), and
 * what only reads (`user`). `reportError` is one where the config sends errors to the agent.
 */
const CARRIERS: readonly CapabilityName[] = [
  "db",
  "artifact",
  "assets",
  "openLink",
  "sendPrompt",
  "setModelContext",
  "callTool",
  "readData",
  "subscribeData",
];

/**
 * Whether a page shown under `config` with `declaration` may pass on what it is given (P112: a
 * person's draft, which a host shows a page only where it can't). It may when it can reach one of
 * the host functions that carry what it puts in them to others (`CARRIERS`; `reportError` where
 * errors go to the agent), or the network beyond the library CDNs (`LIBRARY_CDNS`): any https site
 * (`anyHttps`), or an origin the host (or a capability) added for connections, scripts, styles,
 * images, fonts or media. A library CDN serves published packages by their path, and its logs are
 * its operator's, not the page author's: not counted. A page reaches a host function the config
 * declares: under the runtime with a declaration, only through a built-in family or one it
 * declared (one no family serves, wherever the config declares it); without a declaration (a page from before 0.7), or without the runtime, every one, as
 * 0.6's globals. The host's rule made checkable: "a page with a channel gets no drafts".
 */
export function mayPassOn(config: PortholeConfig, declaration: PageDeclaration | null): boolean {
  const declared = (declaration?.capabilities ?? {}) as Readonly<Record<string, unknown>>;
  const reaches = (name: CapabilityName): boolean => {
    if (config.capabilities[name] === undefined) {
      return false;
    }
    if (config.runtime === undefined || declaration === null) {
      return true;
    }
    // One no runtime family serves (`reportError`: the shell reports what the page throws) is
    // the page's wherever the config declares it.
    const family = familyOf(name);
    return (
      family === null ||
      runtimeCapability(family.name).builtIn ||
      declared[family.name] !== undefined
    );
  };
  if (CARRIERS.some(reaches) || (config.errors === "agent" && reaches("reportError"))) {
    return true;
  }
  if ((config.egress.anyHttps ?? []).length > 0) {
    return true;
  }
  return KINDS.some((kind) => {
    const cdns = new Set(LIBRARY_CDNS[kind] ?? []);
    return egressOrigins(config, kind).some((origin) => !cdns.has(origin));
  });
}
