import { describe, expect, test } from "vitest";
import { LIMIT_CHECKS } from "../src/conformance/limits.ts";
import { PROBES } from "../src/conformance/probes.ts";
import { servedTests, type ServedConformanceHost } from "../src/conformance/served.ts";
import { LIMIT_IDS, manualLimits } from "../src/guide/limits.ts";
import { compile, LIBRARY_CDNS, presets, type PortholeConfig } from "../src/index.ts";

/**
 * Every line the manual states about the sandbox has a named browser check (P064): a limit the
 * manual can emit names checks that exist in the suite, and the manual's "The sandbox:" list is
 * exactly the limits, so a new line can't go untested.
 */

const SERVED = "https://*.example-usercontent.com";

const CONFIGS: Record<string, PortholeConfig> = {
  "inline widget": presets.inlineWidget(),
  "inline widget, links, prompts and copy": presets.inlineWidget({
    capabilities: { openLink: {}, sendPrompt: {}, copyText: {} },
  }),
  "artifact page, library CDNs, downloads": presets.artifact({
    egress: LIBRARY_CDNS,
    capabilities: { downloadFile: {} },
  }),
  "artifact page, served, images from any https site": presets.artifact({
    isolation: "domain",
    contentOrigins: [SERVED],
    egress: { anyHttps: ["img", "media"] },
  }),
  "inline widget, served, storage shared": presets.inlineWidget({
    isolation: "domain",
    contentOrigins: [SERVED],
    storage: { shared: "conversation" },
  }),
  "MCP Apps view": presets.mcpApp({ egress: { connect: ["https://api.example.com"] } }),
  "a whole-page viewer: fills, no host theme, 10 MB, storage per artifact, errors to the host":
    presets.artifact({
      isolation: "domain",
      contentOrigins: [SERVED],
      layout: { kind: "fill" },
      theme: { documents: "never" },
      limits: { maxBytes: 10 * 1_048_576 },
      storage: { scope: "this artifact, across its versions" },
      errors: "host",
    }),
  "an artifact page whose errors go nowhere": presets.artifact({ errors: "none" }),
};

/** Every check id the suites define: the leak probes and the served cases. */
const checks = (() => {
  const host = new Proxy({}, { get: () => () => undefined }) as unknown as ServedConformanceHost;
  return new Set([...PROBES.map((probe) => probe.id), ...servedTests(host).map((each) => each.id)]);
})();

describe("every limit the manual can state has browser checks that exist", () => {
  test.each(LIMIT_IDS)("%s", (id) => {
    const named = LIMIT_CHECKS[id];
    expect(named.length, `${id} names no check`).toBeGreaterThan(0);
    for (const check of named) {
      expect(checks.has(check), `${id} names ${check}, which no suite defines`).toBe(true);
    }
  });
});

describe.each(Object.entries(CONFIGS))("%s", (_name, config) => {
  const compiled = compile(config);
  const limits = manualLimits(config, "");

  test("the manual's sandbox list is exactly its limits, each with checks", () => {
    const guide = compiled.guide(["widget"]).split("\n");
    const start = guide.indexOf("The sandbox:");
    expect(start, "the manual has a sandbox list").toBeGreaterThan(-1);
    const listed: string[] = [];
    for (
      let index = start + 1;
      index < guide.length && guide[index]?.startsWith("- ");
      index += 1
    ) {
      listed.push(guide[index]?.slice(2) ?? "");
    }
    const stated = manualLimits(config, "NETWORK").filter((limit) => limit.topic === "sandbox");
    expect(listed.length).toBe(stated.length);
    stated.forEach((limit, index) => {
      expect(listed[index], limit.id).toBe(limit.id === "network" ? listed[index] : limit.text);
      expect(LIMIT_CHECKS[limit.id].length).toBeGreaterThan(0);
    });
    expect(listed.find((line) => line.startsWith("Network:"))).toBeDefined();
  });

  test("the other topics state their limits: where it runs, and in the interactive topic", () => {
    const widget = compiled.guide(["widget"]);
    const interactive = compiled.guide(["interactive"]);
    for (const limit of limits) {
      if (limit.topic === "where") {
        expect(widget, limit.id).toContain(limit.text);
      }
      if (limit.topic === "interactive") {
        expect(interactive, limit.id).toContain(`- ${limit.text}`);
      }
    }
  });

  test("lines follow the config: dialogs and forms while the sandbox withholds them, the address per isolation", () => {
    const ids = new Set(limits.map((limit) => limit.id));
    for (const id of [
      "silent",
      "dialogs",
      "print",
      "downloads",
      "forms",
      "windows",
      "devices",
      "workers",
      "sound",
      "address",
      "shell",
    ] as const) {
      expect(ids.has(id), id).toBe(true);
    }
    const address = limits.find((limit) => limit.id === "address")?.text ?? "";
    expect(address).toContain(config.isolation === "opaque" ? "about:srcdoc" : "one-time ticket");
  });
});

test("url mode states nothing: it has no shell and no manual", () => {
  expect(manualLimits(presets.url({ contentOrigins: [SERVED] }), "")).toEqual([]);
});

test("the copy and openLink capabilities change what the lines say", () => {
  const withCopy = manualLimits(
    presets.inlineWidget({ capabilities: { copyText: {}, openLink: {} } }),
    "",
  );
  expect(withCopy.find((each) => each.id === "shell")?.text).toContain(
    "copy buttons call copyText",
  );
  expect(withCopy.find((each) => each.id === "windows")?.text).toContain("through the app");
  const downloads = manualLimits(presets.artifact({ capabilities: { downloadFile: {} } }), "");
  expect(downloads.find((each) => each.id === "downloads")?.text).toContain("ui/download-file");
});

describe("the silent line follows where errors go, as the Errors line does (#4)", () => {
  const silent = (config: PortholeConfig) =>
    manualLimits(config, "").find((limit) => limit.id === "silent")?.text ?? "";
  const errors = (config: PortholeConfig) =>
    manualLimits(config, "").find((limit) => limit.id === "errors")?.text ?? "";

  test("agent: each block comes back to the agent, so it checks them", () => {
    const config = presets.inlineWidget({ errors: "agent" });
    expect(silent(config)).toContain("Each block comes back to you as an error, so check them.");
    expect(silent(config)).not.toContain("nothing shows an error");
    expect(errors(config)).toContain("comes back to you");
  });

  test("host: the app is told, the agent isn't", () => {
    const config = presets.inlineWidget({ errors: "host" });
    expect(silent(config)).toContain("The app is told of each block, but you aren't");
    expect(silent(config)).not.toContain("nothing shows an error");
    expect(errors(config)).toContain("goes to the app");
  });

  test("none: silent, and nothing reports", () => {
    const config = presets.inlineWidget({ errors: "none" });
    expect(silent(config)).toContain("fails silently");
    expect(silent(config)).toContain("nothing shows an error");
    expect(errors(config)).toContain("nothing reports");
  });

  test("unset: reported to the app where reportError is declared; silent where it isn't", () => {
    const declared = presets.inlineWidget();
    expect(silent(declared)).toContain("Each block is reported to the app.");
    expect(silent(declared)).not.toContain("nothing shows an error");
    expect(errors(declared)).toContain("is reported to the app");
    const undeclared = presets.inlineWidget({ capabilities: { reportError: false } });
    expect(silent(undeclared)).toContain("nothing shows an error");
    expect(errors(undeclared)).toContain("nothing reports");
  });

  test("14.silent checks both: what the host hears, and that nothing is shown", () => {
    expect(LIMIT_CHECKS.silent).toContain("14.silent");
  });
});
