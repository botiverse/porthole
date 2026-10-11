import type { ColorScheme } from "../config/schema.ts";
import { postMessageTransport } from "../transport/post-message.ts";
import type { PlatformHost, Surface, SurfaceSpec } from "./types.ts";

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
    const transport = postMessageTransport(() => frame.contentWindow, origin, view);
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
      userActivation() {
        const activation = (
          view.navigator as Navigator & { userActivation?: { isActive: boolean } }
        ).userActivation;
        return activation === undefined ? undefined : activation.isActive;
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
        transport.close();
        frame.remove();
      },
    };
  },
};
