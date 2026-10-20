/**
 * The negative controls (P032, P096), run as a check: each control in `leak/controls.ts` is served,
 * its specs run, and the run must fail exactly the tests the control is for, by their own
 * assertions, on every engine asked, and nothing else. A control that fails nothing has gone
 * blind; one that fails more is a probe that depends on something else; a run that didn't happen,
 * or whose probes were skipped, timed out or errored, proves nothing and fails the check.
 *
 *   node scripts/controls.ts                                    # every control, three engines
 *   PORTHOLE_LEAK_ENGINES=chromium node scripts/controls.ts     # a subset of engines
 *   node scripts/controls.ts runtime-level db-private           # some controls
 *   node scripts/controls.ts --table                            # DESIGN.md's table of them
 *
 * Each run's report is kept in `.dev/controls/<control>.json`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROLS,
  ENGINES,
  UNWEAKENED,
  controlsTable,
  judge,
  type Engine,
} from "../leak/controls.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reports = path.join(root, "../../.dev/controls");

const asked = process.argv.slice(2);
if (asked.includes("--table")) {
  process.stdout.write(`${controlsTable()}\n`);
  process.exit(0);
}
const names = asked.length > 0 ? asked : Object.keys(CONTROLS);
const unknown = names.filter((name) => CONTROLS[name] === undefined);
if (unknown.length > 0) {
  process.stderr.write(
    `No control ${unknown.join(", ")} here: ${Object.keys(CONTROLS).join(", ")}\n`,
  );
  process.exit(2);
}
const blind = names.flatMap((name) =>
  CONTROLS[name]!.specs.filter((spec) => UNWEAKENED[spec] !== undefined).map(
    (spec) => `${name}: ${spec} (${UNWEAKENED[spec]})`,
  ),
);
if (blind.length > 0) {
  process.stderr.write(
    `No control is run with a spec its weakening can't reach:\n${blind.join("\n")}\n`,
  );
  process.exit(2);
}
// The engines as the leak suite's config reads them; a name it doesn't know would run nothing.
const engines = (process.env.PORTHOLE_LEAK_ENGINES ?? ENGINES.join(",")).split(",");
const strange = engines.filter((engine) => !(ENGINES as readonly string[]).includes(engine));
if (strange.length > 0 || engines.length === 0) {
  process.stderr.write(`No engine ${strange.join(", ")}: ${ENGINES.join(", ")}\n`);
  process.exit(2);
}

mkdirSync(reports, { recursive: true });
let failed = 0;
for (const name of names) {
  const control = CONTROLS[name]!;
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      "-c",
      "leak/playwright.config.ts",
      ...control.specs,
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
  writeFileSync(path.join(reports, `${name}.json`), run.stdout ?? "");
  const verdict = judge(control, engines as Engine[], run);
  const took = `${Math.round((Date.now() - started) / 1000)} s`;
  if (verdict.ok) {
    process.stdout.write(`✓ ${name}: ${verdict.summary}, as it should (${took})\n`);
  } else {
    failed += 1;
    process.stdout.write(
      `✘ ${name}: ${verdict.summary} (${took})\n  ${verdict.problems.join("\n  ")}\n`,
    );
  }
}
process.stdout.write(
  `${names.length - failed} of ${names.length} controls fail exactly their probes on ${engines.join(", ")}\n`,
);
process.exit(failed > 0 ? 1 : 0);
