import type { PortholeConfig } from "../config/schema.ts";
import { egressOrigins, type EgressKind } from "../compile/policy.ts";
import { LIBRARY_CDNS } from "../presets/presets.ts";
import { offeredCapabilities } from "../runtime/contract.ts";
import type { PageDeclaration } from "../runtime/declaration.ts";

/** Every kind a page reaches the network by. */
const KINDS: readonly EgressKind[] = ["connect", "script", "style", "img", "font", "media"];

/**
 * Whether a page shown under `config` with `declaration` may pass on what it is given (P112: a
 * person's draft, which a host shows a page only where it can't): it may when it can keep it where
 * others read it, knowing whose it is (`db` and `user`, both declared and offered), or when it
 * reaches the network beyond the library CDNs (`LIBRARY_CDNS`): any https site (`anyHttps`), or an
 * origin the host (or a capability) added for connections, scripts, styles, images, fonts or media.
 * A library CDN serves published packages by their path, and its logs aren't the page author's: not
 * counted. A page without a declaration (before 0.7) has none of the runtime's
 * stores. The host's rule made checkable: "a page with a channel gets no drafts".
 */
export function mayPassOn(config: PortholeConfig, declaration: PageDeclaration | null): boolean {
  const offered = new Set(offeredCapabilities(config));
  const declared = declaration?.capabilities ?? {};
  const keeps =
    declared.db !== undefined &&
    offered.has("db") &&
    declared.user !== undefined &&
    offered.has("user");
  if (keeps) {
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
