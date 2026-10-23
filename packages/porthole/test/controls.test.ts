import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  CONTROLS,
  ENGINES,
  UNWEAKENED,
  VERDICT,
  controlsTable,
  judge,
  names,
  shard,
  summarize,
  type Control,
  type Run,
} from "../leak/controls.ts";
import { WEAKENINGS } from "../leak/weakenings.ts";

const root = path.join(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

// ---------------------------------------------------------------------------------------------
// The judge, against synthetic runs (V01: the runner said "as it should" for a run that never
// happened, for an empty report, and for a skipped probe).

type Status = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";

const ASSERTION = "Error: \u001b[2mexpect(\u001b[22mreceived).toBe(expected)\n\nExpected: 0";
/** A probe's verdict failing: its deciding expect carries the mark. */
const VERDICT_FAILED = `Error: ${VERDICT}WebRTC is gone\n\nexpect(received).toBe(expected)\n\nExpected: 0`;

interface Synthetic {
  readonly title: string;
  readonly status: Status | "not run";
  readonly message?: string;
  /** What the test declares: `test.fail` is "failed". */
  readonly expected?: "passed" | "failed";
}

/** A Playwright JSON report: each engine's tests, in one spec file ("A › b": b in describe A). */
function report(tests: Readonly<Record<string, readonly Synthetic[]>>, errors: string[] = []) {
  const titles = [...new Set(Object.values(tests).flatMap((each) => each.map((one) => one.title)))];
  const spec = (title: string) => ({
    title: title.split(" › ").at(-1),
    tests: Object.entries(tests).flatMap(([project, mine]) =>
      mine
        .filter((one) => one.title === title)
        .map((one) => ({
          projectName: project,
          expectedStatus: one.expected ?? "passed",
          status:
            one.status === "skipped" || one.status === "not run"
              ? "skipped"
              : (one.status === "passed") === ((one.expected ?? "passed") === "passed")
                ? "expected"
                : "unexpected",
          results:
            one.status === "not run"
              ? []
              : [
                  {
                    status: one.status,
                    errors:
                      one.status === "failed" || one.status === "timedOut"
                        ? [
                            {
                              message:
                                one.message ??
                                (one.title.includes("[3.") ? VERDICT_FAILED : ASSERTION),
                            },
                          ]
                        : [],
                  },
                ],
        })),
    ),
  });
  const described = (title: string) => (title.includes(" › ") ? title.split(" › ")[0] : undefined);
  return JSON.stringify({
    suites: [
      {
        title: "leak/leak.spec.ts",
        specs: titles.filter((title) => described(title) === undefined).map(spec),
        suites: [...new Set(titles.map(described).filter((one) => one !== undefined))].map(
          (block) => ({
            title: block,
            specs: titles.filter((title) => described(title) === block).map(spec),
          }),
        ),
      },
    ],
    errors: errors.map((message) => ({ message })),
    stats: {},
  });
}

const control: Control = {
  specs: ["leak/leak.spec.ts"],
  fails: { chromium: ["[3.webrtc]"], webkit: ["[3.webrtc]"], firefox: ["[3.webrtc]"] },
};
const run = (stdout: string, status: number | null = 1, more: Partial<Run> = {}): Run => ({
  status,
  signal: null,
  stdout,
  stderr: "",
  ...more,
});
/** An engine's run as the control wants it: its probe failed by its assertion, the rest passed. */
const good = (status: Status | "not run" = "failed", message?: string): Synthetic[] => [
  { title: "[3.webrtc] WebRTC is gone", status, ...(message === undefined ? {} : { message }) },
  { title: "[1.connect] fetch reaches only allowed origins", status: "passed" },
  { title: "[14.workers] Web Workers work", status: "skipped" },
];

describe("V01: a control's run passes only when its probes failed for real", () => {
  test("a run whose probes failed by their assertions, and nothing else, passes", () => {
    const verdict = judge(
      control,
      ["chromium", "webkit"],
      run(report({ chromium: good(), webkit: good() })),
    );
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  test("an empty report fails: no suites, whatever the exit status", () => {
    for (const status of [0, 1]) {
      const verdict = judge(
        control,
        ["chromium"],
        run(JSON.stringify({ suites: [], errors: [] }), status),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join("\n")).toContain("[chromium] no test ran");
    }
  });

  test("a launch error in the report fails, with no suites (the audit's first case)", () => {
    const verdict = judge(
      control,
      ["chromium"],
      run(report({}, ["Error: Process from config.webServer was not able to start. Exit code: 1"])),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join("\n")).toContain("was not able to start");
  });

  test("a report error fails even when every probe failed as it should", () => {
    const verdict = judge(
      control,
      ["chromium"],
      run(report({ chromium: good() }, ["Error: global setup threw"])),
    );
    expect(verdict.ok).toBe(false);
  });

  test("a skipped probe fails (the audit's second case)", () => {
    const verdict = judge(control, ["chromium"], run(report({ chromium: good("skipped") })));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([
      `[chromium] "[3.webrtc]" didn't fail by its verdict: skipped`,
    ]);
  });

  test("a probe that never ran, timed out or was interrupted fails", () => {
    for (const status of ["not run", "timedOut", "interrupted"] as const) {
      const verdict = judge(control, ["chromium"], run(report({ chromium: good(status) })));
      expect(verdict.ok, status).toBe(false);
    }
  });

  test("a probe that failed without an assertion (a browser that didn't start) fails", () => {
    const launch =
      "Error: browserType.launch: Executable doesn't exist at /ms-playwright/webkit-2359/pw_run.sh";
    const verdict = judge(control, ["chromium"], run(report({ chromium: good("failed", launch) })));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join("\n")).toContain("errored: Error: browserType.launch");
  });

  test("a verdict's own message counts, after the mark", () => {
    const message = `Error: ${VERDICT}the very next request\n\nexpect(received).toBe(expected)\n\n> 93 |   expect(`;
    expect(
      judge(control, ["chromium"], run(report({ chromium: good("failed", message) }))).ok,
    ).toBe(true);
  });

  test("an engine asked for but missing from the report fails", () => {
    const verdict = judge(
      control,
      ["chromium", "webkit", "firefox"],
      run(report({ chromium: good() })),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([
      "[webkit] no test ran: the engine isn't in the report",
      "[firefox] no test ran: the engine isn't in the report",
    ]);
  });

  test("a probe that passed has gone blind; another test failing too fails", () => {
    expect(judge(control, ["chromium"], run(report({ chromium: good("passed") }), 0)).ok).toBe(
      false,
    );
    const more = [...good(), { title: "[4.static] frames in markup", status: "failed" as const }];
    const verdict = judge(control, ["chromium"], run(report({ chromium: more })));
    expect(verdict.problems).toEqual([
      `[chromium] "[4.static] frames in markup" failed too: Error: expect(received).toBe(expected)`,
    ]);
  });

  test("a probe the registry names that matches no test fails; one it names twice fails in both", () => {
    const gone: Control = { ...control, fails: { ...control.fails, chromium: ["[3.gone]"] } };
    expect(judge(gone, ["chromium"], run(report({ chromium: good() }))).problems).toContain(
      `[chromium] no test "[3.gone]"`,
    );
    // The leak suite on two host pages: its probe is a test in each, and each must fail.
    const twice = (second: Status): Synthetic[] => [
      ...good(),
      { title: "strict CSP › [3.webrtc] WebRTC is gone", status: second },
    ];
    expect(judge(control, ["chromium"], run(report({ chromium: twice("failed") }))).ok).toBe(true);
    expect(
      judge(control, ["chromium"], run(report({ chromium: twice("passed") }))).problems,
    ).toEqual([
      `[chromium] "[3.webrtc]" (strict CSP › [3.webrtc] WebRTC is gone) passed: the control has gone blind`,
    ]);
  });

  test("a run that didn't start, was killed, or gave no report fails", () => {
    const stdout = report({ chromium: good() });
    expect(
      judge(control, ["chromium"], run("", null, { error: new Error("spawn ENOENT") })).ok,
    ).toBe(false);
    expect(judge(control, ["chromium"], run(stdout, null, { signal: "SIGKILL" })).ok).toBe(false);
    expect(judge(control, ["chromium"], run("Error: no tests found", 1)).ok).toBe(false);
  });

  test("the exit status must be what the control expects, not simply 0", () => {
    const stdout = report({ chromium: good() });
    expect(judge(control, ["chromium"], run(stdout, 1)).ok).toBe(true);
    expect(judge(control, ["chromium"], run(stdout, 0)).ok).toBe(false);
    expect(judge(control, ["chromium"], run(stdout, 130)).ok).toBe(false);
    // A control that fails nothing (another wall holds): every test passes, exit 0.
    const holds: Control = { ...control, fails: { chromium: [], webkit: [], firefox: [] } };
    const clean = report({ chromium: good("passed") });
    expect(judge(holds, ["chromium"], run(clean, 0)).ok).toBe(true);
    expect(judge(holds, ["chromium"], run(clean, 1)).ok).toBe(false);
    expect(judge(holds, ["chromium"], run(JSON.stringify({ suites: [] }), 0)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The review of P096: a probe fails for the right reason, named exactly; a test declared to fail
// that passes is news; a control that fails nothing says why.

describe("P096's review: what counts as a control's probe failing", () => {
  test("only a failure of the probe's verdict counts, never one of its setup (item 1)", () => {
    const setup =
      "Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 200\nReceived: 404";
    const verdict = judge(control, ["chromium"], run(report({ chromium: good("failed", setup) })));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([
      `[chromium] "[3.webrtc]" didn't fail by its verdict: unmarked: Error: expect(received).toBe(expected) // Object.is equality`,
    ]);
    // A poll's message carries the mark the same way.
    const poll = `Error: ${VERDICT}the frame still runs\n\nexpect(received).toBe(expected)\n\nCall Log:\n- Timeout 5000ms exceeded while waiting on the predicate`;
    expect(judge(control, ["chromium"], run(report({ chromium: good("failed", poll) }))).ok).toBe(
      true,
    );
    // The mark elsewhere in the message (a quoted source line) is no verdict.
    const quoted = `Error: expect(received).toBe(expected)\n\n> 12 |   expect(x, "${VERDICT}y")`;
    expect(judge(control, ["chromium"], run(report({ chromium: good("failed", quoted) }))).ok).toBe(
      false,
    );
  });

  test("a registry entry names a test exactly, not as a part of its title (item 3)", () => {
    expect(names("[3.webrtc]", "[3.webrtc] WebRTC is gone")).toBe(true);
    expect(names("[3.web", "[3.webrtc] WebRTC is gone")).toBe(false);
    expect(names("[3.webrtc]", "[3.webrtc-extra] another")).toBe(false);
    expect(names("served.domain.tab-links", "served.domain.tab-links: a page on a tab…")).toBe(
      true,
    );
    expect(names("served.domain.tab-links", "served.domain.tab-links-x: another")).toBe(false);
    expect(names("served.domain.tab", "served.domain.tab-links: a page on a tab…")).toBe(false);
    expect(names("a page opens nothing", "a page opens nothing else: not a file")).toBe(false);
    expect(
      names("a page opens nothing else: not a file", "a page opens nothing else: not a file"),
    ).toBe(true);
    // The judge matches a test's own title, not its describe blocks.
    const described: Control = {
      ...control,
      fails: { ...control.fails, chromium: ["in a frame"] },
    };
    const nested = [...good("passed"), { title: "in a frame › a test", status: "failed" as const }];
    expect(judge(described, ["chromium"], run(report({ chromium: nested }))).problems).toContain(
      `[chromium] no test "in a frame"`,
    );
  });

  test("a test declared to fail (test.fail) that passes fails the control, unless it is a target (item 4)", () => {
    const declared = (status: Status): Synthetic[] => [
      ...good(),
      { title: "[4.static] a known gap", status, expected: "failed" },
    ];
    expect(judge(control, ["chromium"], run(report({ chromium: declared("failed") }))).ok).toBe(
      true,
    );
    expect(
      judge(control, ["chromium"], run(report({ chromium: declared("passed") }))).problems,
    ).toEqual([
      `[chromium] "[4.static] a known gap" passed, though it is declared to fail (test.fail)`,
    ]);
    // As a target, it is held to its verdict like any other.
    const target: Control = {
      ...control,
      fails: { ...control.fails, chromium: ["[3.webrtc]", "[4.static]"] },
    };
    expect(
      judge(target, ["chromium"], run(report({ chromium: declared("passed") }))).problems,
    ).toEqual([`[chromium] "[4.static]" passed: the control has gone blind`]);
  });
});

/** Each weakening's source edits, as `file` and the text it finds. */
const edits = (name: string): string[] =>
  name
    .split(",")
    .flatMap((part) => {
      const weakening = WEAKENINGS[part];
      return typeof weakening === "object" ? weakening : [];
    })
    .map((edit) => `${edit.file}\n${edit.find}`);

describe("P096's review: a control that fails nothing says why (item 2)", () => {
  const quiet = Object.entries(CONTROLS).filter(([, each]) =>
    ENGINES.some((engine) => each.fails[engine].length === 0),
  );

  test("every control that names no test on an engine says why, and only those", () => {
    expect(quiet.length).toBeGreaterThan(5);
    for (const [name, each] of Object.entries(CONTROLS)) {
      const silent = ENGINES.some((engine) => each.fails[engine].length === 0);
      expect(each.holds !== undefined, name).toBe(silent);
      if (each.holds !== undefined) {
        expect(each.holds.why.length, name).toBeGreaterThan(20);
      }
    }
  });

  test("each is covered by a control that takes its walls out with another's and fails something there, or says no probe can see it", () => {
    for (const [name, each] of quiet) {
      const by = each.holds?.by;
      if (by === undefined) {
        expect(each.holds?.why, name).toMatch(/^no probe /);
        continue;
      }
      const cover = CONTROLS[by];
      expect(cover, `${name}: ${by}`).toBeDefined();
      expect(by, name).not.toBe(name);
      const parts = new Set(by.split(","));
      const mine = name.split(",");
      const takes =
        mine.every((part) => parts.has(part)) ||
        (edits(name).length > 0 && edits(name).every((edit) => edits(by).includes(edit)));
      expect(takes, `${by} takes ${name}'s walls out`).toBe(true);
      for (const engine of ENGINES.filter((one) => each.fails[one].length === 0)) {
        expect(cover!.fails[engine].length, `${by} fails something on ${engine}`).toBeGreaterThan(
          0,
        );
      }
    }
  });
});

describe("CI's shards of the registry (P096)", () => {
  test("every control is in exactly one shard, whatever the count, and none is empty", () => {
    for (const count of [1, 2, 3, 4, 6]) {
      const all = Array.from({ length: count }, (_, at) => shard(at + 1, count));
      expect(all.flat().toSorted(), `${count}`).toEqual(Object.keys(CONTROLS).toSorted());
      for (const one of all) {
        expect(one.length, `${count}`).toBeGreaterThan(0);
      }
    }
    // Stable: the same registry splits the same way.
    expect(shard(2, 4)).toEqual(shard(2, 4));
  });

  test("the summary fails a control that failed, or that no shard ran on an engine", () => {
    const registered = Object.keys(CONTROLS);
    const held = (engine: string, only = registered) => ({
      engines: [engine],
      shard: null,
      controls: Object.fromEntries(only.map((name) => [name, { ok: true, problems: [] }])),
    });
    expect(
      summarize(
        ENGINES.map((engine) => held(engine)),
        ENGINES,
      ),
    ).toEqual([]);
    const [first, ...rest] = registered;
    expect(summarize([held("chromium", rest), held("webkit"), held("firefox")], ENGINES)).toEqual([
      `[chromium] ${first} never ran`,
    ]);
    const broken = {
      ...held("webkit"),
      controls: { ...held("webkit").controls, [first!]: { ok: false, problems: ["x"] } },
    };
    expect(summarize([held("chromium"), broken, held("firefox")], ENGINES)).toEqual([
      `[webkit] ${first} failed`,
    ]);
    expect(summarize([], ["chromium"]).length).toBe(registered.length);
  });
});

// ---------------------------------------------------------------------------------------------
// The registry: every weakening is run, each control as DESIGN.md says (V02).

describe("V02: one registry of the negative controls", () => {
  test("every weakening is run by a control, and every control is made of weakenings", () => {
    const used = new Set(Object.keys(CONTROLS).flatMap((name) => name.split(",")));
    expect(Object.keys(WEAKENINGS).filter((name) => !used.has(name))).toEqual([]);
    expect([...used].filter((name) => WEAKENINGS[name] === undefined)).toEqual([]);
  });

  test("each control's specs exist, its weakening reaches them, and it names its tests on every engine", () => {
    for (const [name, each] of Object.entries(CONTROLS)) {
      expect(each.specs.length, name).toBeGreaterThan(0);
      for (const spec of each.specs) {
        expect(existsSync(path.join(root, spec)), `${name}: ${spec}`).toBe(true);
        expect(UNWEAKENED[spec], `${name}: ${spec}`).toBeUndefined();
      }
      expect(Object.keys(each.fails).toSorted(), name).toEqual([...ENGINES].toSorted());
    }
  });

  test("DESIGN.md's table of the controls is the registry's", () => {
    const design = read("../../docs/DESIGN.md");
    const table = controlsTable();
    expect(design.includes(table), `DESIGN.md should have this table:\n${table}`).toBe(true);
  });

  test("every control DESIGN.md's tables name is in the registry", () => {
    const design = read("../../docs/DESIGN.md");
    const named = new Set<string>();
    let columns = -1;
    for (const line of design.split("\n")) {
      if (!line.startsWith("|")) {
        columns = -1;
        continue;
      }
      const cells = line.split(/(?<!\\)\|/).slice(1, -1);
      if (columns === -1) {
        columns = cells.findIndex((cell) => /Negative control/.test(cell));
        continue;
      }
      const cell = columns < 0 ? undefined : cells[columns];
      if (cell === undefined) {
        continue;
      }
      for (const [, token] of cell.matchAll(/`([a-z,-]+)`/g)) {
        if (token!.split(",").every((part) => WEAKENINGS[part] !== undefined)) {
          named.add(token!);
        }
      }
    }
    expect(named.size).toBeGreaterThan(20);
    expect([...named].filter((name) => CONTROLS[name] === undefined)).toEqual([]);
  });

  test("CI runs every control, on every engine, in shards whose summary checks them all", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:controls"]).toBe("node scripts/controls.ts");
    const ci = read("../../.github/workflows/ci.yml");
    const job = ci.slice(ci.indexOf("\n  controls-shard:"), ci.indexOf("\n  controls:"));
    expect(job).toContain("engine: [chromium, webkit, firefox]");
    const shards = /shard: \[([\d, ]+)\]/.exec(job)?.[1]?.split(", ").map(Number) ?? [];
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, at) => at + 1));
    expect(job).toContain(
      `run: pnpm --filter @botiverse/porthole exec node scripts/controls.ts --shard \${{ matrix.shard }}/${shards.length}\n`,
    );
    // A shard runs about 42 minutes; a slow browser install fails on its own (ci.yml).
    expect(job).toContain("    timeout-minutes: 90\n");
    expect(job).toContain("--with-deps ${{ matrix.engine }}\n        timeout-minutes: 25\n");
    const summary = ci.slice(ci.indexOf("\n  controls:"), ci.indexOf("\n  examples:"));
    expect(summary).toContain("needs: controls-shard");
    expect(summary).toContain(
      "run: node packages/porthole/scripts/controls.ts --summary .dev/shards",
    );
  });
});
