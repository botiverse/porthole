import { createHash } from "node:crypto";
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
import { createServer, type Grant, type PortholeServer } from "../../src/server/index.ts";
import { weakened, weakenServed } from "../weakenings.ts";

/**
 * Embed grants (P143) in real browsers: a public artifact page framed below a page that is no host
 * (the host app's own outer embed page), itself framed by any site.
 *
 * - app: the host origin's page, `http://127.0.0.1:<port>`, framing what it is given;
 * - content: `/server` on `http://*.embed.localhost:<port>`, `embeds: true`, its host origin the app;
 * - outer: `http://localhost:<port>`, the embed page: no host, framing one content address under a
 *   `frame-src` of that label alone, recording what reaches it, and (`hostile=1`) saying a host's
 *   words to the frame as if it were one;
 * - top: `http://127.0.0.1:<port>` (another port), a foreign site framing the outer page (or content
 *   itself), recording what reaches it, and saying the same words to the content frame.
 *
 * Probes: `[embed.loads]` (the positive control), `[embed.unheard]`, `[embed.untold]`,
 * `[embed.no-escape]`, `[embed.reader-unframeable]`. Negative controls (leak/controls.ts):
 * `embed-ancestors`, `embed-handshake`, `embed-origins`.
 */

interface Served {
  readonly app: string;
  readonly outer: string;
  readonly top: string;
  readonly porthole: PortholeServer;
  readonly hits: Map<string, number>;
}

const listen = (server: Server, host = "127.0.0.1"): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
    server.unref();
  });

/**
 * A page that frames `?src=` and records every message that reaches it (`window.said`); with
 * `hostile=1`, it says a host's words to the content frame (its child, or its grandchild below the
 * outer page) every 100 ms: a document to draw, a theme, an answer to the shell's first requests,
 * a runtime call's answer.
 */
const FRAMING_PAGE = `<!doctype html><meta charset="utf-8"><title>framing</title><body><script>
  window.said = [];
  window.told = 0;
  const params = new URLSearchParams(location.search);
  addEventListener("message", (event) => {
    const data = event.data;
    window.said.push({ origin: event.origin, method: data && typeof data === "object" ? (data.method ?? null) : null, jsonrpc: data && typeof data === "object" ? data.jsonrpc === "2.0" : false });
  });
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.src = params.get("src") || "about:blank";
  document.body.append(frame);
  if (params.get("hostile") === "1") {
    const words = [
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { html: '<!doctype html><html><body><p id="taken">taken</p></body></html>' } } },
      { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { styles: { variables: { "--color-text-primary": "rgb(1, 2, 3)" } } } },
    ];
    for (let id = 1; id <= 6; id += 1) {
      words.push({ jsonrpc: "2.0", id: "porthole-shell-" + id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "hostile", version: "1" }, hostCapabilities: { experimental: { "porthole/runtime": { version: "1", capabilities: ["comments"] } } }, hostContext: { styles: { variables: { "--color-text-primary": "rgb(1, 2, 3)" } } } } });
    }
    setInterval(() => {
      const targets = [];
      try { if (frame.contentWindow) targets.push(frame.contentWindow); } catch (_) {}
      try { if (frame.contentWindow && frame.contentWindow.frames.length > 0) targets.push(frame.contentWindow.frames[0]); } catch (_) {}
      for (const target of targets) {
        for (const word of words) {
          try { target.postMessage(word, "*"); } catch (_) {}
        }
      }
      window.told += 1;
    }, 100);
  }
</script>`;

/** The outer page's answer: framing one content origin alone (its frame-src), as the host's would. */
function framingPage(request: IncomingMessage, response: ServerResponse) {
  const src = new URL(request.url ?? "/", "http://x.invalid").searchParams.get("src") ?? "";
  let origin = "'none'";
  try {
    origin = new URL(src).origin;
  } catch {
    // No frame source: it frames nothing.
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `frame-src ${origin}`,
  });
  response.end(FRAMING_PAGE);
}

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

/**
 * The served answer as the browser gets it, with the requested controls applied: the server runs
 * in this process, unweakened, so the spec does what the served harness does. `embed-ancestors`
 * (harness): every answer framed by any page, an embed session's or not. `embed-handshake` and
 * `embed-origins` (the shell's runtime, `SERVED`): the documents' shell, weakened.
 */
