/**
 * JSON-RPC 2.0, as MCP Apps carries it over a transport. Every message crossing the frame boundary
 * is checked against these shapes before use; anything else is dropped, never coerced.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly error: JsonRpcError };

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** The standard error codes the adapters answer with. */
export const JSON_RPC_ERRORS = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isId = (value: unknown): value is JsonRpcId =>
  (typeof value === "string" && value.length <= 256) ||
  (typeof value === "number" && Number.isSafeInteger(value));

/**
 * `value` as a JSON-RPC message, or null when it isn't one: a request (id + method), a
 * notification (method only), or a response (id + exactly one of result / error).
 */
export function parseJsonRpc(value: unknown): JsonRpcMessage | null {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    return null;
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    return null;
  }
  if (typeof value.method === "string") {
    if (value.method.length === 0 || value.method.length > 256) {
      return null;
    }
    if (value.id === undefined) {
      return value as unknown as JsonRpcNotification;
    }
    return isId(value.id) ? (value as unknown as JsonRpcRequest) : null;
  }
  if (!isId(value.id) || value.method !== undefined) {
    return null;
  }
  const hasResult = "result" in value;
  const hasError = "error" in value;
  if (hasResult === hasError) {
    return null;
  }
  if (hasError) {
    const error = value.error;
    if (!isRecord(error) || typeof error.code !== "number" || typeof error.message !== "string") {
      return null;
    }
  }
  return value as unknown as JsonRpcResponse;
}
