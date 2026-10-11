import { describe, expect, test } from "vitest";
import { parseJsonRpc } from "../src/protocol/jsonrpc.ts";

describe("parseJsonRpc", () => {
  test("takes requests, notifications and responses", () => {
    expect(
      parseJsonRpc({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} }),
    ).not.toBeNull();
    expect(parseJsonRpc({ jsonrpc: "2.0", method: "ui/notifications/initialized" })).not.toBeNull();
    expect(parseJsonRpc({ jsonrpc: "2.0", id: "a", result: { ok: true } })).not.toBeNull();
    expect(
      parseJsonRpc({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "no" } }),
    ).not.toBeNull();
  });

  test.each([
    ["not an object", "ui/initialize"],
    ["no version", { id: 1, method: "x" }],
    ["array params", { jsonrpc: "2.0", id: 1, method: "x", params: [1] }],
    ["object id", { jsonrpc: "2.0", id: {}, method: "x" }],
    ["fractional id", { jsonrpc: "2.0", id: 1.5, method: "x" }],
    ["empty method", { jsonrpc: "2.0", method: "" }],
    ["result and error", { jsonrpc: "2.0", id: 1, result: 1, error: { code: 1, message: "x" } }],
    ["neither result nor error", { jsonrpc: "2.0", id: 1 }],
    ["malformed error", { jsonrpc: "2.0", id: 1, error: "nope" }],
    ["response without id", { jsonrpc: "2.0", result: 1 }],
  ])("drops %s", (_name, message) => {
    expect(parseJsonRpc(message)).toBeNull();
  });
});
