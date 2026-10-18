import { createBridge } from "../bridge/bridge.ts";
import type { CallOutcome, CapabilityHandlers } from "../bridge/types.ts";
import { isRefused } from "../bridge/refusal.ts";
import type { CapabilityName } from "../config/capabilities.ts";
import type { PortholeConfig } from "../config/schema.ts";
import type { InstanceRef } from "../isolation/types.ts";
import { RUNTIME_VERSION } from "../runtime/contract.ts";
import { checkDeclaration, type CapabilityDeclaration } from "../runtime/declaration.ts";
import type { DbSnapshot } from "../runtime/db.ts";
import type { ViewerInfo } from "../runtime/levels.ts";
import { ASSET_ID, assetUrl, type AssetInfo } from "../runtime/requests.ts";
import type { AssetStore } from "../server/types.ts";

/**
 * The capability runtime's host conformance (P085–P090): cases an app runs against its own
 * handlers (the ones it gives `createHost`), through Porthole's real bridge, as a page would call
 * them, and straight to the handler, as a page that got past the bridge would (the app's API is
 * its data's wall). No browser and no test runner: each case is a function that throws on a
 * failure; register them with yours (P041), `for (const each of cases) test(each.name, each.run)`.
 *
 * What a host's services must do: `db` versions every write and refuses a stale one (`conflict`),
 * applies a batch whole or not at all, follows a document, keeps each person's `data/users/<id>`
 * theirs and the page's rules; `artifact` answers its current version and refuses a publish from
 * a base that moved, or by someone below admin; `assets` stores an upload where `/server` serves
 * it, lists it, and removes it; `comments` answers only whether the composer opened.
 */

export interface RuntimeConformanceOptions {
  /** The config the handlers serve under, its runtime capabilities declared. */
  readonly config: PortholeConfig;
  /**
   * Fresh handlers for one artifact, made for each case (a new artifact, a clean store): the
   * functions the app passes `createHost`.
   */
  readonly handlers: () => CapabilityHandlers | Promise<CapabilityHandlers>;
  /** People at each level; `other` is a second person at interact (whose data isn't `interact`'s). */
  readonly viewers: {
    readonly view: ViewerInfo;
    readonly interact: ViewerInfo;
    readonly admin: ViewerInfo;
    readonly other: ViewerInfo;
  };
  /** The instance the handlers act on, as the app's mount names it. */
  readonly instance?: InstanceRef;
  /** The asset store `/server` serves from (`ServerOptions.assets`), to see an upload served. */
  readonly assets?: (handlers: CapabilityHandlers) => AssetStore;
  /** The page's db rules the cases declare (default: `config` writable by admins only). */
  readonly rules?: Readonly<
    Record<string, { read?: ViewerInfo["level"]; write?: ViewerInfo["level"] }>
  >;
}

export interface RuntimeCase {
  readonly name: string;
  run(): Promise<void>;
}

class ConformanceFailure extends Error {
  override name = "ConformanceFailure";
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ConformanceFailure(message);
  }
}

const codeOf = (outcome: CallOutcome<unknown>): string | null =>
  outcome.ok ? null : (outcome.reason?.code ?? null);

const ok = <T>(outcome: CallOutcome<T>, what: string): T => {
  if (!outcome.ok) {
    throw new ConformanceFailure(
      `${what}: refused (${outcome.refusal}, ${outcome.reason?.code ?? "no code"}): ${outcome.message ?? ""}`,
    );
  }
  return outcome.value;
};

