import { capabilitySpec, isCapabilityName } from "./capabilities.ts";
import type { PortholeConfig } from "./schema.ts";

/**
 * What a valid config says that its host likely didn't mean (the review of P100): never an error,
 * since the config is the host's to write. Porthole logs nothing itself (no console in library
 * code): `validateConfig(config, { onWarning })` hands each one over, and `compile(config).warnings`
 * (`host.compiled.warnings`) holds them, for a host to log at startup or fail its tests on.
 */
export interface ConfigWarning {
  /** `model-context-unshown`: a capability whose defaults have `show` lost it to named gates. */
  readonly code: "model-context-unshown";
  readonly path: string;
  readonly message: string;
}

/**
 * Each warning `config` earns. Since 0.8 (P100), `setModelContext`'s defaults have `show`; a
 * config that names its gates (one written for 0.7 did, to change the rate) and leaves `show` out
 * sends content's text to the model unseen, so it is said, unless `withoutShow: true` says the
 * host meant it (its handler shows the person each update, or the content is its own).
 */
export function configWarnings(config: PortholeConfig): readonly ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  for (const [name, capability] of Object.entries(config.capabilities)) {
    if (
      !isCapabilityName(name) ||
      capability?.gates === undefined ||
      !capabilitySpec(name).defaultGates.includes("show") ||
      capability.gates.includes("show") ||
      capability.withoutShow === true
    ) {
      continue;
    }
    warnings.push({
      code: "model-context-unshown",
      path: `config.capabilities.${name}.gates`,
      message: `${name}'s gates leave out "show" (P100): what content tells the model reaches it without the person seeing it. Add "show" to the gates, or set withoutShow: true where your handler shows the person each update itself.`,
    });
  }
  return warnings;
}
