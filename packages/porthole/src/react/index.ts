/**
 * `@botiverse/porthole/react`: the thin React binding (TSX: a host's bundler compiles it, or the
 * package's `dist`). Peer: `react` (19.2+, for `useEffectEvent`).
 *
 *   <PortholeProvider>                         // per page: live-frame cap, heights, the dialog, the copy toast
 *     <PortholeFrame config={widgetConfig} displayId={id} title={title} scheme={scheme}
 *       content={code} partial={streaming} handlers={{ sendPrompt, openLink }}
 *       theme={tokensFor} onError={report} />
 *   </PortholeProvider>
 */
export {
  PLACEHOLDER_HEIGHT_PX,
  PortholeFrame,
  PortholeProvider,
  type PlaceholderProps,
  type PortholeFrameProps,
  type PortholeProviderProps,
} from "./frame.tsx";
export { ARM_DELAY_MS, ConfirmDialog, type ConfirmDialogProps } from "./dialog.tsx";
export {
  CopyToast,
  TOAST_CHARS,
  TOAST_MS,
  clipped,
  type CopyNotice,
  type CopyToastProps,
} from "./toast.tsx";
export { admitFrame, createLiveFrames, type FrameState, type LiveFrames } from "./live.ts";
