import type { PortholeConfig } from "../config/schema.ts";

/**
 * A navigation the shell cancelled (P079), as the host is told it (P080): the address, whole, on
 * the `navigationBlocked` event (the host's to keep), and a sentence for the content's errors
 * (`contentError`, which a host may give the agent that wrote it) that names the address without
 * its query or fragment, where a viewer's data would be.
 */

/** An address without what could carry data: an http(s) one's origin and path, else its scheme. */
export function addressWithoutQuery(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "another address";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `a ${parsed.protocol} address`;
  }
  const rest = parsed.search !== "" || parsed.hash !== "" ? "?…" : "";
  return `${parsed.origin}${parsed.pathname}${rest}`;
}

/** What the content's errors say about a navigation the shell cancelled. */
export function blockedNavigationMessage(url: string, config: PortholeConfig): string {
  const links =
    config.capabilities.openLink === undefined
      ? ""
      : config.mode === "mcp-app"
        ? " Open links with ui/open-link (a new tab)."
        : " Open links with openLink(url) or an <a href> (a new tab).";
  return `It tried to navigate its frame to ${addressWithoutQuery(url)}, and was stopped: content never leaves its page.${links}`;
}
