import { createElement as h, Fragment } from "react";
import { createRoot } from "react-dom/client";
import type { ConfirmRequest } from "../../src/bridge/types.ts";
import { presets, type PortholeConfig } from "../../src/index.ts";
import { PortholeFrame, PortholeProvider } from "../../src/react/index.ts";

/**
 * A host app on the React binding, driven by the test through `window.app`: which frames it shows
 * and with what props, which provider (the default dialog, a host's own confirm, or none), and a
 * log of everything the binding told it.
 */

const CONFIGS: Readonly<Record<string, PortholeConfig>> = {
  widget: presets.inlineWidget(),
  prompt: presets.inlineWidget({ capabilities: { sendPrompt: {}, openLink: {} } }),
  capped: presets.inlineWidget({ limits: { maxLiveFrames: 3 } }),
  artifact: presets.artifact(),
};

export interface FrameSpec {
  /** The host's React key for the frame (default: the display id). */
  readonly key?: string;
  readonly displayId: string;
  readonly title: string;
  readonly config: keyof typeof CONFIGS;
  readonly content?: string;
  readonly partial?: boolean;
  readonly scheme?: "light" | "dark";
  readonly generation?: number;
  readonly eager?: boolean;
  /** Space above the frame, px (to push it off screen). */
  readonly gapPx?: number;
}

export interface AppState {
  readonly frames: readonly FrameSpec[];
  readonly provider: "default" | "custom" | "none";
}

type LogEntry = { readonly display: string; readonly event: string; readonly detail?: unknown };

const log: LogEntry[] = [];
let pendingCustom: ((accepted: boolean) => void) | null = null;
const root = createRoot(document.getElementById("root") as HTMLElement);

const record = (display: string, event: string, detail?: unknown) =>
  log.push({ display, event, ...(detail === undefined ? {} : { detail }) });

function render(state: AppState): void {
  const frames = state.frames.map((frame) =>
    h(
      Fragment,
      { key: frame.key ?? frame.displayId },
      frame.gapPx === undefined ? null : h("div", { style: { height: frame.gapPx } }),
      h(PortholeFrame, {
        config: CONFIGS[frame.config] as PortholeConfig,
        displayId: frame.displayId,
        title: frame.title,
        scheme: frame.scheme ?? "light",
        ...(frame.content === undefined ? {} : { content: frame.content }),
        ...(frame.partial === undefined ? {} : { partial: frame.partial }),
        ...(frame.generation === undefined ? {} : { generation: frame.generation }),
        ...(frame.eager === undefined ? {} : { eager: frame.eager }),
        handlers: {
          sendPrompt: ({ text }) => {
            record(frame.displayId, "sendPrompt", text);
            return true;
          },
          openLink: ({ url }) => {
            record(frame.displayId, "openLink", url);
            return true;
          },
        },
        onInitialized: () => record(frame.displayId, "initialized"),
        onResize: ({ height }) => record(frame.displayId, "resize", height),
        onError: (message) => record(frame.displayId, "error", message),
        onNavigated: () => record(frame.displayId, "navigated"),
        onRefused: (capability, refusal) =>
          record(frame.displayId, "refused", `${capability}:${refusal}`),
      }),
    ),
  );
  if (state.provider === "none") {
    root.render(h(Fragment, null, frames));
    return;
  }
  root.render(
    h(
      PortholeProvider,
      state.provider === "custom"
        ? {
            confirm: (request: ConfirmRequest) => {
              record(request.display.id, "custom-confirm", request);
              return new Promise<boolean>((resolve) => (pendingCustom = resolve));
            },
          }
        : {},
      frames,
    ),
  );
}

const app = {
  render,
  log: () => log,
  answerCustom(accepted: boolean) {
    pendingCustom?.(accepted);
    pendingCustom = null;
  },
};

(window as unknown as { app: typeof app }).app = app;
