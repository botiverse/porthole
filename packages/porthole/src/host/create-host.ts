import { compile } from "../compile/compile.ts";
import { declaredCapabilities } from "../compile/policy.ts";
import { CAPABILITIES } from "../config/capabilities.ts";
import type { PortholeConfig } from "../config/schema.ts";
import { NotBuiltYet } from "../internal/not-built.ts";
import type { AdapterConnection, ShellConnection } from "../protocol/adapter.ts";
import type { DisplayHandle, HostOptions, MountOptions, PortholeHost } from "./types.ts";

/**
 * Compiles `config` once and returns a host that mounts displays under it. Throws a `ConfigError`
 * for a bad config.
 */
export function createHost<C extends AdapterConnection = ShellConnection>(
  config: PortholeConfig,
  options: HostOptions<C> = {},
): PortholeHost<C> {
  const compiled = compile(config);
  if (
    (config.isolation === "domain" || config.isolation === "external") &&
    options.locator === undefined
  ) {
    throw new TypeError(`${config.isolation} isolation needs a locator (HostOptions.locator)`);
  }
  return {
    compiled,
    mount(_container: HTMLElement, mount: MountOptions): DisplayHandle<C> {
      const missing = declaredCapabilities(config).filter(
        (name) =>
          CAPABILITIES[name].served === "handler" &&
          (mount.handlers as Record<string, unknown> | undefined)?.[name] === undefined &&
          (options.handlers as Record<string, unknown> | undefined)?.[name] === undefined,
      );
      if (missing.length > 0) {
        throw new TypeError(`No handler for the declared capabilities: ${missing.join(", ")}`);
      }
      throw new NotBuiltYet("PortholeHost.mount", "M2");
    },
  };
}