async function weakenedAnswer(answer: Response): Promise<Response> {
  const headers = new Headers(answer.headers);
  if (weakened.includes("embed-ancestors")) {
    const csp = headers.get("content-security-policy");
    if (csp !== null) {
      headers.set(
        "content-security-policy",
        csp.replace(/frame-ancestors [^;,]*/gu, "frame-ancestors *"),
      );
    }
  }
  if (!(headers.get("content-type") ?? "").startsWith("text/html")) {
    return new Response(answer.body, { status: answer.status, headers });
  }
  const body = weakenServed(await answer.text());
  const script = /<script>([\s\S]*?)<\/script>/u.exec(body)?.[1];
  const csp = headers.get("content-security-policy");
  if (script !== undefined && csp !== null && csp.includes("'sha256-")) {
    const hash = createHash("sha256").update(script).digest("base64");
    headers.set("content-security-policy", csp.replace(/'sha256-[^']+'/u, `'sha256-${hash}'`));
  }
  return new Response(body, { status: answer.status, headers });
}

/** Content labels (`host`) whose documents arrive in two parts (`[embed.unheard]`). */
const slow = new Set<string>();

let started: Promise<Served> | null = null;
const served = (): Promise<Served> => (started ??= start());

async function start(): Promise<Served> {
  let porthole: PortholeServer | null = null;
  const hits = new Map<string, number>();
  const count = (name: string) => hits.set(name, (hits.get(name) ?? 0) + 1);
  const main = createHttpServer((request, response) => {
    const host = request.headers.host ?? "";
    if (!host.includes(".embed.localhost")) {
      framingPage(request, response);
      return;
    }
    // A label no instance is on (`escape.`): a frame that got there navigated itself out.
    if (host.startsWith("escape.")) {
      count("escape");
    }
    void porthole!.handle(toRequest(request)).then(async (given) => {
      const answer = given === null ? null : await weakenedAnswer(given);
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
      const bytes = answer === null ? Buffer.alloc(0) : Buffer.from(await answer.arrayBuffer());
      // A label marked slow: its documents come in two parts, the shell's script first and the
      // rest 1.5 s later, so a word reaches the shell before its document has loaded (before it
      // draws its own page), as on a loaded box (P145).
      const cut = bytes.lastIndexOf("</script>");
      if (
        slow.has(host) &&
        cut > 0 &&
        (answer?.headers.get("content-type") ?? "").startsWith("text/html")
      ) {
        response.write(bytes.subarray(0, cut + "</script>".length));
        setTimeout(() => response.end(bytes.subarray(cut + "</script>".length)), 1_500);
        return;
      }
      response.end(bytes);
    });
  });
  const port = await listen(main);
  const outerPort = await listen(
    createHttpServer((request, response) => framingPage(request, response)),
    "localhost",
  );
  const topServer = createHttpServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x.invalid").pathname;
    if (path.startsWith("/canary/")) {
      count(path.slice("/canary/".length));
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("canary");
      return;
    }
    framingPage(request, response);
  });
  const topPort = await listen(topServer);
  const app = `http://127.0.0.1:${port}`;
  const top = `http://127.0.0.1:${topPort}`;
  const source = `http://*.embed.localhost:${port}`;
  const canary = `${top}/canary`;
  const html = `<!doctype html><html><head><title>embedded</title></head><body>
<p id="content">An embedded page</p>
<p><a id="out" href="${canary}/link">out</a> <a id="out-blank" href="${canary}/link-blank" target="_blank">new window</a> <a id="out-top" href="${canary}/link-top" target="_top">top</a></p>
<script>
  window.loaded = true;
  // Things the shell says to its host of its own: a size, an error report.
  setTimeout(() => { document.body.style.minHeight = "900px"; }, 200);
  setTimeout(() => { console.error("an error the shell would report"); }, 300);
</script>
</body></html>`;
  porthole = createServer({
    content: { domain: "embed.localhost", scheme: "http", port },
    secret: new Uint8Array(32).fill(43),
    hostOrigins: [app],
    embeds: true,
    configs: {
      artifact: presets.artifact({
        isolation: "domain",
        contentOrigins: [source],
        runtime: "1",
        capabilities: { openLink: {}, copyText: {} },
      }),
    },
    artifacts: { get: () => Promise.resolve({ html }) },
  });
  return { app, outer: `http://localhost:${outerPort}`, top, porthole, hits };
}

