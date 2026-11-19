import {
  BIDI_CONTROLS,
  LINK_LABEL_LIMITS as LIMITS,
  LINK_LABEL_TAG,
  type LinkLabel,
} from "./types.ts";

/**
 * The host's checks on link labels (P151), before they go to the frame: each label rebuilt from its
 * known fields, within `LINK_LABEL_LIMITS`; a malformed one is dropped, the rest kept.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `text` without its bidirectional controls (`BIDI_CONTROLS`). */
export const withoutBidi = (text: string): string => text.replace(BIDI_CONTROLS, "");

/**
 * An address as a label names it: an absolute http(s) URL within the limit, as the platform's own
 * parser writes it (so it compares with a link's resolved `href`); null for anything else.
 */
export function labelHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length > LIMITS.href) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  return url.href.length > LIMITS.href ? null : url.href;
}

/** One label, checked: rebuilt, its address parsed, its text without bidi controls; null if malformed. */
export function checkLinkLabel(value: unknown): LinkLabel | null {
  if (!isRecord(value)) {
    return null;
  }
  const href = labelHref(value.href);
  const { text, tag } = value;
  if (href === null || typeof text !== "string" || text.length > LIMITS.text) {
    return null;
  }
  const shown = withoutBidi(text);
  if (shown.trim() === "") {
    return null;
  }
  // A tag that isn't one is left out; the label still applies.
  return {
    href,
    text: shown,
    ...(typeof tag === "string" && LINK_LABEL_TAG.test(tag) ? { tag } : {}),
  };
}

/**
 * A label set as the host gives it, checked: every malformed label dropped, the first for each
 * address kept, at most `LINK_LABEL_LIMITS.labels`. Throws a `TypeError` for anything but a list.
 */
export function checkLinkLabels(labels: unknown): LinkLabel[] {
  if (!Array.isArray(labels)) {
    throw new TypeError("links.label: labels are a list of { href, text, tag? }");
  }
  const kept: LinkLabel[] = [];
  const seen = new Set<string>();
  for (const each of labels as unknown[]) {
    if (kept.length === LIMITS.labels) {
      break;
    }
    const label = checkLinkLabel(each);
    if (label !== null && !seen.has(label.href)) {
      seen.add(label.href);
      kept.push(label);
    }
  }
  return kept;
}
