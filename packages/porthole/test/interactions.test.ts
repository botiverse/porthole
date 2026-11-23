import { Script, runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ESCAPE_METHOD, PRESS_METHOD, presets, type PortholeConfig } from "../src/index.ts";
import { createHost, INTERACTIONS_PER_SECOND } from "../src/host/create-host.ts";
import type { PlatformHost } from "../src/platform/types.ts";
import { SHELL_RUNTIME } from "../src/shell/runtime.ts";

const HOST = "https://app.example.com";

const shellPart = (start: string, end: string): string => {
  const at = SHELL_RUNTIME.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  const stop = SHELL_RUNTIME.indexOf(end, at);
  expect(stop, end).toBeGreaterThan(at);
  return SHELL_RUNTIME.slice(at, stop);
};

interface PostedMessage {
  readonly jsonrpc?: string;
  readonly method?: string;
  readonly params?: unknown;
}

function runShellInteractions(
  options: { readonly hostless?: boolean; readonly topLevel?: boolean } = {},
) {
  const posted: PostedMessage[] = [];
  const win = new EventTarget();
  const parentObj = options.topLevel
    ? win
    : { postMessage: (msg: unknown) => posted.push(msg as PostedMessage) };

  class FakeKeyboardEvent extends Event {
    readonly #key: string;
    readonly #keyCode: number;
    readonly #composing: boolean;
    readonly #repeat: boolean;

    constructor(
      type: string,
      init: {
        readonly key?: string;
        readonly keyCode?: number;
        readonly isComposing?: boolean;
        readonly repeat?: boolean;
        readonly cancelable?: boolean;
        readonly bubbles?: boolean;
        readonly trusted?: boolean;
      } = {},
    ) {
      super(type, { cancelable: init.cancelable ?? true, bubbles: init.bubbles ?? true });
      this.#key = init.key ?? "";
      this.#keyCode = init.keyCode ?? 0;
      this.#composing = init.isComposing ?? false;
      this.#repeat = init.repeat ?? false;
      if (init.trusted) {
        Object.defineProperty(this, "isTrusted", { value: true });
      }
    }

    get key(): string {
      return this.#key;
    }

    get keyCode(): number {
      return this.#keyCode;
    }

    get isComposing(): boolean {
      return this.#composing;
    }

    get repeat(): boolean {
      return this.#repeat;
    }
  }

  class FakePointerEvent extends Event {
    constructor(type: string, trusted = false) {
      super(type, { cancelable: true, bubbles: true });
      if (trusted) {
        Object.defineProperty(this, "isTrusted", { value: true });
      }
    }
  }

  const code = [
    shellPart("  const callOf =", "\n  // Whose messages"),
    `  const hostless = ${String(options.hostless === true)};`,
    shellPart("  const getterOf =", "\n  const navigateProto"),
    "  const listenIn = EventTarget.prototype.addEventListener;",
    shellPart("  const post = (message) => {", "\n  const send ="),
    shellPart(
      "  // Frame presses and unhandled Escapes (P157):",
      "\n  // Requests a spliced runtime",
    ),
  ].join("\n");

  const context = {
    window: Object.assign(win, { parent: parentObj, setTimeout }),
    Event,
    EventTarget,
    KeyboardEvent: FakeKeyboardEvent,
    Object,
    Reflect,
  };
  Object.defineProperty(win, "window", { value: win });
  runInNewContext(code, context);

  return {
    posted,
    win,
    context,
    FakeKeyboardEvent,
    FakePointerEvent,
    flushTasks: () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
  };
}

