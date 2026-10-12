import type { JsonRpcMessage } from "../protocol/jsonrpc.ts";
import type { Transport } from "./types.ts";

/**
 * A transport to one frame over `postMessage`. A message counts as the frame's only if it comes
 * from the frame's own window AND from the expected origin: `"null"` for an opaque frame (every
 * opaque frame says "null", so the window is what identifies it), the served origin otherwise.
 * Messages go to the frame's window addressed to that origin; an opaque frame can only be
 * addressed as `"*"`, so nothing secret is ever sent.
 */
export function postMessageTransport(
  frameWindow: () => Window | null,
  expectedOrigin: string,
  host: Window = window,
  /**
   * Another origin the frame's window may say some things from: the host's own, whose pages a
   * served frame passes through on a redirect entry (P068), for their frame status only.
   */
  also?: { readonly origin: string; readonly accept: (data: unknown) => boolean },
): Transport {
  const listeners = new Set<(message: unknown) => void>();
  let closed = false;
  const onMessage = (event: MessageEvent) => {
    const source = frameWindow();
    if (closed || source === null || event.source !== source) {
      return;
    }
    if (
      event.origin !== expectedOrigin &&
      (also === undefined || event.origin !== also.origin || !also.accept(event.data))
    ) {
      return;
    }
    for (const listener of listeners) {
      listener(event.data);
    }
  };
  host.addEventListener("message", onMessage);
  const target = expectedOrigin === "null" ? "*" : expectedOrigin;
  return {
    send(message: JsonRpcMessage) {
      if (!closed) {
        frameWindow()?.postMessage(message, target);
      }
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      listeners.clear();
      host.removeEventListener("message", onMessage);
    },
  };
}
