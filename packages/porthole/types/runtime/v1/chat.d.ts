// Porthole capability runtime, contract 1: chat. Declare it: { chat: {} }.

interface PortholeChat {
  /**
   * Sends text to the agent as the person's message ("explain this point"); the app asks them
   * first. Resolves true if it was sent. Level: interact.
   */
  send(text: string): Promise<boolean>;
}

interface PortholeCapabilities {
  chat: PortholeChat;
}
