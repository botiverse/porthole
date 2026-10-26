import type { ColorScheme } from "../config/schema.ts";
import { FRAME_STATUS_METHOD } from "../isolation/types.ts";
import { postMessageTransport } from "../transport/post-message.ts";
import { focusGuard, type FocusTake } from "./focus-guard.ts";
import type { PlatformHost, Surface, SurfaceSpec } from "./types.ts";

/** A frame-status message (`porthole/notifications/frame-status`), by its method alone. */
const isFrameStatus = (data: unknown): boolean =>
  data !== null &&
  typeof data === "object" &&
  (data as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
  (data as { method?: unknown }).method === FRAME_STATUS_METHOD;

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
    const unguard = guard.add(frame, (take) => {
      for (const listener of taken) {
        listener(take);
      }
    });
    // A served frame may pass through the host's own pages (a redirect entry's, P068): what they
    // say of the frame's status is heard too, and nothing else from there.
    const own = view.origin;
    const transport = postMessageTransport(
      () => frame.contentWindow,
      origin,
      view,
      origin === "null" || own === "null" || own === origin
        ? undefined
        : { origin: own, accept: isFrameStatus },
    );
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
        return guard.focused(frame);
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
