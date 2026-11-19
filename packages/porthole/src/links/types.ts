/**
 * Link labels (P151): the host knows the title of a page a display links to, as the person viewing
 * it may see it (another of the host's own artifacts, say), and has a link whose text is its own
 * address show that title instead. The host decides what to label from its own list; the page
 * never reports its links, and nothing comes back from the frame.
 *
 * The labels go into the content's realm, which can read them, rewrite them, or draw a lookalike:
 * a label is a convenience for the reader, never a trust signal.
 */

/** One label: the link's address, the words to show, and an optional tag for the host's styles. */
export interface LinkLabel {
  /**
   * The address a link must go to, exactly: an absolute http(s) URL, compared after the platform's
   * own parsing (WHATWG) of both it and the link's `href` against the document's base, so
   * `https://Example.com` and `https://example.com/` are one address.
   */
  readonly href: string;
  /**
   * What a bare link (its only child a text node whose words are its address) shows instead: text
   * only, never markup, at most `LINK_LABEL_LIMITS.text` characters, its bidirectional controls
   * removed (`BIDI_CONTROLS`). A link with words of its own keeps them.
   */
  readonly text: string;
  /**
   * Put on every link to `href`, bare or not, as `data-porthole-label="<tag>"`, for a style the
   * page or the host's theme may give it (an icon, say): `LINK_LABEL_TAG`, else left out.
   */
  readonly tag?: string;
}

/** Porthole's own message for link labels (own-prefixed, P002). */
export const LINK_LABEL_METHODS = {
  /**
   * Host → frame, a notification: `{ labels: LinkLabel[] }`, the labels for the document shown,
   * replacing any before (an empty list gives every link back its own words). Nothing is answered.
   */
  label: "porthole/links.label",
} as const;

/** The most of each part of a label set. */
export const LINK_LABEL_LIMITS = {
  /** The most labels one message carries; past it the rest are dropped. */
  labels: 500,
  /** The longest address, in UTF-16 code units, as given and once parsed. */
  href: 2_048,
  /** The longest text, in UTF-16 code units, as given. */
  text: 300,
} as const;

/** What a tag may be: lowercase letters, digits and `-`, 1 to 32 of them. */
export const LINK_LABEL_TAG = /^[a-z0-9-]{1,32}$/u;

/**
 * The bidirectional controls a label's text loses (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F):
 * with them a title could reorder what is drawn after it, and show another address than its own.
 */
export const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏]/gu;
