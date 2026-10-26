// Porthole capability runtime, contract 1: comments. Built in: never declare it.

/** Where a comment goes, in the page's own words. */
interface PortholeCommentAnchor {
  /** A stable name the page chose: "slide-3", "refs/a.md#L12" (at most 256 characters). */
  readonly name: string;
  /** What the app shows for it (at most 200; what a person can't see is taken out). */
  readonly label?: string;
  /** The text the comment is about (at most 2,000; what a person can't see is taken out). */
  readonly quote?: string;
}

/** How the composer opens. */
interface PortholeCommentOptions {
  /**
   * Text the composer starts with (at most 2,000 characters): a draft the person edits, posts
   * or discards in the app. It is never posted without them. Visible text only: new lines and
   * tabs are fine (at most 32 blanks in a row, two blank lines in a row); a draft with zero-width
   * characters or joiners (an emoji joined with U+200D too; ❤️ is fine), bidi or tag characters,
   * or a line or paragraph separator (U+2028, U+2029) is refused.
   */
  readonly draft?: string;
}

interface PortholeComments {
  /**
   * Opens the app's comment composer at the anchor (a name alone is { name }), starting with
   * `options.draft` if given. The person writes and posts it in the app. Resolves true if the
   * composer opened, false if it didn't (the app may refuse while the person is writing).
   * Write-only: a page never reads comments. Call it from a click in the page. Level: view.
   */
  open(anchor: PortholeCommentAnchor | string, options?: PortholeCommentOptions): Promise<boolean>;
}

interface PortholeCapabilities {
  comments: PortholeComments;
}
