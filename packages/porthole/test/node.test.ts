import { spawn } from "node:child_process";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestListener,
} from "node:http";
import { connect, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { presets } from "../src/index.ts";
import { nodeHost, nodeListener, sendResponse } from "../src/node/index.ts";
import { createContentHost, prefixedName } from "../src/server/index.ts";

/**
 * The Node adapter (P070, P092): nothing a request does ends the process (S01), and nothing a
 * request leaves behind runs on (a body no one reads, a client gone before the answer).
 */

const CONTENT = "a-1.content.localhost";
const SLOW = { timeout: 30_000 };

interface Child {
  readonly ports: { readonly whole: number; readonly own: number };
  readonly events: unknown[][];
  stderr(): string;
  alive(): boolean;
  close(): void;
}

/** `test/node/server.ts` in a process of its own: its ports, and what it says happened. */
async function start(): Promise<Child> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("node/server.ts", import.meta.url))],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let pending = "";
  const events: unknown[][] = [];
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const ports = await new Promise<Child["ports"]>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      pending += String(chunk);
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const event = JSON.parse(pending.slice(0, end)) as unknown[];
        pending = pending.slice(end + 1);
        events.push(event);
        if (event[0] === "ports") {
          resolve(event[1] as Child["ports"]);
        }
      }
    });
    child.once("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
  });
  return {
    ports,
    events,
    stderr: () => stderr,
    alive: () => child.exitCode === null && child.signalCode === null,
    close: () => child.kill(),
  };
}

/** The status line a raw request gets, one connection each ("closed", "timeout" otherwise). */
const ask = (port: number, raw: string, ms = 3_000) =>
  new Promise<string>((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(raw));
    let said = "";
    const done = (status: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    };
    const timer = setTimeout(() => done("timeout"), ms);
    socket.on("data", (chunk) => {
      said += String(chunk);
      if (said.includes("\r\n")) {
        done(said.split("\r\n")[0] ?? "");
      }
    });
    socket.on("error", (error) => done(`error: ${error.message}`));
    socket.on("close", () => done(said === "" ? "closed" : (said.split("\r\n")[0] ?? "")));
  });

const UPGRADE = "Connection: Upgrade\r\nUpgrade: websocket\r\n";
const request = (target: string, host: string, method = "GET", more = "") =>
  `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\n${more === UPGRADE ? "" : "Connection: close\r\n"}${more}\r\n`;

/** Still there, still serving, and nothing on its stderr. */
async function stillServes(child: Child): Promise<void> {
  expect(await ask(child.ports.whole, request("/", "localhost"))).toBe("HTTP/1.1 200 OK");
  expect(await ask(child.ports.whole, request("/nothing", CONTENT))).toBe("HTTP/1.1 404 Not Found");
  expect(await ask(child.ports.own, request("/", "localhost"))).toBe("HTTP/1.1 200 OK");
  expect(child.alive()).toBe(true);
  expect(child.stderr()).toBe("");
}

const told = (child: Child, message: string | true) =>
  vi.waitFor(() =>
    expect(
      child.events.some(
        ([kind, said]) => kind === "error" && (message === true || said === message),
      ),
    ).toBe(true),
  );

