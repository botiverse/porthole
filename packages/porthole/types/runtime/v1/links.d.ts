// Porthole capability runtime, contract 1: links. Built in: never declare it.

interface PortholeLinks {
  /**
   * Opens an http(s) link outside the page (a click on an <a href> does the same); the app asks
   * the person first. Resolves true if it opened. Level: view.
   */
  open(url: string): Promise<boolean>;
}

interface PortholeCapabilities {
  links: PortholeLinks;
}