describe("P157 shell runtime listeners", () => {
  testOrderAndSyntax();

  it("posts porthole/press on trusted pointerdown before any capture, bubble, or click handler", () => {
    const { win, posted, FakePointerEvent } = runShellInteractions();
    const order: string[] = [];
    win.addEventListener("pointerdown", () => order.push(`capture:${posted.length}`), true);
    win.addEventListener("pointerdown", () => order.push(`bubble:${posted.length}`));
    win.addEventListener("click", () => order.push(`click:${posted.length}`));

    win.dispatchEvent(new FakePointerEvent("pointerdown", false));
    expect(posted).toEqual([]);
    order.length = 0;

    win.dispatchEvent(new FakePointerEvent("pointerdown", true));
    win.dispatchEvent(new FakePointerEvent("click", true));

    expect(posted).toEqual([{ jsonrpc: "2.0", method: PRESS_METHOD, params: {} }]);
    expect(order).toEqual(["capture:1", "bubble:1", "click:1"]);
  });

  it("posts porthole/escape for trusted unhandled Escape and respects later preventDefault() or non-Escape states", async () => {
    const { win, posted, FakeKeyboardEvent, flushTasks } = runShellInteractions();

    // Handled by content via bubble listener registered later on window.
    let cancelEscape = false;
    win.addEventListener("keydown", (event) => {
      if (cancelEscape) {
        event.preventDefault();
      }
    });

    // Ignored variants.
    win.dispatchEvent(new FakeKeyboardEvent("keydown", { key: "Escape", trusted: false }));
    win.dispatchEvent(new FakeKeyboardEvent("keydown", { key: "Enter", trusted: true }));
    win.dispatchEvent(
      new FakeKeyboardEvent("keydown", { key: "Escape", repeat: true, trusted: true }),
    );
    win.dispatchEvent(
      new FakeKeyboardEvent("keydown", { key: "Escape", isComposing: true, trusted: true }),
    );
    win.dispatchEvent(
      new FakeKeyboardEvent("keydown", { key: "Escape", keyCode: 229, trusted: true }),
    );

    cancelEscape = true;
    win.dispatchEvent(new FakeKeyboardEvent("keydown", { key: "Escape", trusted: true }));
    await flushTasks();
    expect(posted).toEqual([]);

    // Unhandled Escape emits after the current task finishes.
    cancelEscape = false;
    win.dispatchEvent(new FakeKeyboardEvent("keydown", { key: "Escape", trusted: true }));
    expect(posted).toEqual([]);
    await flushTasks();
    expect(posted).toEqual([{ jsonrpc: "2.0", method: ESCAPE_METHOD, params: {} }]);
  });

  it("reads native KeyboardEvent getters and window.setTimeout even if content tampers later", async () => {
    const { win, context, posted, FakeKeyboardEvent, flushTasks } = runShellInteractions();
    // Simulate hostile content clobbering window.setTimeout and KeyboardEvent.prototype.key after boot.
    Object.defineProperty(context.KeyboardEvent.prototype, "key", {
      configurable: true,
      get: () => "Enter",
    });
    (context.window as unknown as { setTimeout: unknown }).setTimeout = () => {
      throw new Error("clobbered setTimeout");
    };

    // Non-KeyboardEvent trusted keydown safely returns without throwing TypeError.
    const plainKeydown = new context.Event("keydown", { cancelable: true, bubbles: true });
    Object.defineProperty(plainKeydown, "isTrusted", { value: true });
    expect(() => win.dispatchEvent(plainKeydown)).not.toThrow();

    win.dispatchEvent(new FakeKeyboardEvent("keydown", { key: "Escape", trusted: true }));
    await flushTasks();
    expect(posted).toEqual([{ jsonrpc: "2.0", method: ESCAPE_METHOD, params: {} }]);
  });

  it("posts nothing on hostless or top-level frames", async () => {
    for (const opts of [{ hostless: true }, { topLevel: true }]) {
      const { win, posted, FakePointerEvent, FakeKeyboardEvent, flushTasks } =
        runShellInteractions(opts);
      win.dispatchEvent(new FakePointerEvent("pointerdown", true));
      win.dispatchEvent(new FakeKeyboardEvent("keydown", { key: "Escape", trusted: true }));
      await flushTasks();
      expect(posted).toEqual([]);
    }
  });
});

function testOrderAndSyntax() {
  it("parses cleanly and installs listeners before __ANNOTATE__", () => {
    expect(() => new Script(SHELL_RUNTIME.replace("__PLAN__", "{}"))).not.toThrow();
    const pressAt = SHELL_RUNTIME.indexOf(`method: "${PRESS_METHOD}"`);
    const escapeAt = SHELL_RUNTIME.indexOf(`method: "${ESCAPE_METHOD}"`);
    const annotateAt = SHELL_RUNTIME.indexOf("__ANNOTATE__");
    expect(pressAt).toBeGreaterThan(-1);
    expect(escapeAt).toBeGreaterThan(pressAt);
    expect(escapeAt).toBeLessThan(annotateAt);
  });
}

