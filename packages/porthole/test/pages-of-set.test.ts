import { afterEach, describe, expect, it, vi } from "vitest";
import { HELD_MOST, LATE_NOTICE_MS, PAGE_OF_SET_MS, pagesOfSet } from "../src/host/pages-of-set.ts";
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
  const pages: string[] = [];
  const surface = pagesOfSet({
    surface: raw.surface,
    set,
    away: () => void (restarts += 1),
    page: (url) => void pages.push(url),
  });
  const heard: unknown[] = [];
  surface.transport.listen((message) => heard.push(message));
  return { raw, surface, heard, restarts: () => restarts, pages };
}

const notice = (url: string, more: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  method: "porthole/navigating",
  params: { url, ...more },
});
const leaving = (url: string) => notice(url, { set: SET });
const arriving = (url: string, set: unknown = SET) => notice(url, { arrived: true, set });
const stayed = (url: string, set: unknown = SET) => notice(url, { same: true, set });
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

  // After the review of P098: the host hears the frame's load only once its images and modules
  // have loaded, so an arriving page's word can come seconds before its load (reproduced: the
  // notice, then the load 2.5 s later, restarted).
  it("takes the arriving page's notice for its load however late it comes, up to the leaving page's ten seconds", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const slow = display();
    slow.raw.say(arriving("./about"));
    vi.advanceTimersByTime(2_500);
    slow.raw.load();
    vi.advanceTimersByTime(LATE_NOTICE_MS * 2);
    expect(slow.restarts()).toBe(0);
    // No longer than P084 grants the leaving page's.
    const late = display();
    late.raw.say(arriving("./about"));
    vi.advanceTimersByTime(PAGE_OF_SET_MS);
    late.raw.load();
    vi.advanceTimersByTime(LATE_NOTICE_MS);
    expect(late.restarts()).toBe(1);
  });

  it("holds no more than HELD_MOST messages either way during a wait: past them, the display starts again", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const said = display();
    said.raw.load();
    for (let each = 0; each < HELD_MOST; each += 1) {
      said.raw.say({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height: each },
      });
    }
    expect(said.restarts()).toBe(0);
    said.raw.say({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 0 },
    });
    expect(said.restarts()).toBe(1);
    expect(said.heard).toEqual([]);
    const sent = display();
    sent.raw.load();
    for (let each = 0; each <= HELD_MOST; each += 1) {
      sent.surface.transport.send({
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: "x" },
      });
    }
    expect(sent.restarts()).toBe(1);
    expect(sent.raw.sent).toEqual([]);
  });

  it("in a display whose pages never come with files, every load after the first starts it again at once", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const each = display(null);
    each.raw.say(arriving("./about"));
    each.raw.load();
    expect(each.restarts()).toBe(1);
  });
});

/**
 * A navigation within a page's document (P142): WebKit fires the frame's load for the first one
 * (a link to `#bottom`; measured on 18.2 and 26.6: no request, the document and its globals kept),
 * after the frame's word on 26.6 and before it on 18.2. The page says it stayed (`same`).
 */
