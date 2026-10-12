import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { expect, type Frame, type Page, type TestInfo, type TestType } from "@playwright/test";
import type { PortholeConfig } from "../config/schema.ts";
import type { Displays } from "../displays/displays.ts";
import type { FrameLocation, InstanceRef } from "../isolation/types.ts";
import { entryTests, type EntryConformanceHost } from "./entry.ts";
import HARNESS from "./harness-source.ts";
export { conformancePage } from "./page.ts";
import type { ConformanceHarness } from "./harness/page.ts";
import type { FrameOutcome } from "../host/types.ts";
import type { ConformanceHost, LaunchedDisplay, LaunchSpec } from "./index.ts";
import { leakTests, type ConformanceFixtures, type ConformanceTest } from "./probes.ts";
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
  /**
   * The config a served instance is framed under (the app's served config for its preset). Or
   * `displays` with `contentSource` (P072), which say it for every kind.
   */
  readonly config?: (instance: InstanceRef) => PortholeConfig;
  /** The app's display kinds (`defineDisplays`), in place of `config`. */
  readonly displays?: Displays;
  /**
   * The content source `displays` serve from (`http://*.content.localhost:8790`). A function is
   * asked when a case needs it (P074): a test server's port that isn't known when the spec file
   * loads.
   */
  readonly contentSource?: string | (() => string);
  /**
   * The instances the served cases ask for, each for the scope a case names (may be async: a
   * page published on demand, `onDemand`). Give what the app serves; the cases for the rest are
   * skipped, each with its reason:
   * - `shell`: a served shell (domain mode). An app that serves only stored pages leaves it out:
   *   the domain-mode cases then run on `artifact(scope, "1")`;
   * - `artifact(scope, version)`: versions "1" and "2" of one stored page on `scope`'s origin,
   *   each exactly `conformancePage(version)`;
   * - `app`: a url-mode app; `proxy`: the MCP Apps sandbox proxy.
   */
  readonly instances: Partial<Pick<ServedConformanceHost, "shell" | "artifact" | "app" | "proxy">>;
  /**
   * Redirect entry (P068), where the app serves clean addresses: the cases open them directly,
   * signed in and out, and in a frame.
   */
  readonly entry?: {
    /**
     * The clean address of `instances.artifact(scope, "1")` (`ContentHost.urlOf`); may publish it
     * on demand.
     */
    readonly url: (scope: string) => string | Promise<string>;
    /** A clean address the signed-in viewer may not open. Absent: that case is skipped. */
    readonly denied?: (scope: string) => string | Promise<string>;
    /**
     * Whether `page` shows the app's own sign-in. Absent: the browser left the content origin and
     * shows no content.
     */
    readonly atSignIn?: (page: Page) => Promise<boolean>;
    /** On the app's sign-in page: signs in, as a person does. Absent: the case stops there. */
    readonly completeSignIn?: (page: Page) => Promise<void>;
    /**
     * Addresses on the content domain that name nothing: each a 404 there (P070). `"derive"`:
     * `www`, the bare domain and a label no naming makes, under the domain of `url`'s address.
     */
    readonly unknown?: "derive" | (() => readonly string[] | Promise<readonly string[]>);
  };
  /** Case ids to skip, each with its reason (shown in the report). */
  readonly skip?: Readonly<Record<string, string>>;
}

const CANARY = "https://porthole-canary.example";
/** A page on no one's origin that frames what a case asks (routed by the test, like the canary). */
const FOREIGN = "http://porthole-foreign.example";
/** Where the harness loads from, on the app's own origin (routed by the test, never the app's). */
const HARNESS_PATH = "/__porthole/conformance/harness.js";

/**
 * The harness as one script, imported with this module (`harness-source`), so a bundle has it too
 * (P075).
 */