describe("P157 host press and escape events", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function mountFakeDisplay(config: PortholeConfig = presets.inlineWidget()) {
    let activeListeners: ((message: unknown) => void)[] = [];
    const platform: PlatformHost = {
      name: "stand-in",
      createSurface: () => {
        const listeners: ((message: unknown) => void)[] = [];
        activeListeners = listeners;
        return {
          transport: {
            send: () => {},
            listen: (listener) => {
              listeners.push(listener);
              return () => {
                const index = listeners.indexOf(listener);
                if (index !== -1) {
                  listeners.splice(index, 1);
                }
              };
            },
            close: () => {
              listeners.length = 0;
              if (activeListeners === listeners) {
                activeListeners = [];
              }
            },
          },
          element: null,
          setHeight: () => {},
          setColorScheme: () => {},
          userActivation: () => undefined,
          onNavigated: () => () => {},
          onLoad: () => () => {},
          destroy: () => {},
        };
      },
    };
    const container = {
      ownerDocument: {
        defaultView: { location: { origin: HOST }, navigator: { language: "en" } },
      },
      getBoundingClientRect: () => ({ width: 600 }),
    } as unknown as HTMLElement;
    const display = createHost(config, { platform }).mount(container, {
      displayId: "d1",
      title: "T",
      scheme: "light",
    });
    const events: string[] = [];
    display.on("initialized", () => events.push("initialized"));
    display.on("press", () => events.push("press"));
    display.on("escape", () => events.push("escape"));
    const say = (message: unknown) => {
      for (const listener of activeListeners.slice()) {
        listener(message);
      }
    };
    return {
      display,
      events,
      ready: () => say({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }),
      press: () => say({ jsonrpc: "2.0", method: PRESS_METHOD, params: {} }),
      escape: () => say({ jsonrpc: "2.0", method: ESCAPE_METHOD, params: {} }),
      say,
    };
  }

  it("drops notices before initialized and drops JSON-RPC requests carrying an id", () => {
    const { display, events, ready, press, escape, say } = mountFakeDisplay();
    press();
    escape();
    expect(events).toEqual([]);

    ready();
    say({ jsonrpc: "2.0", id: 1, method: PRESS_METHOD, params: {} });
    say({ jsonrpc: "2.0", id: 2, method: ESCAPE_METHOD, params: {} });
    expect(events).toEqual(["initialized"]);

    press();
    escape();
    expect(events).toEqual(["initialized", "press", "escape"]);
    display.destroy();
  });

  it("caps press and escape independently at INTERACTIONS_PER_SECOND across restarts", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { display, events, ready, press, escape } = mountFakeDisplay();
    ready();
    events.length = 0;

    for (let i = 0; i < INTERACTIONS_PER_SECOND + 5; i += 1) {
      press();
    }
    expect(events).toHaveLength(INTERACTIONS_PER_SECOND);
    // Exhausting press never starves escape.
    escape();
    expect(events.at(-1)).toBe("escape");

    // Still within the 1s sliding window.
    await vi.advanceTimersByTimeAsync(999);
    press();
    expect(events).toHaveLength(INTERACTIONS_PER_SECOND + 1);

    // Reload resets handshake until initialized, but keeps the sliding-second budget.
    display.reload();
    press();
    expect(events).toHaveLength(INTERACTIONS_PER_SECOND + 1);
    ready();
    expect(events.at(-1)).toBe("initialized");
    press();
    expect(events).toHaveLength(INTERACTIONS_PER_SECOND + 2);

    // After the full 1s window advances, presses emit again.
    await vi.advanceTimersByTimeAsync(1);
    press();
    expect(events.filter((e) => e === "press")).toHaveLength(INTERACTIONS_PER_SECOND + 1);
    display.destroy();
  });
});
