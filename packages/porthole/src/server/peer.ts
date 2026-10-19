/**
 * The address a request came from, as the server that took it saw it: its socket's peer. The Node
 * adapter leaves it on the fetch `Request` under a symbol no client can send (P092), and the issue
 * endpoint's rate limit keys an anonymous viewer by it. No Node API here: `/server` stays free of
 * Node.
 */
const PEER = Symbol.for("@botiverse/porthole/peer-address");

/** Leaves the socket's peer on a request (the Node adapter does). */
export function withPeerAddress(request: Request, address: string | undefined): Request {
  if (address !== undefined && address !== "") {
    Object.defineProperty(request, PEER, { value: address });
  }
  return request;
}

/** The socket's peer the Node adapter left on a request, or null. */
export function peerAddress(request: Request): string | null {
  const address: unknown = (request as unknown as Record<symbol, unknown>)[PEER];
  return typeof address === "string" ? address : null;
}
