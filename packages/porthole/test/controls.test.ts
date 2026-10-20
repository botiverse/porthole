import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  CONTROLS,
  ENGINES,
  UNWEAKENED,
  controlsTable,
  judge,
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

interface Synthetic {
  readonly title: string;
  readonly status: Status | "not run";
  readonly message?: string;
}

/** A Playwright JSON report: each engine's tests, in one spec file. */
function report(tests: Readonly<Record<string, readonly Synthetic[]>>, errors: string[] = []) {
  const titles = [...new Set(Object.values(tests).flatMap((each) => each.map((one) => one.title)))];
  return JSON.stringify({
    suites: [
      {
        title: "leak/leak.spec.ts",
        specs: titles.map((title) => ({
          title,
          tests: Object.entries(tests).flatMap(([project, mine]) =>
            mine
              .filter((one) => one.title === title)
              .map((one) => ({
                projectName: project,
                expectedStatus: "passed",
                status:
                  one.status === "passed"
                    ? "expected"
                    : one.status === "skipped" || one.status === "not run"
                      ? "skipped"
                      : "unexpected",
                results:
                  one.status === "not run"
                    ? []
                    : [
                        {
                          status: one.status,
                          errors:
                            one.status === "failed" || one.status === "timedOut"
                              ? [{ message: one.message ?? ASSERTION }]
                              : [],
                        },
                      ],
              })),
          ),
        })),
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
      `[chromium] "[3.webrtc]" didn't fail by its assertion: skipped`,
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

  test("an assertion with its own message counts as an assertion", () => {
    const message =
      "Error: the very next request\n\nexpect(received).toBe(expected)\n\n> 93 |   expect(";
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
    const names = new Set<string>();
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
          names.add(token!);
        }
      }
    }
    expect(names.size).toBeGreaterThan(20);
    expect([...names].filter((name) => CONTROLS[name] === undefined)).toEqual([]);
  });

  test("CI runs every control, on every engine", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:controls"]).toBe("node scripts/controls.ts");
    const ci = read("../../.github/workflows/ci.yml");
    const job = ci.slice(ci.indexOf("\n  controls:"), ci.indexOf("\n  examples:"));
    expect(job).toContain("engine: [chromium, webkit, firefox]");
    expect(job).toMatch(/run: pnpm --filter @botiverse\/porthole run test:controls\n/);
  });
});
