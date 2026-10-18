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

interface PortholeComments {
  /**
   * Opens the app's comment composer at the anchor (a name alone is { name }). The person writes
   * and posts it in the app. Resolves true if the composer opened. Write-only: a page never reads
   * comments. Call it from a click. Level: view.
   */
  open(anchor: PortholeCommentAnchor | string): Promise<boolean>;
}

interface PortholeCapabilities {
  comments: PortholeComments;
}
