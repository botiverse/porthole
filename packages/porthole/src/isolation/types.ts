/**
 * The isolation-mode seam. Opaque frames need nothing from outside: the host builds the shell
 * document and the frame is `srcdoc`. Served modes (domain, and url mode's external app) load a
 * URL, so the host asks a locator for one; the locator is the host's own code, typically a call to
 * the host's backend, which asks `/server` for a ticketed URL after deciding the viewer may see it.
 *
 * Storage is keyed by origin. In domain mode each storage scope gets its own subdomain of the
 * content domain (`<label>.example-usercontent.com`, the label derived from the scope by `/server`,
 * not guessable from it), so content with the same scope shares an origin and its storage and
 * nothing else does. The host chooses the scope (PRINCIPLE 8): per display, per conversation, per
 * app. Browsers partition a framed origin's storage by the top-level site, so it is stable within
 * one host app.
 */
import type { EgressConfig } from "../config/schema.ts";

/**
 * Which document a served frame loads. `preset` names the config it is served under (the server's
 * `configs`); the artifact and the proxy default to their presets' names.
 */
export type ServedDocument =
  /** The shell, served with its CSP in headers; content arrives over the transport as for opaque. */
  | { readonly kind: "shell"; readonly preset: string }
  /** A stored page (artifact mode), by id and version: versions are immutable. */
  | {
      readonly kind: "artifact";
      readonly id: string;
      readonly version: string;
      /** Default `artifact`. */
      readonly preset?: string;
    }
  /**
   * The MCP Apps sandbox proxy: a second origin the host hands the view's HTML to, which becomes
   * the view. `egress` is what the view declares (`_meta.ui.csp`, mapped by `/mcp`'s
   * `viewEgress`), opened on top of the config's: its CSP goes out in the proxy's headers, before
   * the HTML arrives.
   */
  | { readonly kind: "mcp-proxy"; readonly preset?: string; readonly egress?: EgressConfig }
  /**
   * Someone else's running app (url mode), e.g. a dev server behind the host's preview gateway:
   * `url` is where the host's upstream finds it; the frame lands on its path and query.
   */
  | { readonly kind: "external"; readonly url: string };

/** One served instance: where its storage lives, and what it shows. */
export interface InstanceRef {
  /**
   * What the content's origin, and so its storage, is keyed by. Instances with the same scope
   * share an origin. Opaque to Porthole: the host picks it (a display id, an app id).
   */
  readonly scope: string;
  readonly document: ServedDocument;
}

/** Where a served frame loads from. */
export interface FrameLocation {
  /** The URL the frame loads, carrying a one-time ticket where the content is private. */
  readonly url: string;
  /** Its origin: the host takes messages only from this origin, from this frame. */
  readonly origin: string;
}

/**
 * Turns an instance into the URL its frame loads. Implemented by the host, usually by asking its
 * own backend (which authenticates the viewer and calls `PortholeServer.issue`). Called on every
 * mount: a ticket is good once.
 */
export interface InstanceLocator {
  locate(instance: InstanceRef, signal?: AbortSignal): Promise<FrameLocation>;
}

/**
 * Where a frame's document comes from: built by the host (`srcdoc`, opaque isolation), or loaded
 * from a URL (domain and external isolation).
 */
export type FrameSource =
  | { readonly kind: "srcdoc"; readonly html: string }
  | { readonly kind: "url"; readonly url: string; readonly origin: string };