/** The runtime's conformance cases for an app's handlers. */
export function defineRuntimeConformance(
  options: RuntimeConformanceOptions,
): readonly RuntimeCase[] {
  const { config, viewers } = options;
  const rules = options.rules ?? { config: { write: "admin" } };
  const declared: CapabilityDeclaration = {
    ...(config.capabilities.db === undefined ? {} : { db: { rules } }),
    ...(config.capabilities.artifact === undefined ? {} : { artifact: {} }),
    ...(config.capabilities.assets === undefined ? {} : { assets: {} }),
  };
  const declaration = checkDeclaration(
    { capabilities: declared, runtime: RUNTIME_VERSION },
    config,
  );
  const display = {
    id: "conformance",
    title: "Runtime conformance",
    ...(options.instance === undefined ? {} : { instance: options.instance }),
  };

  /** A page's calls as `viewer`, through the bridge. */
  const as = (handlers: CapabilityHandlers, viewer: ViewerInfo) => {
    const bridge = createBridge({
      config,
      display,
      handlers,
      declaration,
      viewer,
      // Gates the person answers are the app's UI: a yes here, so the services are what's tested.
      confirm: () => Promise.resolve(true),
      consent: () => true,
      userActivation: () => true,
      onEvent: () => {},
    });
    return (
      capability: CapabilityName,
      args: unknown,
      subscription?: Parameters<typeof bridge.call>[2],
    ) => bridge.call(capability, args, subscription);
  };

  /** A call straight to the handler, as a page past the bridge would make it (the app's wall). */
  const direct = async (
    handlers: CapabilityHandlers,
    capability: "db" | "artifact" | "assets",
    args: unknown,
    viewer: ViewerInfo,
  ): Promise<{ ok: true; value: unknown } | { ok: false; code: string | null }> => {
    const handler = handlers[capability] as
      | ((args: unknown, context: unknown) => unknown)
      | undefined;
    if (handler === undefined) {
      throw new ConformanceFailure(`no ${capability} handler`);
    }
    try {
      const value = await handler(args, {
        displayId: display.id,
        title: display.title,
        capability,
        viewer,
        ...(options.instance === undefined ? {} : { instance: options.instance }),
        ...(capability === "db" ? { declared: { rules } } : {}),
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, code: isRefused(error) ? error.code : null };
    }
  };

  const cases: RuntimeCase[] = [];
  const add = (name: string, run: (handlers: CapabilityHandlers) => Promise<void>) => {
    cases.push({ name, run: async () => run(await options.handlers()) });
  };

  if (config.capabilities.db !== undefined) {
    add("db: a set is read back, versioned from 1", async (handlers) => {
      const call = as(handlers, viewers.interact);
      const set = ok(await call("db", { op: "set", path: "notes/a", data: { text: "hi" } }), "set");
      expect((set as { version: number }).version === 1, "a first write is version 1");
      const got = ok(await call("db", { op: "get", path: "notes/a" }), "get") as DbSnapshot;
      expect(got.exists && got.version === 1 && got.data?.text === "hi", "get reads it back");
      const missing = ok(await call("db", { op: "get", path: "notes/none" }), "get") as DbSnapshot;
      expect(
        !missing.exists && missing.version === 0,
        "a missing document: exists false, version 0",
      );
    });
    add(
      "db: a write that names a stale version, or none for a document that exists, is a conflict",
      async (handlers) => {
        const call = as(handlers, viewers.interact);
        ok(await call("db", { op: "set", path: "notes/a", data: { n: 1 } }), "set");
        expect(
          codeOf(await call("db", { op: "set", path: "notes/a", data: { n: 2 } })) === "conflict",
          "set without ifVersion over an existing document: conflict",
        );
        expect(
          codeOf(
            await call("db", { op: "update", path: "notes/a", data: { n: 2 }, ifVersion: 7 }),
          ) === "conflict",
          "update with a stale ifVersion: conflict",
        );
        const updated = ok(
          await call("db", { op: "update", path: "notes/a", data: { m: 3 }, ifVersion: 1 }),
          "update",
        ) as { version: number };
        expect(updated.version === 2, "an update with the right version is the next one");
        const got = ok(await call("db", { op: "get", path: "notes/a" }), "get") as DbSnapshot;
        expect(got.data?.n === 1 && got.data?.m === 3, "update merges fields");
        expect(
          codeOf(await call("db", { op: "set", path: "notes/b", data: {}, ifVersion: 0 })) === null,
          "ifVersion 0 creates",
        );
        ok(await call("db", { op: "delete", path: "notes/a", ifVersion: 2 }), "delete");
        const gone = ok(await call("db", { op: "get", path: "notes/a" }), "get") as DbSnapshot;
        expect(!gone.exists, "a deleted document is gone");
      },
    );
    add(
      "db: a query answers a collection's documents, filtered, ordered, limited",
      async (handlers) => {
        const call = as(handlers, viewers.interact);
        for (const [id, score] of [
          ["a", 3],
          ["b", 1],
          ["c", 2],
        ] as const) {
          ok(await call("db", { op: "set", path: `scores/${id}`, data: { score } }), "set");
        }
        ok(await call("db", { op: "set", path: "scores/a/history/1", data: { score: 9 } }), "set");
        const found = ok(
          await call("db", {
            op: "query",
            collection: "scores",
            where: [["score", ">=", 2]],
            orderBy: { field: "score", direction: "desc" },
            limit: 5,
          }),
          "query",
        ) as { docs: DbSnapshot[] };
        expect(
          JSON.stringify(found.docs.map((each) => each.id)) === '["a","c"]',
          `a query answers its collection's own documents, filtered and ordered: ${JSON.stringify(found.docs.map((each) => each.id))}`,
        );
      },
    );
    add("db: a batch is applied whole or not at all", async (handlers) => {
      const call = as(handlers, viewers.interact);
      ok(await call("db", { op: "set", path: "items/x", data: { n: 1 } }), "set");
      const refused = await call("db", {
        op: "batch",
        writes: [
          { op: "set", path: "items/y", data: { n: 1 } },
          { op: "update", path: "items/x", data: { n: 2 }, ifVersion: 9 },
        ],
      });
      expect(codeOf(refused) === "conflict", "a batch with a stale write: conflict");
      const y = ok(await call("db", { op: "get", path: "items/y" }), "get") as DbSnapshot;
      expect(!y.exists, "nothing of a refused batch is written");
      const done = ok(
        await call("db", {
          op: "batch",
          writes: [
            { op: "set", path: "items/y", data: { n: 1 } },
            { op: "update", path: "items/x", data: { n: 2 }, ifVersion: 1 },
          ],
        }),
        "batch",
      ) as { versions: (number | null)[] };
      expect(JSON.stringify(done.versions) === "[1,2]", "a batch answers each write's version");
    });
    add("db: a watch hears the document now and at each change", async (handlers) => {
      const heard: DbSnapshot[] = [];
      const controller = new AbortController();
      const watching = as(handlers, viewers.view);
      ok(
        await watching(
          "db",
          { op: "watch", path: "notes/w" },
          {
            subscription: {
              changed: (state) => heard.push(state as DbSnapshot),
              signal: controller.signal,
            },
          },
        ),
        "watch",
      );
      ok(
        await as(handlers, viewers.interact)("db", { op: "set", path: "notes/w", data: { n: 1 } }),
        "set",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      ok(
        await as(handlers, viewers.interact)("db", {
          op: "set",
          path: "notes/w",
          data: { n: 2 },
          ifVersion: 1,
        }),
        "set",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        heard.length >= 1 && heard.some((each) => each.exists && each.data?.n === 1),
        "a watch hears a write",
      );
      expect(!heard.some((each) => each.data?.n === 2), "a watch ends with its signal");
    });
    add(
      "db: a person's own data is theirs: data/users/me is them, another's is refused, even past the bridge",
      async (handlers) => {
        const mine = as(handlers, viewers.interact);
        ok(
          await mine("db", { op: "set", path: "data/users/me/prefs", data: { dark: true } }),
          "set own",
        );
        const own = ok(
          await mine("db", { op: "get", path: `data/users/${viewers.interact.id}/prefs` }),
          "get own",
        ) as DbSnapshot;
        expect(own.exists, "me is the viewer's own id");
        const theirs = as(handlers, viewers.other);
        const path = `data/users/${viewers.interact.id}/prefs`;
        expect(
          codeOf(await theirs("db", { op: "get", path })) === "forbidden",
          "another person's data: forbidden",
        );
        const past = await direct(handlers, "db", { op: "get", path }, viewers.other);
        expect(!past.ok, "the app's handler refuses another person's data itself");
        const listed = await direct(
          handlers,
          "db",
          { op: "query", collection: `data/users/${viewers.interact.id}` },
          viewers.other,
        );
        expect(!listed.ok, "and their collections");
      },
    );
    add("db: the page's rules hold, at the bridge and in the app", async (handlers) => {
      expect(
        codeOf(
          await as(handlers, viewers.interact)("db", { op: "set", path: "config/main", data: {} }),
        ) === "forbidden",
        "a rule's write level holds at the bridge",
      );
      const past = await direct(
        handlers,
        "db",
        { op: "set", path: "config/main", data: {} },
        viewers.interact,
      );
      expect(!past.ok, "the app's handler applies the page's rules itself");
      const view = await direct(
        handlers,
        "db",
        { op: "set", path: "notes/v", data: {} },
        viewers.view,
      );
      expect(!view.ok, "a view-only person writes nothing, even past the bridge");
      ok(
        await as(handlers, viewers.admin)("db", { op: "set", path: "config/main", data: {} }),
        "an admin writes it",
      );
    });
  }

  if (config.capabilities.artifact !== undefined) {
    add(
      "artifact: get answers the current version; a publish from it makes the next",
      async (handlers) => {
        const call = as(handlers, viewers.admin);
        const current = ok(await call("artifact", { op: "get" }), "get") as {
          version: string;
          files: { path: string }[];
        };
        expect(
          typeof current.version === "string" && Array.isArray(current.files),
          "get: { version, files }",
        );
        const published = ok(
          await call("artifact", {
            op: "publish",
            base: current.version,
            files: { "notes.txt": { text: "new" } },
            label: "From the page",
          }),
          "publish",
        ) as { version: string };
        expect(published.version !== current.version, "a publish makes a new version");
        const after = ok(await call("artifact", { op: "get" }), "get") as {
          version: string;
          files: { path: string }[];
        };
        expect(after.version === published.version, "the new version is current");
        expect(
          after.files.some((each) => each.path === "notes.txt"),
          "with the patch applied",
        );
        expect(
          current.files.every((file) => after.files.some((each) => each.path === file.path)),
          "and the base's other files kept",
        );
      },
    );
    add(
      "artifact: a publish from a base that moved is a conflict; below admin, refused even past the bridge",
      async (handlers) => {
        const call = as(handlers, viewers.admin);
        const current = ok(await call("artifact", { op: "get" }), "get") as { version: string };
        ok(
          await call("artifact", {
            op: "publish",
            base: current.version,
            files: { "a.txt": { text: "1" } },
          }),
          "publish",
        );
        expect(
          codeOf(
            await call("artifact", {
              op: "publish",
              base: current.version,
              files: { "a.txt": { text: "2" } },
            }),
          ) === "conflict",
          "a stale base: conflict",
        );
        expect(
          codeOf(
            await as(handlers, viewers.interact)("artifact", {
              op: "publish",
              base: "x",
              files: { "a.txt": { text: "3" } },
            }),
          ) === "forbidden",
          "below admin: forbidden at the bridge",
        );
        const now = ok(await call("artifact", { op: "get" }), "get") as { version: string };
        const past = await direct(
          handlers,
          "artifact",
          { op: "publish", base: now.version, files: { "a.txt": { text: "4" } } },
          viewers.interact,
        );
        expect(!past.ok, "the app's handler refuses a publish below admin itself");
      },
    );
  }

  if (config.capabilities.assets !== undefined) {
    add("assets: an upload is listed, served by its id, and removed", async (handlers) => {
      const call = as(handlers, viewers.admin);
      const bytes = "R0lGODlhAQABAAAAACw="; // a small GIF's start: its bytes, as base64
      const asset = ok(
        await call("assets", { op: "upload", name: "pixel.gif", base64: bytes }),
        "upload",
      ) as AssetInfo;
      expect(ASSET_ID.test(asset.id), "an asset's id is 32 lowercase hex characters");
      expect(asset.url === assetUrl(asset.id), "its url is /_blob/<id>");
      expect(
        asset.type === "image/gif" && asset.size === 14,
        "its type is the name's; its size the bytes'",
      );
      const listed = ok(
        await as(handlers, viewers.view)("assets", { op: "list" }),
        "list",
      ) as AssetInfo[];
      expect(
        listed.some((each) => each.id === asset.id),
        "the library lists it",
      );
      const store = options.assets?.(handlers);
      if (store !== undefined) {
        const stored = await store.get(asset.id);
        expect(stored !== null && stored.size === 14, "the server's store has it");
        const body = await stored?.read();
        const length =
          body instanceof Uint8Array
            ? body.length
            : body === null || body === undefined
              ? -1
              : (await new Response(body).arrayBuffer()).byteLength;
        expect(length === 14, "with its bytes");
      }
      ok(await call("assets", { op: "delete", id: asset.id }), "delete");
      const after = ok(await call("assets", { op: "list" }), "list") as AssetInfo[];
      expect(!after.some((each) => each.id === asset.id), "a removed asset isn't listed");
      if (store !== undefined) {
        expect((await store.get(asset.id)) === null, "nor served");
      }
    });
    add("assets: removing is the admins', even past the bridge", async (handlers) => {
      const asset = ok(
        await as(handlers, viewers.admin)("assets", {
          op: "upload",
          name: "a.txt",
          base64: "aGk=",
        }),
        "upload",
      ) as AssetInfo;
      expect(
        codeOf(await as(handlers, viewers.interact)("assets", { op: "delete", id: asset.id })) ===
          "forbidden",
        "below admin: forbidden at the bridge",
      );
      const past = await direct(handlers, "assets", { op: "delete", id: asset.id }, viewers.view);
      expect(
        !past.ok || past.value !== true,
        "the app's handler refuses a removal below admin itself",
      );
    });
  }

  if (config.capabilities.comments !== undefined) {
    add("comments: content hears only whether the composer opened", async (handlers) => {
      const opened = ok(
        await as(handlers, viewers.view)("comments", {
          anchor: { name: "slide-3", label: "Slide 3" },
        }),
        "open",
      );
      expect(typeof opened === "boolean", "comments.open answers a boolean");
    });
  }
  return cases;
}
