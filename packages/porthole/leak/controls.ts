/**
 * The negative controls (P032, P096): one registry of every control the suite has, each with the
 * specs it is checked by and the tests it must fail on each engine. `scripts/controls.ts` runs
 * them (in CI, a job per engine); `test/controls.test.ts` holds the registry to `WEAKENINGS` (every
 * weakening is run) and to DESIGN.md's table of controls (`controlsTable`), and the judge below to
 * synthetic runs: a run that didn't happen, or whose probes were skipped, never passes.
 */

export const ENGINES = ["chromium", "webkit", "firefox"] as const;
export type Engine = (typeof ENGINES)[number];

/** A control: `PORTHOLE_LEAK_WEAKEN=<its name>` (one weakening, or several joined by commas). */
export interface Control {
  /** The spec files it is run with, relative to the package. */
  readonly specs: readonly string[];
  /**
   * The tests it must make fail on each engine, each a part of a test's title (a probe's `[id]`,
   * or a served test's own words; every test it is part of, as a probe in two specs). Every other
   * test of its specs must pass (or
   * be skipped as it always is). An engine with none: the control fails nothing there, a claim
   * the run checks as well (another wall holds).
   */
  readonly fails: Readonly<Record<Engine, readonly string[]>>;
  /**
   * `fail`: every other test of its specs fails too, by its assertion or by timing out, and none
   * passes: the control takes out what all of them stand on (the shell, on a strict page without
   * the host's nonce). Its named tests still fail by their assertions.
   */
  readonly others?: "fail";
}

/**
 * Specs no control is run with, each with the reason: their servers run Porthole without the
 * weakenings, so a control would take nothing out there and its probes would pass for the wrong
 * reason (after the audit: the kit's harness ignores PORTHOLE_LEAK_WEAKEN). The runner refuses a
 * control that names one; a control's probes that pass are a failure anyway (gone blind).
 */
export const UNWEAKENED: Readonly<Record<string, string>> = {
  "leak/kit.spec.ts":
    "the host kit's reference app (leak/kit/server.ts) runs Porthole from its sources in Node, where no weakening is applied; its walls are the core's, whose controls run against the leak and served harnesses",
};

const LEAK = "leak/leak.spec.ts";
const RUNTIME = "leak/served/runtime.spec.ts";
const FILES = "leak/served/files.spec.ts";
const SERVED = "leak/served/served.spec.ts";
const TAB = "leak/served/tab.spec.ts";

/** What the CSP sandbox alone holds on a tab (P099), every engine. */
const TAB_SANDBOX = [
  "served.domain.tab-escapes",
  "served.domain.tab-opener",
  "a file set's page on a tab of its own",
  "a frame's sealed address opened on a tab of its own",
];

/** The same tests on every engine. */
function all(...tests: string[]): Control["fails"] {
  return { chromium: tests, webkit: tests, firefox: tests };
}

/** Each engine's tests: those of every engine, and each engine's own. */
function each(
  common: readonly string[],
  own: Partial<Record<Engine, readonly string[]>>,
): Control["fails"] {
  return {
    chromium: [...common, ...(own.chromium ?? [])],
    webkit: [...common, ...(own.webkit ?? [])],
    firefox: [...common, ...(own.firefox ?? [])],
  };
}

const NOTHING = all();

