import { describe, expect, it } from "vitest";
import { FRAME_STATUS_METHOD } from "../src/isolation/types.ts";
import { postMessageTransport } from "../src/transport/post-message.ts";

/**
 * The frame transport takes a message only from the frame's own window and its located origin:
 * never the host's own origin (P125 removed P068's in-frame pages and the `also` channel that heard
 * them), so no page of the host's own can say a frame's status.
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
  it("hears the frame's own origin from its own window, and nothing else", () => {
    const host = new FakeWindow();
    const frame = new FakeWindow();
    const transport = postMessageTransport(
      () => frame as unknown as Window,
      "https://a-1.content.example",
      host as unknown as Window,
    );
    const heard: unknown[] = [];
    transport.listen((message) => heard.push(message));
    const call = { jsonrpc: "2.0", id: 1, method: "ui/message", params: {} };
    host.dispatch(call, "https://a-1.content.example", frame);
    // Another origin, or another window, is never heard.
    host.dispatch(status, "https://evil.example", frame);
    host.dispatch(call, "https://a-1.content.example", new FakeWindow());
    expect(heard).toEqual([call]);
  });

  it("never hears the host's own origin, a frame status least of all (P125: no `also` channel)", () => {
    const host = new FakeWindow();
    const frame = new FakeWindow();
    // Even called as the old four-argument form, a fourth argument is nothing.
    const transport = (
      postMessageTransport as unknown as (
        frameWindow: () => Window | null,
        origin: string,
        host: Window,
        also: unknown,
      ) => ReturnType<typeof postMessageTransport>
    )(() => frame as unknown as Window, "https://a-1.content.example", host as unknown as Window, {
      origin: "https://app.example",
      accept: isStatus,
    });
    const heard: unknown[] = [];
    transport.listen((message) => heard.push(message));
    host.dispatch(status, "https://app.example", frame);
    host.dispatch(
      { jsonrpc: "2.0", method: "ui/notifications/size-changed" },
      "https://app.example",
      frame,
    );
    expect(heard, "the host's own origin is never heard from a frame").toEqual([]);
  });
});

describe("the web platform hears a frame from its own origin alone (P125)", () => {
  it("statically: every transport platform/web.ts opens takes exactly the frame's window, its origin and the view", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(
      path.join(import.meta.dirname, "../src/platform/web.ts"),
      "utf8",
    ).replace(/\s+/gu, " ");
    const calls = [...source.matchAll(/postMessageTransport\(([^;]*?)\);/gu)].map((match) =>
      match[1]?.trim(),
    );
    expect(calls, "a surface's transport and a door's").toEqual([
      "() => frame.contentWindow, origin, view",
      '() => frame.contentWindow, "null", view',
    ]);
    expect(source, "nothing reads the host's own origin to hear a frame").not.toMatch(
      /view\.origin/u,
    );
  });
});
