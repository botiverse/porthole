import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Frame, type Page } from "@playwright/test";
import { presets } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { createServer, type PortholeServer } from "../../src/server/index.ts";
import { FRAME_STATUS_METHOD } from "../../src/isolation/types.ts";

/**
 * `framedBy` (P141) in real browsers: an outer page (an app that frames the host's app, Deck framing
 * Raft) may be an ancestor of the host's frames, and is never their host.
 *
 * - app: the host origin's page, `http://127.0.0.1:<port>`, framing what it is given and answering
 *   the frame's `ui/initialize` as a host does;
 * - content: `/server` on `http://*.framed.localhost:<port>`, its host origins the app and a
 *   desktop scheme (so a page's `*` fallback is live), its `framedBy` the outer page;
 * - outer: `http://localhost:<port>`, framing the app's page, or (a misuse) content itself, and
 *   answering `ui/initialize` too;
 * - foreign: `http://127.0.0.1:<port>`, another port, framing the app's page.
 */

const DESKTOP = "ferry://app";

interface Served {
  readonly app: string;
  readonly outer: string;
  readonly foreign: string;
  readonly porthole: PortholeServer;
}

const listen = (server: Server, host = "127.0.0.1"): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
    server.unref();
  });

/** A page that frames `?src=` and records what reaches it; with `answer`, it answers as a host. */
const FRAMING_PAGE = `<!doctype html><meta charset="utf-8"><title>framing</title><body><script>
  window.said = [];
  const params = new URLSearchParams(location.search);
  addEventListener("message", (event) => {
    const data = event.data;
    window.said.push({ origin: event.origin, method: data && typeof data === "object" ? data.method : null });
    if (params.get("answer") === "1" && data && data.method === "ui/initialize" && typeof data.id === "string") {
      event.source.postMessage({ jsonrpc: "2.0", id: data.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "probe", version: "1" }, hostCapabilities: {}, hostContext: {} } }, event.origin);
    }
  });
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.src = params.get("src") || "about:blank";
  document.body.append(frame);
</script>`;

const framingPage = (response: ServerResponse) => {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(FRAMING_PAGE);
};

function toRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, each);
    }
  }
  return new Request(`http://${request.headers.host ?? "localhost"}${request.url ?? "/"}`, {
    method: request.method ?? "GET",
    headers,
  });
}

let started: Promise<Served> | null = null;
const served = (): Promise<Served> => (started ??= start());

async function start(): Promise<Served> {
  let porthole: PortholeServer | null = null;
  const main = createHttpServer((request, response) => {
    const host = request.headers.host ?? "";
    if (!host.includes(".framed.localhost")) {
      framingPage(response);
      return;
    }
    void porthole!.handle(toRequest(request)).then(async (answer) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of answer?.headers ?? []) {
        if (name !== "set-cookie") {
          headers[name] = value;
        }
      }
      const cookies = answer?.headers.getSetCookie() ?? [];
      if (cookies.length > 0) {
        headers["set-cookie"] = cookies;
      }
      response.writeHead(answer?.status ?? 404, headers);
      response.end(answer === null ? "" : Buffer.from(await answer.arrayBuffer()));
    });
  });
  const port = await listen(main);
  const outerPort = await listen(
    createHttpServer((_request, response) => framingPage(response)),
    "localhost",
  );
  const foreignPort = await listen(createHttpServer((_request, response) => framingPage(response)));
  const app = `http://127.0.0.1:${port}`;
  const outer = `http://localhost:${outerPort}`;
  const source = `http://*.framed.localhost:${port}`;
  porthole = createServer({
    content: { domain: "framed.localhost", scheme: "http", port },
    secret: new Uint8Array(32).fill(41),
    hostOrigins: [app, DESKTOP],
    framedBy: [outer],
    configs: {
      inlineWidget: presets.inlineWidget({ isolation: "domain", contentOrigins: [source] }),
    },
  });
  return { app, outer, foreign: `http://127.0.0.1:${foreignPort}`, porthole };
}

let count = 0;
const issue = async () => {
  const { porthole } = await served();
  const instance: InstanceRef = {
    scope: `framed-by-${process.pid}-${(count += 1)}`,
    document: { kind: "shell", preset: "inlineWidget" },
  };
  return porthole.issue(instance, { viewer: "ada" });
};

