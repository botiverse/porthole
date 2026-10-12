import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Frame, type Page, type TestType } from "@playwright/test";
import type { PortholeConfig } from "../config/schema.ts";
import type { FrameLocation, InstanceRef } from "../isolation/types.ts";
import { entryTests, type EntryConformanceHost } from "./entry.ts";
import type { ConformanceHarness } from "./harness/page.ts";
import type { FrameOutcome } from "../host/types.ts";
import type { ConformanceHost, LaunchedDisplay, LaunchSpec } from "./index.ts";
import { leakTests, type ConformanceFixtures } from "./probes.ts";
import { servedTests, type ServedConformanceHost, type ServedDisplay } from "./served.ts";

/**
 * The conformance runner (P066): an app points it at its real page (its CSP, its nonce, its
 * session) and its issue endpoint; Porthole loads its own harness there (framework-free, on the
 * core's `createHost`), routes the canaries and a foreign origin, and registers the leak and
 * served suites in the app's Playwright project:
 *
 *   defineHostConformance(test, {
 *     name: "my-app",
 *     open: async (page) => { await signIn(page); await page.goto("/viewer"); },
 *     issue: { url: "/api/frames" },             // the app's ContentHost.issue route
 *     config: (instance) => servedConfigs[presetOf(instance)],
 *     instances: { shell: (scope) => ({ scope, document: { kind: "shell", preset: "widget" } }) },
 *   });
 */

export interface HostConformanceOptions {
  readonly name: string;
  /** Opens the app's real page in `page` as a person sees it (signed in); the harness runs there. */
  readonly open: (page: Page) => Promise<void>;
  /**
   * The page's script nonce, where its CSP is nonce-based. Default: the first `script[nonce]`'s.
   * The harness loads as a script from the page's own origin, so `'self'` policies need none.
   */
  readonly nonce?: (page: Page) => Promise<string | undefined>;
  /**
   * The app's issue endpoint (`ContentHost.issue`), relative to the page: the harness asks it from
   * the page with the page's own cookies, as the app's client does (`httpLocator`).
   */
  readonly issue?: { readonly url: string; readonly headers?: Readonly<Record<string, string>> };
  /** Or the location for an instance, got the test's own way. */
  readonly locate?: (instance: InstanceRef, page: Page) => Promise<FrameLocation>;
  /** The config a served instance is framed under (the app's served config for its preset). */
  readonly config: (instance: InstanceRef) => PortholeConfig;
  /**
   * The instances the served cases ask for, each for the scope a case names. `shell` runs the
   * domain-mode cases; `artifact` (versions of one stored page), `app` (url mode) and `proxy` (the
   * MCP Apps sandbox proxy) run theirs where given, and are skipped (with the reason) where not.
   */
  readonly instances: Pick<ServedConformanceHost, "shell"> &
    Partial<Pick<ServedConformanceHost, "artifact" | "app" | "proxy">>;
  /**
   * Redirect entry (P068), where the app serves clean addresses: the cases open them directly,
   * signed in and out, and in a frame.
   */
  readonly entry?: {
    /** The clean address of `instances.artifact(scope, "1")` (`ContentHost.urlOf`). */
    readonly url: (scope: string) => string;
    /** A clean address the signed-in viewer may not open. */
    readonly denied: (scope: string) => string;
    /** Whether `page` shows the app's own sign-in. */
    readonly atSignIn: (page: Page) => Promise<boolean>;
    /** On the app's sign-in page: signs in, as a person does. */
    readonly completeSignIn: (page: Page) => Promise<void>;
  };
  /** Case ids to skip, each with its reason (shown in the report). */
  readonly skip?: Readonly<Record<string, string>>;
}

const CANARY = "https://porthole-canary.example";
/** A page on no one's origin that frames what a case asks (routed by the test, like the canary). */
const FOREIGN = "http://porthole-foreign.example";
/** Where the harness loads from, on the app's own origin (routed by the test, never the app's). */
const HARNESS_PATH = "/__porthole/conformance/harness.js";

let built: Promise<string> | null = null;

/**
 * The harness as one script: from the package (`dist/conformance/harness.js`), or, run from the
 * sources, bundled now (esbuild, a development dependency of Porthole's).
 */
