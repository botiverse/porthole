import { describe, expect, it } from "vitest";
import { FRAME_STATUS_METHOD } from "../src/isolation/types.ts";
import { postMessageTransport } from "../src/transport/post-message.ts";

/**
 * The frame transport takes a message only from the frame's own window and its located origin;
 * from the host's own origin (a redirect entry's pages, P068) only what `also` accepts.
 */

class FakeWindow {
  readonly listeners = new Set<(event: MessageEvent) => void>();
  addEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners.delete(listener);
  }
  postMessage() {}
  dispatch(data: unknown, origin: string, source: unknown) {
    for (const listener of this.listeners) {
      listener({ data, origin, source } as MessageEvent);
    }
  }
}

const status = {
  jsonrpc: "2.0",
  method: FRAME_STATUS_METHOD,
  params: { state: "blocked", reason: "sign-in" },
};
const isStatus = (data: unknown) =>
  (data as { method?: unknown } | null)?.method === FRAME_STATUS_METHOD;

describe("postMessageTransport", () => {
  it("hears the frame's own origin; the host's own only for what it accepts; nothing else", () => {
    const host = new FakeWindow();
    const frame = new FakeWindow();
    const transport = postMessageTransport(
      () => frame as unknown as Window,
      "https://a-1.content.example",
      host as unknown as Window,
      { origin: "https://app.example", accept: isStatus },
    );
    const heard: unknown[] = [];
    transport.listen((message) => heard.push(message));
    const call = { jsonrpc: "2.0", id: 1, method: "ui/message", params: {} };
    host.dispatch(call, "https://a-1.content.example", frame);
    host.dispatch(status, "https://app.example", frame);
    // From the host's own origin, a protocol call isn't the frame's to make.
    host.dispatch(call, "https://app.example", frame);
    // Another origin, or another window, is never heard.
    host.dispatch(status, "https://evil.example", frame);
    host.dispatch(call, "https://a-1.content.example", new FakeWindow());
    expect(heard).toEqual([call, status]);
  });

  it("without `also`, the host's own origin is not heard at all", () => {
    const host = new FakeWindow();
    const frame = new FakeWindow();
    const transport = postMessageTransport(
      () => frame as unknown as Window,
      "https://a-1.content.example",
      host as unknown as Window,
    );
    const heard: unknown[] = [];
    transport.listen((message) => heard.push(message));
    host.dispatch(status, "https://app.example", frame);
    expect(heard).toEqual([]);
  });
});