describe("a request never ends the process (S01, P092)", () => {
  const cases: {
    readonly name: string;
    readonly server: "whole" | "own";
    readonly raw: string;
    readonly status: string;
    readonly error?: string | true;
  }[] = [
    // Methods fetch can't carry, on the content domain and on the app's own hosts.
    {
      name: "TRACE on the content domain",
      server: "whole",
      raw: request("/", CONTENT, "TRACE"),
      status: "405 Method Not Allowed",
    },
    {
      name: "TRACE on the app's own host",
      server: "whole",
      raw: request("/", "localhost", "TRACE"),
      status: "405 Method Not Allowed",
    },
    {
      name: "TRACE through nodeHost",
      server: "own",
      raw: request("/", CONTENT, "TRACE"),
      status: "405 Method Not Allowed",
    },
    // A Host or a target that is no URL.
    {
      name: "a Host with a space",
      server: "whole",
      raw: request("/", "a b"),
      status: "400 Bad Request",
    },
    { name: "an empty Host", server: "whole", raw: request("/", ""), status: "400 Bad Request" },
    {
      name: "OPTIONS * on the content domain",
      server: "whole",
      raw: request("*", CONTENT, "OPTIONS"),
      status: "400 Bad Request",
    },
    {
      name: "a broken absolute-form target",
      server: "whole",
      raw: request("http://[::1", "localhost"),
      status: "400 Bad Request",
    },
    {
      name: "* through nodeHost",
      server: "own",
      raw: request("*", CONTENT),
      status: "400 Bad Request",
    },
    // The fetch-style handler, and the answer's writing: the app is told (onError).
    {
      name: "a handler that throws",
      server: "whole",
      raw: request("/throws", "localhost"),
      status: "500 Internal Server Error",
      error: "the app broke",
    },
    {
      name: "a handler that rejects",
      server: "whole",
      raw: request("/rejects", "localhost"),
      status: "500 Internal Server Error",
      error: "the app broke later",
    },
    {
      name: "an answer whose head Node can't write",
      server: "whole",
      raw: request("/unwritable", "localhost"),
      status: "500 Internal Server Error",
      error: true,
    },
    {
      name: "an answer whose body is locked",
      server: "whole",
      raw: request("/locked", "localhost"),
      status: "500 Internal Server Error",
      error: true,
    },
    {
      name: "an answer that is no Response",
      server: "whole",
      raw: request("/not-a-response", "localhost"),
      status: "500 Internal Server Error",
      error: true,
    },
    // The app's own Node listener: thrown, or an async one's rejection.
    {
      name: "the app's listener throws",
      server: "own",
      raw: request("/throws", "localhost"),
      status: "500 Internal Server Error",
      error: "the app's listener broke",
    },
    {
      name: "the app's listener throws on a reserved label",
      server: "own",
      raw: request("/throws", "p-1.content.localhost"),
      status: "500 Internal Server Error",
      error: "the app's listener broke",
    },
    {
      name: "the app's async listener rejects",
      server: "own",
      raw: request("/async-rejects", "localhost"),
      status: "500 Internal Server Error",
      error: "the app's async listener broke",
    },
    {
      name: "the app's async listener rejects on a reserved label",
      server: "own",
      raw: request("/async-rejects", "p-1.content.localhost"),
      status: "500 Internal Server Error",
      error: "the app's async listener broke",
    },
    // WebSockets on the content domain, converted the same way.
    {
      name: "a TRACE upgrade on the content domain",
      server: "whole",
      raw: request("/", CONTENT, "TRACE", UPGRADE),
      status: "405 Method Not Allowed",
    },
    {
      name: "an upgrade to *",
      server: "whole",
      raw: request("*", CONTENT, "GET", UPGRADE),
      status: "400 Bad Request",
    },
    {
      name: "a TRACE upgrade through nodeHost",
      server: "own",
      raw: request("/", CONTENT, "TRACE", UPGRADE),
      status: "405 Method Not Allowed",
    },
  ];
  for (const { name, server, raw, status, error } of cases) {
    it(`${name}: ${status.split(" ")[0]}, and the next request is served`, SLOW, async () => {
      const child = await start();
      try {
        expect(await ask(child.ports[server], raw)).toBe(`HTTP/1.1 ${status}`);
        if (error !== undefined) {
          await told(child, error);
        }
        await stillServes(child);
      } finally {
        child.close();
      }
    });
  }

  // Node takes its own error listener off an upgrade's socket before the event (P092).
  const resets: [string, "whole" | "own", string][] = [
    ["on the content domain, refused once its access is asked (async)", "whole", CONTENT],
    ["on the app's own host, which takes no upgrades", "whole", "localhost"],
    ["through nodeHost with no appSocket, refused at once", "own", CONTENT],
  ];
  for (const [name, server, host] of resets) {
    it(`an upgrade the client resets ${name}`, SLOW, async () => {
      const child = await start();
      try {
        for (let at = 0; at < 10 && child.alive(); at += 1) {
          await new Promise<void>((resolve) => {
            const socket = connect(child.ports[server], "127.0.0.1", () => {
              socket.write(request("/", host, "GET", UPGRADE));
              socket.resetAndDestroy();
              setTimeout(resolve, 20);
            });
            socket.on("error", () => undefined);
          });
        }
        await stillServes(child);
      } finally {
        child.close();
      }
    });
  }
});