export function harnessScript(): Promise<string> {
  built ??= (async () => {
    try {
      return await readFile(new URL("./harness.js", import.meta.url), "utf8");
    } catch {
      const { build } = await import("esbuild");
      const result = await build({
        entryPoints: [fileURLToPath(new URL("./harness/page.ts", import.meta.url))],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2022",
        write: false,
        logLevel: "silent",
      });
      const text = result.outputFiles[0]?.text;
      if (text === undefined) {
        throw new Error("the conformance harness didn't build");
      }
      return text;
    }
  })();
  return built;
}

type Harness = Record<string, ((...args: unknown[]) => unknown) | undefined>;

/** Calls one of the harness's methods in the page. */
function invoke<K extends keyof ConformanceHarness>(
  page: Page,
  method: K,
  ...args: Parameters<ConformanceHarness[K]>
): Promise<Awaited<ReturnType<ConformanceHarness[K]>>> {
  return page.evaluate(
    ([name, given]) => {
      const harness = (window as unknown as { portholeConformance?: Harness }).portholeConformance;
      const run = harness?.[name];
      if (run === undefined) {
        throw new Error(`the conformance harness has no ${name}`);
      }
      return run(...given);
    },
    [method, args] as [string, unknown[]],
  ) as Promise<Awaited<ReturnType<ConformanceHarness[K]>>>;
}

/** The display's frame element's document, once it exists. */
async function frameIn(page: Page, id: number): Promise<Frame> {
  let found: Frame | null = null;
  await expect
    .poll(async () => {
      const element = await page
        .locator(`#porthole-display-${id} iframe`)
        .elementHandle({ timeout: 2_000 })
        .catch(() => null);
      found = (await element?.contentFrame()) ?? null;
      return found !== null;
    })
    .toBe(true);
  return found as unknown as Frame;
}

export interface HostConformance {
  readonly leak: ConformanceHost;
  readonly served: ServedConformanceHost;
  /** Redirect entry's host, where the options give `entry`. */
  readonly entry: EntryConformanceHost | null;
  /** Prepares a test's page (the canaries, the foreign origin, the harness's route): call first. */
  begin(page: Page): Promise<void>;
}

