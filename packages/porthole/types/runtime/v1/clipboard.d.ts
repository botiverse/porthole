// Porthole capability runtime, contract 1: clipboard. Built in: never declare it.

interface PortholeClipboard {
  /**
   * Copies text to the person's clipboard (at most 20,000 characters); the app shows them what
   * was copied. Nothing else in the page can write the clipboard. Call it from a click.
   * Resolves true if it was copied. Level: view.
   */
  copy(text: string): Promise<boolean>;
}

interface PortholeCapabilities {
  clipboard: PortholeClipboard;
}