describe("what a request leaves behind stops with it (P092)", () => {
  it(
    "HEAD: the head goes out at once, the body is cancelled, and the server goes on",
    SLOW,
    async () => {
      const child = await start();
      try {
        expect(await ask(child.ports.whole, request("/endless", "localhost", "HEAD"))).toBe(
          "HTTP/1.1 200 OK",
        );
        await vi.waitFor(() =>
          expect(child.events.some(([kind]) => kind === "endless-cancelled")).toBe(true),
        );
        await stillServes(child);
      } finally {
        child.close();
      }
    },
  );

  const leaveEarly = async (child: Child) => {
    const socket = connect(child.ports.whole, "127.0.0.1", () =>
      socket.write("GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n"),
    );
    socket.on("error", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
  };

  it("a client gone before the answer: its body is cancelled, never pulled on", SLOW, async () => {
    const child = await start();
    try {
      await leaveEarly(child);
      await vi.waitFor(
        () => expect(child.events.some(([kind]) => kind === "slow-cancelled")).toBe(true),
        { timeout: 2_000 },
      );
      expect(child.events.filter(([kind]) => kind === "slow-pulled").length).toBeLessThanOrEqual(1);
      await stillServes(child);
    } finally {
      child.close();
    }
  });

  it("a client gone before the answer: nodeListener's request.signal aborts", SLOW, async () => {
    const child = await start();
    try {
      await leaveEarly(child);
      await vi.waitFor(
        () => expect(child.events.some(([kind]) => kind === "slow-aborted")).toBe(true),
        { timeout: 2_000 },
      );
    } finally {
      child.close();
    }
  });
});

describe("in this process", () => {
  const listen = async (handler: RequestListener) => {
    const server = createHttpServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, port: (server.address() as AddressInfo).port };
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sendResponse never rejects: a locked body, or no Response, is a 500", async () => {
    const outcomes: string[] = [];
    const locked = new Response("x");
    locked.body?.getReader();
    const answers = [locked, {} as Response];
    const { server, port } = await listen((_request, response) => {
      sendResponse(response, answers.shift() as Response).then(
        () => outcomes.push("resolved"),
        () => outcomes.push("rejected"),
      );
    });
    try {
      expect(await ask(port, request("/", "localhost"))).toBe("HTTP/1.1 500 Internal Server Error");
      expect(await ask(port, request("/", "localhost"))).toBe("HTTP/1.1 500 Internal Server Error");
      await vi.waitFor(() => expect(outcomes).toEqual(["resolved", "resolved"]));
    } finally {
      server.close();
    }
  });

  it("without onError, what failed is a process warning, never the client's to read", async () => {
    const warned = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const { server, port } = await listen(
      nodeListener(() => {
        throw new Error("SECRET-STACK-TEXT");
      }),
    );
    try {
      const body = await new Promise<string>((resolve) => {
        const socket = connect(port, "127.0.0.1", () => socket.write(request("/", "localhost")));
        let said = "";
        socket.on("data", (chunk) => (said += String(chunk)));
        socket.on("close", () => resolve(said));
      });
      expect(body).toMatch(/^HTTP\/1\.1 500 /u);
      expect(body).not.toContain("SECRET");
      expect(warned).toHaveBeenCalledWith(
        expect.objectContaining({ message: "SECRET-STACK-TEXT" }),
      );
    } finally {
      server.close();
    }
  });

  it("a POST to a reserved label reaches the app's listener whole (its body untouched)", async () => {
    const content = createContentHost({
      domain: "content.localhost",
      appOrigins: ["http://localhost:5173"],
      secret: "a test secret that is at least thirty-two bytes long",
      configs: (source) => ({
        artifact: presets.artifact({ isolation: "domain", contentOrigins: [source] }),
      }),
      name: prefixedName("a-"),
      reserved: ["p-*"],
      instance: () => null,
      access: () => null,
    });
    const listener: RequestListener = (incoming: IncomingMessage, response) => {
      let size = 0;
      incoming.on("data", (chunk: Buffer) => (size += chunk.byteLength));
      incoming.on("end", () => response.end(`got ${size}`));
    };
    const { server, port } = await listen(nodeHost(content, { request: listener }).request);
    try {
      const said = await new Promise<string>((resolve, reject) => {
        const asked = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/x",
            method: "POST",
            headers: { host: "p-1.content.localhost", "content-length": 200_000 },
            timeout: 3_000,
          },
          (response) => {
            let text = "";
            response.on("data", (chunk) => (text += String(chunk)));
            response.on("end", () => resolve(`${response.statusCode} ${text}`));
          },
        );
        asked.on("timeout", () => asked.destroy(new Error("no answer")));
        asked.on("error", reject);
        asked.end(Buffer.alloc(200_000, 0x61));
      });
      expect(said).toBe("200 got 200000");
    } finally {
      server.close();
    }
  });
});
