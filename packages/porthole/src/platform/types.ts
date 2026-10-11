import type { ColorScheme } from "../config/schema.ts";
import type { FrameSource } from "../isolation/types.ts";
import type { Transport } from "../transport/types.ts";

/**
 * The platform-host seam (ARCHITECTURE § Platform hosts): what owns the isolation primitive and
 * the transport. The web's is an `<iframe>` with `postMessage`; a native web view is another
 * implementation of the same interface, not a fork.
 */

/** What to create: the frame's document and its policy attributes, all from the compiled config. */
export interface SurfaceSpec {
  readonly source: FrameSource;
  /** The frame's accessible name. */
  readonly title: string;
  readonly sandbox: string;
  readonly allow: string;
  readonly referrerPolicy: "no-referrer";
  readonly colorScheme: ColorScheme;
  /** The height to start at (a remembered height, so a frame mounting again doesn't jump). */
  readonly initialHeightPx: number;
}

/** One isolated frame. */
export interface Surface {
  readonly transport: Transport;
  /** The platform's own element for the frame (an `HTMLIFrameElement` on the web). */
  readonly element: unknown;
  setHeight(px: number): void;
  setColorScheme(scheme: ColorScheme): void;
  /**
   * The frame loaded a document other than the one it was given: the content navigated it. The
   * framework starts it again from its content and reports it.
   */
  onNavigated(listener: () => void): () => void;
  destroy(): void;
}

export interface PlatformHost<Container = HTMLElement> {
  readonly name: string;
  /** Creates an isolated frame in `container`, its policy set before its document loads. */
  createSurface(container: Container, spec: SurfaceSpec): Surface;
}
