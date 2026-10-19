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
  /**
   * What asked for the yes, above the detail (which scrolls): a db batch's writes whose gates
   * asked, however late in the batch they come (P094).
   */
  readonly summary?: string;
  /** What the person is shown in full. */
  readonly detail: string;
  /** A line under it (the link's host). */
  readonly note?: string;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? "";

/** How many of one kind of write the summary names before it counts the rest. */
const MOST_PATHS = 10;

/**
 * A db change in a line (P094): the writes whose own gates asked for the yes, by kind ("Delete
 * n/x, n/y; and 48 other writes."), or every write by kind where none of them asked (the host
 * function's own confirmation); at most `MOST_PATHS` paths a kind, then a count.
 */
function writesSummary(
  writes: readonly { readonly op: string; readonly path: string }[],
  askedBy: readonly string[],
): string {
  const asked = writes.filter((each) => askedBy.includes(each.op));
  const lead = asked.length === 0 ? writes : asked;
  const kinds = new Map<string, string[]>();
  for (const each of lead) {
    kinds.set(each.op, [...(kinds.get(each.op) ?? []), each.path]);
  }
  const said = [...kinds]
    .map(
      ([op, paths]) =>
        `${op} ${paths.slice(0, MOST_PATHS).join(", ")}${paths.length > MOST_PATHS ? ` and ${paths.length - MOST_PATHS} more` : ""}`,
    )
    .join("; ");
  const others = writes.length - lead.length;
  const text = `${said}${others === 0 ? "" : `; and ${others} other write${others === 1 ? "" : "s"}`}.`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

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
    case "subscribeData":
      return { heading: "Let it follow this?", accept: "Allow", detail: request.args.uri };
    case "copyText":
      return { heading: "Copy this text?", accept: "Copy", detail: request.args.text };
    // The runtime's (P088, P089): the whole effect, as the page asked for it.
    case "artifact":
      return request.args.op === "publish"
        ? {
            heading: "Publish a new version of this page?",
            accept: "Publish",
            detail: Object.entries(request.args.files)
              .map(([path, file]) =>
                file === null
                  ? `${path}: removed`
                  : "text" in file
                    ? `${path}: ${file.text.length.toLocaleString("en-US")} characters`
                    : `${path}: ${Math.floor((file.base64.length * 3) / 4).toLocaleString("en-US")} bytes`,
              )
              .join("\n"),
            note: `From version ${request.args.base}${request.args.label === undefined ? "" : `: ${request.args.label}`}.`,
          }
        : { heading: "Allow this?", accept: "Allow", detail: json(request.args) };
    case "assets":
      return request.args.op === "upload"
        ? {
            heading: "Add this file to the page's library?",
            accept: "Add",
            detail: `${request.args.name} (${request.args.type}, ${request.args.size.toLocaleString("en-US")} bytes)`,
            note: "Everyone who can see the page can load it.",
          }
        : request.args.op === "delete"
          ? {
              heading: "Remove this file from the page's library?",
              accept: "Remove",
              detail: request.args.id,
            }
          : { heading: "Allow this?", accept: "Allow", detail: json(request.args) };
    // The page's shared data (P088): a change leads with what asked for the yes (P094).
    case "db": {
      const args = request.args;
      const writes =
        args.op === "batch"
          ? args.writes
          : args.op === "set" || args.op === "update" || args.op === "delete"
            ? [args]
            : null;
      return writes === null
        ? { heading: "Allow this?", accept: "Allow", detail: json(args) }
        : {
            heading: "Change this page's shared data?",
            accept: "Change",
            summary: writesSummary(writes, request.askedBy ?? []),
            detail: json(args),
          };
    }
    default:
      return { heading: "Allow this?", accept: "Allow", detail: json(request.args) };
  }
}

const STYLE = `.porthole-confirm{color-scheme:light dark;color:CanvasText;background:Canvas;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:12px;padding:20px;width:min(440px,calc(100vw - 32px));font:inherit;box-shadow:0 12px 40px rgb(0 0 0 / .28)}
.porthole-confirm::backdrop{background:rgb(0 0 0 / .4)}
.porthole-confirm h2{font-size:1.05em;margin:0 0 4px}
.porthole-confirm [data-porthole-source],.porthole-confirm [data-porthole-note]{opacity:.72;font-size:.9em;margin:0 0 12px}
.porthole-confirm [data-porthole-summary]{font-weight:600;overflow-wrap:anywhere;max-height:20vh;overflow:auto;margin:0 0 12px}
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
          {said.summary === undefined ? null : <p data-porthole-summary="">{said.summary}</p>}
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
