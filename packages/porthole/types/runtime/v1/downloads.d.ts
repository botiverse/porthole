// Porthole capability runtime, contract 1: downloads. Built in: never declare it.

/** A file to hand the person: its name, and its text or bytes. */
interface PortholeDownload {
  /** A file name, no slashes: "report.csv". Its extension gives its type unless `type` says. */
  readonly name: string;
  readonly type?: string;
  readonly text?: string;
  readonly data?: Blob | ArrayBuffer | ArrayBufferView;
}

interface PortholeDownloads {
  /**
   * Hands the person a file to save (<a download> and script-driven saves don't work here).
   * Call it from a click. Resolves true if the download started. Level: view.
   */
  save(file: PortholeDownload): Promise<boolean>;
}

interface PortholeCapabilities {
  downloads: PortholeDownloads;
}
