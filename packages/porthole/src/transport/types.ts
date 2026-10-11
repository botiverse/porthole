import type { JsonRpcMessage } from "../protocol/jsonrpc.ts";

/**
 * A message channel to one frame. The platform host makes it (on the web, `postMessage` to the
 * frame's window); adapters speak through it. It checks WHO sent a message (this frame's window,
 * from its expected origin: `"null"` for an opaque frame, the served origin otherwise) and drops
 * everything else; adapters check WHAT it says.
 */
export interface Transport {
  /** Sends one message to the frame. Never secret: an opaque frame can only be addressed as `*`. */
  send(message: JsonRpcMessage): void;
  /** Every message from this frame, still unchecked in shape. Returns an unsubscribe function. */
  listen(listener: (message: unknown) => void): () => void;
  /** Stops listening and sending. */
  close(): void;
}