describe("a page that stayed (P142)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes a load as the page that stayed when its word comes before it or after it", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const before = display();
    before.raw.say(stayed("./#bottom"));
    before.raw.load();
    vi.advanceTimersByTime(LATE_NOTICE_MS * 2);
    expect(before.restarts()).toBe(0);
    const after = display();
    after.raw.load();
    after.raw.say(call);
    vi.advanceTimersByTime(LATE_NOTICE_MS - 1);
    after.raw.say(stayed("./#bottom"));
    expect(after.heard).toEqual([call, stayed("./#bottom")]);
    vi.advanceTimersByTime(LATE_NOTICE_MS * 2);
    expect(after.restarts()).toBe(0);
  });

  it("says so at every navigation within the page, the same address again too: each may come with a load", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const each = display();
    for (let at = 0; at < 3; at += 1) {
      each.raw.say(stayed("./#bottom"));
      each.raw.load();
      vi.advanceTimersByTime(LATE_NOTICE_MS * 2);
    }
    expect(each.restarts()).toBe(0);
  });

  it("is no word for a page to come: a load past LATE_NOTICE_MS waits, and starts the display again", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const each = display();
    each.raw.say(stayed("./#bottom"));
    vi.advanceTimersByTime(LATE_NOTICE_MS);
    each.raw.load();
    vi.advanceTimersByTime(LATE_NOTICE_MS);
    expect(each.restarts()).toBe(1);
  });

  it("never shortens a page's word already given", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const each = display();
    each.raw.say(leaving("./about"));
    each.raw.say(stayed("./#bottom"));
    vi.advanceTimersByTime(LATE_NOTICE_MS * 2);
    each.raw.load();
    vi.advanceTimersByTime(LATE_NOTICE_MS * 2);
    expect(each.restarts()).toBe(0);
  });

  it("ends the wait at once, started again, for another version's page or one that won't say which", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    for (const word of [
      stayed("./#bottom", { id: "site", version: "2" }),
      stayed("./#bottom", null),
      notice("./#bottom", { same: true }),
    ]) {
      const each = display();
      each.raw.load();
      each.raw.say(word);
      expect(each.restarts(), JSON.stringify(word)).toBe(1);
    }
  });

  it("in a display whose pages never come with files, a load after the first starts it again at once, as before", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const each = display(null);
    each.raw.say(stayed("./#bottom"));
    each.raw.load();
    expect(each.restarts()).toBe(1);
  });
});

describe("which page of the set the frame is on (P156)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is each load taken for a page's notice, and each arriving page's own word, whenever it comes", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    // The leaving page's word, then the load: that page, at the load (not as the word comes: the
    // navigation may never happen).
    const before = display();
    before.raw.say(leaving("./about"));
    expect(before.pages).toEqual([]);
    before.raw.load();
    expect(before.pages).toEqual(["./about"]);
    // The arriving page's, before its load or after it (its document is the one in the frame).
    const arrived = display();
    arrived.raw.say(arriving("./about"));
    expect(arrived.pages).toEqual(["./about"]);
    arrived.raw.load();
    expect(arrived.pages).toEqual(["./about", "./about"]);
    // A load that waits, then the leaving page's late word, or the arriving page's.
    for (const late of [leaving("./about"), arriving("./about")]) {
      const each = display();
      each.raw.load();
      expect(each.pages).toEqual([]);
      each.raw.say(late);
      expect(each.pages).toEqual(["./about"]);
    }
    // Back: each page as it comes, the entry by its own address.
    const back = display();
    back.raw.say(leaving("./about"));
    back.raw.load();
    back.raw.say(leaving("./"));
    back.raw.load();
    expect(back.pages).toEqual(["./about", "./"]);
  });

  it("is not a navigation within the page, nor a word no load took, nor another version's page", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    // A document that stayed (P142), its load taken or not.
    const stays = display();
    stays.raw.say(stayed("./#bottom"));
    stays.raw.load();
    stays.raw.load();
    stays.raw.say(stayed("./#bottom"));
    expect(stays.pages).toEqual([]);
    expect(stays.restarts()).toBe(0);
    // A leaving page's word with no load in time: nothing.
    const unused = display();
    unused.raw.say(leaving("./about"));
    vi.advanceTimersByTime(PAGE_OF_SET_MS + 1);
    expect(unused.pages).toEqual([]);
    // Another version's, or one that won't say which: never this display's page.
    for (const word of [
      arriving("./about", { id: "site", version: "2" }),
      arriving("./about", null),
      notice("./about"),
    ]) {
      const each = display();
      each.raw.say(word);
      each.raw.load();
      expect(each.pages, JSON.stringify(word)).toEqual([]);
    }
    // A display whose pages never come with files has none.
    const single = display(null);
    single.raw.say(arriving("./about"));
    expect(single.pages).toEqual([]);
  });
});
