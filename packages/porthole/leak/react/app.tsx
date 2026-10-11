import { createElement as h, Fragment } from "react";
import { createRoot } from "react-dom/client";
import type { ConfirmRequest, Proceed } from "../../src/bridge/types.ts";
import {
  presets,
  type AnnotateMode,
  type AnnotationMark,
  type PortholeConfig,
} from "../../src/index.ts";
import { PortholeFrame, PortholeProvider } from "../../src/react/index.ts";

/**
 * A host app on the React binding, driven by the test through `window.app`: which frames it shows
 * and with what props, which provider (the default dialog, a host's own confirm, or none), and a
 * log of everything the binding told it.
 */

/** A running app for url mode: this server under another name, so another site. */
const APP_ORIGIN = `http://localhost:${location.port}`;

const CONFIGS: Readonly<Record<string, PortholeConfig>> = {
  widget: presets.inlineWidget(),
  prompt: presets.inlineWidget({ capabilities: { sendPrompt: {}, openLink: {} } }),
  capped: presets.inlineWidget({ limits: { maxLiveFrames: 3 } }),
  artifact: presets.artifact(),
  copy: presets.inlineWidget({ capabilities: { copyText: {} } }),
  notes: presets.artifact({ capabilities: { annotate: {} } }),
  url: presets.url({ contentOrigins: [APP_ORIGIN] }),
  urlPopups: presets.url({
    contentOrigins: [APP_ORIGIN],
    sandbox: ["allow-popups", "allow-popups-to-escape-sandbox", "allow-modals"],
  }),
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
  readonly aliases?: readonly string[];
  readonly themeKey?: number;
  /** Space above the frame, px (to push it off screen). */
  readonly gapPx?: number;
  readonly annotating?: AnnotateMode | null;
  readonly annotations?: readonly AnnotationMark[];
  readonly focusedAnnotation?: string | null;
}

export interface AppState {
  readonly frames: readonly FrameSpec[];
  /** "late": a host's own confirm that answers yes later, without `proceed` (out of the click). */
  readonly provider: "default" | "custom" | "late" | "none";
}

type LogEntry = { readonly display: string; readonly event: string; readonly detail?: unknown };

const log: LogEntry[] = [];
let pendingCustom: ((accepted: boolean) => void) | null = null;
const root = createRoot(document.getElementById("root") as HTMLElement);

const record = (display: string, event: string, detail?: unknown) =>
  log.push({ display, event, ...(detail === undefined ? {} : { detail }) });

/** The host's theme values, read from its own page's styles (as a host's tokens are). */
const theme = () => ({
  "--color-text-primary": getComputedStyle(document.documentElement)
    .getPropertyValue("--host-text")
    .trim(),
});

const locator = {
  locate: async () => ({ url: `${APP_ORIGIN}/leak/host/app.html`, origin: APP_ORIGIN }),
};

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
        theme,
        ...(frame.content === undefined ? {} : { content: frame.content }),
        ...(frame.partial === undefined ? {} : { partial: frame.partial }),
        ...(frame.generation === undefined ? {} : { generation: frame.generation }),
        ...(frame.eager === undefined ? {} : { eager: frame.eager }),
        ...(frame.aliases === undefined ? {} : { aliases: frame.aliases }),
        ...(frame.themeKey === undefined ? {} : { themeKey: frame.themeKey }),
        ...(frame.annotating === undefined ? {} : { annotating: frame.annotating }),
        ...(frame.annotations === undefined ? {} : { annotations: frame.annotations }),
        ...(frame.focusedAnnotation === undefined
          ? {}
          : { focusedAnnotation: frame.focusedAnnotation }),
        onAnnotation: (report) => record(frame.displayId, "annotation", report),
        ...(frame.config.startsWith("url")
          ? {
              instance: {
                scope: frame.displayId,
                document: { kind: "external" as const, url: "http://app.test/" },
              },
              style: { height: 400 },
            }
          : {}),
        handlers: {
          sendPrompt: ({ text }) => {
            record(frame.displayId, "sendPrompt", text);
            return true;
          },
          openLink: ({ url }) => {
            // An effect that needs the person's gesture: a window of its own.
            const opened = window.open(url, "_blank") !== null;
            record(frame.displayId, "openLink", { url, opened });
            return opened;
          },
        },
        onInitialized: () => record(frame.displayId, "initialized"),
        onResize: ({ height }) => record(frame.displayId, "resize", height),
        onError: (message) => record(frame.displayId, "error", message),
        onNavigated: () => record(frame.displayId, "navigated"),
        onOutcome: (outcome) => record(frame.displayId, "outcome", outcome),
        onRefused: (capability, refusal) =>
          record(frame.displayId, "refused", `${capability}:${refusal}`),
      }),
    ),
  );
  if (state.provider === "none") {
    root.render(h(Fragment, null, frames));
    return;
  }
  const confirm =
    state.provider === "custom"
      ? (request: ConfirmRequest) => {
          record(request.display.id, "custom-confirm", request);
          return new Promise<boolean>((resolve) => (pendingCustom = resolve));
        }
      : state.provider === "late"
        ? (_request: ConfirmRequest, _proceed: Proceed) =>
            new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1_500))
        : undefined;
  root.render(
    h(PortholeProvider, { locator, ...(confirm === undefined ? {} : { confirm }) }, frames),
  );
}

const app = {
  render,
  log: () => log,
  answerCustom(accepted: boolean) {
    pendingCustom?.(accepted);
    pendingCustom = null;
  },
  /** The host's own styles, set now. */
  restyle(value: string) {
    document.documentElement.style.setProperty("--host-text", value);
  },
  /** The host's own styles, set on its next frame (a host that restyles asynchronously). */
  restyleLater(value: string) {
    requestAnimationFrame(() => document.documentElement.style.setProperty("--host-text", value));
  },
};

(window as unknown as { app: typeof app }).app = app;
