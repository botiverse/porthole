import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { FRAME_STATUS_METHOD } from "../src/isolation/types.ts";
import { ENTER_SCRIPT_PATH, pageScript, STATUS_SCRIPT_PATH } from "../src/server/pages.ts";

/**
 * The server's pages tell the page that frames them how loading went, at each host origin. A
 * desktop app's own scheme (`ferry://app`) is no target origin a browser takes: posting to it
 * throws, and that must never stop the page (#5, P070).
 */

const script = async (path: string): Promise<string> => (await pageScript(path)?.text()) ?? "";

/** A browser's postMessage: a target origin it can't parse as a web origin throws. */
function parentWindow(posted: [unknown, string][]) {
  return {
    postMessage(message: unknown, origin: string) {
      if (origin !== "*" && !/^https?:\/\/[^/]+$/u.test(origin)) {
        throw new SyntaxError(
          `Failed to execute 'postMessage' on 'Window': Invalid target origin '${origin}'`,
        );
      }
      posted.push([message, origin]);
    },
  };
}

/** Runs a page script against a fake page whose main element has `data` and `parts`. */
function run(
  code: string,
  hosts: readonly string[],
  ancestors: readonly string[] | undefined,
  extra: { fetch?: () => Promise<{ ok: boolean }>; dataset?: Record<string, string> } = {},
) {
  const posted: [unknown, string][] = [];
  const parent = parentWindow(posted);
  const texts: Record<string, string> = {};
  const main = {
    dataset: { portholeHosts: JSON.stringify(hosts), ...extra.dataset },
    querySelector: (selector: string) => ({
      set textContent(value: string) {
        texts[selector] = value;
      },
    }),
  };
  const replaced: string[] = [];
  const page = {
    querySelector: () => main,
    readyState: "complete",
  };
  runInNewContext(code, {
    window: { parent },
    document: page,
    location: {
      ...(ancestors === undefined ? {} : { ancestorOrigins: ancestors }),
      replace: (to: string) => replaced.push(to),
    },
    fetch: extra.fetch ?? (() => Promise.resolve({ ok: true })),
    addEventListener: () => undefined,
    setTimeout: (resolve: () => void) => resolve(),
  });
  return { posted, texts, replaced };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("the pages' frame status (#5)", () => {
  const blocked = { portholeReason: "cookies", portholeStatus: "401" };

  it("a custom-scheme host origin doesn't stop the word reaching a web host", async () => {
    const { posted } = run(
      await script(STATUS_SCRIPT_PATH),
      ["https://app.example", "ferry://app"],
      ["https://app.example"],
      { dataset: blocked },
    );
    expect(posted).toEqual([
      [
        {
          jsonrpc: "2.0",
          method: FRAME_STATUS_METHOD,
          params: { state: "blocked", reason: "cookies", status: 401 },
        },
        "https://app.example",
      ],
    ]);
  });

  it("framed by the desktop app itself, the word goes to its parent (frame-ancestors holds it there)", async () => {
    const { posted } = run(
      await script(STATUS_SCRIPT_PATH),
      ["https://app.example", "ferry://app"],
      ["ferry://app"],
      { dataset: blocked },
    );
    expect(posted.map(([, origin]) => origin)).toEqual(["https://app.example", "*"]);
  });

  it("where the parent can't be told (no ancestorOrigins), both; with web hosts only, never *", async () => {
    const unknown = run(
      await script(STATUS_SCRIPT_PATH),
      ["https://app.example", "ferry://app"],
      undefined,
      { dataset: blocked },
    );
    expect(unknown.posted.map(([, origin]) => origin)).toEqual(["https://app.example", "*"]);
    const web = run(
      await script(STATUS_SCRIPT_PATH),
      ["https://app.example", "https://other.example"],
      undefined,
      { dataset: blocked },
    );
    expect(web.posted.map(([, origin]) => origin)).toEqual([
      "https://app.example",
      "https://other.example",
    ]);
  });

  it("the entry page goes on to the app with a custom-scheme host origin in the list", async () => {
    const entered = run(
      await script(ENTER_SCRIPT_PATH),
      ["https://app.example", "ferry://app"],
      ["https://app.example"],
      { dataset: { portholeTarget: "/app" } },
    );
    await settle();
    expect(entered.replaced).toEqual(["/app"]);
    const refused = run(
      await script(ENTER_SCRIPT_PATH),
      ["ferry://app", "https://app.example"],
      ["https://app.example"],
      { fetch: () => Promise.resolve({ ok: false }) },
    );
    await settle();
    expect(refused.replaced).toEqual([]);
    expect(refused.texts.h1).toBe("Open this app in a new tab");
    expect(refused.posted.map(([message]) => (message as { params: unknown }).params)).toEqual([
      { state: "entering" },
      { state: "blocked", reason: "cookies", status: 401 },
    ]);
  });
});
