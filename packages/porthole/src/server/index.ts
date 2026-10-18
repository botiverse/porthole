/**
 * `@botiverse/porthole/server`: serving content on origins of its own (domain mode, artifact
 * pages, the MCP Apps sandbox proxy, and url mode's access gate). A host's backend mounts it as a
 * fetch-style handler in front of its own routes, for every request whose host is under the
 * content domain:
 *
 *   const porthole = createServer({ content: { domain: "example-usercontent.com", scheme: "https" }, … });
 *   app.all("*", async (c, next) => (await porthole.handle(c.req.raw)) ?? next());   // Hono
 *
 * and calls `issue` from its own authenticated API when a viewer opens served content.
 *
 * The host kit (P066): `createContentHost` wraps `createServer` with the routing middleware
 * (`fetch`), the issue endpoint (`issue`), the content domain's parsing and clash guards
 * (`contentDomain`), and an optional health gate with an opaque fallback. An app writes its four
 * policy callbacks and its settings; on Node, `@botiverse/porthole/node` adapts it.
 *
 * Runs on any runtime with web-standard `Request`/`Response` and `crypto.getRandomValues`: Node,
 * Cloudflare Workers (no `nodejs_compat` needed), Deno, Bun (P044). On Workers, keep tickets in D1
 * (`d1TicketStore`, P045).
 *
 * Origins: each storage scope gets `<label>.<domain>`, the label keyed from the scope by the
 * secret (stable, DNS-safe, not guessable from the scope), or a host's own flat name
 * (`content.name`, `prefixedName("a-")` for `a-<id>`), with other servers' namespaces reserved (P047). The domain is a registrable domain the
 * host uses for nothing else, so no content origin is ever same-site with the host. Documents go
 * out with their CSP (from the config) plus `frame-ancestors` (the host origins) in headers.
 *
 * Tickets: `issue` mints a one-time ticket for an instance and a viewer (or anonymously, for a
 * public link, P046), good for a short time;
 * the frame's first request carries it, and the content origin takes it (once). A served document
 * comes back in that same answer, with a cookie of that origin only (`__Host-`, `Secure`,
 * `HttpOnly`, `SameSite=None; Partitioned` in a frame) for what follows; a url-mode app's ticket
 * buys the cookie and redirects to the app's landing path without the ticket (P025). Private
 * content without a valid ticket or cookie gets nothing of the content.
 */
export { createServer } from "./server.ts";
export {
  createContentHost,
  HEALTH_PATH,
  type ContentHealthView,
  type ContentHost,
  type ContentHostEvent,
  type ContentHostOptions,
  type ContentClientMeta,
  type ContentLogger,
  type EntryContext,
  type EntryOptions,
  ASSET_LIBRARY_PATH,
  type FileAddress,
  isFileAddress,
  versionBase,
  versionedAddress,
  type ContentMeta,
  type HealthOptions,
  type HealthProbe,
} from "./host.ts";
export {
  clashOf,
  contentDomain,
  ContentDomainError,
  hostnameOf,
  type ContentDomainInfo,
  type ContentDomainProblem,
} from "./domain.ts";
export {
  d1TicketSchema,
  d1TicketStore,
  memoryTicketStore,
  type D1Like,
  type D1StatementLike,
} from "./tickets.ts";
export { FRAME_STATUS_METHOD } from "../isolation/types.ts";
export { isHostLabel, prefixedName, type Naming } from "./naming.ts";
// The page an app serves in conformance test mode (P071).
export { conformancePage } from "../conformance/page.ts";
// The types an app's callbacks take and give (P070).
export type { PortholeConfig } from "../config/schema.ts";
export type { FrameLocation, InstanceRef, ServedDocument } from "../isolation/types.ts";
export {
  isPortholeCookie,
  proxyTo,
  upstreamHeaders,
  withoutPortholeCookies,
  type ProxyOptions,
} from "./proxy.ts";
export { statusPageOf as statusPage } from "./pages.ts";
export { contentHostFor, type ContentHostFor } from "./bootstrap.ts";
// A version made of files (P081): the rules its paths follow, its limits and its types.
export {
  checkFileSet,
  DEFAULT_ENTRY,
  fileLimits,
  filePathProblem,
  type FileLimits,
  type FileSetProblem,
} from "../files/paths.ts";
export { fileTypeOf, type FileRole, type FileType } from "../files/types.ts";
export type {
  Access,
  ArtifactStore,
  AssetStore,
  StoredAsset,
  FileBody,
  StoredFile,
  StoredFiles,
  StoredVersion,
  AuthorizeAnswer,
  AuthorizeRequest,
  Authorizer,
  ContentDomain,
  EntryState,
  Grant,
  PortholeServer,
  ServerOptions,
  TicketRecord,
  TicketStore,
  Upstream,
} from "./types.ts";
