import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The release path (V03 of the 2026-10-19 audit, P097): npm gets only a commit of main that passed
 * the whole of ci.yml (the three engines' loopback and negative controls, prod-shape, the
 * examples), every Action is a reviewed commit, and only the job that publishes can mint the
 * id-token, running none of the package's or its dependencies' code.
 */

const repo = path.resolve(import.meta.dirname, "../../..");
const workflows = path.join(repo, ".github/workflows");

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
}
interface Job {
  readonly name?: string;
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly "timeout-minutes"?: number;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly strategy?: { readonly matrix?: Readonly<Record<string, unknown>> };
  readonly steps?: readonly Step[];
}
interface Workflow {
  readonly on: unknown;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, Job>>;
}

const text = (name: string): string => readFileSync(path.join(workflows, name), "utf8");
const workflow = (name: string): Workflow => parse(text(name)) as Workflow;
const files = readdirSync(workflows).filter((name) => /\.ya?ml$/u.test(name));
const release = workflow("release.yml");
const ci = workflow("ci.yml");
const needs = (job: Job | undefined): readonly string[] =>
  job?.needs === undefined ? [] : typeof job.needs === "string" ? [job.needs] : job.needs;

type Combination = Readonly<Record<string, unknown>>;

/** A matrix's combinations as GitHub makes them: its lists' product, less `exclude`, with `include`. */
function combinations(matrix: Readonly<Record<string, unknown>>): Combination[] {
  const {
    include = [],
    exclude = [],
    ...axes
  } = matrix as { include?: Combination[]; exclude?: Combination[] };
  const matches = (each: Combination, pattern: Combination): boolean =>
    Object.entries(pattern).every(([key, value]) => each[key] === value);
  let all: Combination[] = Object.keys(axes).length === 0 ? [] : [{}];
  for (const [key, values] of Object.entries(axes)) {
    // A list made at run time (`${{ fromJSON(…) }}`) can't be expanded here: name its jobs.
    expect(Array.isArray(values), `matrix.${key} is a list`).toBe(true);
    all = all.flatMap((each) => (values as unknown[]).map((value) => ({ ...each, [key]: value })));
  }
  all = all.filter((each) => !exclude.some((pattern) => matches(each, pattern)));
  const extra: Combination[] = [];
  for (const entry of include) {
    // Added to every combination whose own values it keeps; a combination of its own otherwise.
    const own = Object.fromEntries(
      Object.entries(entry).filter(([key]) => Object.hasOwn(axes, key)),
    );
    let added = false;
    all = all.map((each) => {
      if (!matches(each, own)) {
        return each;
      }
      added = true;
      return { ...each, ...entry };
    });
    if (!added) {
      extra.push({ ...entry });
    }
  }
  // Only the lists' combinations take what an `include` adds; one it made is its own.
  return [...all, ...extra];
}

/**
 * ci.yml's jobs as GitHub names them: a job's `name` or id; a matrix job once per combination,
 * its name with `${{ matrix.<key> }}` filled in, or else followed by the combination's values.
 */
function ciJobNames(): string[] {
  return Object.entries(ci.jobs).flatMap(([id, job]) => {
    const name = job.name ?? id;
    const matrix = job.strategy?.matrix;
    if (matrix === undefined) {
      expect(name, `${id}: a name without expressions`).not.toContain("${{");
      return [name];
    }
    return combinations(matrix).map((each) => {
      if (!name.includes("${{")) {
        return `${name} (${Object.values(each).map(String).join(", ")})`;
      }
      const named = name.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/gu, (_, key: string) =>
        String(each[key]),
      );
      expect(named, `${id}: a name made of matrix values only`).not.toContain("${{");
      return named;
    });
  });
}

const gate = release.jobs["gate"];
const gateEnv = (gate?.steps ?? []).find((step) => step.env !== undefined)?.env ?? {};
/** The gate's list of ci.yml's jobs (REQUIRED_CI_JOBS), its one place. */
const requiredCiJobs = (gateEnv["REQUIRED_CI_JOBS"] ?? "")
  .split("\n")
  .map((each) => each.trim())
  .filter((each) => each !== "");

