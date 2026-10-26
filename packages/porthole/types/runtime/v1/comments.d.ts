// Porthole capability runtime, contract 1: comments. Built in: never declare it.

/** Where a comment goes, in the page's own words. */
interface PortholeCommentAnchor {
  /** A stable name the page chose: "slide-3", "refs/a.md#L12" (at most 256 characters). */
  readonly name: string;
  /** What the app shows for it (at most 200). */
  readonly label?: string;
  /** The text the comment is about (at most 2,000). */
  readonly quote?: string;
}

/** How the composer opens. */
interface PortholeCommentOptions {
  /**
   * Text the composer starts with (at most 2,000 characters): a draft the person edits, posts
   * or discards in the app. It is never posted without them. Visible text only: new lines and
   * tabs are fine; a draft with zero-width, bidi or tag characters is refused.
   */
  readonly draft?: string;
}

interface PortholeComments {
  /**
   * Opens the app's comment composer at the anchor (a name alone is { name }), starting with
   * `options.draft` if given. The person writes and posts it in the app. Resolves true if the
   * composer opened. Write-only: a page never reads comments. Call it from a click. Level: view.
   */
  open(anchor: PortholeCommentAnchor | string, options?: PortholeCommentOptions): Promise<boolean>;
}

interface PortholeCapabilities {
  comments: PortholeComments;
}
