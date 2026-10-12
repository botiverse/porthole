import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

/** The shipped MCP example (P073): its tools listed with schemas, and answered. */

function server() {
  const child = spawn(
    process.execPath,
    [new URL("../examples/mcp/server.mjs", import.meta.url).pathname],
    {
      stdio: ["pipe", "pipe", "inherit"],
      // No browser for the check here: it says so and gives the lint (the browser path is the
      // check spec's).
      env: { ...process.env, NODE_PATH: "" },
    },
  );
  const waiting = new Map<number, (message: unknown) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id: number };
    waiting.get(message.id)?.(message);
  });
  let next = 0;
  const ask = (method: string, params?: unknown) =>
    new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve) => {
      next += 1;
      waiting.set(next, resolve as (message: unknown) => void);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
    });
  return { ask, close: () => child.kill() };
}

describe("the MCP example", () => {
  it("lists show, guide and check, and answers them", async () => {
    const mcp = server();
    try {
      const init = await mcp.ask("initialize", { protocolVersion: "2025-06-18" });
      expect(init.result?.instructions).toContain("page_guide");
      const listed = await mcp.ask("tools/list");
      const tools = listed.result?.tools as { name: string; inputSchema: { type: string } }[];
      expect(tools.map((each) => each.name)).toEqual(["show_page", "page_guide", "check_page"]);
      expect(tools.every((each) => each.inputSchema.type === "object")).toBe(true);
      const refused = await mcp.ask("tools/call", {
        name: "show_page",
        arguments: { title: "x", html: '<iframe src="x"></iframe>' },
      });
      expect(refused.result).toMatchObject({ isError: true });
      expect(JSON.stringify(refused.result)).toContain("Remove the <iframe>");
      const shown = await mcp.ask("tools/call", {
        name: "show_page",
        arguments: { title: "x", html: "<!doctype html><title>x</title><p>fine</p>" },
      });
      expect(shown.result).toEqual({ content: [{ type: "text", text: "Shown." }] });
      const guide = await mcp.ask("tools/call", {
        name: "page_guide",
        arguments: { topics: ["chart"] },
      });
      expect(JSON.stringify(guide.result)).toContain("Charts");
    } finally {
      mcp.close();
    }
  });
});
