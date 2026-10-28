import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { presets } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { nodeServer } from "../../src/node/index.ts";
import {
  createContentHost,
  prefixedName,
  versionBase,
  versionedAddress,
  type StoredFiles,
} from "../../src/server/index.ts";
import { servedShellWeakened, weakened, weakenServed } from "../weakenings.ts";

/**
 * File sets for the served cases (P081-P084): a version from a map of paths, the Vite + React
 * fixture from disk, the harness's two controls, and a host with clean addresses (redirect entry,
 * P068) for the cases on a tab.
 */

const bytesOf = (body: string | Uint8Array): Uint8Array =>
  typeof body === "string" ? new TextEncoder().encode(body) : body;

/** A version made of `files` (path → text or bytes), as a host's store gives it. */
export function storedFiles(
  files: Readonly<Record<string, string | Uint8Array>>,
  options: { readonly entry?: string; readonly spa?: boolean } = {},
): StoredFiles {
  return {
    files: Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        name,
        {
          size: bytesOf(body).byteLength,
          sha256: createHash("sha256").update(bytesOf(body)).digest("hex"),
        },
      ]),
    ),
    ...options,
    read: (name) => {
      const body = files[name];
      return Promise.resolve(body === undefined ? null : bytesOf(body));
    },
  };
}

/** Every file under `directory`, by its path relative to it. */
export async function filesIn(directory: string): Promise<Record<string, Uint8Array>> {
  const found: Record<string, Uint8Array> = {};
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        found[path.relative(directory, full).split(path.sep).join("/")] = await readFile(full);
      }
    }
  };
  await walk(directory);
  return found;
}

/** The Vite + React build (`leak/fixtures/vite-react/out`), as committed. */
export const viteFixture = (): Promise<Record<string, Uint8Array>> =>
  filesIn(path.join(import.meta.dirname, "..", "fixtures", "vite-react", "out"));

/** The `service-worker` control: a worker's script request passed on as a plain script's. */
export function asServiceWorkerAllowed(request: Request): Request {
  if (
    request.headers.get("service-worker") === null &&
    request.headers.get("sec-fetch-dest") !== "serviceworker"
  ) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.delete("service-worker");
  headers.set("sec-fetch-dest", "script");
  return new Request(request, { headers });
}

/**
 * The `file-self` control: a file set's CSP with `'self'` where it names its version's own path
 * (any path-limited source but Porthole's libraries).
 */
export function withSelfForFiles(response: Response): Response {
  const csp = response.headers.get("content-security-policy");
  if (csp === null || !/https?:\/\/[^\s/]+\/\S+\//u.test(csp)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    csp.replace(/https?:\/\/[^\s/]+\/(?!__porthole\/lib\/)\S+\//gu, "'self'"),
  );
  return new Response(response.body, { status: response.status, headers });
}

