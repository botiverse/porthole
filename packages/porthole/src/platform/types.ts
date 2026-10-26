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
  /**
   * Fill the container's height (a url-mode app, which reports no size), at least
   * `initialHeightPx`, instead of taking the content's.
   */
  readonly fill?: boolean;
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
   * Whether the embedding page has transient user activation now (a gesture in the frame
   * activates its ancestors), or undefined where the platform can't tell. The gesture gate reads
   * it, and so does a marker's click (P105): false, or a throw, drops it.
   */
  userActivation(): boolean | undefined;
  /**
   * The frame's viewport now, CSS px (its content box): what a box the frame reports is clamped
   * to (P104). Undefined, or absent, where the platform can't tell: every reported box is then
   * clamped to nothing, at the frame's corner, as it is for an answer that isn't a size, or a
   * throw (P105).
   */
  viewport?(): { readonly width: number; readonly height: number } | undefined;
  /**
   * Whether the embedding page's focus is in this frame now, once the platform's focus guard
   * judged any move into it (P109); undefined, or absent, where the platform can't tell. A gesture
   * gate that asks for the person in the calling frame (`comments`) reads it: false refuses.
   */
  focused?(): boolean | undefined;
  /**
   * Each time the content moved the keyboard into its frame from one of the embedding page's text
   * fields without the person (no press on the frame, no Tab) and the platform gave focus back
   * (P109): whether the person was typing then (a key within the last second), and whether focus
   * failed to go back (the frame kept it or took it again). Absent where the platform has no guard.
   */
  onFocusTaken?(
    listener: (take: { readonly typing: boolean; readonly failed: boolean }) => void,
  ): () => void;
  /** The host moves focus into the frame itself: the guard takes it as the person's (P109). */
  focus?(): void;
  /**
   * The frame loaded a document other than the one it was given: the content navigated it. The
   * framework starts it again from its content and reports it.
   */
  onNavigated(listener: () => void): () => void;
  /** Every load of the frame's document, the first included. */
  onLoad(listener: () => void): () => void;
  destroy(): void;
}

export interface PlatformHost<Container = HTMLElement> {
  readonly name: string;
  /** Creates an isolated frame in `container`, its policy set before its document loads. */
  createSurface(container: Container, spec: SurfaceSpec): Surface;
}
