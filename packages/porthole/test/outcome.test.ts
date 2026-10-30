import { afterEach, describe, expect, test, vi } from "vitest";
import { UNTRUSTED_FRAME_STATUS, watchOutcome } from "../src/host/outcome.ts";
import type { DisplayEvents, FrameOutcome } from "../src/host/types.ts";
import { createHost, presets, type PlatformHost, type PortholeConfig } from "../src/index.ts";
import { NO_DOOR, REUSED_LOCATION } from "../src/host/create-host.ts";
import { LocateError } from "../src/host/locator.ts";
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

function watch(source: FrameSource, speaks: boolean, nested = false) {
  const fake = fakeSurface();
  const seen: FrameOutcome[] = [];
  const refused: string[] = [];
  const handle = watchOutcome({
    surface: fake.surface,
    source,
    speaks,
    nested,
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

  test("a nested page's shell that loaded without a word never ran either", () => {
    vi.useFakeTimers();
    const { seen, load } = watch(served(true), true, true);
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

  test("a nested page's frame's first document that is a status page says how it went", () => {
    vi.useFakeTimers();
    const { seen, refused, say, load } = watch(served(true), true, true);
    say(status({ state: "blocked", reason: "denied", status: 403, code: "revoked" }));
    load();
    vi.advanceTimersByTime(10_000);
    expect(seen).toEqual([{ state: "blocked", reason: "denied", status: 403, code: "revoked" }]);
    expect(refused).toEqual([]);
  });

  test("a served shell's content, after the shell's hello, can't say it is blocked: before or after the handshake", () => {
    vi.useFakeTimers();
    const { seen, refused, say, load, handle } = watch(served(true), true, true);
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
    const { seen, refused, say, load, handle } = watch(served(true), true, true);
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
    const { seen, refused, say } = watch(served(true), true, true);
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

describe("a served display that isn't nested takes no frame status from its frame (P125)", () => {
  test("its frame's status is dropped, even as the first word, and the host is told once", () => {
    vi.useFakeTimers();
    const { seen, refused, say, load, handle } = watch(served(true), true);
    say(status(SIGN_IN));
    say(status({ state: "blocked", reason: "denied", status: 403, code: "revoked" }));
    say(hello);
    load();
    handle.initialized();
    vi.advanceTimersByTime(10_000);
    expect(seen).toEqual([{ state: "loaded" }]);
    expect(refused).toEqual([UNTRUSTED_FRAME_STATUS]);
  });

  test("a load from which nothing spoke is a timeout, decided early, never framing", () => {
    vi.useFakeTimers();
    const { seen, load } = watch(served(true), true);
    load();
    vi.advanceTimersByTime(399);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([{ state: "timeout" }]);
    vi.advanceTimersByTime(10_000);
    expect(seen).toEqual([{ state: "timeout" }]);
  });

  test("a load after which only frame statuses came is a timeout too", () => {
    vi.useFakeTimers();
    const { seen, refused, say, load } = watch(served(true), true);
    say(status({ state: "blocked", reason: "denied", status: 403 }));
    load();
    vi.advanceTimersByTime(1_000);
    expect(seen).toEqual([{ state: "timeout" }]);
    expect(refused).toEqual([UNTRUSTED_FRAME_STATUS]);
  });

  test("a frame that spoke before its load isn't timed out early", () => {
    vi.useFakeTimers();
    const { seen, say, load, handle } = watch(served(true), true);
    say(hello);
    load();
    vi.advanceTimersByTime(1_000);
    expect(seen).toEqual([]);
    handle.initialized();
    expect(seen).toEqual([{ state: "loaded" }]);
  });

  test("a door's word in a frame is no entry page's: an app isn't loaded by it", () => {
    vi.useFakeTimers();
    const url = watch(served(true), false);
    url.say(status({ state: "open" }));
    url.load();
    url.load();
    vi.advanceTimersByTime(1_000);
    expect(url.seen).toEqual([]);
    vi.advanceTimersByTime(5_000);
    expect(url.seen).toEqual([{ state: "timeout" }]);
  });

  test("url mode and opaque frames are as before", () => {
    vi.useFakeTimers();
    const app = watch(served(true), false);
    app.say(status({ state: "blocked", reason: "sign-in", status: 401 }));
    expect(app.seen).toEqual([{ state: "blocked", reason: "sign-in", status: 401 }]);
    const opaque = watch({ kind: "srcdoc", html: "" }, true);
    opaque.say(status(SIGN_IN));
    opaque.load();
    vi.advanceTimersByTime(1_000);
    expect(opaque.seen).toEqual([]);
    expect(opaque.refused).toEqual([UNTRUSTED_FRAME_STATUS]);
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

/** A platform whose door and content surfaces the test drives. */
function harness(withDoor = true, locate?: () => Promise<unknown>) {
  const made: { door?: Harnessed; content?: Harnessed } = {};
  interface Harnessed {
    say(message: unknown): void;
    load(): void;
    destroyed: boolean;
  }
  const surface = (): Harnessed & {
    transport: {
      send: () => void;
      listen: (l: (m: unknown) => void) => () => void;
      close: () => void;
    };
    onLoad: (l: () => void) => () => void;
  } => {
    const listeners = new Set<(m: unknown) => void>();
    const loads = new Set<() => void>();
    const h = {
      destroyed: false,
      say: (m: unknown) => listeners.forEach((each) => each(m)),
      load: () => loads.forEach((each) => each()),
      transport: {
        send: () => {},
        listen: (l: (m: unknown) => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        close: () => listeners.clear(),
      },
      onLoad: (l: () => void) => {
        loads.add(l);
        return () => loads.delete(l);
      },
    };
    return h;
  };
  const platform: PlatformHost = {
    name: "stand-in",
    createSurface: () => {
      const s = surface();
      made.content = s;
      return {
        transport: s.transport,
        element: null,
        setHeight: () => {},
        setColorScheme: () => {},
        userActivation: () => undefined,
        onNavigated: () => () => {},
        onLoad: s.onLoad,
        destroy: () => {
          s.destroyed = true;
        },
      };
    },
    ...(withDoor
      ? {
          createDoor: (_c: HTMLElement, _spec: { url: string }) => {
            const s = surface();
            made.door = s;
            return {
              transport: s.transport,
              element: null,
              onLoad: s.onLoad,
              destroy: () => {
                s.destroyed = true;
              },
            };
          },
        }
      : {}),
  };
  const container = {
    ownerDocument: {
      defaultView: { location: { origin: "https://app.example" }, navigator: { language: "en" } },
    },
    getBoundingClientRect: () => ({ width: 600 }),
  } as unknown as HTMLElement;
  const config = presets.artifact({
    isolation: "domain",
    contentOrigins: ["https://*.example-usercontent.com"],
  });
  const locator = {
    locate:
      (locate as (() => Promise<never>) | undefined) ??
      (() =>
        Promise.resolve({
          kind: "url" as const,
          url: "https://a-x.example-usercontent.com/__porthole/d/aaaaaaaaaaaaaaaa?ticket=t",
          origin: "https://a-x.example-usercontent.com",
          reports: true,
          ...(withDoor
            ? {
                door: {
                  url: "https://a-x.example-usercontent.com/__porthole/door/aaaaaaaaaaaaaaaa?ticket=d",
                },
              }
            : {}),
        })),
  };
  const outcomes: FrameOutcome[] = [];
  const hostErrors: DisplayEvents["hostError"][] = [];
  const shown = createHost(config, { platform, locator }).mount(container, {
    displayId: "d1",
    title: "Artifact",
    scheme: "light",
    instance: { scope: "s", document: { kind: "artifact", id: "p", version: "1" } },
  });
  shown.on("outcome", (each) => outcomes.push(each));
  shown.on("hostError", (each) => hostErrors.push(each));
  return { made, outcomes, hostErrors, shown };
}

/** The door harness, its locator answering as `locate` does (P125). */
const harnessOf = (locate: () => Promise<unknown>) => harness(true, locate);

describe("createHost: a served display's door decides, before the content frame (P125)", () => {
  test("the door opens, then the content frame is made and loads", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.made.door).toBeDefined());
    expect(h.made.content, "no content frame before the door opens").toBeUndefined();
    h.made.door!.say(status({ state: "open" }));
    expect(h.made.door!.destroyed, "the door is removed once it opened").toBe(true);
    await vi.waitFor(() => expect(h.made.content).toBeDefined());
    h.made.content!.load();
    // The content's handshake loads it.
    h.shown.destroy();
  });

  test("the door blocks: the outcome is the block, and no content frame is made", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.made.door).toBeDefined());
    h.made.door!.say(status({ state: "blocked", reason: "denied", status: 403, code: "revoked" }));
    expect(h.outcomes).toEqual([
      { state: "blocked", reason: "denied", status: 403, code: "revoked" },
    ]);
    expect(h.made.content, "no content frame after a door block").toBeUndefined();
    expect(h.made.door!.destroyed).toBe(true);
    h.shown.destroy();
  });

  test("a served non-nested location without a door (an old server, a clean address) is refused before any frame: blocked locate, and a door host error naming the fix", async () => {
    const h = harness(false);
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));
    expect(h.outcomes).toEqual([{ state: "blocked", reason: "locate" }]);
    expect(h.made.door, "no door frame").toBeUndefined();
    expect(h.made.content, "no content frame").toBeUndefined();
    expect(h.hostErrors).toEqual([{ message: NO_DOOR, kind: "door" }]);
    expect(NO_DOOR).toMatch(/door from issue/u);
    expect(NO_DOOR).toMatch(/client\.resolve/u);
    h.shown.destroy();
  });

  test("a platform that makes no doors frames no served display that isn't nested", async () => {
    const h = harness(true);
    // The same harness, without createDoor: a platform of a host's own that predates P125.
    h.shown.destroy();
    const listeners = new Set<(message: unknown) => void>();
    let surfaces = 0;
    const platform: PlatformHost = {
      name: "no doors",
      createSurface: () => {
        surfaces += 1;
        return {
          transport: {
            send: () => {},
            listen: (l) => (listeners.add(l), () => listeners.delete(l)),
            close: () => {},
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
        defaultView: { location: { origin: "https://app.example" }, navigator: { language: "en" } },
      },
      getBoundingClientRect: () => ({ width: 600 }),
    } as unknown as HTMLElement;
    const kinds: string[] = [];
    const outcomes: FrameOutcome[] = [];
    const shown = createHost(
      presets.artifact({
        isolation: "domain",
        contentOrigins: ["https://*.example-usercontent.com"],
      }),
      {
        platform,
        locator: {
          locate: () =>
            Promise.resolve({
              url: "https://a-x.example-usercontent.com/__porthole/d/aaaaaaaaaaaaaaaa?ticket=t",
              origin: "https://a-x.example-usercontent.com",
              door: { url: "https://a-x.example-usercontent.com/__porthole/door/k?ticket=d" },
            }),
        },
      },
    ).mount(container, {
      displayId: "d1",
      title: "Artifact",
      scheme: "light",
      instance: { scope: "s", document: { kind: "artifact", id: "p", version: "1" } },
    });
    shown.on("hostError", ({ kind }) => kinds.push(kind));
    shown.on("outcome", (each) => outcomes.push(each));
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes).toEqual([{ state: "blocked", reason: "locate" }]);
    expect(kinds).toEqual(["door"]);
    expect(surfaces).toBe(0);
    shown.destroy();
  });
});

describe("createHost: the host's issue endpoint refused, before any frame (P125)", () => {
  const refused = (answered: number, code: string, reason?: string) => () =>
    Promise.reject(new LocateError("refused", answered, code, reason));

  test("401, 403 (with the host's own reason code) and 404 are sign-in, denied and not-found: the host's word, no host error, no frame", async () => {
    for (const [locate, expected] of [
      [refused(401, "unauthenticated"), { state: "blocked", reason: "sign-in", status: 401 }],
      [
        refused(403, "forbidden", "revoked"),
        { state: "blocked", reason: "denied", status: 403, code: "revoked" },
      ],
      [refused(403, "forbidden"), { state: "blocked", reason: "denied", status: 403 }],
      [refused(404, "not-found"), { state: "blocked", reason: "not-found", status: 404 }],
    ] as const) {
      const h = harnessOf(locate);
      await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));
      expect(h.outcomes).toEqual([expected]);
      expect(h.hostErrors, "a refusal is no host failure").toEqual([]);
      expect(h.made.door).toBeUndefined();
      expect(h.made.content).toBeUndefined();
      h.shown.destroy();
    }
  });

  test("a reason that isn't a short lowercase token never becomes a code", async () => {
    const h = harnessOf(refused(403, "forbidden", "<b>Nope</b>"));
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));
    expect(h.outcomes).toEqual([{ state: "blocked", reason: "denied", status: 403 }]);
    h.shown.destroy();
  });

  test("a 500, a network failure or a malformed answer is the host's own failure (locate), never denied", async () => {
    for (const locate of [
      refused(500, "failed"),
      refused(503, "not-served"),
      refused(429, "rate-limited"),
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => Promise.resolve({ url: 42 }),
    ]) {
      const h = harnessOf(locate);
      await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));
      expect(h.outcomes).toEqual([{ state: "blocked", reason: "locate" }]);
      expect(h.hostErrors.map((each) => each.kind)).toEqual(["locate"]);
      h.shown.destroy();
    }
  });

  test("a backend that never answers is a timeout", async () => {
    vi.useFakeTimers();
    const h = harnessOf(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.outcomes).toEqual([{ state: "timeout" }]);
    expect(h.hostErrors.map((each) => each.kind)).toEqual(["locate"]);
    h.shown.destroy();
  });
});

