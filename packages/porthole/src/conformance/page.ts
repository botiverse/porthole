/**
 * The stored page the served and entry cases ask for, version "1" or "2": what an app's
 * `instances.artifact(scope, version)` must serve, exactly (P071). Free of Playwright, so an app
 * in test mode serves it from `@botiverse/porthole/server`.
 */
export function conformancePage(version: "1" | "2"): string {
  return `<!doctype html><html><head><title>Page</title></head><body><main id="artifact">version ${version}</main><script>document.documentElement.dataset.rtc = typeof RTCPeerConnection;</script></body></html>`;
}
