import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * release.yml's scripts (V03, P097), run as GitHub would run them, against a simulated API: a fake
 * `gh` answers from canned JSON through the real `jq` (as `gh --jq` filters), a fake `sleep`
 * returns at once, a fake `pnpm` records what it was asked to publish. What the gate lets through,
 * what stops it (an API error included: it must never read as "no tag" or "no run"), and how a
 * prerelease is published.
 */

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
}
const workflow = parse(
  readFileSync(path.resolve(import.meta.dirname, "../../../.github/workflows/release.yml"), "utf8"),
) as { jobs: Record<string, { steps: Step[] }> };
/** A job's step by its name, or its last script. */
const step = (job: string, name?: string): Step => {
  const found = workflow.jobs[job]?.steps.findLast(
    (each) => each.run !== undefined && (name === undefined || each.name === name),
  );
  if (found === undefined) {
    throw new Error(`no script ${name ?? ""} in ${job}`);
  }
  return found;
};

const has = (command: string): boolean =>
  spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
// GitHub's runners have both; elsewhere the simulation needs them too, or it is skipped (never in CI).
const runnable = (has("bash") && has("jq")) || process.env["CI"] !== undefined;

const root = mkdtempSync(path.join(tmpdir(), "porthole-release-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const bin = path.join(root, "bin");
mkdirSync(bin);
const tool = (name: string, body: string): void => {
  writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}`);
  chmodSync(path.join(bin, name), 0o755);
};
// `gh api [--paginate] <path> [--jq <filter>] [-H …] [-f …]`, and `gh release create`: answers from
// $SIM's files, and fails where $SIM/fail names part of the path (an HTTP error).
tool(
  "gh",
  `set -euo pipefail
echo "gh $*" >> "$SIM/calls"
if [ "$1" = release ]; then
  [ "$2" = create ] || exit 2
  exit 0
fi
shift
api=
filter=.
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) filter=$2; shift 2 ;;
    -H|-f) shift 2 ;;
    --paginate) shift ;;
    *) [ -n "$api" ] || api=$1; shift ;;
  esac
done
if [ -f "$SIM/fail" ] && grep -qF -f "$SIM/fail" <<< "$api"; then
  echo "gh: HTTP 502 for $api" >&2; exit 1
fi
answer() { if [ -f "$SIM/$1" ]; then cat "$SIM/$1"; else echo "$2"; fi; }
case "$api" in
  */git/matching-refs/tags/*) answer refs.json '[]' | jq -r "$filter" ;;
  */actions/workflows/ci.yml/runs*)
    n=$(( $(cat "$SIM/runs.count" 2>/dev/null || echo 0) + 1 )); echo $n > "$SIM/runs.count"
    if [ -f "$SIM/runs.$n.json" ]; then cat "$SIM/runs.$n.json"; else answer runs.json '{"workflow_runs":[]}'; fi | jq -r "$filter" ;;
  */actions/runs/*/jobs*) answer jobs.json '{"jobs":[]}' | jq -r "$filter" ;;
  */git/ref/heads/main) answer main.json '{"object":{"sha":"ma1n"}}' | jq -r "$filter" ;;
  */compare/*) answer compare.json '{"status":"behind"}' | jq -r "$filter" ;;
  */git/refs) echo '{}' ;;
  */git/tags/*) answer tag.json '{}' | jq -r "$filter" ;;
  */releases*) answer releases.json '[]' | jq -r "$filter" ;;
  */contents/CHANGELOG.md*) answer CHANGELOG.md '' ;;
  *) echo "gh: no simulation for $api" >&2; exit 1 ;;
