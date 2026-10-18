// Porthole capability runtime, contract 1: assets (the artifact's asset library). Declare it: { assets: {} }.
// Assets live outside every version, at "/_blob/<id>" on the page's own origin: keep that url (or
// the id) in your data, and show it with assets.url(id). Images, media and fonts load; scripts and
// stylesheets only where the app lets only admins upload, and only those an admin added. Not for
// files that version with the page: publish those with it.

interface PortholeAsset {
  /** 32 hex characters. */
  readonly id: string;
  /** "/_blob/<id>": use it as given. */
  readonly url: string;
  readonly name: string;
  /** Porthole's type for the name's extension. */
  readonly type: string;
  readonly size: number;
}

interface PortholeAssets {
  /** The library, people's uploads through the page included. Level: view. */
  list(): Promise<readonly PortholeAsset[]>;
  /**
   * Adds a file (a File from an <input type="file">, a Blob, bytes) under its name (a File's own,
   * or options.name): an image, media, a font, a PDF, text or data, never HTML; a script or a
   * stylesheet only where uploads are the admins'. The app may ask the person first. Level: admin,
   * unless the app lets people who interact upload.
   */
  upload(
    file: Blob | ArrayBuffer | ArrayBufferView,
    options?: { readonly name?: string },
  ): Promise<PortholeAsset>;
  /**
   * The address that loads an asset in this page now: put it in src or href when you show it.
   * Store the id (or "/_blob/<id>"), never this: it carries this page's access. A "/_blob/<id>"
   * written in the page loads too, except in some browsers' frames (Safari's); this always does.
   */
  url(id: string): string;
  /** Removes one, from a click; the app asks the person first. Level: admin. */
  delete(id: string): Promise<boolean>;
}

interface PortholeCapabilities {
  assets: PortholeAssets;
}
