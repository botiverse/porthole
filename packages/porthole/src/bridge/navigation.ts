import type { PortholeConfig } from "../config/schema.ts";

/**
 * A navigation the shell cancelled (P079), as the host is told it (P080): the address, whole, on
 * the `navigationBlocked` event (the host's to keep), and a sentence for the content's errors
 * (`contentError`, which a host may give the agent that wrote it) that names the address without
 * its query or fragment, where a viewer's data would be.
 */

/**
 * A frame's sealed files' address (P083) is its access: whatever content says, the host is told
 * it as `./`, the page's own files (the shell says it so already; content may not).
 */
const SEALED = /(?:https?:\/\/[^\s"'<>/]+)?\/__porthole\/f\/[A-Za-z0-9_-]{20,}\//gu;
export const withoutSealedAddresses = (text: string): string => text.replace(SEALED, "./");

/** An address without what could carry data: an http(s) one's origin and path, else its scheme. */
export function addressWithoutQuery(url: string): string {
  // A page's own file (P084), as the shell names it: its path, without query or fragment.
  if (url.startsWith("./")) {
    const path = url.split(/[?#]/u)[0] ?? "./";
    return path === url ? path : `${path}?…`;
  }
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
