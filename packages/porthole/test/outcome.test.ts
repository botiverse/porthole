import { afterEach, describe, expect, test, vi } from "vitest";
import { UNTRUSTED_FRAME_STATUS, watchOutcome } from "../src/host/outcome.ts";
import type { DisplayEvents, FrameOutcome } from "../src/host/types.ts";
import { createHost, presets, type PlatformHost, type PortholeConfig } from "../src/index.ts";
import { FRAME_STATUS_METHOD, type FrameSource } from "../src/isolation/types.ts";
import type { Surface } from "../src/platform/types.ts";

/** A surface whose loads and messages the test makes happen. */
function fakeSurface() {
  const loads = new Set<() => void>();
  const messages = new Set<(data: unknown) => void>();
  const surface = {
    transport: {
      send: () => {},
      listen: (listener: (data: unknown) => void) => {
        messages.add(listener);
        return () => messages.delete(listener);
      },
      close: () => {},
    },
    element: null,
    setHeight: () => {},
    setColorScheme: () => {},
    userActivation: () => undefined,
    onNavigated: () => () => {},
    onLoad: (listener: () => void) => {
      loads.add(listener);
      return () => loads.delete(listener);
    },
    destroy: () => {},
  } satisfies Surface;
  return {
    surface,
    load: () => [...loads].forEach((each) => each()),
    say: (data: unknown) => [...messages].forEach((each) => each(data)),
  };
}

const status = (params: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  method: FRAME_STATUS_METHOD,
  params,
});
const served = (reports: boolean): FrameSource => ({
  kind: "url",
  url: "https://a.example/x",
  origin: "https://a.example",
  reports,
});