esac
`,
);
tool("sleep", 'echo "sleep $*" >> "$SIM/calls"\n');
tool("pnpm", 'echo "pnpm $*" >> "$SIM/calls"\n');

let cases = 0;
interface Run {
  readonly status: number | null;
  readonly out: string;
  readonly calls: string[];
  readonly dir: string;
}
/**
 * Runs `job`'s script (its step `stepName`, or its last) with `files` as the API's answers and
 * `env` as the run's context.
 */
function simulate(
  job: string,
  files: Record<string, unknown>,
  env: Record<string, string>,
  stepName?: string,
): Run {
  const dir = path.join(root, `case-${(cases += 1)}`);
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      path.join(dir, name),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  const script = path.join(dir, `${job}.sh`);
  writeFileSync(script, step(job, stepName).run ?? "");
  const { GH_TOKEN: _, ...stepEnv } = step(job, stepName).env ?? {};
  const result = spawnSync("bash", [script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      SIM: dir,
      GITHUB_REPOSITORY: "botiverse/porthole",
      GITHUB_SHA: "c0ffee",
      RUNNER_TEMP: dir,
      ...stepEnv,
      ...env,
    },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");
  } catch {
    // nothing was called
  }
  return { status: result.status, out: `${result.stdout}${result.stderr}`, calls, dir };
}

const REQUIRED = (step("gate").env?.["REQUIRED_CI_JOBS"] ?? "").trim().split("\n");
const run = (event: string, conclusion: string | null, created: string, id = 7) => ({
  id,
  event,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  created_at: created,
});
const runs = (...each: unknown[]) => ({ workflow_runs: each });
const jobs = (overrides: Record<string, string> = {}, extra: unknown[] = []) => ({
  jobs: [
    ...REQUIRED.filter((name) => overrides[name] !== "missing").map((name) => ({
      name,
      conclusion: overrides[name] ?? "success",
      run_attempt: 1,
    })),
    ...extra,
  ],
});
const PUSH = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v0.7.1", TAG: "v0.7.1" };
const DISPATCH = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  TAG: "v0.7.1",
};
const passed = {
  "runs.json": runs(run("push", "success", "2026-10-19T10:00:00Z")),
  "jobs.json": jobs(),
};

describe.skipIf(!runnable)("V03: the gate, against a simulated API", () => {
  it("lets through a commit whose push run on main passed every required job", () => {
    const result = simulate("gate", passed, DISPATCH);
    expect(result.out).toContain("ci.yml passed on c0ffee");
    expect(result.status).toBe(0);
    expect(result.calls.some((call) => call.includes("branch=main"))).toBe(true);
  });

  it("accepts a run on main started by workflow_dispatch (a re-run through Stamp)", () => {
    const result = simulate(
      "gate",
      {
        "runs.json": runs(
          run("workflow_dispatch", "success", "2026-10-19T11:00:00Z", 8),
          run("push", "failure", "2026-10-19T10:00:00Z", 7),
        ),
        "jobs.json": jobs(),
      },
      PUSH,
    );
    expect(result.out).toContain("ci.yml run 8 on c0ffee: completed success");
    expect(result.status).toBe(0);
  });

  it("takes the newest of those runs: a later failed dispatch run stops a passed push run", () => {
    const result = simulate(
      "gate",
      {
        "runs.json": runs(
          run("push", "success", "2026-10-19T10:00:00Z", 7),
          run("workflow_dispatch", "failure", "2026-10-19T11:00:00Z", 8),
        ),
        "jobs.json": jobs(),
      },
      PUSH,
    );
    expect(result.out).toContain("ci.yml did not pass");
    expect(result.status).toBe(1);
  });

  it("ignores a pull request's run, even a newer one that passed", () => {
    const over = simulate(
      "gate",
      {
        "runs.json": runs(
          run("pull_request", "success", "2026-10-19T11:00:00Z", 9),
          run("push", "failure", "2026-10-19T10:00:00Z", 7),
        ),
        "jobs.json": jobs(),
      },
      PUSH,
    );
    expect(over.out).toContain("ci.yml run 7 on c0ffee: completed failure");
    expect(over.status).toBe(1);
    const alone = simulate(
      "gate",
      { "runs.json": runs(run("pull_request", "success", "2026-10-19T11:00:00Z", 9)) },
      PUSH,
    );
    expect(alone.out).toContain("no ci.yml run on main for c0ffee");
    expect(alone.status).toBe(1);
  });

  it("stops on an API error in any lookup, never reading it as no tag or no run", () => {
    for (const fail of [
      "matching-refs/tags",
      "git/ref/heads/main",
      "/compare/",
      "ci.yml/runs",
      "/jobs",
    ]) {
      const result = simulate("gate", { ...passed, fail }, DISPATCH);
      expect(result.out, fail).toContain("HTTP 502");
      expect(result.out, fail).not.toContain("ci.yml passed");
      expect(result.status, fail).toBe(1);
    }
  });

  it("stops when a required job was skipped, failed its latest attempt, or is missing", () => {
    for (const [overrides, extra] of [
      [{ "prod-shape": "skipped" }, []],
      [{ "controls (webkit)": "missing" }, []],
      [
        { examples: "missing" },
        [
          { name: "examples", conclusion: "success", run_attempt: 1 },
          { name: "examples", conclusion: "failure", run_attempt: 2 },
        ],
      ],
    ] as const) {
      const result = simulate(
        "gate",
        { "runs.json": passed["runs.json"], "jobs.json": jobs(overrides, [...extra]) },
        PUSH,
      );
      expect(result.out).toMatch(/ci\.yml job '.+' did not pass in run 7/u);
      expect(result.status).toBe(1);
    }
    // A failed first attempt that passed when re-run is a pass.
    const rerun = simulate(
      "gate",
      {
        "runs.json": passed["runs.json"],
        "jobs.json": jobs({ examples: "missing" }, [
          { name: "examples", conclusion: "failure", run_attempt: 1 },
          { name: "examples", conclusion: "success", run_attempt: 2 },
        ]),
      },
      PUSH,
    );
    expect(rerun.status).toBe(0);
  });

  it("waits for a pending run, and gives up after CI_WAIT_MINUTES", () => {
    const pending = simulate(
      "gate",
      {
        "runs.1.json": runs(run("push", null, "2026-10-19T10:00:00Z")),
        "runs.2.json": runs(run("push", null, "2026-10-19T10:00:00Z")),
        ...passed,
      },
      PUSH,
    );
    expect(pending.calls.filter((call) => call === "sleep 60")).toHaveLength(2);
    expect(pending.status).toBe(0);
    // Three minutes, not the gate's 150, so the case runs in well under vitest's 5 s.
    const never = simulate(
      "gate",
      { "runs.json": runs(run("push", null, "2026-10-19T10:00:00Z")) },
      { ...PUSH, CI_WAIT_MINUTES: "3" },
    );
    expect(never.calls.filter((call) => call === "sleep 60")).toHaveLength(3);
    expect(never.out).toContain("did not finish in time");
    expect(never.status).toBe(1);
  });

  it("refuses a commit that isn't on main (a branch's tag, or a tag named main)", () => {
    for (const status of ["ahead", "diverged"]) {
      const result = simulate("gate", { ...passed, "compare.json": { status } }, PUSH);
      expect(result.out, status).toContain(
        `c0ffee is not on main (main is ma1n; the commit is ${status})`,
      );
      expect(result.status, status).toBe(1);
      expect(
        result.calls.some((call) => call.includes("ci.yml/runs")),
        status,
      ).toBe(false);
    }
    for (const status of ["identical", "behind"]) {
      const result = simulate("gate", { ...passed, "compare.json": { status } }, PUSH);
      expect(result.status, status).toBe(0);
    }
    // main by its full ref, and the commit against main's head.
    const calls = simulate("gate", passed, PUSH).calls;
    expect(calls).toContain("gh api repos/botiverse/porthole/git/ref/heads/main --jq .object.sha");
    expect(calls).toContain("gh api repos/botiverse/porthole/compare/ma1n...c0ffee --jq .status");
  });

  it("refuses a dispatch from another ref, a tag that exists, and what isn't a version", () => {
    const branch = simulate("gate", passed, { ...DISPATCH, GITHUB_REF: "refs/heads/feature" });
    expect(branch.out).toContain("dispatch from main only");
    const exists = simulate(
      "gate",
      {
        ...passed,
        "refs.json": [{ ref: "refs/tags/v0.7.1", object: { type: "commit", sha: "c0ffee" } }],
      },
      DISPATCH,
    );
    expect(exists.out).toContain("v0.7.1 already exists");
    // A longer tag sharing the prefix is another tag.
    const longer = simulate(
      "gate",
      {
        ...passed,
        "refs.json": [{ ref: "refs/tags/v0.7.10", object: { type: "commit", sha: "beef" } }],
      },
      DISPATCH,
    );
    expect(longer.status).toBe(0);
    const junk = simulate("gate", passed, { ...PUSH, TAG: "vnext" });
    expect(junk.out).toContain("not a version: vnext");
    expect([branch.status, exists.status, junk.status]).toEqual([1, 1, 1]);
  });
});

const CHANGELOG = "# Changelog\n\n## 0.7.1\n\nThe fix.\n\n## 0.7.0\n\nThe runtime.\n";
const SECTION_STEP = "verify CHANGELOG.md has the version's section";

describe.skipIf(!runnable)(
  "V03: the build's CHANGELOG.md check, before anything is published",
  () => {
    it("passes a version with its own section, Windows line ends or not", () => {
      for (const text of [CHANGELOG, CHANGELOG.replaceAll("\n", "\r\n")]) {
        const result = simulate("build", { "CHANGELOG.md": text }, { TAG: "v0.7.1" }, SECTION_STEP);
        expect(result.status, JSON.stringify(text)).toBe(0);
      }
    });

    it("stops a release whose heading isn't exactly `## X.Y.Z`, or whose section is empty", () => {
      for (const [text, says] of [
        ["# Changelog\n\n## v0.7.1\n\nThe fix.\n", "no '## 0.7.1' heading"],
        ["# Changelog\n\n## 0.7.1 (2026-10-19)\n\nThe fix.\n", "no '## 0.7.1' heading"],
        ["# Changelog\n\n## 0.7.1\n\n  \n## 0.7.0\n\nThe runtime.\n", "section is empty"],
        ["# Changelog\n\n## 0.7.0\n\nThe runtime.\n", "no '## 0.7.1' heading"],
      ]) {
        const result = simulate("build", { "CHANGELOG.md": text }, { TAG: "v0.7.1" }, SECTION_STEP);
        expect(result.out, text).toContain(says);
        expect(result.status, text).toBe(1);
      }
    });
  },
);

