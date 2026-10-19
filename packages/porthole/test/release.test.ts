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
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
}
interface Job {
  readonly name?: string;
  readonly needs?: string | readonly string[];
  readonly if?: string;
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

/** ci.yml's jobs as GitHub names them: a matrix job once per engine, `<id> (<engine>)`. */
function ciJobNames(): string[] {
  const names: string[] = [];
  for (const [id, job] of Object.entries(ci.jobs)) {
    const matrix = job.strategy?.matrix;
    const keys = Object.keys(matrix ?? {});
    expect(
      keys.every((key) => key === "engine"),
      `${id}: a matrix of engines only`,
    ).toBe(true);
    const engines = (matrix?.["engine"] ?? []) as readonly string[];
    const name = job.name ?? id;
    if (engines.length === 0) {
      names.push(name);
    }
    for (const engine of engines) {
      names.push(`${name} (${engine})`);
    }
  }
  return names;
}

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
  const gate = release.jobs["gate"];
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
    // ci.yml's run for this very commit, from a push to main.
    expect(gateScript).toContain(
      "actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA&branch=main&event=push",
    );
    expect(gateScript).toContain('"$GITHUB_REF" != refs/heads/main');
  });

  it("requires every one of ci.yml's jobs by name, not only the run's conclusion", () => {
    const required = (gate?.steps ?? [])
      .map((step) => step.env?.["REQUIRED_CI_JOBS"])
      .find((each) => each !== undefined);
    expect(required, "REQUIRED_CI_JOBS").toBeDefined();
    const names = (required ?? "")
      .split("\n")
      .map((each) => each.trim())
      .filter((each) => each !== "");
    expect(names.sort()).toEqual(ciJobNames().sort());
    // The security suites are among them.
    for (const engine of ["chromium", "webkit", "firefox"]) {
      expect(names).toContain(`loopback (${engine})`);
      expect(names).toContain(`controls (${engine})`);
    }
    expect(names).toContain("prod-shape");
    expect(names).toContain("examples");
  });

  it("ci.yml runs every job on every push: none is skipped or allowed to fail", () => {
    const on = ci.on as { push?: unknown };
    expect(on.push ?? null, "every push, unfiltered").toBeNull();
    for (const [id, job] of Object.entries(ci.jobs)) {
      expect(job.if, id).toBeUndefined();
      expect((job as { "continue-on-error"?: unknown })["continue-on-error"], id).toBeUndefined();
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