describe("V03: Actions are reviewed commits", () => {
  it("every `uses:` names a full commit SHA, with the release it is in a comment", () => {
    let seen = 0;
    for (const name of files) {
      for (const line of text(name).split("\n")) {
        const match = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/u.exec(line);
        if (match === null) {
          continue;
        }
        seen += 1;
        const [, action = "", rest = ""] = match;
        expect(action, `${name}: ${line.trim()}`).toMatch(
          /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/u,
        );
        expect(rest, `${name}: ${line.trim()}`).toMatch(/^\s+# v\d+\.\d+\.\d+$/u);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("every checkout leaves no credentials behind for the code that runs after it", () => {
    for (const name of files) {
      for (const [id, job] of Object.entries(workflow(name).jobs)) {
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith("actions/checkout@") === true) {
            expect(step.with?.["persist-credentials"], `${name}: ${id}`).toBe(false);
          }
        }
      }
    }
  });

  it("each workflow's token reads only, unless a job says otherwise", () => {
    for (const name of files) {
      expect(workflow(name).permissions, name).toEqual({ contents: "read" });
    }
  });
});

describe("V03: a release waits for ci.yml on the same commit", () => {
  const gateScript = (gate?.steps ?? []).map((step) => step.run ?? "").join("\n");

  it("is a commit of main, gated before anything is built", () => {
    expect(gate, "a gate job").toBeDefined();
    expect(needs(gate)).toEqual([]);
    // Reads the tags and ci.yml's runs; a job's permissions leave out what they don't name.
    expect(gate?.permissions).toEqual({ contents: "read", actions: "read" });
    // Every other job waits for it, directly or through one that does.
    const gated = new Set(["gate"]);
    for (const [id, job] of Object.entries(release.jobs)) {
      if (id !== "gate") {
        expect(
          needs(job).some((each) => gated.has(each)),
          `${id} needs the gate`,
        ).toBe(true);
        gated.add(id);
      }
    }
    // ci.yml's runs on main for this very commit, a push's or one started by hand, never a pull
    // request's (test/release-scripts.test.ts runs the script against each).
    expect(gateScript).toContain("actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA&branch=main");
    expect(gateScript).toContain('select(.event == "push" or .event == "workflow_dispatch")');
    expect(gateScript).toContain('"$GITHUB_REF" != refs/heads/main');
    // The commit on main itself, against main by its full ref (no tag can stand in for it).
    expect(gateScript).toContain("git/ref/heads/main");
    expect(gateScript).toContain("compare/$main...$GITHUB_SHA");
  });

  it("tags after it publishes, a dispatched release only, as Ferry's and OAR's releases", () => {
    const tag = release.jobs["tag"];
    expect(needs(release.jobs["publish"])).toEqual(["gate", "build"]);
    expect(needs(tag)).toEqual(["publish"]);
    expect(tag?.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(tag?.permissions).toEqual({ contents: "write" });
    expect(needs(release.jobs["release"])).toEqual(["tag"]);
  });

  it("checks the GitHub release's notes are there in build, before npm has the version", () => {
    const build = release.jobs["build"]?.steps ?? [];
    const section = build.findIndex(
      (each) => each.name === "verify CHANGELOG.md has the version's section",
    );
    expect(section).toBeGreaterThanOrEqual(0);
    expect(section).toBeLessThan(build.findIndex((each) => each.run?.includes(" pack ") === true));
  });

  it("requires every one of ci.yml's jobs by name, as GitHub names them", () => {
    // A job added to, renamed in or dropped from ci.yml fails here, not at release time.
    expect([...requiredCiJobs].sort()).toEqual(ciJobNames().sort());
    expect(new Set(requiredCiJobs).size, "each once").toBe(requiredCiJobs.length);
    // The security suites are among them.
    for (const engine of ["chromium", "webkit", "firefox"]) {
      expect(requiredCiJobs).toContain(`loopback (${engine})`);
      expect(requiredCiJobs).toContain(`controls (${engine})`);
    }
    expect(requiredCiJobs).toContain("prod-shape");
    expect(requiredCiJobs).toContain("examples");
  });

  it("names jobs as GitHub does: matrix values in parentheses, or filled into the name", () => {
    expect(combinations({ engine: ["a", "b"], os: ["x"], exclude: [{ engine: "b" }] })).toEqual([
      { engine: "a", os: "x" },
    ]);
    expect(
      combinations({ engine: ["a"], include: [{ engine: "a", extra: 1 }, { engine: "c" }] }),
    ).toEqual([{ engine: "a", extra: 1 }, { engine: "c" }]);
    expect(combinations({ include: [{ control: "x" }, { control: "y" }] })).toEqual([
      { control: "x" },
      { control: "y" },
    ]);
  });

  it("gives every job of every workflow a timeout (GitHub's default is six hours)", () => {
    for (const name of files) {
      for (const [id, job] of Object.entries(workflow(name).jobs)) {
        expect(job["timeout-minutes"], `${name}: ${id}`).toBeGreaterThan(0);
      }
    }
  });

  it("waits for a pending run longer than ci.yml's slowest job, inside its own timeout", () => {
    const wait = Number(gateEnv["CI_WAIT_MINUTES"]);
    const slowest = Math.max(...Object.values(ci.jobs).map((job) => job["timeout-minutes"] ?? 360));
    expect(wait).toBeGreaterThanOrEqual(slowest + 30);
    expect(gate?.["timeout-minutes"] ?? 0).toBeGreaterThanOrEqual(wait + 5);
  });

  it("ci.yml runs on pushes to main, pull requests and by hand, and none of its jobs is skipped or allowed to fail", () => {
    const on = ci.on as Record<string, unknown>;
    // main, never tags: a tag's run names the tag as its branch (a tag named main). A pull
    // request's commits run as the pull request's, once (P096).
    expect(on["push"]).toEqual({ branches: ["main"] });
    expect(Object.hasOwn(on, "pull_request")).toBe(true);
    // `stamp workflow run ci.yml` for a run that flaked, or a commit without one.
    expect(Object.hasOwn(on, "workflow_dispatch")).toBe(true);
    for (const [id, job] of Object.entries(ci.jobs)) {
      expect(job.if, id).toBeUndefined();
      expect((job as { "continue-on-error"?: unknown })["continue-on-error"], id).toBeUndefined();
    }
  });

  it("calls the API only as an assignment or a command of its own, never inside a test", () => {
    for (const id of ["gate", "tag", "release"]) {
      for (const step of release.jobs[id]?.steps ?? []) {
        const script = step.run ?? "";
        expect(script.startsWith("set -euo pipefail\n"), id).toBe(true);
        for (const line of script.split("\n")) {
          if (/^\s*#/u.test(line) || !/\bgh (?:api|release)\b/u.test(line)) {
            continue;
          }
          expect(line, id).toMatch(
            /^\s*(?:[a-z_]+=\$\(gh (?:api|release)\b|gh (?:api|release)\b)/u,
          );
        }
      }
    }
  });
});

describe("V03: only the job that publishes can mint an id-token", () => {
  const publish = release.jobs["publish"];

  it("is the one job with `id-token: write`, and the publish is in release.yml", () => {
    expect(release.permissions?.["id-token"]).toBeUndefined();
    const minting = Object.entries(release.jobs)
      .filter(([, job]) => job.permissions?.["id-token"] !== undefined)
      .map(([id]) => id);
    expect(minting).toEqual(["publish"]);
    expect(publish?.permissions).toEqual({ contents: "read", "id-token": "write" });
    // npm's trusted-publisher setting names this file: the publish must stay in it.
    for (const name of files) {
      expect(text(name).includes("pnpm publish"), name).toBe(name === "release.yml");
    }
  });

  it("publishes the tarball the read-only build made, and runs no project code", () => {
    const build = release.jobs["build"];
    expect(build?.permissions).toEqual({ contents: "read" });
    expect(needs(publish)).toContain("build");
    const scripts = (publish?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(scripts).toMatch(/pnpm publish "\$\{?tarballs\[0\]\}?"/u);
    expect(scripts).not.toMatch(
      /\b(?:install|npx|node|pnpm (?:run|exec|dlx|test|check|build|pack|--filter))\b/u,
    );
    for (const step of publish?.steps ?? []) {
      expect(step.with?.["cache"], step.uses).toBeUndefined();
    }
  });

  it("checks out package.json alone, and publishes with the pnpmfile ignored", () => {
    // pnpm loads a checkout's .pnpmfile.cjs and pnpm-workspace.yaml's configDependencies for any
    // command, a publish of a tarball too: neither is in this job's checkout.
    const checkouts = (publish?.steps ?? []).filter(
      (step) => step.uses?.startsWith("actions/checkout@") === true,
    );
    expect(checkouts.map((step) => step.with)).toEqual([
      {
        "persist-credentials": false,
        "sparse-checkout": "/package.json",
        "sparse-checkout-cone-mode": false,
      },
    ]);
    const scripts = (publish?.steps ?? []).map((step) => step.run ?? "").join("\n");
    // `pnpm publish` refuses --ignore-pnpmfile; the config key is the same guard.
    expect(scripts).toMatch(/pnpm publish .*--config\.ignore-pnpmfile=true/u);
  });

  it("writes to the repository only from a job that checks nothing out", () => {
    for (const [id, job] of Object.entries(release.jobs)) {
      const writes = Object.entries(job.permissions ?? {}).filter(([, level]) => level === "write");
      if (writes.some(([scope]) => scope !== "id-token")) {
        expect(
          (job.steps ?? []).filter((step) => step.uses !== undefined),
          `${id} uses no action`,
        ).toEqual([]);
      }
    }
  });

  it("builds a release without a dependency cache", () => {
    for (const [id, job] of Object.entries(release.jobs)) {
      for (const step of job.steps ?? []) {
        expect(step.with?.["cache"], `${id}: ${step.uses}`).toBeUndefined();
      }
    }
  });
});