export const CONTROLS: Readonly<Record<string, Control>> = {
  // The shell runtime and the CSP, through the leak suite (DESIGN.md, items 1-13).
  // 14.silent's fetch rejects only while connect-src holds; 8.prefetch holds on Chromium too, by
  // the shell's hint guard (measured, 0.7.0).
  "connect-src": { specs: [LEAK], fails: all("[1.connect]", "[14.silent]") },
  webrtc: { specs: [LEAK], fails: all("[3.webrtc]", "[14.workers]") },
  // The frame guards are two walls: either alone is covered by the other.
  "frame-guard": { specs: [LEAK], fails: NOTHING },
  "attach-shadow": { specs: [LEAK], fails: NOTHING },
  "sync-guard": { specs: [LEAK], fails: each([], { webkit: ["[8.preconnect]"] }) },
  "frame-guard,sync-guard": {
    specs: [LEAK],
    fails: each(
      [
        "[4.light-dom]",
        "[4.sync-realm]",
        "[4.plugins]",
        "[4.foreign-object]",
        "[4.template-clone]",
        "[7.base-plugins]",
        "[14.shell]",
      ],
      { webkit: ["[8.preconnect]"] },
    ),
  },
  "attach-shadow,sync-guard": {
    specs: [LEAK],
    fails: each(["[4.closed-shadow]", "[4.shadow-nested]"], { webkit: ["[8.preconnect]"] }),
  },
  "declarative-shadow": { specs: [LEAK], fails: all("[4.declarative-shadow]") },
  "parser-entry-points": { specs: [LEAK], fails: all("[4.document-write]", "[14.shell]") },
  // Firefox no longer holds 5.data by itself (Firefox 155; P035 measured it did).
  "embedder-csp": {
    specs: [LEAK],
    fails: all(
      "[5.location]",
      "[5.replace]",
      "[5.open-self]",
      "[5.anchor]",
      "[5.svg-link]",
      "[5.host-origin]",
      "[5.blob]",
      "[5.data]",
      "[6.remote-download]",
    ),
  },
  "embedder-self": { specs: [LEAK], fails: all("[5.host-origin]") },
  sandbox: {
    specs: [LEAK],
    fails: each(
      [
        "[6.open]",
        "[6.blank-link]",
        "[6.top]",
        "[6.top-link]",
        "[6.parent]",
        "[14.dialogs]",
        "[14.windows]",
      ],
      // WebKit prints nothing from a frame even with allow-modals (measured, 0.7.0).
      { chromium: ["[6.download]", "[14.print]"], firefox: ["[14.print]"] },
    ),
  },
  "base-uri": { specs: [LEAK], fails: all("[7.base-plugins]") },
  // 'self' reaches nothing of the host from an opaque frame (measured); kept out anyway.
  self: { specs: [LEAK], fails: NOTHING },
  "style-split": {
    specs: [LEAK],
    fails: all("[0.app-sdk-inline]", "[0.app-sdk-artifact]", "[0.app-sdk-mcp-app]"),
  },
  "draft-inert": { specs: [LEAK], fails: all("[11.streaming]") },
  "document-theme": { specs: [LEAK], fails: all("[11.document-theme]", "[14.theme-never]") },
  "confirm-gate": {
    specs: [LEAK],
    fails: all(
      "[12.prompt-gesture-confirm]",
      "[12.link]",
      "[12.mute]",
      "[12.no-confirm]",
      "[14.windows]",
    ),
  },
  "shell-gesture": {
    specs: [LEAK],
    fails: all("[12.prompt-gesture-confirm]", "[12.mute]", "[12.copy-text]"),
  },
  "host-gesture": { specs: [LEAK], fails: all("[12.raw-message]") },
  // The show gate (P100): a model context update reaches the handler unseen.
  "model-context-show": { specs: [LEAK], fails: all("[12.model-context]") },
  "link-scheme": { specs: [LEAK], fails: all("[12.link]") },
  clipboard: {
    specs: [LEAK],
    // Chromium holds the async API (and 14.shell's clipboard) by the frame's `allow` denial too.
    fails: each(["[13.clipboard-command]", "[13.clipboard-event]"], {
      webkit: ["[13.clipboard-api]", "[14.shell]"],
      firefox: ["[13.clipboard-api]", "[14.shell]"],
    }),
  },
  // What content logs, formatted as it came before the bridge's gate (P095, S05), on both host
  // pages; 14.silent reads the shell's blocked-load report as the text it was (measured).
  "report-unbounded": {
    specs: [LEAK, "leak/strict-csp.spec.ts"],
    fails: all("[14.error-shapes]", "[14.silent]"),
  },
  // A strict host page (P054): without the host's nonce the shell never runs, so nothing the
  // suite asks of it happens.
  nonce: {
    specs: ["leak/strict-csp.spec.ts"],
    fails: all("[0.opaque-origin]", "[0.globals]"),
    others: "fail",
  },
  "annotation-checks": {
    specs: ["leak/annotate.spec.ts"],
    fails: all("a hostile page fakes reports"),
  },
  // Served content (leak/served/).
  authorize: {
    specs: ["leak/served/authorize.spec.ts"],
    fails: each(
      ["a revoked subject's ticket opens nothing", "in a tab of its own, a revoked app and page"],
      // WebKit keeps no cookie in a cross-site frame (P025): no framed session to revoke.
      {
        chromium: ["a framed app mid-session", "a framed page mid-session"],
        firefox: ["a framed app mid-session", "a framed page mid-session"],
      },
    ),
  },
  "url-permissions": {
    specs: ["leak/served/permissions.spec.ts"],
    fails: all("a url-mode frame gets no clipboard writes or full screen"),
  },
  "navigate-guard": {
    specs: ["leak/served/live.spec.ts", FILES, SERVED, TAB],
    fails: all(
      "served.domain.self-navigation",
      "served.domain.tab-navigation",
      // A tab's links stand on the guard's rule too (measured: the outside site hears them).
      "served.domain.tab-links",
      "can't navigate itself away (location)",
      "can't navigate itself away (replace)",
      "can't navigate itself away (open-self)",
      "can't navigate itself away (navigation-api)",
      // The in-set link case and its two P098 variants (the leaving page's notice dropped, late).
      "a link to another page of the set opens it in the frame",
      "a page opens nothing else",
      "no report, content error or blocked navigation names the frame's sealed address",
    ),
  },
  // A served page on a tab of its own (P099): its CSP's sandbox is the wall for links and forms
  // in new windows, downloads, browser dialogs and its opener; window.open and picture-in-picture
  // have the shell's lock behind it too, so their case fails only with both out.
  "tab-sandbox": { specs: [TAB], fails: all(...TAB_SANDBOX) },
  "window-open": { specs: [TAB], fails: NOTHING },
  "tab-sandbox,window-open": {
    specs: [TAB],
    fails: all(...TAB_SANDBOX, "served.domain.tab-window-open"),
  },
  // navigation.navigate() and a tab's links ask the guard's rule before they start (P099): WebKit
  // sends their request though the navigate event cancels it; Chromium and Firefox hold by the
  // event alone. The shell follows a link only where the rule lets it.
  "navigate-ask": {
    specs: [TAB],
    fails: each([], { webkit: ["served.domain.tab-navigation", "served.domain.tab-links"] }),
  },
  // A tab's links followed by the shell, as it read them (P099): without it the browser follows
  // them after content's listeners, and WebKit sends a cancelled one's request.
  "link-rule": {
    specs: [TAB],
    fails: each([], { webkit: ["served.domain.tab-links", "served.domain.tab-navigation"] }),
  },
  // Its devices, location and full screen (P099): the Permissions-Policy header, and the shell's
  // locks behind it (the only wall where the header isn't applied: WebKit, Firefox). WebKit
  // refuses each prompt at once without them (no share sheet on desktop, no authenticator).
  "permissions-policy": { specs: [TAB], fails: NOTHING },
  "device-locks": {
    specs: [TAB],
    fails: each([], {
      webkit: ["served.domain.tab-devices"],
      firefox: ["served.domain.tab-devices", "served.domain.tab-prompts"],
    }),
  },
  "permissions-policy,device-locks": {
    specs: [TAB],
    fails: each(["served.domain.tab-devices"], {
      chromium: ["served.domain.tab-prompts"],
      firefox: ["served.domain.tab-prompts"],
    }),
  },
  // A url-mode app's origin check (P101): WebKit keeps no framed cookie (P025), so only the
  // framed half of the case rides one, on Chromium and Firefox.
  "url-origin": {
    specs: [SERVED],
    fails: each([], {
      chromium: ["served.url.siblings"],
      firefox: ["served.url.siblings"],
    }),
  },
  "service-worker": { specs: [FILES], fails: all("no service worker ever registers") },
  "file-corp": { specs: [FILES], fails: all("another origin reads none of the files") },
  "file-self": {
    specs: [FILES],
    fails: all(
      "a page loads no other version's files",
      "a file outside the set is a 404, and so is every spelling of a way out",
    ),
  },
  // The capability runtime (P085-P091).
  "runtime-declaration": { specs: [RUNTIME], fails: all("an undeclared capability") },
  // The pushed-result probe (P094) stands on the level check too: both its reads are refused for it.
  "runtime-level": {
    specs: [RUNTIME],
    fails: all(
      "a method above the viewer's level",
      "a read above the viewer's level: a result the host pushed is refused",
    ),
  },
  // A page's data names, held with a viewer and without one (P094).
  "runtime-data-names": {
    specs: [RUNTIME],
    fails: all("a resource outside the page's data names: refused with a viewer and without one"),
  },
  // A result the host pushed answers a read only past the read's gates (P094).
  "live-held-read": {
    specs: [RUNTIME],
    fails: all("a read above the viewer's level: a result the host pushed is refused"),
  },
  "db-private": { specs: [RUNTIME], fails: all("a person's own data is theirs") },
  "comments-result": { specs: [RUNTIME], fails: all("comments are write-only") },
  // Two walls stand behind a script from /_blob/: the CSP and the type it is served as. Each
  // control alone takes one out; the CSP's probe fails only with both out.
  "blob-script": { specs: [RUNTIME], fails: NOTHING },
  "blob-trusted": {
    specs: [RUNTIME],
    fails: all("a script asset runs as code only if an admin uploaded it"),
  },
  "blob-script,blob-trusted": {
    specs: [RUNTIME],
    fails: all(
      "a script asset runs as code only if an admin uploaded it",
      "scripts load from /_blob/ only where uploads are the admins'",
    ),
  },
  "blob-inert": { specs: [RUNTIME], fails: all("an asset opened on its own runs nothing") },
};