export function harnessScript(): Promise<string> {
  return Promise.resolve(HARNESS);
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
  const { displays, contentSource } = options;
  const configOf =
    options.config ??
    (displays !== undefined && contentSource !== undefined
      ? (instance: InstanceRef) =>
          displays.configFor(
            instance,
            typeof contentSource === "function" ? contentSource() : contentSource,
          )
      : () => {
          throw new TypeError("hostConformance needs config, or displays with contentSource");
        });
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
      const id = await invoke(page, "show", configOf(instance), instance, where, given.content);
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
    // An app that serves only stored pages: the domain-mode cases on its page's first version.
    shell:
      options.instances.shell ??
      (artifact === undefined
        ? (scope) => ({ scope, document: { kind: "shell", preset: "inlineWidget" } })
        : (scope) => artifact(scope, "1")),
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
          url: given.url,
          // Signed in on the app's page, the harness there (a frame needs it).
          signIn: async (page) => {
            await open(page);
            await ready(page);
          },
          ...(given.denied === undefined ? {} : { denied: given.denied }),
          ...(given.atSignIn === undefined ? {} : { atSignIn: given.atSignIn }),
          ...(given.completeSignIn === undefined ? {} : { completeSignIn: given.completeSignIn }),
          ...(given.unknown === undefined
            ? {}
            : {
                unknown:
                  given.unknown === "derive"
                    ? async () => derivedUnknown(await given.url("entry-unknown"))
                    : given.unknown,
              }),
          async frame(page, url) {
            await ready(page);
            const instance = await served.artifact("entry", "1");
            const id = await invoke(page, "show", configOf(instance), instance, {
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
const DOMAIN_CASES = [
  "served.domain.origin",
  "served.domain.no-reach",
  "served.domain.no-top-navigation",
  "served.domain.no-popups",
  "served.domain.address",
  "served.domain.storage-scope",
  "served.domain.ticket-once",
  "served.domain.frame-ancestors",
  "served.domain.egress",
];

/**
 * Addresses that name nothing, under the content domain of a clean address: `www`, the bare
 * domain, and a label no naming makes (P071).
 */
function derivedUnknown(clean: string): string[] {
  const url = new URL(clean);
  const domain = url.hostname.split(".").slice(1).join(".");
  const port = url.port === "" ? "" : `:${url.port}`;
  return ["www.", "", "zz-porthole-nothing."].map(
    (label) => `${url.protocol}//${label}${domain}${port}/`,
  );
}

/**
 * A memo for fixtures made on demand (a page published the first time a case asks for it): one
 * promise per key, per worker (P071).
 */
export function onDemand<V>(make: (key: string) => Promise<V>): (key: string) => Promise<V> {
  const made = new Map<string, Promise<V>>();
  return (key) => {
    let found = made.get(key);
    if (found === undefined) {
      found = make(key);
      made.set(key, found);
      // A failure is tried again by the next case, not remembered.
      found.catch(() => made.delete(key));
    }
    return found;
  };
}

/** One Playwright project per engine Porthole supports, as Porthole's own suites run them. */
export interface ConformanceProject {
  readonly name: "chromium" | "webkit" | "firefox";
  readonly use: Record<string, unknown>;
}

/**
 * The Playwright projects to run the suite on: Chromium, WebKit and Firefox, Firefox with the
 * preferences its WebRTC probe needs (loopback ICE). Pass `devices` from `@playwright/test`
 * (P071).
 */
export interface ConformanceProjectsOptions {
  readonly engines?: readonly ConformanceProject["name"][];
  /** Added to every project's `use` (a trace setting, `ignoreHTTPSErrors`, a `baseURL`). */
  readonly use?: Readonly<Record<string, unknown>>;
  /**
   * Each engine's launch options, merged with Porthole's own (P074): a system browser's
   * `executablePath` and `args` (`{ chromium: { executablePath: "/usr/bin/chromium" } }`, on a box
   * Playwright has no Chromium build for). Firefox's preferences add to the ones its probes need.
   */
  readonly launchOptions?: Partial<
    Readonly<Record<ConformanceProject["name"], Readonly<Record<string, unknown>>>>
  >;
}

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

export function conformanceProjects(
  devices: Readonly<Record<string, Record<string, unknown>>>,
  options: ConformanceProjectsOptions = {},
): ConformanceProject[] {
  const DEVICE = {
    chromium: "Desktop Chrome",
    webkit: "Desktop Safari",
    firefox: "Desktop Firefox",
  } as const;
  /** Porthole's own launch options: Firefox's WebRTC probe needs loopback ICE. */
  const OWN: Readonly<Record<ConformanceProject["name"], Record<string, unknown>>> = {
    chromium: {},
    webkit: {},
    firefox: {
      firefoxUserPrefs: {
        "media.peerconnection.ice.loopback": true,
        "media.peerconnection.ice.obfuscate_host_addresses": false,
      },
    },
  };
  const engines = options.engines ?? ["chromium", "webkit", "firefox"];
  return (["chromium", "webkit", "firefox"] as const)
    .filter((name) => engines.includes(name))
    .map((name) => {
      const given = { ...recordOf(options.use?.launchOptions), ...options.launchOptions?.[name] };
      const prefs = {
        ...recordOf(OWN[name].firefoxUserPrefs),
        ...recordOf(given.firefoxUserPrefs),
      };
      const launchOptions = {
        ...OWN[name],
        ...given,
        ...(Object.keys(prefs).length === 0 ? {} : { firefoxUserPrefs: prefs }),
      };
      return {
        name,
        use: {
          ...devices[DEVICE[name]],
          ...options.use,
          ...(Object.keys(launchOptions).length === 0 ? {} : { launchOptions }),
        },
      };
    });
}

/**
 * Registers the leak and served suites against an app's real page, in a spec file of the app's
 * (so `-g "\[1\.connect\]"` selects one). The served cases for instances the app didn't give are
 * skipped, each with its reason.
 */
export function defineHostConformance<T extends object, W extends object>(
  test: TestType<T, W>,
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
  if (options.instances.shell === undefined && options.instances.artifact === undefined) {
    absent(
      DOMAIN_CASES,
      "the app serves no documents on content origins (instances.shell or .artifact)",
    );
  }
  if (options.instances.app === undefined) {
    absent(URL_CASES, "the app serves no url-mode apps");
  }
  if (options.instances.proxy === undefined) {
    absent(PROXY_CASES, "the app serves no MCP Apps views");
  }
  // Registered as the app's own spec file's (P070): Playwright locates a test where `test()` is
  // called, so `playwright test <spec>` and `<spec>:<line>` select these.
  const at = callerOf(defineHostConformance);
  const describeOf = Reflect.get(test, "describe") as unknown as Register;
  const describe = calledFrom(describeOf, at);
  const register = calledFrom(typed as unknown as Register, at);
  const suite = (title: string, tests: readonly ConformanceTest[]) => {
    describe(title, () => {
      for (const each of tests) {
        // Playwright reads the fixtures a test uses from its parameter's destructuring.
        register(each.title, async ({ page, browserName }: ConformanceFixtures, info: TestInfo) => {
          await hosts.begin(page);
          await each.run({ page, browserName }, info);
        });
      }
    });
  };
  suite(`Porthole leak suite (${options.name})`, leakTests(hosts.leak, { skip }));
  suite(`Porthole served modes (${options.name})`, servedTests(hosts.served, { skip }));
  if (hosts.entry !== null) {
    suite(`Porthole redirect entry (${options.name})`, entryTests(hosts.entry, { skip }));
  }
}

/** Where a function was called from: the caller's file and line, or null. */
function callerOf(callee: (...args: never[]) => unknown): { file: string; line: number } | null {
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, callee);
  // The first frame is the caller's: "    at file:///…/app.spec.ts:16:1" or "    at fn (/…/app.spec.ts:16:1)".
  const frame = (holder.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
  const where = (frame ?? "").slice(3).replace(/^.*\((.*)\)$/u, "$1");
  const found = /^(.+):(\d+):\d+$/u.exec(where);
  if (found?.[1] === undefined || found[2] === undefined) {
    return null;
  }
  try {
    return {
      file: found[1].startsWith("file://") ? fileURLToPath(found[1]) : found[1],
      line: Number(found[2]),
    };
  } catch {
    return null;
  }
}

type Register = (title: string, body: unknown) => void;

/**
 * `register` (Playwright's `test` or `test.describe`), called from a function compiled as the
 * caller's file and line (`vm`'s `filename` and `lineOffset`), so the tests it makes are located
 * there. Without a caller, `register` itself.
 */
function calledFrom(register: Register, at: { file: string; line: number } | null): Register {
  if (at === null) {
    return (title, body) => register(title, body);
  }
  const call = runInThisContext("(register, title, body) => register(title, body)", {
    filename: at.file,
    lineOffset: Math.max(0, at.line - 1),
  }) as (register: Register, title: string, body: unknown) => void;
  return (title, body) => call(register, title, body);
}
