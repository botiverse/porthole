import type { ReactElement } from "react";
import type { CapabilityArgs } from "../config/capabilities.ts";

/**
 * The default model context notice (P100): when content tells the agent something
 * (`setModelContext`, MCP Apps' `ui/update-model-context`), the host's page shows the person all
 * of it, outside every frame, before the host's handler has it: the text the agent reads at its
 * next turn, in the content's words. One per display, the latest (an update replaces the last, as
 * it does for the agent); it stays until the person hides it. Nothing in it is a question: the
 * update has gone. All of it shows (after the review: the text box grows, never hiding a payload
 * below blank lines, and says how many characters and lines it holds); the stack of displays
 * scrolls within the window, so a later display never pushes an earlier one out of reach. A host replaces it by passing its own `show` (a chip by its composer, say); it
 * styles it through the `porthole-context` class and data attributes.
 */

export interface ContextUpdate {
  /** The display's id and title, as the host named it. */
  readonly displayId: string;
  readonly title: string;
  /** The update, whole: text blocks and structured content, as the bridge took them. */
  readonly update: CapabilityArgs["setModelContext"];
}

export interface ContextNoticeProps {
  /** The latest update of each display that sent one, in the order they came. */
  readonly updates: readonly ContextUpdate[];
  /** The person hid one display's notice (the agent still has its update). */
  readonly onHide: (displayId: string) => void;
  readonly className?: string;
}

/** How long an update is, in words: "412 characters, 3 lines". */
export function contextSize(text: string): string {
  const lines = text === "" ? 0 : text.split("\n").length;
  return `${text.length.toLocaleString("en-US")} characters, ${lines.toLocaleString("en-US")} ${lines === 1 ? "line" : "lines"}`;
}

/** What the person is shown of an update: its text blocks, then its structured content's JSON. */
export function contextText(update: CapabilityArgs["setModelContext"]): string {
  const text = (update.content ?? []).map((block) => block.text).join("\n\n");
  const structured =
    update.structuredContent === undefined ? "" : JSON.stringify(update.structuredContent, null, 2);
  return [text, structured].filter((part) => part !== "").join("\n\n");
}

const STYLE = `.porthole-context{position:fixed;right:16px;bottom:24px;z-index:2147483646;display:flex;flex-direction:column;gap:8px;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow-y:auto;overscroll-behavior:contain;font:inherit;font-size:.9em}
.porthole-context[hidden]{display:none}
.porthole-context>section{flex:none;color-scheme:light dark;color:CanvasText;background:Canvas;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:12px;padding:12px 14px;box-shadow:0 8px 28px rgb(0 0 0 / .25)}
.porthole-context p{margin:0 0 6px}
.porthole-context [data-porthole-source],.porthole-context [data-porthole-note],.porthole-context [data-porthole-context-size]{opacity:.72}
.porthole-context>[data-porthole-context-count]{flex:none;margin:0;padding:6px 12px;border-radius:8px;color-scheme:light dark;color:CanvasText;background:Canvas;border:1px solid color-mix(in srgb,CanvasText 18%,transparent)}
.porthole-context [data-porthole-context-size]{margin:6px 0 0}
.porthole-context pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,CanvasText 7%,transparent);font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.porthole-context menu{display:flex;justify-content:flex-end;margin:8px 0 0;padding:0}
.porthole-context button{font:inherit;min-height:32px;padding:0 12px;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);background:transparent;color:inherit;cursor:pointer}`;

export function ContextNotice({ updates, onHide, className }: ContextNoticeProps): ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className={className === undefined ? "porthole-context" : `porthole-context ${className}`}
      data-porthole-context=""
      hidden={updates.length === 0}
    >
      <style>{STYLE}</style>
      {updates.length > 1 ? (
        <p data-porthole-context-count="">{`${updates.length} displays told the agent something: scroll to read them all.`}</p>
      ) : null}
      {updates.map((each) => {
        const text = contextText(each.update);
        return (
          <section key={each.displayId} data-porthole-context-display={each.displayId}>
            <p>
              <strong>Context for the agent</strong>{" "}
              <span data-porthole-source="">{`from “${each.title}”`}</span>
            </p>
            <p data-porthole-note="">
              The agent reads this at its next turn. It is the content’s text, not yours.
            </p>
            <pre data-porthole-context-text="" tabIndex={0}>
              {text}
            </pre>
            <p data-porthole-context-size="">{contextSize(text)}</p>
            <menu>
              <button type="button" data-porthole-hide="" onClick={() => onHide(each.displayId)}>
                Hide
              </button>
            </menu>
          </section>
        );
      })}
    </div>
  );
}
