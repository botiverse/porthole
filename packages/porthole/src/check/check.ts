import type { ColorScheme, PortholeConfig } from "../config/schema.ts";
import type { InstanceRef } from "../isolation/types.ts";
import { presets } from "../presets/presets.ts";
import { createServer } from "../server/server.ts";
import { CHECK_CONTENT_DOMAIN, CHECK_ORIGIN } from "./drivers.ts";
import { lintContent, type Finding } from "./lint.ts";
import {
  instrumented,
  namedScripts,
  type CheckCall,
  type CheckRunData,
  type CheckRunSpec,
} from "./instrument.ts";

export type { CheckCall } from "./instrument.ts";

/** The content source the check's served origins match. */
const CHECK_SOURCE = `https://*.${CHECK_CONTENT_DOMAIN}`;

/**
 * Checks content before people see it (P073): runs it in the real sandbox at each width and
 * scheme, through a driver (a browser the host has: Playwright, or any CDP session, Cloudflare
 * Browser Rendering's included), and says what went wrong, briefly, for the agent.
 *
 *   const report = await checkPage({ config, content: html, driver: playwrightDriver(browser) });
 *   report.ok; report.text;   // "At 320 px, dark: TypeError: … (line 12). …"
 */

/** A page the check drives: one at a time, sequentially. */
export interface CheckSession {
  setViewport(width: number, height: number): Promise<void>;
  /** Loads a whole HTML document into the page. */
  load(html: string): Promise<void>;
  /**
   * Answers every request to the check page's origin and the check's content domain with
   * `handler`, and opens the page (`/`): a served config's content then runs on an origin of its
   * own, as people's browsers run it (P074). Without it, the check runs content opaque.
   */
  serve?(handler: (request: Request) => Promise<Response>): Promise<void>;
  /** Evaluates a JavaScript expression in the page (a promise is awaited); JSON back. */
  evaluate<T>(expression: string): Promise<T>;
  /** A PNG of the element `selector` names, where the driver can. */
  screenshot?(selector: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** How the check gets a page: `playwrightDriver(browser)`, `cdpDriver(session)`. */
export interface CheckDriver {
  open(): Promise<CheckSession>;
}

export interface CheckOptions {
  readonly config: PortholeConfig;
  /** The content as the agent would send it: a fragment, or a whole document. */
  readonly content: string;
  readonly driver: CheckDriver;
  /** Widths, px. Default: the manual's phone and desktop widths (`config.layout`). */
  readonly widths?: readonly number[];
  /** Default: light and dark, or light alone where the app doesn't theme it. */
  readonly schemes?: readonly ColorScheme[];
  /** The host's live theme values per scheme, as `HostOptions.theme` answers. */
  readonly hostTheme?: {
    readonly light?: Readonly<Record<string, string>>;
    readonly dark?: Readonly<Record<string, string>>;
  };
  /** How long content settles before it is measured, ms. Default 1500. */
  readonly settleMs?: number;
  /** A PNG of each run, for an agent that sees. */
  readonly screenshots?: boolean;
  /** The most distinct problems `text` names (default 8): the rest are counted. */
  readonly maxProblems?: number;
  /**
   * The check page's script (`import page from "@botiverse/porthole/check/page"`). Node finds it
   * itself; a bundled runtime (a Worker) passes it.
   */
  readonly page?: string;
}

export interface CheckRun {
  readonly width: number;
  readonly scheme: ColorScheme;
  /** The height the content reported, px, and whether the config's limit cuts it. */
  readonly height: number | null;
  readonly clipped: boolean;
  /** Wider than its frame: it scrolls sideways (or is cut). */
  readonly overflowX: boolean;
  readonly errors: readonly string[];
  readonly blocked: readonly { readonly url: string; readonly directive: string }[];
  readonly failedLoads: readonly { readonly url: string; readonly tag: string }[];
  readonly console: readonly { readonly level: "error" | "warning"; readonly text: string }[];
  /**
   * The host functions it called (P074), each answered as a host that declines would. One a
   * host's gates refuse whatever the person says (no click, bad arguments, not offered, too
   * often) is a problem; one a person or host may decline is a note.
   */
  readonly calls: readonly CheckCall[];
  readonly screenshot?: Uint8Array;
}

export interface CheckReport {
  /**
   * Nothing failed: no errors, blocks, failed loads, console errors, host-function calls a host
   * refuses, overflow or cut, no lint error.
   */
  readonly ok: boolean;
  readonly lint: readonly Finding[];
  readonly runs: readonly CheckRun[];
  /** One short summary for the agent: each problem once, with where it happened. */
  readonly text: string;
}

const noun = (config: PortholeConfig) =>
  config.mode === "artifact" ? "page" : config.mode === "mcp-app" ? "view" : "widget";

/**
 * The config the check runs content under where it can't serve it (a driver without `serve`):
 * opaque (a served config's content with the same CSP); an MCP Apps view as a page with the view's
 * egress (its protocol is its host's).
 */
function checkedAs(config: PortholeConfig): PortholeConfig {
  const opaque: PortholeConfig =
    config.isolation === "opaque" ? config : { ...config, isolation: "opaque", contentOrigins: [] };
  return opaque.mode === "mcp-app"
    ? presets.artifact({ egress: opaque.egress, limits: opaque.limits })
    : opaque;
}

/** The check page's script: given, or (Node) the package's own. */
async function pageScript(given: string | undefined): Promise<string> {
  if (given !== undefined) {
    return given;
  }
  // Not a literal: a bundler for a Worker leaves it alone (a Worker passes `page`).
  const where = new URL(
    import.meta.url.endsWith(".ts") ? "./page-source.ts" : "./page-source.js",
    import.meta.url,
  ).href;
  const loaded = (await import(where)) as { default: string };
  return loaded.default;
}

const escapeScript = (code: string) => code.replace(/<\/script/giu, "<\\/script");

export async function checkPage(options: CheckOptions): Promise<CheckReport> {
  const { config } = options;
  const lint = lintContent(config, options.content);
  if (config.mode === "url") {
    return {
      ok: true,
      lint,
      runs: [],
      text: "A url-mode app runs its own page: nothing to check here.",
    };
  }
  const widths = options.widths ?? [config.layout.narrowWidthPx, config.layout.wideWidthPx];
  const unthemed = config.theme.documents === "never";
  const schemes = options.schemes ?? (unthemed ? ["light"] : ["light", "dark"]);
  const settle = options.settleMs ?? 1_500;
  const fills = config.layout.kind === "fill";
  const script = await pageScript(options.page);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Porthole check</title><style>body{margin:0;padding:8px}section{margin-bottom:16px}</style></head><body><script>${escapeScript(script)}</script></body></html>`;
  // Its inline scripts named, so an error says the line in the content as written (P074).
  const { content, scriptLines } = namedScripts(options.content);

  const session = await options.driver.open();
  // A served config runs served, on a content origin the driver answers, under Porthole's own
  // server: its CSP in headers, its shell, its storage and cookies (P074). Else opaque.
  const servedHere =
    config.isolation === "domain" && config.mode !== "mcp-app" && session.serve !== undefined;
  const servedConfig: PortholeConfig = { ...config, contentOrigins: [CHECK_SOURCE] };
  const server = servedHere
    ? createServer({
        content: { domain: CHECK_CONTENT_DOMAIN, scheme: "https" },
        secret: crypto.getRandomValues(new Uint8Array(32)),
        hostOrigins: [CHECK_ORIGIN],
        configs: { check: servedConfig },
        artifacts: { get: () => Promise.resolve({ html: instrumented(content) }) },
      })
    : null;
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin === CHECK_ORIGIN) {
      if (url.pathname === "/") {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/issue" && server !== null) {
        const asked = (await request.json()) as { instance: InstanceRef };
        return Response.json(await server.issue(asked.instance, { viewer: "check" }));
      }
      return new Response("not found", { status: 404 });
    }
    return (await server?.handle(request)) ?? new Response("not found", { status: 404 });
  };
  const shown = servedHere ? servedConfig : checkedAs(config);
  let runIndex = 0;

  const runs: CheckRun[] = [];
  try {
    for (const width of widths) {
      await session.setViewport(width + 40, fills ? 760 : 900);
      if (servedHere && session.serve !== undefined) {
        await session.serve(handler);
      } else {
        await session.load(html);
      }
      for (const scheme of schemes) {
        runIndex += 1;
        // Each run on an origin of its own: its storage starts empty, as a new page's does.
        const instance: InstanceRef | undefined = servedHere
          ? {
              scope: `check-${runIndex}`,
              document:
                config.mode === "inline"
                  ? { kind: "shell", preset: "check" }
                  : { kind: "artifact", id: "check", version: "1", preset: "check" },
            }
          : undefined;
        const spec: CheckRunSpec = {
          config: shown,
          content,
          scriptLines,
          ...(instance === undefined ? {} : { instance }),
          widthPx: width,
          ...(fills ? { heightPx: 700 } : {}),
          scheme,
          ...(options.hostTheme?.[scheme] === undefined
            ? {}
            : { hostTheme: options.hostTheme[scheme] }),
        };
        const id = await session.evaluate<number>(
          `window.portholeCheck.run(${JSON.stringify(spec)})`,
        );
        await session.evaluate(`new Promise((resolve) => setTimeout(resolve, ${settle}))`);
        await session.evaluate(`window.portholeCheck.measure(${id})`);
        const data = await session.evaluate<CheckRunData | null>(
          `window.portholeCheck.result(${id})`,
        );
        const screenshot =
          options.screenshots === true && session.screenshot !== undefined
            ? await session.screenshot(`#porthole-check-${id}`)
            : undefined;
        await session.evaluate(`window.portholeCheck.end(${id})`);
        const height = data?.height ?? null;
        runs.push({
          width,
          scheme,
          height,
          clipped: !fills && height !== null && height >= config.limits.maxHeightPx,
          overflowX:
            data?.scrollWidth !== null &&
            data?.scrollWidth !== undefined &&
            data.clientWidth !== null &&
            data.scrollWidth > data.clientWidth + 1,
          errors: unique(data?.errors ?? []),
          blocked: uniqueBy(data?.blocked ?? [], (each) => `${each.url} ${each.directive}`),
          failedLoads: uniqueBy(data?.failedLoads ?? [], (each) => each.url),
          console: uniqueBy(data?.console ?? [], (each) => `${each.level} ${each.text}`),
          calls: uniqueBy(data?.calls ?? [], (each) => `${each.capability} ${each.outcome}`),
          ...(screenshot === undefined ? {} : { screenshot }),
        });
      }
    }
  } finally {
    await session.close();
  }
  const failed = (run: CheckRun) =>
    run.errors.length > 0 ||
    run.blocked.length > 0 ||
    run.failedLoads.length > 0 ||
    run.console.some((each) => each.level === "error") ||
    run.calls.some((each) => REFUSED[each.outcome] !== undefined) ||
    run.overflowX ||
    run.clipped;
  const ok = !lint.some((each) => each.severity === "error") && !runs.some(failed);
  return { ok, lint, runs, text: summary(config, lint, runs, options.maxProblems ?? 8) };
}

