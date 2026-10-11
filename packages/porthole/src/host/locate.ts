import type { PortholeConfig } from "../config/schema.ts";
import { checkFrameLocation } from "../isolation/served.ts";
import type { FrameSource, InstanceLocator, InstanceRef } from "../isolation/types.ts";

/**
 * Where a served frame (domain or external isolation) loads from: the host's locator answers, and
 * `checkFrameLocation` checks the answer (one of the config's content origins, never the host's
 * own site) before any frame is made.
 */
export async function locateServed(
  locator: InstanceLocator,
  instance: InstanceRef,
  config: PortholeConfig,
  hostOrigin: string,
  signal?: AbortSignal,
): Promise<FrameSource> {
  const location = await locator.locate(instance, signal);
  checkFrameLocation(location, config.contentOrigins, hostOrigin);
  return {
    kind: "url",
    url: new URL(location.url).href,
    origin: location.origin,
    ...(location.reports === true ? { reports: true } : {}),
  };
}
