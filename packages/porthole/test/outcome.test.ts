import { afterEach, describe, expect, test, vi } from "vitest";
import { watchOutcome } from "../src/host/outcome.ts";
import type { FrameOutcome } from "../src/host/types.ts";
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
  const handle = watchOutcome({
    surface: fake.surface,
    source,
    speaks,
    timeoutMs: 5_000,
    onOutcome: (each) => seen.push(each),
  });
  return { ...fake, seen, handle };
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
