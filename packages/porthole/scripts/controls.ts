/**
 * The negative controls (P032), run as a check: each control is served, its spec run, and the
 * run must fail exactly the probes the control is for, on every engine asked, and nothing else. A
 * control that fails nothing has gone blind; one that fails more is a probe that depends on
 * something else (after the review of 0.7.0: controls in CI, not only by hand).
 *
 *   node scripts/controls.ts                                    # every control here, three engines
 *   PORTHOLE_LEAK_ENGINES=chromium node scripts/controls.ts     # a subset of engines
 *   node scripts/controls.ts runtime-level db-private           # some controls
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Each control: the spec it is checked by, and the titles (a part of each) it must fail. */
export const CONTROLS: Readonly<Record<string, { spec: string; fails: readonly string[] }>> = {
  "runtime-declaration": {
    spec: "leak/served/runtime.spec.ts",
    fails: ["an undeclared capability: null from use, refused when sent anyway"],
  },
  "runtime-level": {
    spec: "leak/served/runtime.spec.ts",
    fails: ["a method above the viewer's level: forbidden"],
  },
  "db-private": {
    spec: "leak/served/runtime.spec.ts",
    fails: ["a person's own data is theirs"],
  },
  "comments-result": {
    spec: "leak/served/runtime.spec.ts",
    fails: ["comments are write-only"],
  },
  // Two walls stand behind a script from /_blob/: the CSP and the type it is served as. Each
  // control alone takes one out; the CSP's probe fails only with both out.
  "blob-trusted": {
    spec: "leak/served/runtime.spec.ts",
    fails: ["a script asset runs as code only if an admin uploaded it"],
  },
  "blob-script,blob-trusted": {
    spec: "leak/served/runtime.spec.ts",
    fails: [
      "a script asset runs as code only if an admin uploaded it",
      "scripts load from /_blob/ only where uploads are the admins'",
    ],
  },
  "blob-inert": {
    spec: "leak/served/runtime.spec.ts",
    fails: ["an asset opened on its own runs nothing"],
  },
};

interface Result {
  readonly title: string;
  readonly project: string;
  readonly ok: boolean;
}

/** The run's tests, flattened from Playwright's JSON report. */
function resultsOf(report: unknown): Result[] {
  const out: Result[] = [];
  const walk = (suite: unknown, titles: string[]): void => {
    const node = suite as {
      title?: string;
      suites?: unknown[];
      specs?: { title: string; tests: { projectName: string; status: string }[] }[];
    };
    const here =
      node.title === undefined || node.title.endsWith(".ts") ? titles : [...titles, node.title];
    for (const spec of node.specs ?? []) {
      for (const each of spec.tests) {
        out.push({
          title: [...here, spec.title].join(" › "),
          project: each.projectName,
          ok: each.status === "expected",
        });
      }
    }
    for (const child of node.suites ?? []) {
      walk(child, here);
    }
  };
  for (const suite of (report as { suites?: unknown[] }).suites ?? []) {
    walk(suite, []);
  }
  return out;
}

const asked = process.argv.slice(2);
const names = asked.length > 0 ? asked : Object.keys(CONTROLS);
let failed = false;
for (const name of names) {
  const control = CONTROLS[name];
  if (control === undefined) {
    process.stderr.write(`No control ${name} here: ${Object.keys(CONTROLS).join(", ")}\n`);
    process.exit(2);
  }
  const run = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      "-c",
      "leak/playwright.config.ts",
      control.spec,
      "--reporter=json",
      "--retries=0",
    ],
    {
      cwd: root,
      env: { ...process.env, PORTHOLE_LEAK_WEAKEN: name },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  let results: Result[];
  try {
    results = resultsOf(JSON.parse(run.stdout));
  } catch {
    process.stderr.write(`${name}: the run gave no report\n${run.stderr.slice(-4000)}\n`);
    failed = true;
    continue;
  }
  const projects = [...new Set(results.map((each) => each.project))];
  const problems: string[] = [];
  for (const project of projects) {
    const mine = results.filter((each) => each.project === project);
    for (const expected of control.fails) {
      const probe = mine.find((each) => each.title.includes(expected));
      if (probe === undefined) {
        problems.push(`[${project}] no test "${expected}"`);
      } else if (probe.ok) {
        problems.push(`[${project}] "${expected}" passed: the control has gone blind`);
      }
    }
    for (const each of mine.filter((one) => !one.ok)) {
      if (!control.fails.some((expected) => each.title.includes(expected))) {
        problems.push(`[${project}] "${each.title}" failed too`);
      }
    }
  }
  const counts = projects
    .map(
      (project) =>
        `${project} ${results.filter((each) => each.project === project && !each.ok).length} failed`,
    )
    .join(", ");
  if (problems.length > 0) {
    failed = true;
    process.stdout.write(`✘ ${name}: ${counts}\n  ${problems.join("\n  ")}\n`);
  } else {
    process.stdout.write(`✓ ${name}: ${counts}, as it should\n`);
  }
}
process.exit(failed ? 1 : 0);