describe.skipIf(!runnable)("V03: the tag job, against a simulated API", () => {
  it("tags the commit when the tag isn't there", () => {
    const result = simulate("tag", {}, { TAG: "v0.7.1" });
    expect(result.status).toBe(0);
    expect(result.calls.at(-1)).toBe(
      "gh api repos/botiverse/porthole/git/refs -f ref=refs/tags/v0.7.1 -f sha=c0ffee",
    );
  });

  it("passes a tag already on the commit (a pushed tag, or a re-run), annotated or not", () => {
    const light = simulate(
      "tag",
      { "refs.json": [{ ref: "refs/tags/v0.7.1", object: { type: "commit", sha: "c0ffee" } }] },
      { TAG: "v0.7.1" },
    );
    const annotated = simulate(
      "tag",
      {
        "refs.json": [{ ref: "refs/tags/v0.7.1", object: { type: "tag", sha: "7a9" } }],
        "tag.json": { object: { type: "commit", sha: "c0ffee" } },
      },
      { TAG: "v0.7.1" },
    );
    for (const result of [light, annotated]) {
      expect(result.out).toContain("v0.7.1 is c0ffee");
      expect(result.calls.some((call) => call.includes("git/refs -f"))).toBe(false);
      expect(result.status).toBe(0);
    }
  });

  it("refuses a tag on another commit", () => {
    const result = simulate(
      "tag",
      { "refs.json": [{ ref: "refs/tags/v0.7.1", object: { type: "commit", sha: "beef" } }] },
      { TAG: "v0.7.1" },
    );
    expect(result.out).toContain("v0.7.1 points at beef, not c0ffee");
    expect(result.status).toBe(1);
  });

  it("stops on an API error in a lookup, before creating anything", () => {
    for (const [fail, files] of [
      ["matching-refs/tags", {}],
      [
        "git/tags/",
        { "refs.json": [{ ref: "refs/tags/v0.7.1", object: { type: "tag", sha: "7a9" } }] },
      ],
    ] as const) {
      const result = simulate("tag", { ...files, fail }, { TAG: "v0.7.1" });
      expect(result.out, fail).toContain("HTTP 502");
      expect(
        result.calls.some((call) => call.includes("git/refs -f")),
        fail,
      ).toBe(false);
      expect(result.status, fail).toBe(1);
    }
  });
});