/** The leak and served hosts on an app's real page, for an app that registers the cases itself. */
export function hostConformance(options: HostConformanceOptions): HostConformance {
  let current: Page | null = null;
  const opened = new WeakSet<Page>();
  const hits = new Map<string, number>();

  const open = async (page: Page) => {
    await options.open(page);
    opened.add(page);
  };

  /** Opens the app's page, if it isn't, and loads the harness into it under the page's policy. */
  const ready = async (page: Page) => {
    const loaded = await page
      .evaluate(() => document.documentElement.dataset.portholeConformance === "ready")
      .catch(() => false);
    if (loaded) {
      return;
    }
    await open(page);
    const nonce =
      (await options.nonce?.(page)) ??
      (await page.evaluate(
        () => document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || undefined,
      ));
    await page.evaluate(
      ([path, given]) => {
        const script = document.createElement("script");
        if (given !== undefined) {
          script.nonce = given;
        }
        script.src = path;
        document.head.append(script);
      },
      [HARNESS_PATH, nonce] as const,
    );
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.portholeConformance), {
        message:
          "the harness runs on the app's page (does its CSP let a script from its own origin, or with its nonce, run?)",
      })
      .toBe("ready");
  };

  const leak: ConformanceHost = {
    name: options.name,
    async launch(page: Page, spec: LaunchSpec): Promise<LaunchedDisplay> {
      await ready(page);
      const id = await invoke(page, "launch", spec);
      return {
        frame: () => frameIn(page, id),
        async box() {
          const element = await page.locator(`#porthole-display-${id} iframe`).elementHandle();
          const area = await element?.boundingBox();
          return { width: area?.width ?? 0, height: area?.height ?? 0 };
        },
        setContent: (html, given) => invoke(page, "setContent", id, html, given?.partial === true),
        setTheme: (scheme) => invoke(page, "setTheme", id, scheme),
        async answerNextConfirmation(accept, given) {
          await expect
            .poll(() => invoke(page, "pendingConfirmations", id), {
              timeout: given?.timeoutMs ?? 5_000,
            })
            .toBeGreaterThan(0);
          const request = await invoke(page, "answer", id, accept);
          if (request === null) {
            throw new Error("no confirmation was waiting");
          }
          return request;
        },
        calls: () => invoke(page, "calls", id),
        errors: () => invoke(page, "errors", id),
        events: () => invoke(page, "events", id),
        destroy: () => invoke(page, "destroy", id),
      };
    },
  };

  const locate = async (instance: InstanceRef): Promise<FrameLocation> => {
    const page = current;
    if (page === null) {
      throw new Error("the runner has no page: call begin(page) first");
    }
    if (options.locate !== undefined) {
      return options.locate(instance, page);
    }
    if (options.issue === undefined) {
      throw new Error("the runner needs the app's issue endpoint (issue) or locate");
    }
    if (!opened.has(page)) {
      await open(page);
    }
    // Asked as the page asks it: the context's cookies, the page's origin.
    const response = await page
      .context()
      .request.post(new URL(options.issue.url, page.url()).href, {
        data: { instance },
        headers: { origin: new URL(page.url()).origin, ...options.issue.headers },
        maxRedirects: 0,
      });
    if (response.status() !== 201) {
      throw new Error(
        `the app's issue endpoint answered ${response.status()}: ${(await response.text()).slice(0, 200)}`,
      );
    }
    return (await response.json()) as FrameLocation;
  };

  const { artifact, app, proxy } = options.instances;
  const served: ServedConformanceHost = {
    name: options.name,
    async show(page, instance, given = {}): Promise<ServedDisplay> {
      await ready(page);
      const where =
        options.locate === undefined && options.issue !== undefined
          ? {
              issue: options.issue.url,
              ...(options.issue.headers === undefined ? {} : { headers: options.issue.headers }),
            }
          : { location: await locate(instance) };
      const id = await invoke(
        page,
        "show",
        options.config(instance),
        instance,
        where,
        given.content,
      );
      let origin: string | null = null;
      await expect
        .poll(
          async () => {
            origin = await invoke(page, "origin", id);
            return origin ?? (await invoke(page, "failure", id)) ?? "";
          },
          { message: "the app's issue endpoint locates the instance" },
        )
        .toMatch(/^https?:\/\//u);
      const located = origin as unknown as string;
      return {
        origin: located,
        async frame() {
          const frame = await frameIn(page, id);
          await frame.waitForURL((url) => url.origin === located);
          // A url-mode app's entry page goes on to the app where the browser kept the cookie; where
          // it didn't (WebKit, P025), it stays, saying so: the frame is that page then.
          await frame
            .waitForURL((url) => url.pathname !== "/__porthole/enter", { timeout: 5_000 })
            .catch(() => undefined);
          await frame.waitForLoadState("load");
          return frame;
        },
        destroy: () => invoke(page, "destroy", id),
        post: (message) => invoke(page, "post", id, message),
        received: () => invoke(page, "received", id),
      };
    },
    locate,
    async frameFromForeignOrigin(page, url) {
      await page.goto(`${FOREIGN}/?frame=${encodeURIComponent(url)}`);
    },
    canary: (name) => Promise.resolve(`${CANARY}/${name}`),
    canaryHits: (name) => Promise.resolve(hits.get(name) ?? 0),
    shell: options.instances.shell,
    // Asked for only by cases that run where the app gave them (`defineHostConformance` skips).
    artifact:
      artifact ??
      ((scope, version) => ({ scope, document: { kind: "artifact", id: "page", version } })),
    app: app ?? ((scope) => ({ scope, document: { kind: "external", url: "http://app.test/" } })),
    proxy: proxy ?? ((scope) => ({ scope, document: { kind: "mcp-proxy" } })),
  };

  const given = options.entry;
  const entry: EntryConformanceHost | null =
    given === undefined
      ? null
      : {
          name: options.name,
          // Signed in on the app's page, the harness there (a frame needs it).
          signIn: async (page) => {
            await open(page);
            await ready(page);
          },
          url: given.url,
          denied: given.denied,
          atSignIn: given.atSignIn,
          completeSignIn: given.completeSignIn,
          async frame(page, url) {
            await ready(page);
            const instance = served.artifact("entry", "1");
            const id = await invoke(page, "show", options.config(instance), instance, {
              location: { url, origin: new URL(url).origin },
            });
            return {
              frame: () => frameIn(page, id),
              async outcome(): Promise<FrameOutcome> {
                let found: FrameOutcome | null = null;
                await expect
                  .poll(
                    async () => {
                      const events = await invoke(page, "events", id);
                      const each = events.find((event) => event.type === "outcome");
                      found = each === undefined ? null : each.detail;
                      return found !== null;
                    },
                    { message: "the display has an outcome", timeout: 15_000 },
                  )
                  .toBe(true);
                return found as unknown as FrameOutcome;
              },
            };
          },
        };

  return {
    leak,
    served,
    entry,
    async begin(page) {
      current = page;
      const script = await harnessScript();
      await page.route(`**${HARNESS_PATH}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/javascript; charset=utf-8",
          headers: { "cache-control": "no-store" },
          body: script,
        }),
      );
      await page.context().route(`${CANARY}/**`, (route) => {
        const name = new URL(route.request().url()).pathname.slice(1);
        hits.set(name, (hits.get(name) ?? 0) + 1);
        return route.fulfill({ status: 200, contentType: "text/plain", body: "canary" });
      });
      await page.context().route(`${FOREIGN}/**`, (route) => {
        const target = new URL(route.request().url()).searchParams.get("frame") ?? "";
        const attribute = target.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><title>Foreign</title><iframe sandbox="allow-scripts allow-same-origin" src="${attribute}"></iframe>`,
        });
      });
    },
  };
}

const URL_CASES = [
  "served.url.origin",
  "served.url.no-reach",
  "served.url.no-top-navigation",
  "served.url.no-popups",
  "served.url.ticket",
  "served.url.tab",
  "served.url.framed",
];
const PROXY_CASES = ["served.proxy.view", "served.proxy.parent-only", "served.proxy.egress"];

/**
 * Registers the leak and served suites against an app's real page, in a spec file of the app's
 * (so `-g "\[1\.connect\]"` selects one). The served cases for instances the app didn't give are
 * skipped, each with its reason.
 */
export function defineHostConformance(
  test: TestType<object, object>,
  options: HostConformanceOptions,
): void {
  const typed = test as unknown as TestType<ConformanceFixtures, object>;
  const hosts = hostConformance(options);
  const skip: Record<string, string> = { ...options.skip };
  const absent = (ids: readonly string[], reason: string) => {
    for (const id of ids) {
      skip[id] ??= reason;
    }
  };
  if (options.instances.artifact === undefined) {
    absent(["served.artifact.versions"], "the app serves no versions of a stored page");
  }
  if (options.instances.app === undefined) {
    absent(URL_CASES, "the app serves no url-mode apps");
  }
  if (options.instances.proxy === undefined) {
    absent(PROXY_CASES, "the app serves no MCP Apps views");
  }
  typed.describe(`Porthole leak suite (${options.name})`, () => {
    for (const each of leakTests(hosts.leak, { skip })) {
      // Playwright reads the fixtures a test uses from its parameter's destructuring.
      typed(each.title, async ({ page, browserName }, info) => {
        await hosts.begin(page);
        await each.run({ page, browserName }, info);
      });
    }
  });
  typed.describe(`Porthole served modes (${options.name})`, () => {
    for (const each of servedTests(hosts.served, { skip })) {
      typed(each.title, async ({ page, browserName }, info) => {
        await hosts.begin(page);
        await each.run({ page, browserName }, info);
      });
    }
  });
  const entry = hosts.entry;
  if (entry !== null) {
    typed.describe(`Porthole redirect entry (${options.name})`, () => {
      for (const each of entryTests(entry, { skip })) {
        typed(each.title, async ({ page, browserName }, info) => {
          await hosts.begin(page);
          await each.run({ page, browserName }, info);
        });
      }
    });
  }
}
