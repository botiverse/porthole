// Porthole capability runtime, contract 1: data (the app's data and tools).
// Declare it: { data: {} }, or narrow it: { data: { resources: ["app://tasks/*"], tools: ["create_task"] } }
// (exact names, or a prefix ending in *; absent: everything the app serves).

interface PortholeDataInfo {
  /** The first value may be the app's last copy (stale: true), with the current one right after. */
  readonly stale: boolean;
  readonly uri: string;
}

interface PortholeData {
  /** Reads the app's data at uri, as the person viewing it may see it: JSON parsed, else text. Level: view. */
  read(uri: string): Promise<unknown>;
  /**
   * Keeps the page current: onData(value, info) now and at every change; onError hears a
   * refusal. Returns a function that stops it. Draw from onData every time; don't poll. Level: view.
   */
  subscribe(
    uri: string,
    onData: (value: unknown, info: PortholeDataInfo) => void,
    onError?: (error: PortholeError) => void,
  ): () => void;
  /** Calls one of the app's tools; resolves with its result. Level: interact. */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface PortholeCapabilities {
  data: PortholeData;
}