let made = 0;
const issue = async (grant: Grant) => {
  const { porthole } = await served();
  const instance: InstanceRef = {
    scope: `embed-${process.pid}-${(made += 1)}`,
    document: { kind: "artifact", id: "page", version: "1" },
  };
  return porthole.issue(instance, grant);
};
const EMBED: Grant = { anonymous: true, embed: true };

const framing = (origin: string, src: string, hostile = false) =>
  `${origin}/frame?hostile=${hostile ? "1" : "0"}&src=${encodeURIComponent(src)}`;

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

/**
 * Whether the frame shows the embedded page (a refused frame shows the engine's error page): an
 * element of one of `ids` is in its document (the page's own `#content` by default).
 */
const shows = (frame: Frame | null, ids: readonly string[] = ["content"]): Promise<boolean> =>
  frame === null
    ? Promise.resolve(false)
    : Promise.race([
        frame
          .evaluate((names) => names.some((id) => document.getElementById(id) !== null), ids)
          .catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
      ]);

/** Polls until the frame shows the page (or 5 s pass). */
async function showsSoon(
  frame: Frame | null,
  ids: readonly string[] = ["content"],
): Promise<boolean> {
  for (let tries = 0; tries < 25; tries += 1) {
    if (await shows(frame, ids)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

const hostWord = (frame: Frame) =>
  frame.evaluate(() => document.documentElement.getAttribute("data-porthole-host"));

interface Said {
  readonly origin: string;
  readonly method: unknown;
  readonly jsonrpc: boolean;
}
const said = (frame: Frame): Promise<Said[]> =>
  frame.evaluate(() => (window as unknown as { said: Said[] }).said);

/** The outer page's frame (the top's child). */
const outerOf = (page: Page, outer: string): Frame | null =>
  page.frames().find((each) => each.url().startsWith(outer)) ?? null;

test.describe("embed grants (P143): a public page below any site, with no host", () => {
  test("[embed.loads] an embed session's page shows below the outer page below a foreign site, with no runtime", async ({
    page,
  }) => {
    const { outer, top } = await served();
    const issued = await issue(EMBED);
    await page.goto(framing(top, framing(outer, issued.url)));
    const content = await frameOn(page, issued.origin);
    expect(await showsSoon(content), "the embedded page shows").toBe(true);
    expect(
      await content!.evaluate(() => {
        const global = (window as unknown as { porthole?: { use: (name: string) => unknown } })
          .porthole;
        return global === undefined ? "absent" : global.use("comments");
      }),
    ).toBeNull();
  });

  test("[embed.unheard] the outer page's and the top's words as a host are dropped: nothing drawn, no theme, no runtime", async ({
    page,
  }) => {
    const { outer, top } = await served();
    const issued = await issue(EMBED);
    // The words reach the shell before its document has loaded, and go on after.
    slow.add(new URL(issued.url).host);
    await page.goto(framing(top, framing(outer, issued.url, true), true));
    const content = await frameOn(page, issued.origin);
    // The page loaded: its own `#content`, or the document a host's word drew in its place
    // (`#taken`). Which one is the verdict's to judge, below: a shell that takes a word before its
    // document loads (the `embed-origins` control) draws that word instead of its page, and must
    // fail there, by the probe, not here (P145, Ferryman's audit of 0.15.0: on a loaded box it
    // failed here, unmarked).
    expect(await showsSoon(content, ["content", "taken"]), "the embedded page loaded").toBe(true);
    const outerFrame = outerOf(page, outer);
    expect(outerFrame, "the outer page").not.toBeNull();
    // The outer page (the content's parent) and the top have said their words many times over.
    await expect
      .poll(() => outerFrame!.evaluate(() => (window as unknown as { told: number }).told), {
        message: "the outer page spoke",
      })
      .toBeGreaterThan(15);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { told: number }).told))
      .toBeGreaterThan(15);
    const state = await content!.evaluate(async () => {
      const global = (window as unknown as { porthole?: { use: (name: string) => unknown } })
        .porthole;
      return {
        taken: document.getElementById("taken") !== null,
        content: document.getElementById("content") !== null,
        theme: document.documentElement.style.getPropertyValue("--color-text-primary"),
        // A namespace only where a host offered it (it serializes as an object).
        use: global === undefined ? null : await global.use("comments"),
      };
    });
    expect(state, "probe: the embedded frame took a word from its parent or the top").toEqual({
      taken: false,
      content: true,
      theme: "",
      use: null,
    });
  });

  test("[embed.untold] neither the outer page nor the top hears a word from Porthole: no handshake (over at once, with no host), no size, no report", async ({
    page,
  }) => {
    const { outer, top } = await served();
    const issued = await issue(EMBED);
    await page.goto(framing(top, framing(outer, issued.url)));
    const content = await frameOn(page, issued.origin);
    expect(await showsSoon(content), "the embedded page shows").toBe(true);
    // The page grows and logs an error as it loads; a shell with a host would have asked for it
    // (ui/initialize), said its size and reported the error by now.
    await content!.evaluate(() => {
      document.body.style.minHeight = "1200px";
      location.hash = "#below";
    });
    await page.waitForTimeout(2_000);
    const outerFrame = outerOf(page, outer);
    expect(outerFrame, "the outer page").not.toBeNull();
    const heard = [...(await said(outerFrame!)), ...(await said(page.mainFrame()))].filter(
      (each) => each.jsonrpc,
    );
    // Its handshake ended at once with no host, not after the 40 tries (10 s) a frame gives a host
    // that never answers.
    expect(
      { heard, host: await hostWord(content!) },
      "probe: the outer page or the top heard Porthole, or the shell asked for a host",
    ).toEqual({ heard: [], host: "none" });
  });

  test("[embed.no-escape] the embedded page opens no window, moves no top, and leaves for no other address", async ({
    page,
  }) => {
    const { outer, top, hits } = await served();
    const issued = await issue(EMBED);
    await page.goto(framing(top, framing(outer, issued.url)));
    const content = await frameOn(page, issued.origin);
    expect(await showsSoon(content), "the embedded page shows").toBe(true);
    const before = new Map(hits);
    const escapeTo = issued.origin.replace(/\/\/[^.]+\./u, "//escape.");
    const tried = await content!.evaluate(
      ({ canary, escape }) => {
        const results: Record<string, string> = {};
        try {
          results.open = String(window.open(`${canary}/open`) === null);
        } catch (error) {
          results.open = `threw ${String(error)}`;
        }
        try {
          (window.top as Window).location.href = `${canary}/top`;
          results.top = "set";
        } catch (error) {
          results.top = `threw ${String(error)}`;
        }
        try {
          location.href = `${escape}/__porthole/d/aaaaaaaaaaaaaaaa`;
          results.self = "set";
        } catch (error) {
          results.self = `threw ${String(error)}`;
        }
        return results;
      },
      { canary: `${top}/canary`, escape: escapeTo },
    );
    expect(tried.open, "window.open").not.toBe("false");
    // The person's own clicks on the page's links: out, in a new window, at the top.
    for (const id of ["out", "out-blank", "out-top"]) {
      await content!.click(`#${id}`).catch(() => {});
    }
    await page.waitForTimeout(1_500);
    const landed = [...hits].filter(([name, value]) => value !== (before.get(name) ?? 0));
    expect(
      {
        landed,
        pages: page.context().pages().length,
        top: page.url(),
        stays: await content!
          .evaluate(() => document.getElementById("content") !== null)
          .catch(() => false),
      },
      "probe: the embedded page got out",
    ).toEqual({
      landed: [],
      pages: 1,
      top: framing(top, framing(outer, issued.url)),
      stays: true,
    });
  });

  test("[embed.reader-unframeable] another session's page, public or a viewer's, is refused below a foreign site, with or without the outer page", async ({
    page,
  }) => {
    const { app, outer, top } = await served();
    // The positive control: below its host, another session's page shows.
    const hosted = await issue({ anonymous: true });
    await page.goto(framing(app, hosted.url));
    expect(await showsSoon(await frameOn(page, hosted.origin)), "below its host it shows").toBe(
      true,
    );
    const shown: string[] = [];
    for (const [name, grant] of [
      ["public", { anonymous: true }],
      ["viewer", { viewer: "ada", level: "view" }],
    ] as const) {
      for (const [how, address] of [
        ["below the outer page", (url: string) => framing(top, framing(outer, url))],
        ["framed by the site itself", (url: string) => framing(top, url)],
      ] as const) {
        const issued = await issue(grant);
        await page.goto(address(issued.url));
        await page.waitForTimeout(800);
        const content = page.frames().find((each) => each.url().startsWith(issued.origin)) ?? null;
        if (await shows(content)) {
          shown.push(`${name} ${how}`);
        }
      }
    }
    expect(shown, "probe: another session's page showed below a foreign site").toEqual([]);
  });
});