/** Calls a host refuses whatever the person says: problems, worded for the agent. */
const REFUSED: Readonly<Record<string, (capability: string) => string>> = {
  "no-user-activation": (name) =>
    `It called ${name} at load, with no click: hosts refuse that. Call ${name} from a click`,
  invalid: (name) =>
    `It called ${name} with arguments hosts refuse: see what the manual says ${name} takes`,
  "not-declared": (name) => `It called ${name}, which this host doesn't offer: leave it out`,
  "rate-limited": (name) => `It called ${name} more often than hosts allow, and was refused`,
  "no-confirm": (name) => `It called ${name}, which this host can't confirm, and was refused`,
};

const unique = (values: readonly string[]) => [...new Set(values)];
function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((each) => {
    const k = key(each);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

const clip = (text: string, most = 200) =>
  text.length > most ? `${text.slice(0, most - 1)}…` : text;

/**
 * The report in a few lines for the agent: each problem once, with the runs it happened in, at
 * most `most` of them.
 */
function summary(
  config: PortholeConfig,
  lint: readonly Finding[],
  runs: readonly CheckRun[],
  most: number,
): string {
  const it = noun(config);
  const where = new Map<string, string[]>();
  const add = (problem: string, run: CheckRun) => {
    const list = where.get(problem) ?? [];
    list.push(`${run.width} px ${run.scheme}`);
    where.set(problem, list);
  };
  // Calls a person or host may decline: the content should still work when they do.
  const notes = new Set<string>();
  for (const run of runs) {
    for (const call of run.calls) {
      const refused = REFUSED[call.outcome];
      if (refused === undefined) {
        notes.add(
          `Note: it called ${call.capability} at load; the check answered no, as a host or a person may. Make sure the ${it} still works then.`,
        );
      } else {
        add(refused(call.capability), run);
      }
    }
    for (const error of run.errors) {
      add(`It threw: ${clip(error)}`, run);
    }
    for (const block of run.blocked) {
      add(
        `The sandbox blocked ${clip(block.url, 120)} (${block.directive}): nothing loads from there here`,
        run,
      );
    }
    const blockedUrls = new Set(run.blocked.map((each) => each.url));
    for (const load of run.failedLoads.filter((each) => !blockedUrls.has(each.url))) {
      add(`Failed to load ${clip(load.url, 120)} (<${load.tag}>)`, run);
    }
    for (const line of run.console.filter((each) => each.level === "error")) {
      add(`console.error: ${clip(line.text)}`, run);
    }
    if (run.overflowX) {
      add(
        `It is wider than its frame and scrolls sideways: nothing fixed wider than ${config.layout.minWidthPx} px; let it wrap`,
        run,
      );
    }
    if (run.clipped) {
      add(`It is taller than ${config.limits.maxHeightPx} px and is cut: make it shorter`, run);
    }
  }
  const lines = [
    ...lint.map(
      (each) =>
        `${each.severity === "error" ? "Error" : "Warning"}${each.line === undefined ? "" : ` (line ${each.line})`}: ${each.message}`,
    ),
    ...[...where].map(
      ([problem, at]) =>
        `${problem} (at ${at.length === runs.length ? "every width and scheme" : at.join(", ")}).`,
    ),
  ];
  const ran = `${[...new Set(runs.map((run) => `${run.width} px`))].join(" and ")}, ${[...new Set(runs.map((run) => run.scheme))].join(" and ")}`;
  if (lines.length === 0) {
    return [
      `OK: the ${it} ran at ${ran} with no errors, blocks, failed loads or overflow.`,
      ...notes,
    ].join("\n");
  }
  const shown = lines.slice(0, most);
  const more = lines.length - shown.length;
  return [
    `The ${it} has ${lines.length} problem${lines.length === 1 ? "" : "s"} (ran at ${ran}):`,
    ...shown.map((line) => `- ${line}`),
    ...(more > 0 ? [`- and ${more} more.`] : []),
    ...notes,
  ].join("\n");
}
