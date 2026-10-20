/**
 * The negative controls (P032, P096), run as a check: each control in `leak/controls.ts` is served,
 * its specs run, and the run must fail exactly the tests the control is for, by their verdicts, on
 * every engine asked, and nothing else. A control that fails nothing has gone blind; one that
 * fails more is a probe that depends on something else; a run that didn't happen, or whose probes
 * were skipped, timed out or failed by anything but their verdicts, proves nothing and fails.
 *
 *   node scripts/controls.ts                                    # every control, three engines
 *   PORTHOLE_LEAK_ENGINES=chromium node scripts/controls.ts     # a subset of engines
 *   node scripts/controls.ts runtime-level db-private           # some controls
 *   node scripts/controls.ts --shard 2/4                        # CI: one shard of the registry
 *   node scripts/controls.ts --summary <dir>                    # CI: every shard's verdicts
 *   node scripts/controls.ts --table                            # DESIGN.md's table of them
 *
 * Each run's report is kept in `.dev/controls/<control>.json`, and its verdicts in
 * `.dev/controls/verdicts.json` (written after each control, so a job cut short leaves what ran).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROLS,
  ENGINES,
  UNWEAKENED,
  controlsTable,
  judge,
  shard,
  summarize,
  type Engine,
  type Verdicts,
} from "../leak/controls.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reports = path.join(root, "../../.dev/controls");

const asked = process.argv.slice(2);
if (asked.includes("--table")) {
  process.stdout.write(`${controlsTable()}\n`);
  process.exit(0);
}

// The summary: every verdicts.json under the directory (each shard's artifact), put together.
const summaryAt = asked.indexOf("--summary");
if (summaryAt >= 0) {
  const dir = asked[summaryAt + 1];
  if (dir === undefined) {
    process.stderr.write("--summary needs the directory of the shards' reports\n");
    process.exit(2);
  }
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const here = path.join(at, entry.name);
      if (entry.isDirectory()) {
        walk(here);
      } else if (entry.name === "verdicts.json") {
        found.push(here);
      }
    }
  };
  walk(path.resolve(dir));
  const runs = found.map((file) => JSON.parse(readFileSync(file, "utf8")) as Verdicts);
  const problems = summarize(runs, ENGINES);
  const total = Object.keys(CONTROLS).length * ENGINES.length;
  process.stdout.write(
    `${found.length} shard reports; ${total - problems.length} of ${total} controls × engines held\n`,
  );
  if (problems.length > 0) {
    process.stdout.write(`  ${problems.join("\n  ")}\n`);
  }
  process.exit(problems.length > 0 ? 1 : 0);
}

const shardAt = asked.indexOf("--shard");
const which = shardAt >= 0 ? /^(\d+)\/(\d+)$/.exec(asked[shardAt + 1] ?? "") : null;
if (
  shardAt >= 0 &&
  (which === null || Number(which[1]) < 1 || Number(which[1]) > Number(which[2]))
) {
  process.stderr.write("--shard takes <index>/<count>, from 1\n");
  process.exit(2);
}
const named = shardAt >= 0 ? asked.filter((_, at) => at !== shardAt && at !== shardAt + 1) : asked;
if (which !== null && named.length > 0) {
  process.stderr.write(`--shard runs its shard alone, not ${named.join(" ")}\n`);
  process.exit(2);
}
const names =
  which !== null
    ? shard(Number(which[1]), Number(which[2]))
    : named.length > 0
      ? named
      : Object.keys(CONTROLS);
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
const verdicts: { -readonly [K in keyof Verdicts]: Verdicts[K] } = {
  engines,
  shard: which === null ? null : `${which[1]}/${which[2]}`,
  controls: {},
};
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
  verdicts.controls = {
    ...verdicts.controls,
    [name]: { ok: verdict.ok, problems: verdict.problems },
  };
  writeFileSync(path.join(reports, "verdicts.json"), JSON.stringify(verdicts, null, 2));
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
  `${names.length - failed} of ${names.length} controls fail exactly their probes on ${engines.join(", ")}${verdicts.shard === null ? "" : ` (shard ${verdicts.shard})`}\n`,
);
process.exit(failed > 0 ? 1 : 0);
