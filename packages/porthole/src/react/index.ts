/**
 * `@botiverse/porthole/react`: the thin React binding (M4). Interfaces only for now, so hosts can
 * be written against them; the components throw until they land.
 *
 * Shape: a `<PortholeProvider>` near the root owns what is per page (the live-frame cap, and the
 * default confirmation dialog, drawn outside every frame); a `<PortholeFrame>` per display mounts
 * it lazily as it nears the screen, keeps at most the config's `maxLiveFrames` running (those off
 * screen longest stop first, and run again when they come back), and remembers each display's
 * height so scrolling back doesn't jump. Written with `createElement`, so it runs without a JSX
 * transform.
 */
import type { CSSProperties, ReactElement, ReactNode } from "react";
import type { CapabilityHandlers, Confirm, ConfirmRequest, Refusal } from "../bridge/types.ts";
import type { CapabilityName } from "../config/capabilities.ts";
import type { ColorScheme, PortholeConfig } from "../config/schema.ts";
import type { InstanceLocator, InstanceRef } from "../isolation/types.ts";
import { NotBuiltYet } from "../internal/not-built.ts";

export interface PortholeProviderProps {
  /**
   * Who confirms gated calls for every frame below. Omitted: the default dialog
   * (`ConfirmDialog`). Pass your own function to replace it.
   */
  readonly confirm?: Confirm;
  /** How the host names itself in the handshake. */
  readonly hostInfo?: { readonly name: string; readonly version: string };
  /** Where domain and external frames load from (see `InstanceLocator`). */
  readonly locator?: InstanceLocator;
  readonly children?: ReactNode;
}

export interface PortholeFrameProps {
  /** A preset's config. Keep it stable (module scope or memoized): a new one remounts the frame. */
  readonly config: PortholeConfig;
  /** The host's id for this display: what its height is remembered by, and calls name. */
  readonly displayId: string;
  /** The frame's accessible name, and the title its confirmations show. */
  readonly title: string;
  /** The content so far (inline and artifact modes). */
  readonly content?: string;
  /** The content is still being written: drawn inert as it grows, run once when whole. */
  readonly partial?: boolean;
  /** A whole document to start with (an MCP Apps view). */
  readonly document?: string;
  /** Domain and external isolation: the instance to show. */
  readonly instance?: InstanceRef;
  readonly scheme: ColorScheme;
  /** The host's live values for the config's theme variables (from its design tokens). */
  readonly theme?: (scheme: ColorScheme) => Readonly<Record<string, string | null | undefined>>;
  /** Handlers for the declared capabilities. */
  readonly handlers?: CapabilityHandlers;
  /** Who confirms this frame's gated calls, over the provider's. */
  readonly confirm?: Confirm;
  /** Bump to run the content again from the start. */
  readonly generation?: number;
  readonly onInitialized?: () => void;
  readonly onResize?: (size: { readonly height: number; readonly width?: number }) => void;
  readonly onError?: (message: string) => void;
  readonly onNavigated?: () => void;
  readonly onRefused?: (capability: CapabilityName, refusal: Refusal) => void;
  readonly className?: string;
  readonly style?: CSSProperties;
}

export interface ConfirmDialogProps {
  /** The call to confirm, or null when nothing is asked. */
  readonly request: ConfirmRequest | null;
  readonly onAnswer: (accepted: boolean) => void;
}

export function PortholeProvider(_props: PortholeProviderProps): ReactElement {
  throw new NotBuiltYet("PortholeProvider", "M4");
}

export function PortholeFrame(_props: PortholeFrameProps): ReactElement {
  throw new NotBuiltYet("PortholeFrame", "M4");
}

/**
 * The default confirmation dialog: the call's whole effect (the prompt's full text, the link's
 * full URL), the display's title, Cancel focused, and the accept button ignoring presses for a
 * moment after it opens. Themed with the host's CSS variables; replace it with `confirm`.
 */
export function ConfirmDialog(_props: ConfirmDialogProps): ReactElement {
  throw new NotBuiltYet("ConfirmDialog", "M4");
}