// ---------------------------------------------------------------------------------------------
// Judging a control's run.

/** What the runner saw of the child: `spawnSync`'s result, as far as the judge needs it. */
export interface Run {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: Error | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * How a test ended: `failed` is an assertion of its own that failed (an `expect`), the only
 * failure a control may count; the rest are runs that prove nothing (skipped, never run, timed
 * out, interrupted, an error that isn't an assertion: a browser that didn't start, a harness
 * that threw).
 */
export type Outcome =
  | "passed"
  | "failed"
  | "skipped"
  | "not run"
  | "timed out"
  | "interrupted"
  | "errored";

export interface TestResult {
  readonly title: string;
  readonly project: string;
  readonly outcome: Outcome;
  /** The first line of its error, where it has one. */
  readonly error: string;
}

export interface Verdict {
  readonly ok: boolean;
  /** One line per engine: what failed. */
  readonly summary: string;
  readonly problems: readonly string[];
}

// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

interface JsonError {
  readonly message?: string;
}
interface JsonResult {
  readonly status?: string;
  readonly error?: JsonError;
  readonly errors?: readonly JsonError[];
}
interface JsonTest {
  readonly projectName: string;
  readonly status: string;
  readonly expectedStatus?: string;
  readonly results?: readonly JsonResult[];
}
interface JsonSuite {
  readonly title?: string;
  readonly suites?: readonly JsonSuite[];
  readonly specs?: readonly { readonly title: string; readonly tests: readonly JsonTest[] }[];
}

function firstLine(error: JsonError | undefined): string {
  return (error?.message ?? "").replace(ANSI, "").trim().split("\n")[0] ?? "";
}

/**
 * An error an `expect` raised: Playwright's message has the matcher's call on a line of its own
 * (after the assertion's own message, where it has one); the source it quotes is indented.
 */
function isAssertion(error: JsonError): boolean {
  return /^(Error: )?expect(\.soft|\.poll)?\(/m.test((error.message ?? "").replace(ANSI, ""));
}

function outcomeOf(test: JsonTest): { outcome: Outcome; error: string } {
  const last = test.results?.at(-1);
  if (last === undefined) {
    return { outcome: "not run", error: "" };
  }
  const errors =
    last.errors !== undefined && last.errors.length > 0
      ? last.errors
      : last.error === undefined
        ? []
        : [last.error];
  const error = firstLine(errors[0]);
  if (test.expectedStatus !== undefined && test.expectedStatus !== "passed") {
    return { outcome: "skipped", error };
  }
  switch (last.status) {
    case "passed":
      return { outcome: "passed", error };
    case "skipped":
      return { outcome: "skipped", error };
    case "timedOut":
      return { outcome: "timed out", error };
    case "interrupted":
      return { outcome: "interrupted", error };
    case "failed":
      return {
        outcome:
          errors.length > 0 && errors.every((one) => isAssertion(one)) ? "failed" : "errored",
        error,
      };
    default:
      return { outcome: "not run", error };
  }
}

/** The run's tests, flattened from Playwright's JSON report. */
export function resultsOf(report: { readonly suites?: readonly JsonSuite[] }): TestResult[] {
  const out: TestResult[] = [];
  const walk = (suite: JsonSuite, titles: readonly string[]): void => {
    const here =
      suite.title === undefined || suite.title.endsWith(".ts") ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        out.push({
          title: [...here, spec.title].join(" › "),
          project: test.projectName,
          ...outcomeOf(test),
        });
      }
    }
    for (const child of suite.suites ?? []) {
      walk(child, here);
    }
  };
  for (const suite of report.suites ?? []) {
    walk(suite, []);
  }
  return out;
}