describe.skipIf(!runnable)("V03: the release job, against a simulated API", () => {
  it("makes the release from the version's CHANGELOG.md section, Windows line ends or not", () => {
    for (const text of [CHANGELOG, CHANGELOG.replaceAll("\n", "\r\n")]) {
      const result = simulate("release", { "CHANGELOG.md": text }, { TAG: "v0.7.1" });
      expect(result.status).toBe(0);
      expect(readFileSync(path.join(result.dir, "notes.md"), "utf8")).toBe("\nThe fix.\n\n");
      expect(result.calls.at(-1)).toBe(
        "gh release create v0.7.1 --title v0.7.1 --notes-file notes.md --verify-tag",
      );
    }
  });

  it("marks a prerelease's GitHub release as one", () => {
    const result = simulate("release", { "CHANGELOG.md": CHANGELOG }, { TAG: "v0.8.0-rc.1" });
    expect(result.status).toBe(0);
    expect(result.calls.at(-1)).toContain("--prerelease");
  });

  it("stops on an API error in the release or CHANGELOG lookup, before creating anything", () => {
    for (const fail of ["/releases", "contents/CHANGELOG.md"]) {
      const result = simulate("release", { "CHANGELOG.md": CHANGELOG, fail }, { TAG: "v0.7.1" });
      expect(result.out, fail).toContain("HTTP 502");
      expect(
        result.calls.some((call) => call.startsWith("gh release create")),
        fail,
      ).toBe(false);
      expect(result.status, fail).toBe(1);
    }
  });

  it("finishes a release that exists already", () => {
    const done = simulate(
      "release",
      { "releases.json": [{ id: 3, tag_name: "v0.7.1" }] },
      { TAG: "v0.7.1" },
    );
    expect(done.out).toContain("release v0.7.1 already exists");
    expect(done.status).toBe(0);
  });
});