describe("createHost: every restart goes through a new door, with a new ticket (P125)", () => {
  interface Driven {
    readonly url: string;
    destroyed: boolean;
    say(message: unknown): void;
    load(): void;
    /** The platform's word that the frame loaded a second document (P031): a restart. */
    navigate(): void;
  }

  function driven(url: string): Driven & {
    readonly transport: Surface["transport"];
    readonly onLoad: (listener: () => void) => () => void;
    readonly onNavigated: (listener: () => void) => () => void;
  } {
    const listeners = new Set<(message: unknown) => void>();
    const loads = new Set<() => void>();
    const navigations = new Set<() => void>();
    return {
      url,
      destroyed: false,
      say: (message) => [...listeners].forEach((each) => each(message)),
      load: () => [...loads].forEach((each) => each()),
      navigate: () => [...navigations].forEach((each) => each()),
      transport: {
        send: () => {},
        listen: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: () => listeners.clear(),
      },
      onLoad: (listener) => {
        loads.add(listener);
        return () => loads.delete(listener);
      },
      onNavigated: (listener) => {
        navigations.add(listener);
        return () => navigations.delete(listener);
      },
    };
  }

  const ORIGIN = "https://a-x.example-usercontent.com";

  function mounted(reuse = false) {
    const doors: Driven[] = [];
    const contents: Driven[] = [];
    let located = 0;
    const platform: PlatformHost = {
      name: "stand-in",
      createSurface: (_container, spec) => {
        const each = driven(spec.source.kind === "url" ? spec.source.url : "srcdoc");
        contents.push(each);
        return {
          transport: each.transport,
          element: null,
          setHeight: () => {},
          setColorScheme: () => {},
          userActivation: () => undefined,
          onNavigated: each.onNavigated,
          onLoad: each.onLoad,
          destroy: () => {
            each.destroyed = true;
          },
        };
      },
      createDoor: (_container, spec) => {
        const each = driven(spec.url);
        doors.push(each);
        return {
          transport: each.transport,
          element: null,
          onLoad: each.onLoad,
          destroy: () => {
            each.destroyed = true;
          },
        };
      },
    };
    // A host's locator issues afresh on every run: a new content ticket and a new door ticket.
    const locator = {
      locate: () => {
        // A locator that memoizes (`reuse`): every run gets the first run's location.
        located = reuse ? 1 : located + 1;
        return Promise.resolve({
          url: `${ORIGIN}/__porthole/d/aaaaaaaaaaaaaaaa?ticket=content-${located}`,
          origin: ORIGIN,
          reports: true,
          door: { url: `${ORIGIN}/__porthole/door/aaaaaaaaaaaaaaaa?ticket=door-${located}` },
        });
      },
    };
    const container = {
      ownerDocument: {
        defaultView: { location: { origin: "https://app.example" }, navigator: { language: "en" } },
      },
      getBoundingClientRect: () => ({ width: 600 }),
    } as unknown as HTMLElement;
    const config = presets.inlineWidget({
      isolation: "domain",
      contentOrigins: ["https://*.example-usercontent.com"],
    });
    const outcomes: FrameOutcome[] = [];
    const shown = createHost(config, { platform, locator }).mount(container, {
      displayId: "d1",
      title: "Widget",
      scheme: "light",
      instance: { scope: "s", document: { kind: "shell", preset: "inlineWidget" } },
    });
    shown.on("outcome", (each) => outcomes.push(each));
    const hostErrors: DisplayEvents["hostError"][] = [];
    shown.on("hostError", (each) => hostErrors.push(each));
    return { doors, contents, outcomes, hostErrors, shown };
  }

  test("a locator that gives a restart the location an earlier run used is told to the host; nothing else changes", async () => {
    const { doors, contents, hostErrors, shown } = mounted(true);
    await vi.waitFor(() => expect(doors).toHaveLength(1));
    doors[0]?.say(status({ state: "open" }));
    expect(hostErrors, "a first run is no reuse").toEqual([]);
    contents[0]?.navigate();
    await vi.waitFor(() => expect(doors).toHaveLength(2));
    expect(hostErrors).toEqual([{ message: REUSED_LOCATION, kind: "locate" }]);
    // The run goes on as it would: the same door address, whose word is the server's.
    expect(doors[1]?.url).toBe(doors[0]?.url);
    doors[1]?.say(status({ state: "blocked", reason: "session", status: 401 }));
    expect(contents).toHaveLength(1);
    shown.destroy();
  });

  test("a restart (the frame's second load) makes a new door frame with the new ticket, and no content frame before it opens", async () => {
    const { doors, contents, shown } = mounted();
    await vi.waitFor(() => expect(doors).toHaveLength(1));
    expect(doors[0]?.url).toBe(`${ORIGIN}/__porthole/door/aaaaaaaaaaaaaaaa?ticket=door-1`);
    expect(contents, "no content frame before the first door opens").toHaveLength(0);
    doors[0]?.say(status({ state: "open" }));
    expect(doors[0]?.destroyed, "the first door is gone once it opened").toBe(true);
    expect(contents).toHaveLength(1);
    expect(contents[0]?.url).toBe(`${ORIGIN}/__porthole/d/aaaaaaaaaaaaaaaa?ticket=content-1`);

    // The content navigates its frame away: the platform tells the second load (P031).
    contents[0]?.navigate();
    expect(contents[0]?.destroyed, "the old content frame is destroyed on the restart").toBe(true);
    await vi.waitFor(() => expect(doors).toHaveLength(2));
    expect(doors[1]?.url, "the restart's door carries the second door ticket").toBe(
      `${ORIGIN}/__porthole/door/aaaaaaaaaaaaaaaa?ticket=door-2`,
    );
    expect(doors[1]).not.toBe(doors[0]);
    expect(contents, "no new content frame before the new door opens").toHaveLength(1);

    doors[1]?.say(status({ state: "open" }));
    expect(doors[1]?.destroyed).toBe(true);
    expect(contents).toHaveLength(2);
    expect(contents[1]?.url, "the restart's content carries the second content ticket").toBe(
      `${ORIGIN}/__porthole/d/aaaaaaaaaaaaaaaa?ticket=content-2`,
    );
    shown.destroy();
  });

  test("a restart's door that blocks makes no content frame at all", async () => {
    const { doors, contents, outcomes, shown } = mounted();
    await vi.waitFor(() => expect(doors).toHaveLength(1));
    doors[0]?.say(status({ state: "open" }));
    contents[0]?.navigate();
    await vi.waitFor(() => expect(doors).toHaveLength(2));
    doors[1]?.say(status({ state: "blocked", reason: "session", status: 401 }));
    expect(outcomes).toEqual([{ state: "blocked", reason: "session", status: 401 }]);
    expect(contents, "no content frame after the restart's door blocked").toHaveLength(1);
    shown.destroy();
  });
});