function watch(source: FrameSource, speaks: boolean) {
  const fake = fakeSurface();
  const seen: FrameOutcome[] = [];
  const refused: string[] = [];
  const handle = watchOutcome({
    surface: fake.surface,
    source,
    speaks,
    timeoutMs: 5_000,
    onOutcome: (each) => seen.push(each),
    refused: (message) => refused.push(message),
  });
  return { ...fake, seen, refused, handle };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a display's load outcome", () => {
  test("a shell is loaded when it finishes its handshake, once", () => {
    vi.useFakeTimers();
    const { seen, handle } = watch({ kind: "srcdoc", html: "" }, true);
    handle.initialized();
    handle.initialized();
    vi.advanceTimersByTime(10_000);
    expect(seen).toEqual([{ state: "loaded" }]);
  });

  test("an app through Porthole's server is loaded when its document loads after the entry page", () => {
    vi.useFakeTimers();
    const { seen, say, load } = watch(served(true), false);
    say(status({ state: "entering" }));
    load();
    vi.advanceTimersByTime(1_000);
    expect(seen).toEqual([]);
    load();
    expect(seen).toEqual([{ state: "loaded" }]);
  });

  test("a page that loaded but never spoke, where it should have, never ran: framing", () => {
    vi.useFakeTimers();
    const { seen, load } = watch(served(true), false);
    load();
    vi.advanceTimersByTime(1_000);
    expect(seen).toEqual([{ state: "blocked", reason: "framing" }]);
  });

  test("a served shell that loaded without a word never ran either", () => {
    vi.useFakeTimers();
    const { seen, load } = watch(served(true), true);
    load();
    vi.advanceTimersByTime(1_000);
    expect(seen).toEqual([{ state: "blocked", reason: "framing" }]);
  });

  test("a page that says it is blocked is blocked, with its reason and status", () => {
    vi.useFakeTimers();
    const { seen, say, load } = watch(served(true), false);
    say(status({ state: "entering" }));
    load();
    say(status({ state: "blocked", reason: "cookies", status: 401 }));
    expect(seen).toEqual([{ state: "blocked", reason: "cookies", status: 401 }]);
  });

  test("an app from a host's own gateway is loaded on its first load, unless its page says otherwise", () => {
    vi.useFakeTimers();
    const ok = watch(served(false), false);
    ok.load();
    vi.advanceTimersByTime(1_000);
    expect(ok.seen).toEqual([{ state: "loaded" }]);
    const refused = watch(served(false), false);
    refused.load();
    refused.say(status({ state: "blocked", reason: "upstream", status: 502 }));
    vi.advanceTimersByTime(1_000);
    expect(refused.seen).toEqual([{ state: "blocked", reason: "upstream", status: 502 }]);
  });

  test("nothing settled in time is a timeout; malformed words are ignored", () => {
    vi.useFakeTimers();
    const { seen, say } = watch(served(true), false);
    say(status({ state: "loaded" }));
    say({ method: FRAME_STATUS_METHOD, params: { state: "blocked" } });
    vi.advanceTimersByTime(5_000);
    expect(seen).toEqual([{ state: "timeout" }]);
  });

  test("an unknown reason is reported as an error, not trusted", () => {
    vi.useFakeTimers();
    const { seen, say } = watch(served(false), false);
    say(status({ state: "blocked", reason: "<script>" }));
    expect(seen).toEqual([{ state: "blocked", reason: "error" }]);
  });

  test("a loaded app later denied by the host is blocked, once, with the host's code (P050)", () => {
    vi.useFakeTimers();
    const { seen, say, load } = watch(served(true), false);
    say(status({ state: "entering" }));
    load();
    load();
    vi.advanceTimersByTime(60_000);
    say(status({ state: "blocked", reason: "denied", status: 403, code: "revoked" }));
    say(status({ state: "blocked", reason: "session", status: 401 }));
    expect(seen).toEqual([
      { state: "loaded" },
      { state: "blocked", reason: "denied", status: 403, code: "revoked" },
    ]);
  });

  test("a code that isn't a short lowercase token is dropped", () => {
    vi.useFakeTimers();
    const { seen, say } = watch(served(false), false);
    say(status({ state: "blocked", reason: "denied", code: "<b>Revoked</b>" }));
    expect(seen).toEqual([{ state: "blocked", reason: "denied" }]);
  });

  test("a timeout stays a timeout; stop ends the watch", () => {
    vi.useFakeTimers();
    const late = watch(served(true), false);
    vi.advanceTimersByTime(5_000);
    late.say(status({ state: "blocked", reason: "denied" }));
    expect(late.seen).toEqual([{ state: "timeout" }]);
    const stopped = watch(served(false), false);
    stopped.load();
    vi.advanceTimersByTime(1_000);
    stopped.handle.stop();
    stopped.say(status({ state: "blocked", reason: "denied" }));
    expect(stopped.seen).toEqual([{ state: "loaded" }]);
  });
});

/** A shell's (or a view's) hello: Porthole's first word in every document that holds content. */
const hello = { jsonrpc: "2.0", id: "porthole-1", method: "ui/initialize", params: {} };
const SIGN_IN = { state: "blocked", reason: "sign-in", status: 401, code: "phish" };

