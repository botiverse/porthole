import { afterEach, describe, expect, it, vi } from "vitest";
import { LATE_NOTICE_MS, PAGE_OF_SET_MS, pagesOfSet } from "../src/host/pages-of-set.ts";
import type { Surface } from "../src/platform/types.ts";
import type { JsonRpcMessage } from "../src/protocol/jsonrpc.ts";

/**
 * Which loads of a frame are another page of its own set (P084, P098). On Chromium the leaving
 * page's `porthole/navigating` can reach the host after the next page's load, or never (a
 * cross-process `postMessage` is forwarded from a task of the sending document's; CI's trace of
 * `files.spec.ts:151`: `about` loaded, then the display started again at its spent ticket). The
 * arriving page says so too; a load waits LATE_NOTICE_MS for a notice naming the mounted version,
 * holding the frame meanwhile, and the wait ends in a restart unless one comes.
 */

const SET = { id: "site", version: "1" };

function frame() {
  const loads: (() => void)[] = [];
  const listeners: ((message: unknown) => void)[] = [];
  const sent: JsonRpcMessage[] = [];
  const surface: Surface = {
    transport: {
      send: (message) => void sent.push(message),
      listen: (listener) => {
        listeners.push(listener);
        return () => {};
      },
      close: () => {},
    },
    element: null,
    setHeight: () => {},
    setColorScheme: () => {},
    userActivation: () => undefined,
    onNavigated: (listener) => {
      loads.push(listener);
      return () => {};
    },
    onLoad: () => () => {},
    destroy: () => {},
  };
  return {
    surface,
    sent,
    load: () => loads.at(-1)?.(),
    say: (message: unknown) => {
      for (const listener of listeners) {
        listener(message);
      }
    },
  };
}

/** A frame's surface as a display sees it, what reached the display, and its restarts. */
function display(set: typeof SET | null = SET) {
  const raw = frame();
  let restarts = 0;
  const surface = pagesOfSet({ surface: raw.surface, set, away: () => void (restarts += 1) });
  const heard: unknown[] = [];
  surface.transport.listen((message) => heard.push(message));
  return { raw, surface, heard, restarts: () => restarts };
}

const notice = (url: string, more: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  method: "porthole/navigating",
  params: { url, ...more },
});
const leaving = (url: string) => notice(url, { set: SET });
const arriving = (url: string, set: unknown = SET) => notice(url, { arrived: true, set });
const call = { jsonrpc: "2.0", id: 7, method: "ui/open-link", params: { url: "https://x.test/" } };
const hello = { jsonrpc: "2.0", id: "porthole-shell-1", method: "ui/initialize", params: {} };

describe("pages of a set (P098)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes a load as a page of the set when its notice comes before it or after it", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    // Before (P084), the leaving page's; or the arriving page's alone (the leaving one lost).
    for (const first of [leaving("./about"), arriving("./about")]) {
      const each = display();
      each.raw.say(first);
      each.raw.load();
      vi.advanceTimersByTime(LATE_NOTICE_MS * 2);
      expect(each.restarts()).toBe(0);
    }
    // After: the frame is held until it comes, then all it said reaches the display, in order.
    for (const late of [leaving("./about"), arriving("./about")]) {
      const each = display();
      each.raw.load();
      each.raw.say(call);
      each.surface.transport.send({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {},
      });
      expect(each.heard).toEqual([]);
      expect(each.raw.sent).toEqual([]);
      vi.advanceTimersByTime(LATE_NOTICE_MS - 1);
      each.raw.say(late);
      expect(each.heard).toEqual([call, late]);
      expect(each.raw.sent).toHaveLength(1);
      vi.advanceTimersByTime(LATE_NOTICE_MS * 2);
      expect(each.restarts()).toBe(0);
    }
  });

  it("starts the display again when no notice for the mounted version came: nothing the frame said meanwhile reaches it", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const each = display();
    each.raw.load();
    each.raw.say(call);
    each.surface.transport.send({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: "x" },
    });
    vi.advanceTimersByTime(LATE_NOTICE_MS - 1);
    expect(each.restarts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(each.restarts()).toBe(1);
    // Never answered, never sent: what was held goes with the frame.
    expect(each.heard).toEqual([]);
    expect(each.raw.sent).toEqual([]);
  });

  it("ends the wait at once, started again, for another version's page, a page that won't say which, or a hello before any notice", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    for (const word of [
      arriving("./about", { id: "site", version: "2" }),
      arriving("./about", { id: "other", version: "1" }),
      notice("./about", { set: { id: "site", version: "2" } }),
      arriving("./about", null),
      notice("./about", { arrived: true }),
      hello,
    ]) {
      const each = display();
      each.raw.load();
      each.raw.say(word);
      expect(each.restarts(), JSON.stringify(word)).toBe(1);
      expect(each.heard).toEqual([]);
    }
    // And another version's notice is never taken for a load still to come.
    const each = display();
    each.raw.say(arriving("./about", { id: "site", version: "2" }));
    each.raw.load();
    vi.advanceTimersByTime(LATE_NOTICE_MS);
    expect(each.restarts()).toBe(1);
  });

  it("never turns the wait into no restart: more loads don't put it off; a shell's notice that names no version can't end it", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const each = display();
    each.raw.load();
    vi.advanceTimersByTime(LATE_NOTICE_MS - 100);
    each.raw.load();
    each.raw.load();
    // A notice from a shell before P098 (no version): taken only for a load still to come.
    each.raw.say(notice("./about"));
    vi.advanceTimersByTime(100);
    expect(each.restarts()).toBe(1);
    // Before a load it is still taken, as it was (P084), for ten seconds.
    const old = display();
    old.raw.say(notice("./about"));
    vi.advanceTimersByTime(PAGE_OF_SET_MS - 1);
    old.raw.load();
    vi.advanceTimersByTime(LATE_NOTICE_MS);
    expect(old.restarts()).toBe(0);
  });

  it("takes a late copy of the notice for the page the frame is on as no new one", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const each = display();
    each.raw.say(leaving("./about"));
    each.raw.load();
    // about's own word, late: not a grant for the next load.
    each.raw.say(arriving("./about"));
    expect(each.heard).toEqual([leaving("./about")]);
    each.raw.load();
    vi.advanceTimersByTime(LATE_NOTICE_MS);
    expect(each.restarts()).toBe(1);
  });

  it("in a display whose pages never come with files, every load after the first starts it again at once", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const each = display(null);
    each.raw.say(arriving("./about"));
    each.raw.load();
    expect(each.restarts()).toBe(1);
  });
});
