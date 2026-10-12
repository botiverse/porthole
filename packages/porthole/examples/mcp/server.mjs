// The agent's side, as an MCP server over stdio: show_page, page_guide and check_page, each a
// tool definition Porthole makes from the app's display kind (names, descriptions and JSON
// Schemas), answered by Porthole's own helpers. With the official MCP SDK, register the same
// definitions and handlers; this file speaks the protocol by hand to stay dependency-free.
//
//   node node_modules/@botiverse/porthole/examples/mcp/server.mjs     (an MCP client starts it)
//
// show_page refuses only what certainly fails (over the size, nested frames, document.write…) and
// says exactly what to change; everything else comes back as warnings with the result.
// check_page runs the page in the real sandbox where this machine has a browser (Playwright);
// without one, it says so and gives the lint alone (docs/ADOPTING.md: hosts without a browser).
import { createInterface } from "node:readline";
import {
  admitContent,
  answerGuide,
  checkTool,
  guideTool,
  lintContent,
  showTool,
} from "@botiverse/porthole";
import { displays } from "../displays.mjs";

// The manual as served pages get it (the kind's served config, no real origin needed).
const config = displays.guideConfig("artifact", "served");
const tools = [showTool(config), guideTool(config), checkTool(config)];
const shown = new Map(); // title → html: an app stores and shows it (examples/app.mjs)

/** A browser, if this machine has Playwright: the check's driver. */
let browser = null;
async function driver() {
  try {
    const [{ chromium }, { playwrightDriver }] = await Promise.all([
      import("@playwright/test"),
      import("@botiverse/porthole/check"),
    ]);
    browser ??= await chromium.launch();
    return playwrightDriver(browser);
  } catch {
    return null;
  }
}

const text = (value, isError = false) => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

async function call(name, args) {
  if (name === showTool(config).name) {
    const admitted = admitContent(config, String(args?.html ?? ""));
    if (!admitted.ok) return text(admitted.refusal, true);
    shown.set(String(args?.title ?? "Untitled"), admitted.content);
    return text(admitted.note ?? "Shown.");
  }
  if (name === guideTool(config).name) {
    const answer = answerGuide(config, args);
    return "error" in answer ? text(answer.error, true) : text(answer.text);
  }
  if (name === checkTool(config).name) {
    const html = String(args?.html ?? "");
    const check = await driver();
    if (check === null) {
      const findings = lintContent(config, html);
      return text(
        `No browser here, so only what can be told without running it:\n${findings.length === 0 ? "nothing to fix." : findings.map((each) => `- ${each.message}`).join("\n")}`,
      );
    }
    const { checkPage } = await import("@botiverse/porthole/check");
    const report = await checkPage({
      config,
      content: html,
      driver: check,
      ...(Array.isArray(args?.widths) ? { widths: args.widths } : {}),
      ...(Array.isArray(args?.schemes) ? { schemes: args.schemes } : {}),
    });
    return text(report.text, !report.ok);
  }
  throw Object.assign(new Error(`No tool ${name}`), { code: -32602 });
}

async function respond(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "porthole-example", version: "1" },
        instructions: `Call ${guideTool(config).name} once before your first page, and ${checkTool(config).name} before ${showTool(config).name}.`,
      };
    case "tools/list":
      return { tools };
    case "tools/call":
      return call(message.params?.name, message.params?.arguments ?? {});
    case "ping":
      return {};
    default:
      throw Object.assign(new Error(`No method ${message.method}`), { code: -32601 });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => void handleLine(line));

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return; // a notification
  try {
    const result = await respond(message);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } })}\n`,
    );
  }
}
lines.on("close", () => browser?.close());
