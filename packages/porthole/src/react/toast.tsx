import { useEffect, type ReactElement } from "react";

/**
 * The default copy notice (P052): when content's `copyText` copied something, the host's page
 * shows the person what went on their clipboard, clipped, in a small toast outside every frame.
 * If the write failed (no recent gesture), it says so and offers a Copy button: a click on the
 * host's own page, which writes it. A host replaces it by passing its own `copyText` handler; it
 * styles it through the `porthole-toast` class and data attributes.
 */

/** How long a toast for a copy that worked stays. */
export const TOAST_MS = 5_000;
/** The most of the copied text a toast shows. */
export const TOAST_CHARS = 280;
const TOAST_LINES = 4;

export interface CopyNotice {
  /** The whole text copied (or to copy). */
  readonly text: string;
  /** Whether it is on the clipboard. */
  readonly copied: boolean;
  /** The display's title, as the host named it. */
  readonly title: string;
}

export interface CopyToastProps {
  readonly notice: CopyNotice | null;
  /** The person asked to copy it again (it failed), from this click. */
  readonly onCopy: (notice: CopyNotice) => void;
  readonly onClose: () => void;
  readonly className?: string;
}

/** The text as the toast shows it: at most a few lines and `TOAST_CHARS` characters. */
export function clipped(text: string): { readonly shown: string; readonly clipped: boolean } {
  const lines = text.split("\n");
  let shown = lines.slice(0, TOAST_LINES).join("\n");
  if (shown.length > TOAST_CHARS) {
    shown = shown.slice(0, TOAST_CHARS);
  }
  return shown.length < text.length
    ? { shown: `${shown}…`, clipped: true }
    : { shown, clipped: false };
}

const STYLE = `.porthole-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;color-scheme:light dark;color:CanvasText;background:Canvas;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:12px;padding:12px 14px;width:min(420px,calc(100vw - 32px));box-shadow:0 8px 28px rgb(0 0 0 / .25);font:inherit;font-size:.9em}
.porthole-toast p{margin:0 0 6px}
.porthole-toast [data-porthole-source]{opacity:.72}
.porthole-toast pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:8em;overflow:hidden;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,CanvasText 7%,transparent);font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.porthole-toast menu{display:flex;justify-content:flex-end;gap:8px;margin:8px 0 0;padding:0}
.porthole-toast button{font:inherit;min-height:32px;padding:0 12px;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);background:transparent;color:inherit;cursor:pointer}`;

export function CopyToast({ notice, onCopy, onClose, className }: CopyToastProps): ReactElement {
  useEffect(() => {
    if (notice === null || !notice.copied) {
      return;
    }
    const timer = setTimeout(onClose, TOAST_MS);
    return () => clearTimeout(timer);
  }, [notice, onClose]);
  const view = notice === null ? null : clipped(notice.text);
  return (
    <div
      role="status"
      aria-live="polite"
      className={className === undefined ? "porthole-toast" : `porthole-toast ${className}`}
      data-porthole-toast=""
      data-porthole-copied={notice === null ? "" : String(notice.copied)}
      hidden={notice === null}
    >
      <style>{STYLE}</style>
      {notice === null || view === null ? null : (
        <>
          <p>
            <strong>{notice.copied ? "Copied" : "Not copied yet"}</strong>{" "}
            <span data-porthole-source="">{`from “${notice.title}”`}</span>
          </p>
          <pre data-porthole-copied-text="">{view.shown}</pre>
          {view.clipped ? (
            <p data-porthole-length="">{`${notice.text.length.toLocaleString("en-US")} characters in all`}</p>
          ) : null}
          <menu>
            {notice.copied ? null : (
              <button type="button" data-porthole-copy="" onClick={() => onCopy(notice)}>
                Copy
              </button>
            )}
            <button type="button" data-porthole-close="" onClick={onClose}>
              {notice.copied ? "OK" : "Close"}
            </button>
          </menu>
        </>
      )}
    </div>
  );
}