describe("who may say how loading went (P124)", () => {
  test("an opaque frame's content that says it is blocked is never believed, and the host is told once", () => {
    vi.useFakeTimers();
    const { seen, refused, say, handle } = watch({ kind: "srcdoc", html: "" }, true);
    say(status(SIGN_IN));
    say(hello);
    handle.initialized();
    say(status({ state: "blocked", reason: "denied", code: "revoked" }));
    say({ method: FRAME_STATUS_METHOD, params: null });
    vi.advanceTimersByTime(10_000);
    expect(seen).toEqual([{ state: "loaded" }]);
    expect(refused).toEqual([UNTRUSTED_FRAME_STATUS]);
  });

  test("a served frame's first document that is a status page says how it went", () => {
    vi.useFakeTimers();
    const { seen, refused, say, load } = watch(served(true), true);
    say(status({ state: "blocked", reason: "denied", status: 403, code: "revoked" }));
    load();
    vi.advanceTimersByTime(10_000);
    expect(seen).toEqual([{ state: "blocked", reason: "denied", status: 403, code: "revoked" }]);
    expect(refused).toEqual([]);
  });

  test("a served shell's content, after the shell's hello, can't say it is blocked: before or after the handshake", () => {
    vi.useFakeTimers();
    const { seen, refused, say, load, handle } = watch(served(true), true);
    say(hello);
    // Before the host answered: the content runs after the shell spoke, never before.
    say(status(SIGN_IN));
    load();
    handle.initialized();
    say(status({ state: "blocked", reason: "denied", status: 403, code: "revoked" }));
    say(status({ state: "entering" }));
    vi.advanceTimersByTime(10_000);
    expect(seen).toEqual([{ state: "loaded" }]);
    expect(refused).toEqual([UNTRUSTED_FRAME_STATUS]);
  });

  test("a nested page's word, relayed by its shell after the page's hello, is the page's: not taken", () => {
    vi.useFakeTimers();
    // The shell's own words (porthole/shell/) never reach the watch (the platform takes them);
    // the page's hello, relayed, is the first thing it hears.
    const { seen, refused, say, load, handle } = watch(served(true), true);
    load();
    say(hello);
    handle.initialized();
    say(status(SIGN_IN));
    vi.advanceTimersByTime(10_000);
    expect(seen).toEqual([{ state: "loaded" }]);
    expect(refused).toEqual([UNTRUSTED_FRAME_STATUS]);
  });

  test("any other word counts as the frame speaking, a malformed one too", () => {
    vi.useFakeTimers();
    const { seen, refused, say } = watch(served(true), true);
    say({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 10 } });
    say(status(SIGN_IN));
    vi.advanceTimersByTime(5_000);
    expect(seen).toEqual([{ state: "timeout" }]);
    expect(refused).toEqual([UNTRUSTED_FRAME_STATUS]);
  });

  test("a url-mode app's frame status is still taken: it has no shell to speak first (THREAT_MODEL S6)", () => {
    vi.useFakeTimers();
    const { seen, refused, say, load } = watch(served(true), false);
    say(status({ state: "entering" }));
    load();
    load();
    say({ jsonrpc: "2.0", method: "app/anything" });
    say(status({ state: "blocked", reason: "denied", status: 403 }));
    expect(seen).toEqual([
      { state: "loaded" },
      { state: "blocked", reason: "denied", status: 403 },
    ]);
    expect(refused).toEqual([]);
  });
});

describe("createHost: a frame status from the content is a host error, never an outcome (P124)", () => {
  function display(config: PortholeConfig) {
    const listeners = new Set<(message: unknown) => void>();
    const platform: PlatformHost = {
      name: "stand-in",
      createSurface: () => ({
        transport: {
          send: () => {},
          listen: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          close: () => listeners.clear(),
        },
        element: null,
        setHeight: () => {},
        setColorScheme: () => {},
        userActivation: () => undefined,
        onNavigated: () => () => {},
        onLoad: () => () => {},
        destroy: () => {},
      }),
    };
    const container = {
      ownerDocument: {
        defaultView: { location: { origin: "https://app.example" }, navigator: { language: "en" } },
      },
      getBoundingClientRect: () => ({ width: 600 }),
    } as unknown as HTMLElement;
    const shown = createHost(config, { platform }).mount(container, {
      displayId: "d1",
      title: "Widget",
      scheme: "light",
    });
    const outcomes: FrameOutcome[] = [];
    const hostErrors: DisplayEvents["hostError"][] = [];
    const contentErrors: string[] = [];
    shown.on("outcome", (each) => outcomes.push(each));
    shown.on("hostError", (each) => hostErrors.push(each));
    shown.on("contentError", ({ message }) => contentErrors.push(message));
    return {
      shown,
      outcomes,
      hostErrors,
      contentErrors,
      say: (message: unknown) => [...listeners].forEach((each) => each(message)),
    };
  }

  test("an inline widget that says sign in shows nothing of it: the host hears a frame-status host error", () => {
    vi.useFakeTimers();
    const { shown, outcomes, hostErrors, contentErrors, say } = display(presets.inlineWidget());
    say(status(SIGN_IN));
    say(status(SIGN_IN));
    expect(outcomes).toEqual([]);
    expect(hostErrors).toEqual([{ message: UNTRUSTED_FRAME_STATUS, kind: "frame-status" }]);
    expect(contentErrors).toEqual([]);
    shown.destroy();
  });
});
