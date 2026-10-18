import { Refused } from "../../src/bridge/refusal.ts";
import { admitFiles } from "../../src/check/tools.ts";
import type { PortholeConfig } from "../../src/config/schema.ts";
import { checkFileSet } from "../../src/files/paths.ts";
import type { CallContext, CapabilityHandlers, DbContext } from "../../src/bridge/types.ts";
import {
  dbAccess,
  type DbData,
  type DbRequest,
  type DbRules,
  type DbSnapshot,
  type DbWrite,
} from "../../src/runtime/db.ts";
import { atLeast, type ViewerInfo, type ViewerLevel } from "../../src/runtime/levels.ts";
import {
  assetUrl,
  type ArtifactInfo,
  type AssetInfo,
  type CommentAnchor,
} from "../../src/runtime/requests.ts";

/**
 * The reference app's capability services, in memory (P085–P090): what Ferry and raft-artifacts
 * implement over their stores, written once here so the leak suite and the runtime's conformance
 * cases (`defineRuntimeConformance`) run every handler end to end. Plain web APIs only: it runs in
 * Node and in the leak harness's host page alike.
 *
 * It is a host: it checks again what the bridge checked (levels, the per-user data, a base), as a
 * real app's API must, since that is its data's wall; and it records every call it is asked, the
 * leak suite's oracle for "the handler never ran".
 */

export interface MemoryAsset {
  readonly id: string;
  readonly scope: string;
  /** The artifact whose library holds it. */
  readonly artifact: string;
  /** May run as code (the upload's `trusted`, P089). */
  readonly trusted: boolean;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface MemoryRuntimeOptions {
  /** The storage scope the artifact is served on (its assets' origin). */
  readonly scope?: string;
  /** The artifact's id (its assets' owner). Default `page`. */
  readonly artifact?: string;
  /** The config a published version is admitted under (`admitFiles`), as a real host does. */
  readonly config?: PortholeConfig;
  /** The artifact's first version's files, by path (text). */
  readonly files?: Readonly<Record<string, string>>;
  /** Who may upload assets (the host's config says the same: `assets.levels.upload`). */
  readonly uploadLevel?: ViewerLevel;
  /** Told of each asset added or removed (the leak harness keeps them on its server too). */
  readonly onAsset?: (asset: MemoryAsset, removed: boolean) => void | Promise<void>;
  /** What the comment composer answers (default: it opened). */
  readonly composer?: (anchor: CommentAnchor) => boolean;
}

export interface MemoryCall {
  readonly capability: string;
  readonly args: unknown;
  readonly viewer: string | null;
}

interface Doc {
  version: number;
  data: DbData;
}

interface Version {
  readonly id: string;
  readonly number: number;
  readonly entry: string;
  readonly files: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly sha256: string }>;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const encoder = new TextEncoder();

/** Whether a document path is in a collection, directly. */
const inCollection = (path: string, collection: string): boolean =>
  path.startsWith(`${collection}/`) && !path.slice(collection.length + 1).includes("/");

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return String(a).localeCompare(String(b));
}

function matches(data: DbData, [field, op, value]: readonly [string, string, unknown]): boolean {
  const have = (data as Record<string, unknown>)[field];
  switch (op) {
    case "==":
      return JSON.stringify(have) === JSON.stringify(value);
    case "!=":
      return JSON.stringify(have) !== JSON.stringify(value);
    case "<":
      return have !== undefined && compare(have, value) < 0;
    case "<=":
      return have !== undefined && compare(have, value) <= 0;
    case ">":
      return have !== undefined && compare(have, value) > 0;
    case ">=":
      return have !== undefined && compare(have, value) >= 0;
    case "in":
      return (
        Array.isArray(value) && value.some((each) => JSON.stringify(each) === JSON.stringify(have))
      );
    case "array-contains":
      return (
        Array.isArray(have) && have.some((each) => JSON.stringify(each) === JSON.stringify(value))
      );
    default:
      return false;
  }
}

