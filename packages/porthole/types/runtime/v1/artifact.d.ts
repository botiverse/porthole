// Porthole capability runtime, contract 1: artifact (this artifact itself). Declare it: { artifact: {} }.
// Use it when the page is the record: a checklist, a plan, a document someone edits in place.

interface PortholeArtifactFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface PortholeArtifactVersion {
  /** The version's id: what a publish names as its base. */
  readonly version: string;
  readonly number?: number;
  /** The page it opens at ("index.html"). */
  readonly entry: string;
  readonly files: readonly PortholeArtifactFile[];
}

interface PortholeArtifactPublish {
  /** The version you read and changed (from get()). If it moved, publish rejects with conflict. */
  readonly base: string;
  /**
   * A patch on base's files, by path: text, bytes (a Blob, an ArrayBuffer, a typed array), or
   * null to remove one; files not named are kept. A page sends its whole document, as it should
   * be served. At most 255 files.
   */
  readonly files: Readonly<Record<string, string | Blob | ArrayBuffer | ArrayBufferView | null>>;
  readonly entry?: string;
  /** At most 60 characters. */
  readonly label?: string;
  /** At most 500 characters. */
  readonly note?: string;
}

interface PortholeArtifact {
  /** The current version and its files (fetch a file by its relative path). Level: view. */
  get(): Promise<PortholeArtifactVersion>;
  /**
   * Publishes a new version of this artifact, from a click; the app asks the person first. The
   * page can't change what it declares. On conflict: get() again, merge, publish again. Level:
   * admin.
   */
  publish(
    change: PortholeArtifactPublish,
  ): Promise<{ readonly version: string; readonly number?: number }>;
}

interface PortholeCapabilities {
  artifact: PortholeArtifact;
}
