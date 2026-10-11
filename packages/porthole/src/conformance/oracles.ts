import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Out-of-band oracles: listeners outside the browser that see what actually left it. A probe
 * points content at one and asserts it heard nothing; a positive control points something allowed
 * at one and asserts it heard it, so a silent oracle is never mistaken for a wall.
 */

export interface HeardRequest {
  readonly method: string;
  readonly path: string;
  readonly origin: string | undefined;
}

export interface HttpOracle {
  /** `http://127.0.0.1:<port>`: an exact origin a config can allow or leave out. */
  readonly origin: string;
  /** Every request it answered. */
  requests(): readonly HeardRequest[];
  /** Every TCP connection opened to it, whether or not a request followed (preconnects). */
  connections(): number;
  close(): Promise<void>;
}

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** What the oracle answers, by the path's extension: real enough for each kind of load to finish. */
function body(path: string): { type: string; data: string | Buffer } {
  if (/\.m?js(\?|$)/u.test(path)) {
    return {
      type: "text/javascript",
      data: "globalThis.__portholeOracleScript = (globalThis.__portholeOracleScript || 0) + 1;",
    };
  }
  if (/\.css(\?|$)/u.test(path)) {
    return { type: "text/css", data: "html { --porthole-oracle: 1; }" };
  }
  if (/\.(png|gif|jpg)(\?|$)/u.test(path)) {
    return { type: "image/png", data: PIXEL };
  }
  if (/\.html(\?|$)/u.test(path)) {
    return {
      type: "text/html",
      data: "<!doctype html><title>oracle</title><p id=oracle>oracle</p>",
    };
  }
  return { type: "text/plain", data: "oracle" };
}

/** A file an oracle serves at a path, instead of its stand-in answer (a library, say). */
export interface ServedFile {
  readonly type: string;
  readonly data: string | Buffer;
}

export async function httpOracle(
  files: Readonly<Record<string, ServedFile>> = {},
): Promise<HttpOracle> {
  const heard: HeardRequest[] = [];
  let connections = 0;
  const server = createServer((request, response) => {
    heard.push({
      method: request.method ?? "GET",
      path: request.url ?? "/",
      origin: request.headers.origin,
    });
    const { type, data } = files[request.url ?? "/"] ?? body(request.url ?? "/");
    response.writeHead(200, {
      "content-type": type,
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
    response.end(data);
  });
  server.on("connection", () => {
    connections += 1;
  });
  server.on("upgrade", (request, socket) => {
    heard.push({ method: "UPGRADE", path: request.url ?? "/", origin: request.headers.origin });
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests: () => [...heard],
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface UdpOracle {
  /** `stun:127.0.0.1:<port>`, for an ICE server list. */
  readonly stun: string;
  /** The datagrams that reached it. */
  packets(): number;
  close(): Promise<void>;
}

export async function udpOracle(): Promise<UdpOracle> {
  let packets = 0;
  const socket = createSocket("udp4");
  socket.on("message", () => {
    packets += 1;
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  return {
    stun: `stun:127.0.0.1:${port}`,
    packets: () => packets,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

/** Waits `ms`, so a request that was going to leave has time to arrive. */
export const settle = (ms = 800): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
