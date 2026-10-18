// Porthole capability runtime, contract 1: context. Declare it: { context: {} }.

interface PortholeContextUpdate {
  /** MCP content blocks: [{ type: "text", text: "…" }]. */
  readonly content?: readonly unknown[];
  readonly structuredContent?: Record<string, unknown>;
}

interface PortholeContext {
  /** Tells the agent what the person is looking at, for its next turns (replaces the last). Level: interact. */
  set(update: PortholeContextUpdate): Promise<unknown>;
}

interface PortholeCapabilities {
  context: PortholeContext;
}