/** A tarball as `pnpm pack` makes one, with only its manifest. */
function tarball(dir: string, version: string): void {
  const pkg = path.join(dir, "src", "package");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(path.join(dir, "package"), { recursive: true });
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@botiverse/porthole", version }),
  );
  const made = spawnSync("tar", [
    "-czf",
    path.join(dir, "package", `botiverse-porthole-${version}.tgz`),
    "-C",
    path.join(dir, "src"),
    "package",
  ]);
  expect(made.status).toBe(0);
}

describe.skipIf(!runnable)("V03: the publish step, against a simulated pnpm", () => {
  const publish = (version: string, tag: string): Run => {
    const dir = path.join(root, `tarball-${version}-${tag}`);
    tarball(dir, version);
    return simulate("publish", {}, { TAG: tag, RUNNER_TEMP: dir });
  };

  it("publishes a release as `latest`", () => {
    const result = publish("0.7.1", "v0.7.1");
    expect(result.status).toBe(0);
    expect(result.calls.at(-1)).toMatch(
      /^pnpm publish .+botiverse-porthole-0\.7\.1\.tgz --access public --no-git-checks --tag latest --config\.ignore-pnpmfile=true$/u,
    );
  });

  it("publishes a prerelease as `next`, never as `latest`", () => {
    const result = publish("0.8.0-rc.1", "v0.8.0-rc.1");
    expect(result.status).toBe(0);
    expect(result.calls.at(-1)).toMatch(/ --tag next /u);
    expect(result.calls.join("\n")).not.toContain("--tag latest");
  });

  it("refuses a tarball that isn't the tag's version", () => {
    const result = publish("0.7.0", "v0.7.1");
    expect(result.out).toContain("not @botiverse/porthole at v0.7.1");
    expect(result.calls.some((call) => call.startsWith("pnpm publish"))).toBe(false);
    expect(result.status).toBe(1);
  });
});
