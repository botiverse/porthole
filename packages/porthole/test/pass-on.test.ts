import { describe, expect, test } from "vitest";
import { LIBRARY_CDNS, mayPassOn, presets, type PageDeclaration } from "../src/index.ts";

/**
 * `mayPassOn` (P112, after the review): "a page with a channel gets no drafts", as a function a
 * host can call. Each channel alone makes it true; without one, false.
 */

type Options = NonNullable<Parameters<typeof presets.artifact>[0]>;
const base = (extra: Options = {}) =>
  presets.artifact({ runtime: "1", egress: LIBRARY_CDNS, ...extra });
const declaring = (capabilities: PageDeclaration["capabilities"]): PageDeclaration => ({
  capabilities,
  runtime: "1",
});

describe("mayPassOn (P112)", () => {
  test("no channel: the built-ins that stay with the person, user, annotations, the library CDNs", () => {
    const quiet = base({
      capabilities: { comments: {}, copyText: {}, downloadFile: {}, user: {}, annotate: {} },
    });
    expect(mayPassOn(quiet, declaring({ user: {} }))).toBe(false);
    expect(mayPassOn(quiet, declaring({}))).toBe(false);
    expect(mayPassOn(quiet, null)).toBe(false);
    // Errors to the app alone carry nothing on.
    expect(
      mayPassOn(base({ capabilities: { reportError: {} }, errors: "host" }), declaring({})),
    ).toBe(false);
  });

  test("a store others read, declared: db (with user or without), a new version, the asset library", () => {
    const stores = base({
      isolation: "domain",
      contentOrigins: ["https://*.example-usercontent.com"],
      capabilities: { db: {}, artifact: {}, assets: {}, user: {} },
    });
    expect(mayPassOn(stores, declaring({ db: {} }))).toBe(true);
    expect(mayPassOn(stores, declaring({ db: {}, user: {} }))).toBe(true);
    expect(mayPassOn(stores, declaring({ artifact: {} }))).toBe(true);
    expect(mayPassOn(stores, declaring({ assets: {} }))).toBe(true);
    // Offered, not declared: out of the page's reach.
    expect(mayPassOn(stores, declaring({ user: {} }))).toBe(false);
    // A page from before 0.7 reaches all the config declares.
    expect(mayPassOn(stores, null)).toBe(true);
  });

  test("openLink, a built-in: a URL with the draft in it, whatever the page declares", () => {
    expect(mayPassOn(base({ capabilities: { openLink: {} } }), declaring({}))).toBe(true);
  });

  test("the agent and the host's data services: sendPrompt, setModelContext, callTool, readData, subscribeData, and errors sent to the agent", () => {
    const agent = base({
      capabilities: { sendPrompt: {}, setModelContext: {}, callTool: {}, readData: {} },
    });
    expect(mayPassOn(agent, declaring({ chat: {} }))).toBe(true);
    expect(mayPassOn(agent, declaring({ context: {} }))).toBe(true);
    expect(mayPassOn(agent, declaring({ data: {} }))).toBe(true);
    expect(mayPassOn(agent, declaring({}))).toBe(false);
    const live = presets.artifact({ capabilities: { readData: {}, subscribeData: {} } });
    expect(mayPassOn(live, null)).toBe(true);
    // subscribeData alone, through the data family the page declared.
    expect(
      mayPassOn(
        base({ capabilities: { readData: {}, subscribeData: {} } }),
        declaring({ data: {} }),
      ),
    ).toBe(true);
    expect(
      mayPassOn(base({ capabilities: { reportError: {} }, errors: "agent" }), declaring({})),
    ).toBe(true);
  });

  test("the network beyond the library CDNs: a connection, any https site, an origin the host added", () => {
    expect(mayPassOn(base({ egress: { connect: ["https://api.example.com"] } }), null)).toBe(true);
    expect(mayPassOn(base({ egress: { anyHttps: ["img"] } }), null)).toBe(true);
    expect(mayPassOn(base({ egress: { img: ["https://images.example.com"] } }), null)).toBe(true);
  });
});
