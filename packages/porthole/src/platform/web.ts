import type { ColorScheme } from "../config/schema.ts";
import {
  FRAME_STATUS_METHOD,
  SHELL_BEAT_METHOD,
  SHELL_LOOK_METHOD,
  SHELL_METHOD_PREFIX,
  SHELL_STATE_METHOD,
} from "../isolation/types.ts";
import { postMessageTransport } from "../transport/post-message.ts";
import { focusGuard, type FocusGuard, type FocusTake } from "./focus-guard.ts";
import type { Transport } from "../transport/types.ts";
import type { PlatformHost, Surface, SurfaceSpec } from "./types.ts";

/** A frame-status message (`porthole/notifications/frame-status`), by its method alone. */
const isFrameStatus = (data: unknown): boolean =>
  data !== null &&
  typeof data === "object" &&
  (data as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
  (data as { method?: unknown }).method === FRAME_STATUS_METHOD;

/** A shell's own message (P111), by its namespace. */
const isShellWord = (data: unknown): data is { method: string; params?: unknown } =>
  data !== null &&
  typeof data === "object" &&
  typeof (data as { method?: unknown }).method === "string" &&
  (data as { method: string }).method.startsWith(SHELL_METHOD_PREFIX);

/**
 * A nested page's transport (P111): the shell's state, checked, to the focus guard; the rest of
 * the shell's namespace dropped; everything else as it came.
 */
function shellWords(opened: Transport, frame: HTMLIFrameElement, guard: FocusGuard): Transport {
  const listeners = new Set<(message: unknown) => void>();
  opened.listen((message) => {
    if (!isShellWord(message)) {
      for (const listener of listeners) {
        listener(message);
      }
      return;
    }
    const params = message.params;
    if (params === null || typeof params !== "object") {
      return;
    }
    const { supported, ago, focused, gap, asked } = params as Record<string, unknown>;
    const span = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0;
    if (message.method === SHELL_BEAT_METHOD) {
      if (span(gap)) {
        guard.beat(frame);
      }
      return;
    }
    if (
      message.method !== SHELL_STATE_METHOD ||
      typeof supported !== "boolean" ||
      typeof focused !== "boolean" ||
      !(ago === null || span(ago)) ||
      !span(gap) ||
      !(asked === undefined || (Number.isSafeInteger(asked) && (asked as number) >= 0))
    ) {
      return;
    }
    guard.shell(frame, {
      supported,
      ago: ago as number | null,
      focused,
      gap: gap as number,
      ...(asked === undefined ? {} : { asked: asked as number }),
    });
  });
  return {
    send: (message) => opened.send(message),
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      opened.close();
    },
  };
}

/**
 * The web platform: an `<iframe>` whose policy attributes are set before its document is given,
 * talking over `postMessage`. Its first load is the document it was given; any later load is the
 * content navigating its frame away (a navigation the embedding page's `frame-src` let through, or
 * one to a document of the frame's own), which the framework answers by starting it again.
 */
export const webPlatform: PlatformHost = {
  name: "web",
  createSurface(container: HTMLElement, spec: SurfaceSpec): Surface {
    // oxlint-disable-next-line react/iframe-missing-sandbox -- set from the compiled config, next
    const frame = container.ownerDocument.createElement("iframe");
    // Policy first: the sandbox and Permissions Policy must be in place before the document is.
    frame.setAttribute("sandbox", spec.sandbox);
    frame.setAttribute("allow", spec.allow);
    frame.setAttribute("referrerpolicy", spec.referrerPolicy);
    frame.setAttribute("loading", "eager");
    frame.title = spec.title;
    frame.dataset.portholeFrame = "";
    Object.assign(frame.style, {
      display: "block",
      width: "100%",
      border: "0",
      background: "transparent",
      colorScheme: spec.colorScheme,
      ...(spec.fill === true
        ? { height: "100%", minHeight: `${Math.max(0, Math.round(spec.initialHeightPx))}px` }
        : { height: `${Math.max(0, Math.round(spec.initialHeightPx))}px` }),
    });
    const origin = spec.source.kind === "srcdoc" ? "null" : spec.source.origin;
    if (spec.source.kind === "srcdoc") {
      frame.srcdoc = spec.source.html;
    } else {
      frame.src = spec.source.url;
    }

    const navigated = new Set<() => void>();
    const loaded = new Set<() => void>();
    let loads = 0;
    frame.addEventListener("load", () => {
      loads += 1;
      for (const listener of loaded) {
        listener();
      }
      if (loads > 1) {
        for (const listener of navigated) {
          listener();
        }
      }
    });
    container.append(frame);

    const view = container.ownerDocument.defaultView ?? window;
    // The focus guard (P109): a move of the keyboard into this frame from one of the page's text
    // fields that the person didn't make is undone.
    const guard = focusGuard(view);
    const taken = new Set<(take: FocusTake) => void>();
    const nested = spec.nested === true && spec.source.kind === "url";
    // A served frame may pass through the host's own pages (a redirect entry's, P068): what they
    // say of the frame's status is heard too, and nothing else from there.
    const own = view.origin;
    const opened = postMessageTransport(
      () => frame.contentWindow,
      origin,
      view,
      origin === "null" || own === "null" || own === origin
        ? undefined
        : { origin: own, accept: isFrameStatus },
    );
    const unguard = guard.add(
      frame,
      (take) => {
        for (const listener of taken) {
          listener(take);
        }
      },
      {
        nested,
        // A nested page's shell is asked to look as the guard hears a move into its frame (P120).
        ...(nested
          ? {
              ask: (n: number) =>
                opened.send({ jsonrpc: "2.0", method: SHELL_LOOK_METHOD, params: { n } }),
            }
          : {}),
      },
    );
    // A nested page's shell (P111): its own words go to the guard, by the frame's window and the
    // content origin (the transport's checks); the page's pass on. The shell drops any page
    // message in its namespace, so there none is the page's.
    const transport = nested ? shellWords(opened, frame, guard) : opened;
    return {
      transport,
      element: frame,
      setHeight(px: number) {
        if (spec.fill !== true) {
          frame.style.height = `${Math.max(0, Math.round(px))}px`;
        }
      },
      setColorScheme(scheme: ColorScheme) {
        frame.style.colorScheme = scheme;
      },
      viewport() {
        const style = view.getComputedStyle(frame);
        const width =
          frame.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const height =
          frame.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        return Number.isFinite(width) && Number.isFinite(height)
          ? { width: Math.max(0, width), height: Math.max(0, height) }
          : undefined;
      },
      userActivation() {
        const activation = (
          view.navigator as Navigator & { userActivation?: { isActive: boolean } }
        ).userActivation;
        return activation === undefined ? undefined : activation.isActive;
      },
      focused() {
        return guard.focused(frame) || (nested && guard.gesture(frame));
      },
      onFocusTaken(listener) {
        taken.add(listener);
        return () => taken.delete(listener);
      },
      focus() {
        guard.focus(frame);
      },
      onLoad(listener) {
        loaded.add(listener);
        return () => loaded.delete(listener);
      },
      onNavigated(listener) {
        navigated.add(listener);
        return () => navigated.delete(listener);
      },
      destroy() {
        navigated.clear();
        loaded.clear();
        taken.clear();
        unguard();
        transport.close();
        frame.remove();
      },
    };
  },
};
