import { MAX_COPY_CHARS, capabilitySpec, type CapabilityName } from "../config/capabilities.ts";
import type { PortholeConfig } from "../config/schema.ts";
import { declaredCapabilities, effectiveGates } from "../compile/policy.ts";
import { MCP_APPS_PROTOCOL_VERSION } from "../protocol/mcp-apps.ts";
import {
  RUNTIME_GLOBAL,
  methodGates,
  offeredCapabilities,
  runtimeCapability,
  type RuntimeVersion,
} from "../runtime/contract.ts";

/**
 * What the shell wires, derived from the config: the JSON the shell's runtime is given. The
 * agreement test reads it against the CSP and the manual, so it lists everything the shell
 * offers content and nothing else.
 */
export interface ShellPlan {
  /**
   * `shell`: the shell speaks MCP Apps with its host and draws the content it is sent (inline
   * widgets, artifact pages). `none`: the content is a view that speaks for itself (an MCP Apps
   * view); the shell only hardens the frame before it runs.
   */
  readonly protocol: "shell" | "none";
  /** What the host sends: a fragment (or SVG) the shell inserts, or a whole document it writes. */
  readonly content: "fragment" | "document";
  /** Each declared capability, and whether the shell refuses a call made without a gesture. */
  readonly capabilities: { readonly [N in CapabilityName]?: { readonly userActivation: boolean } };
  /**
   * The globals the shell defines on `window` and the manual teaches: `porthole` where the config
   * has the capability runtime (P085), else 0.6's (sugar over the protocol's requests).
   */
  readonly globals: readonly string[];
  /**
   * 0.6's globals the shell still defines under the runtime, for pages written before it (the
   * legacy path, `shell/legacy.ts`), which the manual no longer teaches. Empty without a runtime.
   */
  readonly legacyGlobals: readonly string[];
  /** The capability runtime's contract version, where the config has one (`porthole.use`). */
  readonly runtime?: RuntimeVersion;
  /**
   * The runtime methods whose own gates want a gesture (`capability.method`: `artifact.publish`,
   * `assets.delete`): the shell refuses them without one, as it does a host function's.
   */
  readonly methodActivation?: readonly string[];
  /** The theme variables the shell applies; it drops any other name the host sends. */
  readonly themeVariables: readonly string[];
  /** The window event fired after a theme change. */
  readonly themeEvent: string;
  /** Whether a whole document takes the person's scheme: when it declares it, or always. */
  readonly themeDocuments: "declared" | "always" | "never";
  /** `memory`: an opaque origin has no storage, so a map stands in for the frame's life. */
  readonly storage: "memory" | "native";
  readonly maxErrorReports: number;
  readonly maxPromptChars: number;
  /** The most text `copyText` carries. */
  readonly maxCopyChars: number;
  readonly protocolVersion: string;
}

export function shellPlan(config: PortholeConfig): ShellPlan | null {
  if (config.mode === "url") {
    return null;
  }
  const protocol = config.mode === "mcp-app" ? "none" : "shell";
  const declared = declaredCapabilities(config);
  const capabilities: { [N in CapabilityName]?: { userActivation: boolean } } = {};
  for (const name of declared) {
    capabilities[name] = {
      userActivation: effectiveGates(config, name).includes("user-activation"),
    };
  }
  const legacy =
    protocol === "shell"
      ? declared.flatMap((name) => {
          const spec = capabilitySpec(name);
          return spec.global === undefined ? [] : [spec.global];
        })
      : [];
  const runtime = protocol === "shell" ? config.runtime : undefined;
  return {
    protocol,
    content: config.mode === "artifact" ? "document" : "fragment",
    capabilities,
    globals: runtime === undefined ? legacy : [RUNTIME_GLOBAL],
    legacyGlobals: runtime === undefined ? [] : legacy,
    ...(runtime === undefined
      ? {}
      : {
          runtime,
          methodActivation: offeredCapabilities(config).flatMap((family) =>
            Object.keys(runtimeCapability(family).methods)
              .filter((method) => methodGates(config, family, method).includes("user-activation"))
              .map((method) => `${family}.${method}`),
          ),
        }),
    themeVariables: Object.keys(config.theme.variables),
    themeEvent: config.theme.event,
    themeDocuments: config.theme.documents ?? "declared",
    // An opaque origin has no storage: an opaque frame's, and a nested page's (P111).
    storage: config.isolation === "opaque" || config.nested === true ? "memory" : "native",
    maxErrorReports: config.limits.maxErrorReports,
    maxPromptChars: config.limits.maxPromptChars,
    maxCopyChars: MAX_COPY_CHARS,
    protocolVersion: MCP_APPS_PROTOCOL_VERSION,
  };
}
