import type { PortholeConfig } from "../config/schema.ts";
import { checkFrameLocation } from "../isolation/served.ts";
import type { FrameSource, InstanceLocator, InstanceRef } from "../isolation/types.ts";
import { parseViewer } from "../runtime/levels.ts";

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
  // The host's access, as its backend answered (P087): a viewer that doesn't parse is the host's
  // error, never no viewer (after the review: a mount's own would take its place).
  const viewer = location.viewer === undefined ? null : parseViewer(location.viewer);
  if (location.viewer !== undefined && viewer === null) {
    throw new TypeError(
      "The host's location names a viewer that isn't one: { level: view | interact | admin | owner, id?: one path segment, name? }",
    );
  }
  return {
    kind: "url",
    url: new URL(location.url).href,
    origin: location.origin,
    ...(location.reports === true ? { reports: true } : {}),
    ...(viewer === null ? {} : { viewer }),
  };
}
