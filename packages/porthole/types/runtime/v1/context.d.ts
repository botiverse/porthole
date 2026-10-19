// Porthole capability runtime, contract 1: context. Declare it: { context: {} }.

interface PortholeContextUpdate {
  /** MCP text blocks only: [{ type: "text", text: "…" }]. */
  readonly content?: readonly unknown[];
  /** Plain JSON. With the text, at most 20,000 characters. */
  readonly structuredContent?: Record<string, unknown>;
}

interface PortholeContext {
  /**
   * Tells the agent, at its next turns, what the page says the person is looking at (replaces the
   * last). The agent reads it as the page's words, unconfirmed by the person; the app shows the
   * person each update unless it says otherwise. Level: interact.
   */
  set(update: PortholeContextUpdate): Promise<unknown>;
}

interface PortholeCapabilities {
  context: PortholeContext;
}
