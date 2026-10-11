import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import type { ConfirmRequest } from "../bridge/types.ts";

/**
 * The default confirmation dialog (P019): drawn by the host's page, outside every frame, as a
 * modal (the top layer covers the frames, so content can't draw over it or click it). It shows
 * the call's whole effect (the prompt's full text, the link's full URL), the display's title as
 * the host named it, Cancel focused, and ignores presses on its accept button for a moment after
 * it opens (a click meant for the content mustn't land on it). Escape cancels. A host replaces it
 * by passing its own `confirm`; it styles it through the `porthole-confirm` class and data
 * attributes.
 */

/** How long the accept button ignores presses after the dialog opens. */
export const ARM_DELAY_MS = 500;

export interface ConfirmDialogProps {
  /** The call to confirm, or null when nothing is asked. */
  readonly request: ConfirmRequest | null;
  readonly onAnswer: (accepted: boolean) => void;
  readonly className?: string;
}

interface Words {
  readonly heading: string;
  readonly accept: string;
  /** What the person is shown in full. */
  readonly detail: string;
  /** A line under it (the link's host). */
  readonly note?: string;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? "";

function words(request: ConfirmRequest): Words {
  switch (request.capability) {
    case "sendPrompt":
      return { heading: "Send this message?", accept: "Send", detail: request.args.text };
    case "openLink": {
      let host = "";
      try {
        host = new URL(request.args.url).host;
      } catch {
        host = "";
      }
      return {
        heading: "Open this link?",
        accept: "Open link",
        detail: request.args.url,
        ...(host === "" ? {} : { note: `It opens ${host}.` }),
      };
    }
    case "downloadFile":
      return {
        heading: "Download this file?",
        accept: "Download",
        detail: json(request.args.contents),
      };
    case "callTool":
      return {
        heading: "Run this tool?",
        accept: "Run",
        detail: `${request.args.name}\n${json(request.args.arguments)}`,
      };
    case "setModelContext":
      return { heading: "Share this with the agent?", accept: "Share", detail: json(request.args) };
    case "readData":
      return { heading: "Let it read this?", accept: "Allow", detail: request.args.uri };
    case "copyText":
      return { heading: "Copy this text?", accept: "Copy", detail: request.args.text };
    default:
      return { heading: "Allow this?", accept: "Allow", detail: json(request.args) };
  }
}

const STYLE = `.porthole-confirm{color-scheme:light dark;color:CanvasText;background:Canvas;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:12px;padding:20px;width:min(440px,calc(100vw - 32px));font:inherit;box-shadow:0 12px 40px rgb(0 0 0 / .28)}
.porthole-confirm::backdrop{background:rgb(0 0 0 / .4)}
.porthole-confirm h2{font-size:1.05em;margin:0 0 4px}
.porthole-confirm [data-porthole-source],.porthole-confirm [data-porthole-note]{opacity:.72;font-size:.9em;margin:0 0 12px}
.porthole-confirm [data-porthole-detail]{white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto;padding:10px 12px;border-radius:8px;background:color-mix(in srgb,CanvasText 7%,transparent);margin:0 0 12px;font:inherit}
.porthole-confirm menu{display:flex;justify-content:flex-end;gap:8px;margin:16px 0 0;padding:0}
.porthole-confirm button{font:inherit;min-height:36px;padding:0 14px;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);background:transparent;color:inherit;cursor:pointer}
.porthole-confirm button[data-porthole-accept]{background:Highlight;background:AccentColor;color:HighlightText;color:AccentColorText;border-color:transparent}`;

export function ConfirmDialog({ request, onAnswer, className }: ConfirmDialogProps): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // The request the accept button is armed for: a new one starts unarmed.
  const [armedFor, setArmedFor] = useState<ConfirmRequest | null>(null);
  const armed = request !== null && armedFor === request;
  const heading = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element === null) {
      return;
    }
    if (request === null) {
      if (element.open) {
        element.close();
      }
      return;
    }
    if (!element.open) {
      element.showModal();
    }
    cancel.current?.focus();
    const timer = setTimeout(() => setArmedFor(request), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [request]);

  const said = request === null ? null : words(request);
  return (
    <dialog
      ref={dialog}
      className={className === undefined ? "porthole-confirm" : `porthole-confirm ${className}`}
      aria-labelledby={heading}
      data-porthole-confirm={request?.capability ?? ""}
      onCancel={(event) => {
        event.preventDefault();
        if (request !== null) {
          onAnswer(false);
        }
      }}
    >
      <style>{STYLE}</style>
      {said === null || request === null ? null : (
        <>
          <h2 id={heading}>{said.heading}</h2>
          <p data-porthole-source="">{`From “${request.display.title}”`}</p>
          <div data-porthole-detail="">{said.detail}</div>
          {said.note === undefined ? null : <p data-porthole-note="">{said.note}</p>}
          <menu>
            <button
              type="button"
              ref={cancel}
              autoFocus
              data-porthole-cancel=""
              onClick={() => onAnswer(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              data-porthole-accept=""
              data-armed={String(armed)}
              onClick={() => {
                if (armed) {
                  onAnswer(true);
                }
              }}
            >
              {said.accept}
            </button>
          </menu>
        </>
      )}
    </dialog>
  );
}
