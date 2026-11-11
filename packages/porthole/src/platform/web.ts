import { DOOR_SANDBOX_TOKENS } from "../compile/policy.ts";
import type { ColorScheme } from "../config/schema.ts";
import { postMessageTransport } from "../transport/post-message.ts";
import type { DoorSurface, PlatformHost, Surface, SurfaceSpec } from "./types.ts";

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
    // A frame is heard from its own window and its located origin alone: never the host's own
    // origin (P125 removed P068's in-frame pages and the channel that heard them), so no page of
    // the host's own can speak for a frame either.
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
      // Where the keyboard is, as the frame's own tree says it (its document's, or the shadow
      // root's it is in): no more than that. A frame may take the focus by itself (0.16.0
      // removed the guard that took it back, P149), so this is no word on who put it there.
      focused() {
        const root = frame.getRootNode() as Partial<DocumentOrShadowRoot>;
        return root.activeElement === frame;
      },
      focus() {
        frame.focus();
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
  /**
   * A served display's door (P125): hidden (no size, `visibility: hidden`, which still runs its
   * script and fires its load on all three engines), out of focus and of the accessibility tree,
   * sandboxed with scripts alone, no `allow`, no name. Nothing but its frame status is heard from
   * it, from its window and the opaque origin alone; the bridge and annotations never see it.
   */
  createDoor(container: HTMLElement, spec: { readonly url: string }): DoorSurface {
    // oxlint-disable-next-line react/iframe-missing-sandbox -- set from the door's list, next
    const frame = container.ownerDocument.createElement("iframe");
    frame.setAttribute("sandbox", DOOR_SANDBOX_TOKENS.join(" "));
    frame.setAttribute("allow", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.setAttribute("inert", "");
    frame.setAttribute("loading", "eager");
    frame.dataset.portholeDoor = "";
    Object.assign(frame.style, {
      display: "block",
      width: "0",
      height: "0",
      border: "0",
      visibility: "hidden",
    });
    frame.src = spec.url;
    const loaded = new Set<() => void>();
    frame.addEventListener("load", () => {
      for (const listener of loaded) {
        listener();
      }
    });
    container.append(frame);
    const view = container.ownerDocument.defaultView ?? window;
    const transport = postMessageTransport(() => frame.contentWindow, "null", view);
    return {
      transport,
      element: frame,
      onLoad(listener) {
        loaded.add(listener);
        return () => loaded.delete(listener);
      },
      destroy() {
        loaded.clear();
        transport.close();
        frame.remove();
      },
    };
  },
};