export function memoryRuntime(options: MemoryRuntimeOptions = {}) {
  const scope = options.scope ?? "art-1";
  const artifactId = options.artifact ?? "page";
  const calls: MemoryCall[] = [];
  const docs = new Map<string, Doc>();
  const watchers = new Set<{
    readonly path: string;
    readonly changed: (state?: unknown) => void;
  }>();
  const versions: Version[] = [];
  const assets = new Map<string, MemoryAsset>();
  const uploadLevel = options.uploadLevel ?? "admin";

  const ready = (async () => {
    const files = new Map<string, { bytes: Uint8Array; sha256: string }>();
    for (const [path, text] of Object.entries(
      options.files ?? { "index.html": "<!doctype html><title>Page</title><p>v1</p>" },
    )) {
      const bytes = encoder.encode(text);
      files.set(path, { bytes, sha256: await sha256(bytes) });
    }
    versions.push({ id: "ver_1", number: 1, entry: "index.html", files });
  })();

  const note = (capability: string, args: unknown, context: CallContext) => {
    calls.push({ capability, args, viewer: context.viewer?.id ?? null });
  };

  const snapshot = (path: string): DbSnapshot => {
    const doc = docs.get(path);
    const id = path.slice(path.lastIndexOf("/") + 1);
    return doc === undefined
      ? { path, id, exists: false, version: 0 }
      : { path, id, exists: true, version: doc.version, data: doc.data };
  };
  const stateOf = (path: string): DbSnapshot | { docs: DbSnapshot[] } =>
    path.split("/").length % 2 === 0
      ? snapshot(path)
      : {
          // As a query answers it: at most its limit (after the review).
          docs: [...docs.keys()]
            .filter((each) => inCollection(each, path))
            .sort()
            .slice(0, 500)
            .map(snapshot),
        };
  const tell = (paths: readonly string[]) => {
    for (const watcher of watchers) {
      if (paths.some((path) => path === watcher.path || inCollection(path, watcher.path))) {
        watcher.changed(stateOf(watcher.path));
      }
    }
  };

  /** A write's check against what is stored: the version it read. */
  const conflicts = (write: DbWrite, pending: ReadonlyMap<string, number> = new Map()): boolean => {
    const current = pending.get(write.path) ?? docs.get(write.path)?.version ?? 0;
    // An update needs a document that exists; every write to one that exists names the version
    // it read (after the review: update and delete too).
    if (write.op === "update" && current === 0) {
      return true;
    }
    return write.ifVersion === undefined ? current !== 0 : write.ifVersion !== current;
  };
  const apply = (write: DbWrite): number | null => {
    if (write.op === "delete") {
      docs.delete(write.path);
      return null;
    }
    const current = docs.get(write.path);
    const data = write.op === "update" ? { ...current?.data, ...write.data } : write.data;
    const version = (current?.version ?? 0) + 1;
    docs.set(write.path, { version, data });
    return version;
  };

  const handlers: CapabilityHandlers = {
    db: (args: DbRequest, context: DbContext) => {
      note("db", args, context);
      // The host's own wall: the same rules the bridge applied, again (P088).
      const access = dbAccess(args, context.viewer, context.declared?.rules);
      if (!access.ok) {
        throw new Refused("forbidden");
      }
      const request = access.request;
      switch (request.op) {
        case "get":
          return snapshot(request.path);
        case "query": {
          let found = [...docs.keys()]
            .filter((path) => inCollection(path, request.collection))
            .sort()
            .map(snapshot)
            .filter((each) =>
              (request.where ?? []).every((where) => matches(each.data ?? {}, where)),
            );
          if (request.orderBy !== undefined) {
            const { field, direction } = request.orderBy;
            found = found.sort(
              (a, b) =>
                compare((a.data ?? {})[field], (b.data ?? {})[field]) *
                (direction === "desc" ? -1 : 1),
            );
          }
          return { docs: found.slice(0, request.limit ?? 500) };
        }
        case "set":
        case "update":
        case "delete": {
          if (conflicts(request)) {
            throw new Refused("conflict");
          }
          const version = apply(request);
          tell([request.path]);
          return request.op === "delete" ? undefined : { version: version ?? 0 };
        }
        case "batch": {
          // All or none: every write checked, in order, against the state the ones before it
          // leave, before any is applied.
          const pending = new Map<string, number>();
          for (const write of request.writes) {
            if (conflicts(write, pending)) {
              throw new Refused("conflict");
            }
            const before = pending.get(write.path) ?? docs.get(write.path)?.version ?? 0;
            pending.set(write.path, write.op === "delete" ? 0 : before + 1);
          }
          const written = request.writes.map(apply);
          tell(request.writes.map((each) => each.path));
          return { versions: written };
        }
        case "watch": {
          const { changed, signal } = context;
          if (changed === undefined || signal === undefined) {
            throw new Refused("not_allowed");
          }
          const watcher = { path: request.path, changed };
          watchers.add(watcher);
          signal.addEventListener("abort", () => watchers.delete(watcher), { once: true });
          changed(stateOf(request.path));
          return undefined;
        }
      }
    },
    artifact: async (args, context) => {
      note("artifact", args, context);
      await ready;
      const current = versions.at(-1) as Version;
      if (args.op === "get") {
        return {
          version: current.id,
          number: current.number,
          entry: current.entry,
          files: [...current.files].map(([path, file]) => ({
            path,
            size: file.bytes.length,
            sha256: file.sha256,
          })),
        } satisfies ArtifactInfo;
      }
      if (context.viewer === undefined || !atLeast(context.viewer.level, "admin")) {
        throw new Refused("forbidden");
      }
      if (args.base !== current.id) {
        throw new Refused("conflict");
      }
      const files = new Map(current.files);
      for (const [path, file] of Object.entries(args.files)) {
        if (file === null) {
          files.delete(path);
          continue;
        }
        const bytes = "text" in file ? encoder.encode(file.text) : fromBase64(file.base64);
        files.set(path, { bytes, sha256: await sha256(bytes) });
      }
      // The merged set is a version like any other: checked whole, and admitted (after the review).
      const entry = args.entry ?? current.entry;
      const manifest = Object.fromEntries(
        [...files].map(([path, file]) => [path, { size: file.bytes.length }]),
      );
      if (checkFileSet(manifest, { entry }).length > 0) {
        throw new Refused("not_allowed", "That version's files don't make a page.");
      }
      if (options.config !== undefined) {
        const decoder = new TextDecoder();
        const contents = Object.fromEntries(
          [...files].map(([path, file]) => [
            path,
            /\.(html?|css|m?js|json|svg|txt|md)$/u.test(path)
              ? decoder.decode(file.bytes)
              : file.bytes,
          ]),
        );
        if (!admitFiles(options.config, contents, { entry }).ok) {
          throw new Refused("not_allowed", "That version would not load.");
        }
      }
      const number = current.number + 1;
      versions.push({ id: `ver_${number}`, number, entry, files });
      return { version: `ver_${number}`, number };
    },
    assets: async (args, context) => {
      note("assets", args, context);
      const level = context.viewer?.level;
      const info = (asset: MemoryAsset): AssetInfo => ({
        id: asset.id,
        url: assetUrl(asset.id),
        name: asset.name,
        type: asset.type,
        size: asset.size,
      });
      switch (args.op) {
        case "list":
          return [...assets.values()].map(info);
        case "upload": {
          if (level === undefined || !atLeast(level, uploadLevel)) {
            throw new Refused("forbidden");
          }
          const bytes = fromBase64(args.base64);
          const id = hex(crypto.getRandomValues(new Uint8Array(16)));
          const asset: MemoryAsset = {
            id,
            scope,
            artifact: artifactId,
            trusted: args.trusted,
            name: args.name,
            type: args.type,
            size: bytes.length,
            sha256: await sha256(bytes),
            bytes,
          };
          assets.set(id, asset);
          await options.onAsset?.(asset, false);
          return info(asset);
        }
        case "delete": {
          if (level === undefined || !atLeast(level, "admin")) {
            throw new Refused("forbidden");
          }
          const asset = assets.get(args.id);
          if (asset === undefined) {
            return false;
          }
          assets.delete(args.id);
          await options.onAsset?.(asset, true);
          return true;
        }
      }
    },
    comments: (args, context) => {
      note("comments", args, context);
      return options.composer?.(args.anchor) ?? true;
    },
    sendPrompt: (args, context) => {
      note("sendPrompt", args, context);
      return true;
    },
    copyText: (args, context) => {
      note("copyText", args, context);
      return true;
    },
    openLink: (args, context) => {
      note("openLink", args, context);
      return true;
    },
    downloadFile: (args, context) => {
      note("downloadFile", args, context);
      return true;
    },
    setModelContext: (args, context) => {
      note("setModelContext", args, context);
      return undefined;
    },
    readData: (args, context) => {
      note("readData", args, context);
      return { contents: [{ uri: args.uri, mimeType: "application/json", text: '{"n":1}' }] };
    },
    subscribeData: (args, context) => {
      note("subscribeData", args, context);
      return undefined;
    },
    callTool: (args, context) => {
      note("callTool", args, context);
      return { content: [{ type: "text", text: `called ${args.name}` }] };
    },
  };

  /**
   * The services as the app's own API answers a signed-in person (the conformance cases' raw
   * mode): who asks is the session's, never the context a page's bridge passed (which a page past
   * the bridge could forge), and the page's rules are the stored declaration's.
   */
  const api = (viewer: ViewerInfo, rules?: DbRules): CapabilityHandlers => {
    const bound: Record<string, (args: unknown, context: CallContext) => unknown> = {};
    for (const [name, handler] of Object.entries(handlers)) {
      bound[name] = (args, context) =>
        (handler as (args: unknown, context: unknown) => unknown)(args, {
          ...context,
          viewer,
          ...(rules === undefined ? {} : { declared: { rules } }),
        });
    }
    return bound;
  };

  return {
    handlers,
    api,
    calls,
    docs,
    versions,
    assets,
    /** The asset library as `/server` reads it (`ServerOptions.assets`). */
    assetStore: {
      get: async (id: string) => {
        const asset = assets.get(id);
        return asset === undefined
          ? null
          : {
              scope: asset.scope,
              artifact: asset.artifact,
              trusted: asset.trusted,
              name: asset.name,
              size: asset.size,
              sha256: asset.sha256,
              read: () => Promise.resolve(asset.bytes),
            };
      },
    },
    ready,
  };
}