const framing = (origin: string, src: string, answer: boolean) =>
  `${origin}/frame?answer=${answer ? "1" : "0"}&src=${encodeURIComponent(src)}`;

/** The frame on `origin` once it is there (null: none came). */
async function frameOn(page: Page, origin: string): Promise<Frame | null> {
  for (let tries = 0; tries < 40; tries += 1) {
    const found = page.frames().find((each) => each.url().startsWith(origin));
    if (found !== undefined) {
      return found;
    }
    await page.waitForTimeout(100);
  }
  return null;
}

/** Whether the frame shows Porthole's shell (a refused frame shows the engine's error page). */
const shows = (frame: Frame | null): Promise<boolean> =>
  frame === null
    ? Promise.resolve(false)
    : Promise.race([
        frame.evaluate(() => document.getElementById("porthole-root") !== null).catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
      ]);

const hostWord = (frame: Frame) =>
  frame.evaluate(() => document.documentElement.getAttribute("data-porthole-host"));

const said = (frame: Frame): Promise<{ origin: string; method: unknown }[]> =>
  frame.evaluate(() => (window as unknown as { said: { origin: string; method: unknown }[] }).said);

test.describe("framedBy (P141): an outer page may be an ancestor, never a host", () => {
  test("below the outer page, the app's frame shows and its host is the app", async ({ page }) => {
    const { app, outer } = await served();
    const location = await issue();
    await page.goto(framing(outer, framing(app, location.url, true), false));
    const content = await frameOn(page, location.origin);
    expect(await shows(content), "probe: the content shows below the outer page").toBe(true);
    await expect
      .poll(() => hostWord(content!), { message: "the app answered as its host" })
      .toBe("answered");
  });

  test("below a foreign page, the app's frame is still refused (framedBy opens no one else)", async ({
    page,
  }) => {
    const { app, foreign } = await served();
    const location = await issue();
    await page.goto(framing(foreign, framing(app, location.url, true), false));
    await page.waitForTimeout(1_000);
    const content = page.frames().find((each) => each.url().startsWith(location.origin)) ?? null;
    expect(await shows(content), "probe: a foreign ancestor framed the content").toBe(false);
  });

  test("the outer page framing content itself is no host: its answer is refused, and the handshake ends with none", async ({
    page,
  }) => {
    const { outer } = await served();
    const location = await issue();
    await page.goto(framing(outer, location.url, true));
    const content = await frameOn(page, location.origin);
    // frame-ancestors can't refuse a parent it names as an ancestor: the frame loads...
    expect(await shows(content)).toBe(true);
    const outerFrame = page.mainFrame();
    await expect
      .poll(async () => (await said(outerFrame)).some((each) => each.method === "ui/initialize"), {
        message: "the shell asked its parent",
      })
      .toBe(true);
    // ...but the outer page's answer is no host's: the shell takes nothing from it (P085's 40 tries).
    await expect
      .poll(() => hostWord(content!), { timeout: 15_000, message: "the handshake ended" })
      .toBe("none");
  });

  test("a door framed by the app says open to it; framed by the outer page, says nothing to it, not even *", async ({
    page,
  }) => {
    const { app, outer } = await served();
    const toApp = await issue();
    await page.goto(framing(app, toApp.door!.url, false));
    await expect
      .poll(
        async () =>
          (await said(page.mainFrame())).filter((each) => each.method === FRAME_STATUS_METHOD)
            .length,
        { message: "the door told the app" },
      )
      .toBeGreaterThan(0);
    const toOuter = await issue();
    await page.goto(framing(outer, toOuter.door!.url, false));
    const door = await frameOn(page, toOuter.origin);
    expect(door, "the door loaded below the outer page").not.toBeNull();
    await expect
      .poll(() =>
        door!
          .evaluate(() => document.querySelector("main[data-porthole-door]") !== null)
          .catch(() => false),
      )
      .toBe(true);
    await page.waitForTimeout(1_500);
    expect(
      (await said(page.mainFrame())).filter((each) => each.method === FRAME_STATUS_METHOD),
      "probe: the door told the outer page",
    ).toEqual([]);
  });
});
