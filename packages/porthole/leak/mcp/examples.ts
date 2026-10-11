import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { readViewResource, type ToolInfo } from "../../src/mcp/index.ts";
import type { Recorded } from "./host.ts";
import { harness } from "../served/harness.ts";

/**
 * The official ext-apps example servers, run as published (`npx`-able packages, unmodified) on
 * loopback ports of their own, and a minimal MCP client for them: JSON-RPC over the streamable HTTP
 * transport, which these servers answer statelessly.
 */

export const EXAMPLES = {
  vanillajs: { pkg: "@modelcontextprotocol/server-basic-vanillajs", tool: "get-time" },
  react: { pkg: "@modelcontextprotocol/server-basic-react", tool: "get-time" },
  threejs: { pkg: "@modelcontextprotocol/server-threejs", tool: "show_threejs_scene" },
} as const;

export type ExampleName = keyof typeof EXAMPLES;

export interface ExampleServer {
  rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const require = createRequire(import.meta.url);

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const children: ChildProcess[] = [];
process.once("exit", () => {
  for (const child of children) {
    child.kill();
  }
});

async function start(name: ExampleName): Promise<ExampleServer> {
  // The package's bin (dist/index.js) sits beside its main (dist/server.js).
  const entry = path.join(path.dirname(require.resolve(EXAMPLES[name].pkg)), "index.js");
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} didn't start`)), 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`${name} exited (${String(code)})`)));
  });
  let id = 0;
  return {
    async rpc(method, params) {
      id += 1;
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      const text = await response.text();
      const json = response.headers.get("content-type")?.includes("event-stream")
        ? (text.split("\n").find((line) => line.startsWith("data:")) ?? "data:{}").slice(5)
        : text;
      const message = JSON.parse(json) as {
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      if (message.result === undefined) {
        throw new Error(`${method}: ${message.error?.message ?? "no result"}`);
      }
      return message.result;
    },
  };
}

const servers = new Map<ExampleName, Promise<ExampleServer>>();
export const exampleServer = (name: ExampleName): Promise<ExampleServer> => {
  let server = servers.get(name);
  if (server === undefined) {
    server = start(name);
    servers.set(name, server);
  }
  return server;
};

export type Mode = "opaque" | "proxy";

export interface MountedView {
  readonly index: number;
  readonly frame: FrameLocator;
  readonly server: ExampleServer;
  readonly tool: Record<string, unknown>;
  send(
    op: "sendToolInputPartial" | "sendToolInput" | "sendToolResult" | "sendToolCancelled",
    value: unknown,
  ): Promise<void>;
  calls(): Promise<readonly Recorded[]>;
  events(): Promise<readonly string[]>;
}

/**
 * Reads the example's view the way a host does (its tool's `_meta.ui.resourceUri`, then
 * `resources/read`) and mounts it in the reference host, connected to the example's server.
 */
export async function mountExample(
  page: Page,
  name: ExampleName,
  mode: Mode,
): Promise<MountedView> {
  const server = await exampleServer(name);
  const { tools } = (await server.rpc("tools/list", {})) as { tools: Record<string, unknown>[] };
  const tool = tools.find((each) => each.name === EXAMPLES[name].tool);
  const uri = (tool?.["_meta"] as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
  if (tool === undefined || uri === undefined) {
    throw new Error(`${name} lists no ${EXAMPLES[name].tool} with a view`);
  }
  const view = readViewResource(await server.rpc("resources/read", { uri }));
  if (view === null) {
    throw new Error(`${name}'s ${uri} is no MCP Apps view`);
  }
  const served = await harness();
  await page.exposeFunction("portholeHandle", (capability: string, args: unknown) =>
    capability === "callTool"
      ? server.rpc("tools/call", args as Record<string, unknown>)
      : capability === "readData"
        ? server.rpc("resources/read", args as Record<string, unknown>)
        : true,
  );
  await page.goto(`${served.hostOrigin}/mcp-host`);
  await page.waitForFunction(() => typeof window.mcpHost === "object");
  const located =
    mode === "proxy"
      ? await served.porthole.issue(
          {
            scope: `mcp-${name}-${Math.random()}`,
            document: { kind: "mcp-proxy", egress: view.egress },
          },
          { viewer: "probe" },
        )
      : undefined;
  const toolInfo: ToolInfo = { tool };
  const index = await page.evaluate((spec) => window.mcpHost.mount(spec), {
    html: view.html,
    egress: view.egress,
    toolInfo,
    ...(located === undefined
      ? {}
      : { located: { ...located, contentSource: served.contentSource } }),
  });
  const mounted: MountedView = {
    index,
    frame: page.frameLocator(`#displays iframe[data-display="${index}"]`),
    server,
    tool,
    send: (op, value) =>
      page.evaluate(([each, which, data]) => window.mcpHost.send(each, which, data), [
        index,
        op,
        value,
      ] as const),
    calls: () => page.evaluate((each) => window.mcpHost.calls(each), index),
    events: () => page.evaluate((each) => window.mcpHost.events(each), index),
  };
  await expect.poll(() => mounted.events(), { timeout: 15_000 }).toContain("initialized");
  return mounted;
}
