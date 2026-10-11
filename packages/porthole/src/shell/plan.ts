import { capabilitySpec, type CapabilityName } from "../config/capabilities.ts";
import type { PortholeConfig } from "../config/schema.ts";
import { declaredCapabilities, effectiveGates } from "../compile/policy.ts";
import { MCP_APPS_PROTOCOL_VERSION } from "../protocol/mcp-apps.ts";

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
  /** The globals the shell defines on `window` (sugar over the protocol's requests). */
  readonly globals: readonly string[];
  /** The theme variables the shell applies; it drops any other name the host sends. */
  readonly themeVariables: readonly string[];
  /** The window event fired after a theme change. */
  readonly themeEvent: string;
  /** `memory`: an opaque origin has no storage, so a map stands in for the frame's life. */
  readonly storage: "memory" | "native";
  readonly maxErrorReports: number;
  readonly maxPromptChars: number;
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
  const globals =
    protocol === "shell"
      ? declared.flatMap((name) => {
          const spec = capabilitySpec(name);
          return spec.global === undefined ? [] : [spec.global];
        })
      : [];
  return {
    protocol,
    content: config.mode === "artifact" ? "document" : "fragment",
    capabilities,
    globals,
    themeVariables: Object.keys(config.theme.variables),
    themeEvent: config.theme.event,
    storage: config.isolation === "opaque" ? "memory" : "native",
    maxErrorReports: config.limits.maxErrorReports,
    maxPromptChars: config.limits.maxPromptChars,
    protocolVersion: MCP_APPS_PROTOCOL_VERSION,
  };
}