/** The `file-corp` control: a file without its `Cross-Origin-Resource-Policy`. */
export function withoutResourcePolicy(response: Response): Response {
  if (!response.headers.has("cross-origin-resource-policy")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("cross-origin-resource-policy");
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The `tab-sandbox` control (P099): a served page without its CSP's `sandbox`, so on a tab of its
 * own nothing sandboxes it (in a frame, the frame's attribute still does).
 */
export function withoutDocumentSandbox(response: Response): Response {
  const csp = response.headers.get("content-security-policy");
  if (csp === null || !(response.headers.get("content-type") ?? "").startsWith("text/html")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    csp
      .split(";")
      .filter((directive) => directive.trim().split(/\s+/u)[0] !== "sandbox")
      .join(";"),
  );
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The `file-sandbox` control (P111, after its review): a file that isn't a page goes out without
 * its sandbox, so one opened on its own tab (an SVG, an XML file) has the content origin's.
 */
export function withoutFileSandbox(response: Response): Response {
  const csp = response.headers.get("content-security-policy");
  if (csp === null || (response.headers.get("content-type") ?? "").startsWith("text/html")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    csp
      .split(";")
      .filter((directive) => directive.trim().split(/\s+/u)[0] !== "sandbox")
      .join(";"),
  );
  return new Response(response.body, { status: response.status, headers });
}

/** The `permissions-policy` control (P099): a served page without its `Permissions-Policy`. */
export function withoutPermissionsPolicy(response: Response): Response {
  if (!response.headers.has("permissions-policy")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("permissions-policy");
  return new Response(response.body, { status: response.status, headers });
}

/** The controls this file's hosts apply to a served answer, in turn. */
async function weakenAnswer(answer: Response): Promise<Response> {
  let out = weakened.includes("file-self") ? withSelfForFiles(answer) : answer;
  if (weakened.includes("tab-sandbox")) {
    out = withoutDocumentSandbox(out);
  }
  if (weakened.includes("permissions-policy")) {
    out = withoutPermissionsPolicy(out);
  }
  if (servedShellWeakened() && (out.headers.get("content-type") ?? "").startsWith("text/html")) {
    out = new Response(weakenServed(await out.text()), {
      status: out.status,
      headers: out.headers,
    });
  }
  return out;
}

/** A host whose clean addresses follow the usual convention: `/` the latest, `/v/<n>/` pinned. */
export interface TabHost {
  /** A scope's origin (`http://a-<scope>.files.localhost:<port>`). */
  origin(scope: string): string;
  /** The versions of each scope by number, and which is the latest. */
  readonly versions: Map<string, Map<string, StoredFiles>>;
  readonly latest: Map<string, string>;
  /** Every content URL the host was asked for, in order. */
  readonly requests: string[];
}

let tabHost: Promise<TabHost> | null = null;

/** The worker's tab host, started on first use: the app and its content on one loopback port. */
export const startTabHost = (): Promise<TabHost> => (tabHost ??= start());

async function start(): Promise<TabHost> {
  const versions = new Map<string, Map<string, StoredFiles>>();
  const latest = new Map<string, string>();
  const requests: string[] = [];
  const instance = (scope: string, version: string): InstanceRef => ({
    scope,
    document: { kind: "artifact", id: scope, version },
  });
  let content: ReturnType<typeof createContentHost<{ id: string }>> | null = null;
  const server = nodeServer({
    content: () => content,
    app: async (request) => {
      const answer = await content?.routes(() => ({ id: "ada" }))(request);
      return answer ?? new Response("not found", { status: 404 });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const domain = `files.localhost:${port}`;
  const made = createContentHost<{ id: string }>({
    domain,
    appOrigins: [`http://127.0.0.1:${port}`],
    secret: "the files cases' secret, thirty-two bytes or more",
    configs: (source) => ({
      artifact: presets.artifact({ isolation: "domain", contentOrigins: [source] }),
    }),
    name: prefixedName("a-"),
    instance: () => null,
    access: (_instance, viewer) => (viewer === null ? null : { viewer: viewer.id }),
    source: (id, version) => Promise.resolve(versions.get(id)?.get(version) ?? null),
    entry: {
      at: (scope, address) => {
        const at = versionedAddress(address);
        const version = at === null ? null : (at.version ?? latest.get(scope) ?? null);
        return at === null || version === null || versions.get(scope)?.get(version) === undefined
          ? null
          : {
              instance: instance(scope, version),
              base: versionBase(version),
              file: at.file,
              pinned: true,
            };
      },
    },
  });
  // The harness's controls reach this host's answers too.
  const fetchContent = made.fetch.bind(made);
  content = Object.assign(made, {
    fetch: async (request: Request) => {
      if (made.owns(request)) {
        requests.push(request.url);
      }
      const answer = await fetchContent(
        weakened.includes("service-worker") ? asServiceWorkerAllowed(request) : request,
      );
      return answer === null ? null : weakenAnswer(answer);
    },
  });
  return {
    origin: (scope) => `http://a-${scope}.${domain}`,
    versions,
    latest,
    requests,
  };
}
