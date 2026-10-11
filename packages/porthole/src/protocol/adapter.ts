import type { HostFunctionBridge } from "../bridge/types.ts";
import type { CompiledConfig } from "../compile/compile.ts";
import type { Transport } from "../transport/types.ts";
import type { HostContext } from "./mcp-apps.ts";

/**
 * The protocol-adapter seam (P004): the only layer that knows a wire protocol's method names and
 * shapes. The framework speaks capabilities and lifecycle; an adapter translates.
 *
 * - Frame → host: the adapter validates each message (dropping what it doesn't recognize, and
 *   answering an unknown request with "method not found"), turns every capability use into
 *   `bridge.call(...)` (including sizes and errors, which the bridge turns into the framework's
 *   own events), answers the handshake with `hostContext()`, and reports lifecycle with `emit`.
 * - Host → frame: the framework calls the connection; the adapter encodes and sends.
 *
 * The bridge alone decides whether a call runs (declared, valid, gated); an adapter never calls a
 * host handler itself.
 */

/** What the framework gives an adapter for one display. */
export interface AdapterSession {
  readonly display: { readonly id: string; readonly title: string };
  readonly compiled: CompiledConfig;
  readonly transport: Transport;
  readonly bridge: HostFunctionBridge;
  readonly hostInfo: { readonly name: string; readonly version: string };
  /** The host context as of now: theme, its variables, display mode, sizes, locale. */
  hostContext(): HostContext;
  /** Lifecycle the framework acts on. */
  emit(event: AdapterEvent): void;
  /**
   * The mount's whole document, when the host passed one (an MCP Apps view): for an adapter that
   * delivers it itself, as through a sandbox proxy. In opaque isolation the framework has already
   * put it in the frame, hardened.
   */
  readonly document?: string;
}

export type AdapterEvent =
  /** The view finished its handshake; content may be sent. */
  | { readonly type: "initialized" }
  /** The view asked to be closed. */
  | { readonly type: "teardown-requested" };

/** What the framework drives on every adapter. Adapters add their protocol's own operations. */
export interface AdapterConnection {
  /** The host context changed (a theme flip, a new width): tell the view. */
  hostContextChanged(context: HostContext): void;
  /** Asks the view to clean up before it is removed; resolves when it answered or gave up. */
  teardown(): Promise<void>;
  /** Stops listening. The framework closes the transport. */
  close(): void;
}

export interface ProtocolAdapter<C extends AdapterConnection = AdapterConnection> {
  readonly name: string;
  connect(session: AdapterSession): C;
}

/**
 * The core adapter's connection: the MCP Apps subset the shell speaks (inline widgets, artifact
 * pages). Content goes as `tool-input-partial` while it is written, then `tool-input` once.
 */
export interface ShellConnection extends AdapterConnection {
  /** The content so far (`partial`, drawn inert, any number of times), then whole, once. */
  setContent(html: string, options?: { readonly partial?: boolean }): void;
}