const said = (test: TestResult): string =>
  test.error === "" ? test.outcome : `${test.outcome}: ${test.error.slice(0, 200)}`;

/**
 * A control's run, judged: every engine asked ran its specs, every test the control is for failed
 * by its own assertion there, and nothing else failed. A negative control's run exits 1 (its
 * probes fail), so the exit status is checked against what the control expects, never against 0.
 */
export function judge(control: Control, engines: readonly Engine[], run: Run): Verdict {
  const problems: string[] = [];
  const fail = (summary: string): Verdict => ({ ok: false, summary, problems });
  if (run.error !== undefined) {
    problems.push(`the run didn't start: ${run.error.message}`);
    return fail("no run");
  }
  if (run.signal !== null) {
    problems.push(`the run was killed (${run.signal})`);
  }
  let report: { suites?: readonly JsonSuite[]; errors?: readonly JsonError[] };
  try {
    report = JSON.parse(run.stdout) as typeof report;
  } catch {
    problems.push(`the run gave no report: ${run.stderr.slice(-2000)}`);
    return fail("no report");
  }
  for (const error of report.errors ?? []) {
    problems.push(`the run reported an error: ${firstLine(error)}`);
  }
  const results = resultsOf(report);
  const counts: string[] = [];
  let expectsFailure = false;
  for (const engine of engines) {
    const mine = results.filter((one) => one.project === engine);
    if (mine.length === 0) {
      problems.push(`[${engine}] no test ran: the engine isn't in the report`);
      counts.push(`${engine} not run`);
      continue;
    }
    const targets = control.fails[engine];
    expectsFailure ||= targets.length > 0;
    const matched = new Set<TestResult>();
    for (const expected of targets) {
      // A probe in more than one spec (the leak suite on two host pages) is a test in each.
      const found = mine.filter((one) => one.title.includes(expected));
      if (found.length === 0) {
        problems.push(`[${engine}] no test "${expected}"`);
      }
      for (const probe of found) {
        matched.add(probe);
        const which = found.length > 1 ? ` (${probe.title})` : "";
        if (probe.outcome === "passed") {
          problems.push(`[${engine}] "${expected}"${which} passed: the control has gone blind`);
        } else if (probe.outcome !== "failed") {
          problems.push(
            `[${engine}] "${expected}"${which} didn't fail by its assertion: ${said(probe)}`,
          );
        }
      }
    }
    const why = (one: TestResult): string =>
      one.error === "" ? "" : `: ${one.error.slice(0, 200)}`;
    for (const one of mine) {
      if (matched.has(one)) {
        continue;
      }
      if (control.others === "fail") {
        if (one.outcome !== "failed" && one.outcome !== "timed out") {
          problems.push(
            `[${engine}] "${one.title}" ${one.outcome}, though every test should fail${why(one)}`,
          );
        }
      } else if (one.outcome !== "passed" && one.outcome !== "skipped") {
        problems.push(`[${engine}] "${one.title}" ${one.outcome} too${why(one)}`);
      }
    }
    const failed = mine.filter((one) => one.outcome === "failed").length;
    const skipped = mine.filter((one) => one.outcome === "skipped").length;
    counts.push(
      `${engine} ${failed} of ${mine.length} failed${skipped > 0 ? ` (${skipped} skipped)` : ""}`,
    );
  }
  for (const project of new Set(results.map((one) => one.project))) {
    if (!(engines as readonly string[]).includes(project)) {
      problems.push(`[${project}] ran, though it wasn't asked for`);
    }
  }
  const wanted = expectsFailure ? 1 : 0;
  if (problems.length === 0 && run.status !== wanted) {
    problems.push(`the run exited ${String(run.status)}, not ${wanted}`);
  }
  return { ok: problems.length === 0, summary: counts.join(", "), problems };
}

// ---------------------------------------------------------------------------------------------
// DESIGN.md's table of the controls.

const ENGINE_NAMES: Readonly<Record<Engine, string>> = {
  chromium: "Chromium",
  webkit: "WebKit",
  firefox: "Firefox",
};

/**
 * Each control as a row of DESIGN.md's table (checked by `test/controls.test.ts`): what it fails on
 * every engine, then what only some engines fail.
 */
export function controlsTable(): string {
  const list = (tests: readonly string[]): string =>
    tests.length === 0 ? "nothing" : tests.map((one) => `\`${one}\``).join(", ");
  const rows = Object.entries(CONTROLS).map(([name, control]) => {
    const specs = control.specs.map((spec) => `\`${spec.replace(/^leak\//, "")}\``).join(", ");
    const common = control.fails.chromium.filter((one) =>
      ENGINES.every((engine) => control.fails[engine].includes(one)),
    );
    const own = new Map<string, Engine[]>();
    for (const engine of ENGINES) {
      const extra = control.fails[engine].filter((one) => !common.includes(one));
      if (extra.length > 0) {
        const key = list(extra);
        own.set(key, [...(own.get(key) ?? []), engine]);
      }
    }
    const some = [...own]
      .map(([tests, engines]) => `${engines.map((one) => ENGINE_NAMES[one]).join(", ")}: ${tests}`)
      .join("; ");
    const every = control.others === "fail" ? ", and every other test" : "";
    return `| \`${name}\` | ${specs} | ${list(common)}${every} | ${some === "" ? "—" : some} |`;
  });
  return [
    "| Control | Run with | Fails on every engine | Fails only on |",
    "|---------|----------|-----------------------|---------------|",
    ...rows,
  ].join("\n");
}
