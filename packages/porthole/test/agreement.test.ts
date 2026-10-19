import { describe, expect, test } from "vitest";
import {
  CAPABILITY_NAMES,
  GUIDE_EXAMPLES,
  LIBRARY_CDNS,
  capabilitySpec,
  compile,
  declaredCapabilities,
  effectiveGates,
  egressOrigins,
  fileLimits,
  LIBRARY_PATH,
  VENDORED_LIBRARIES,
  libraryPath,
  presets,
  REFUSAL_CODES,
  type CapabilityName,
  type CompiledConfig,
  type PortholeConfig,
} from "../src/index.ts";
import { composedRuntime } from "../src/shell/document.ts";
import { runtimeEntryPrefix } from "../src/guide/runtime.ts";
import { assetCspDirectives } from "../src/compile/policy.ts";
import { RUNTIME_TYPES } from "../src/runtime/types.generated.ts";
import { familyOf, methodGates, offeredCapabilities } from "../src/runtime/contract.ts";
import { sizeWords } from "../src/guide/limits.ts";
import { librarySources } from "../src/compile/policy.ts";

/**
 * The agreement test (P003, OBJECTIVE 2): for every preset, the CSP, the shell's wiring and the
 * manual are derived from the same config and say the same thing. The manual names only variables
 * the shell injects, only globals the shell defines, only origins the CSP allows; and it names all
 * of them. Changing the config changes all three together.
 */

const ALL_HANDLED: PortholeConfig["capabilities"] = {
  sendPrompt: {},
  openLink: {},
  downloadFile: {},
  callTool: {},
  readData: {},
  subscribeData: {},
  setModelContext: {},
};

const CASES: Record<string, PortholeConfig> = {
  "inline widget, defaults": presets.inlineWidget(),
  "inline widget, Ferry-like": presets.inlineWidget({
    capabilities: { sendPrompt: {}, openLink: {} },
    egress: LIBRARY_CDNS,
    guide: { toolName: "show_widget", guideToolName: "display_guide" },
  }),
  "inline widget, every capability, custom gates": presets.inlineWidget({
    capabilities: {
      ...ALL_HANDLED,
      openLink: { gates: ["confirm", { rateLimit: { perMinute: 5 } }] },
    },
  }),
  "inline widget, a reduced theme": presets.inlineWidget({
    capabilities: { sendPrompt: {} },
    theme: { event: "app:theme" },
  }),
  "inline widget, chart colors and the accent dropped": presets.inlineWidget({
    theme: {
      variables: Object.fromEntries(
        Object.keys(presets.inlineWidget().theme.variables)
          .filter((name) => name.startsWith("--color-chart-") || name.startsWith("--color-accent"))
          .map((name) => [name, null]),
      ),
    },
  }),
  "inline widget, copy buttons and comments": presets.inlineWidget({
    capabilities: { copyText: {}, annotate: {}, sendPrompt: {} },
  }),
  "artifact page": presets.artifact(),
  "artifact page with comments": presets.artifact({ capabilities: { annotate: {} } }),
  "a whole-page viewer (P065)": presets.artifact({
    isolation: "domain",
    contentOrigins: ["https://*.example-usercontent.com"],
    layout: { kind: "fill" },
    theme: { documents: "never" },
    limits: { maxBytes: 10 * 1_048_576 },
    storage: { scope: "this artifact, across its versions" },
    errors: "host",
  }),
  "artifact page, hotlinked images and media from any https site": presets.artifact({
    egress: { anyHttps: ["img", "media"] },
  }),
  "artifact page, library CDNs and any https image": presets.artifact({
    egress: { ...LIBRARY_CDNS, anyHttps: ["img"] },
  }),
  "inline widget, served, storage shared per conversation": presets.inlineWidget({
    isolation: "domain",
    contentOrigins: ["https://*.example-usercontent.com"],
    storage: { shared: "conversation" },
    capabilities: { copyText: {} },
  }),
  "artifact page, served, its files limited (P081)": presets.artifact({
    isolation: "domain",
    contentOrigins: ["https://*.example-usercontent.com"],
    capabilities: { downloadFile: {} },
    limits: { maxFiles: 50, maxFileBytes: 2_000_000, maxVersionBytes: 30_000_000 },
  }),
  "artifact page, served on its own domain": presets.artifact({
    isolation: "domain",
    contentOrigins: ["https://*.example-usercontent.com"],
  }),
  "live widget, served (P079)": presets.liveWidget({
    isolation: "domain",
    contentOrigins: ["https://*.example-usercontent.com"],
    capabilities: { openLink: {}, copyText: {} },
  }),
  "live widget, opaque: no libraries": presets.liveWidget(),
  "artifact page, served, the capability runtime with everything (P085)": presets.artifact({
    isolation: "domain",
    contentOrigins: ["https://*.example-usercontent.com"],
    runtime: "1",
    capabilities: {
      ...ALL_HANDLED,
      copyText: {},
      user: {},
      comments: {},
      artifact: {},
      assets: {},
      db: {},
    },
  }),
  "artifact page, runtime, uploads open to people who interact (P089)": presets.artifact({
    isolation: "domain",
    contentOrigins: ["https://*.example-usercontent.com"],
    runtime: "1",
    capabilities: {
      assets: { levels: { upload: "interact" } },
      db: { levels: { set: "admin" } },
      sendPrompt: { levels: { send: "view" }, gates: ["confirm"] },
    },
  }),
  "inline widget, the capability runtime, a db and a copy button": presets.inlineWidget({
    runtime: "1",
    capabilities: { copyText: {}, db: {}, user: {} },
  }),
  "MCP Apps view": presets.mcpApp({
    capabilities: { ...ALL_HANDLED, copyText: {}, annotate: {} },
    egress: { connect: ["https://api.example.com"], img: ["https://images.example.com"] },
  }),
};

/** Every manual text the agent can see: all topics and the tool description. */
const manual = (compiled: CompiledConfig): string =>
  `${compiled.guide()}\n${compiled.toolDescription()}`;

/** The CSS variables a text names, with `--x-1 … --x-8` ranges expanded. */
function variablesIn(text: string): Set<string> {
  const names = new Set(text.match(/--[a-z0-9]+(?:-[a-z0-9]+)*/gu) ?? []);
  for (const [, prefix, from, to] of text.matchAll(/(--[a-z0-9-]+-)(\d+) … \1(\d+)/gu)) {
    for (let index = Number(from); index <= Number(to); index += 1) {
      names.add(`${prefix}${index}`);
    }
  }
  return names;
}

/** The origins a text names (in URLs, by their origin). */
const originsIn = (text: string): Set<string> =>
  new Set(
    [...text.matchAll(/\b(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d+)?/gu)].map(
      ([url]) => url,
    ),
  );

/**
 * The host sources a CSP lists (not keywords or schemes), less Porthole's libraries' path on the
 * content origins (P079): the manual teaches those as paths on the frame's own address.
 */
const cspOrigins = (compiled: CompiledConfig): Set<string> =>
  new Set(
    compiled.cspDirectives.flatMap(([, ...sources]) =>
      sources.filter((source) => source.includes("://") && !source.endsWith(LIBRARY_PATH)),
    ),
  );

/** How each capability's entry in the manual starts (with the shell's global, or without). */
const ENTRY_PREFIXES: {
  readonly [
    N in Exclude<CapabilityName, "resize" | "user" | "comments" | "artifact" | "assets" | "db">
  ]: readonly string[];
} = {
  sendPrompt: ["- sendPrompt(", "- Messages:"],
  openLink: ["- openLink(", "- Links:"],
  downloadFile: ["- Downloads:"],
  callTool: ["- Tools:"],
  readData: ["- readData(", "- Data:"],
  subscribeData: ["- subscribeData(", "- Live data:"],
  setModelContext: ["- Context for the agent:"],
  reportError: ["- Errors:"],
  copyText: ["- copyText(", "- Copying:"],
  annotate: ["- Comments:"],
};

const GLOBALS = [
  ...CAPABILITY_NAMES.flatMap((name) => {
    const spec = capabilitySpec(name);
    return spec.global === undefined ? [] : [spec.global];
  }),
  "porthole.use",
];

/** How a capability's entry starts: under the runtime, as porthole.use's methods (P085). */
const prefixesOf = (config: PortholeConfig, name: CapabilityName): readonly string[] => {
  const runtime = runtimeEntryPrefix(name);
  if (config.runtime !== undefined && runtime !== null) {
    return [runtime];
  }
  return (ENTRY_PREFIXES as Readonly<Record<string, readonly string[]>>)[name] ?? [];
};

/** The codes a data read is taught (P080), and under the runtime every one (P087). */
const DATA_CODES = ["consent_required", "denied", "rate_limited", "not_allowed", "failed"];

describe.each(Object.entries(CASES))("%s", (_name, config) => {
  const compiled = compile(config);
  const plan = compiled.shell;
  const text = manual(compiled);

  test("the shell injects exactly the config's theme variables, and the manual teaches exactly them", () => {
    expect(plan).not.toBeNull();
    const declared = Object.keys(config.theme.variables);
    expect(plan?.themeVariables).toEqual(declared);
    const taught = variablesIn(text);
    for (const name of taught) {
      expect(declared, `the manual teaches ${name}, which the shell doesn't inject`).toContain(
        name,
      );
    }
    for (const name of declared) {
      expect(taught.has(name), `the shell injects ${name}, which the manual never teaches`).toBe(
        true,
      );
    }
  });

  test("the manual names exactly the globals the shell defines", () => {
    const defined = (plan?.globals ?? []).map((global) =>
      global === "porthole" ? "porthole.use" : global,
    );
    for (const global of GLOBALS) {
      const taught = text.includes(`${global}(`);
      expect(taught, `${global}: taught ${taught}, defined ${defined.includes(global)}`).toBe(
        defined.includes(global),
      );
    }
    // And the runtime really defines each global it is told to, from the plan: under the
    // capability runtime, 0.6's too (the legacy path, P085), which the manual no longer teaches.
    const runtime = plan === null ? "" : composedRuntime(plan);
    for (const global of [...(plan?.globals ?? []), ...(plan?.legacyGlobals ?? [])]) {
      expect(runtime).toContain(`lock(window, "${global}", `);
    }
    expect(plan?.legacyGlobals.length === 0 || plan?.runtime !== undefined).toBe(true);
  });

  test("the shell wires exactly the declared capabilities, with the gates the manual describes", () => {
    const declared = declaredCapabilities(config);
    expect(Object.keys(plan?.capabilities ?? {}).sort()).toEqual([...declared].sort());
    for (const name of declared) {
      const gates = effectiveGates(config, name);
      expect(plan?.capabilities[name]?.userActivation).toBe(gates.includes("user-activation"));
    }
    const interactive = compiled.guide(["interactive"]).split("\n");
    for (const name of declared) {
      if (name === "resize" || config.capabilities[name]?.guide !== undefined) {
        continue;
      }
      const entry = interactive.find((line) =>
        prefixesOf(config, name).some((prefix) => line.startsWith(prefix)),
      );
      expect(entry, `the manual has no entry for ${name}`).toBeDefined();
      if (name === "annotate") {
        // The person comments; the content calls nothing: its gates bound the frame's reports.
        continue;
      }
      // A host function's gates, and under the runtime its methods' own (after the review).
      const family = familyOf(name);
      const gates = [
        ...effectiveGates(config, name),
        ...(config.runtime === undefined || family === null
          ? []
          : family.methods.flatMap((method) => methodGates(config, family.name, method))),
      ];
      expect(entry?.includes("unless they confirm"), `${name}: confirm`).toBe(
        gates.includes("confirm"),
      );
      expect(entry?.includes("asks the person to allow it"), `${name}: consent`).toBe(
        gates.includes("consent"),
      );
      expect(entry?.includes("from a click"), `${name}: user activation`).toBe(
        gates.includes("user-activation"),
      );
      if (name === "readData") {
        // Every reason a refusal can give content, taught where content reads data (P080).
        for (const code of config.runtime === undefined ? DATA_CODES : REFUSAL_CODES) {
          expect(entry, `readData: refusal ${code}`).toContain(code);
        }
      }
      for (const gate of gates) {
        if (typeof gate === "object") {
          expect(entry, `${name}: rate limit`).toContain(
            `At most ${gate.rateLimit.perMinute} a minute`,
          );
        }
      }
    }
  });

  test("the manual teaches the capability runtime exactly where the shell has it (P085)", () => {
    const offered = offeredCapabilities(config);
    expect(text.includes("porthole.use(")).toBe(plan?.runtime !== undefined);
    expect(compiled.guide().includes("# Capabilities")).toBe(plan?.runtime !== undefined);
    if (plan?.runtime === undefined) {
      return;
    }
    const topic = compiled.guide(["capabilities"]);
    // Each offered capability's types, as the package ships them, and nothing else's.
    for (const [name, types] of Object.entries(RUNTIME_TYPES[plan.runtime] ?? {})) {
      expect(topic.includes(types.trim()), `${name}'s types`).toBe(
        name === "porthole" || (offered as readonly string[]).includes(name),
      );
    }
    // Declared assets: scripts from the library taught exactly where the CSP runs them (P089).
    if (config.capabilities.assets !== undefined) {
      const origin = "https://a-x.example-usercontent.com";
      const csp = assetCspDirectives(config, compiled.cspDirectives, origin);
      const runs = csp.some(
        ([name, ...sources]) => name === "script-src" && sources.includes(`${origin}/_blob/`),
      );
      expect(text.includes("and scripts and stylesheets an admin uploaded")).toBe(runs);
      expect(text.includes("the library holds no scripts or stylesheets here")).toBe(!runs);
    }
  });

  test("the manual teaches refusal codes exactly where content reads data (P080), or the runtime calls (P085)", () => {
    expect(text.includes("consent_required")).toBe(
      config.capabilities.readData !== undefined || plan?.runtime !== undefined,
    );
  });

  test("the manual names exactly the origins the CSP allows", () => {
    const allowed = cspOrigins(compiled);
    const named = originsIn(text);
    for (const origin of named) {
      expect(allowed, `the manual names ${origin}, which the CSP blocks`).toContain(origin);
    }
    for (const origin of allowed) {
      expect(named, `the CSP allows ${origin}, which the manual never names`).toContain(origin);
    }
    // Any https site, for passive kinds only (P059): the CSP's scheme source and the manual's words.
    const anyHttpsIn = compiled.cspDirectives
      .filter(([, ...sources]) => sources.includes("https:"))
      .map(([name]) => name);
    for (const name of anyHttpsIn) {
      expect(["img-src", "media-src", "font-src"], `https: in ${name}`).toContain(name);
    }
    expect(text.includes("from any https site")).toBe(anyHttpsIn.length > 0);
    if (allowed.size === 0 && anyHttpsIn.length === 0) {
      expect(text).toContain("Network: none");
      expect(text).toContain("with no network");
    }
  });

  test("each CSP directive allows exactly the egress and the declared capabilities' needs", () => {
    const directive = (name: string) =>
      compiled.cspDirectives
        .find(([each]) => each === name)
        ?.slice(1)
        .filter((source) => source.includes("://")) ?? [];
    expect(directive("connect-src")).toEqual(egressOrigins(config, "connect"));
    expect(directive("script-src")).toEqual([
      ...egressOrigins(config, "script"),
      ...librarySources(config),
    ]);
    expect(directive("style-src")).toEqual(egressOrigins(config, "style"));
    expect(directive("img-src")).toEqual(egressOrigins(config, "img"));
    expect(directive("font-src")).toEqual(egressOrigins(config, "font"));
    expect(directive("media-src")).toEqual(egressOrigins(config, "media"));
    expect(directive("frame-src")).toEqual([]);
    expect(compiled.csp).not.toContain("'self'");
  });

  test("the manual teaches Porthole's libraries exactly where the CSP loads them (P079)", () => {
    const served = librarySources(config).length > 0;
    for (const library of VENDORED_LIBRARIES) {
      expect(text.includes(`<script src="${libraryPath(library)}">`), library.name).toBe(served);
    }
    expect(text.includes(LIBRARY_PATH)).toBe(served);
  });

  test("the manual teaches a page's own files exactly where they are served, with their limits (P081)", () => {
    // `/server` serves a version's files only for an artifact under a served config.
    const served = config.mode === "artifact" && config.isolation === "domain";
    expect(text.includes("Files: a page may come with files of its own")).toBe(served);
    if (served) {
      const limits = fileLimits(config.limits);
      expect(text).toContain(
        `At most ${limits.maxFiles.toLocaleString("en-US")} files, ${sizeWords(limits.maxFileBytes)} each (a page under ${sizeWords(config.limits.maxBytes)}) and ${sizeWords(limits.maxVersionBytes)} in all.`,
      );
      // How a page offers a file: 0.6's capability, or the runtime's method (P085).
      const offer = config.runtime === undefined ? "downloadFile" : "downloads.save";
      expect(text.includes(`offer a file with ${offer}`)).toBe(
        config.capabilities.downloadFile !== undefined,
      );
    }
  });

  test("the manual states the config's limits and theme event", () => {
    expect(text).toContain(`under ${sizeWords(config.limits.maxBytes)}`);
    if (config.capabilities.resize !== undefined && config.layout.kind !== "fill") {
      expect(text).toContain(`at most ${config.limits.maxHeightPx.toLocaleString("en-US")} px`);
    }
    // A page the host doesn't theme hears no theme change, and the manual says none.
    expect(text.includes(`window "${config.theme.event}"`)).toBe(
      config.theme.documents !== "never",
    );
    expect(plan?.themeEvent).toBe(config.theme.event);
    expect(text).toMatch(
      new RegExp(`about ${config.layout.narrowWidthPx} px (wide )?on a phone`, "u"),
    );
  });
});

describe("changing the config changes the CSP, the shell and the manual together", () => {
  test("opening an origin opens it in the CSP and names it in the manual", () => {
    const closed = compile(presets.inlineWidget());
    const open = compile(
      presets.inlineWidget({ egress: { connect: ["https://api.example.com"] } }),
    );
    expect(closed.csp).toContain("connect-src 'none'");
    expect(manual(closed)).not.toContain("https://api.example.com");
    expect(open.csp).toContain("connect-src https://api.example.com");
    expect(manual(open)).toContain("data (fetch, WebSocket) from https://api.example.com");
  });

  test("a capability's own origins join the CSP only while it is declared", () => {
    const needs = { connect: ["https://tools.example.com"] };
    const without = compile(presets.mcpApp());
    const declared = compile(presets.mcpApp({ capabilities: { callTool: needs } }));
    expect(without.csp).not.toContain("tools.example.com");
    expect(declared.csp).toContain("connect-src https://tools.example.com");
    expect(manual(declared)).toContain("https://tools.example.com");
  });

  // P103.3: callTool has a rate by default, which the manual teaches; the host's gates replace it.
  test("callTool's default rate is in the manual, and a host's own gates replace it (P103)", () => {
    const tools = (config: PortholeConfig) =>
      manual(compile(config))
        .split("\n")
        .find((line) => line.startsWith("- Tools:")) ?? "";
    expect(effectiveGates(presets.mcpApp({ capabilities: { callTool: {} } }), "callTool")).toEqual([
      "confirm",
      { rateLimit: { perMinute: 30 } },
    ]);
    expect(tools(presets.mcpApp({ capabilities: { callTool: {} } }))).toContain(
      "nothing happens unless they confirm. At most 30 a minute.",
    );
    const own = presets.mcpApp({ capabilities: { callTool: { gates: ["confirm"] } } });
    expect(tools(own)).toContain("unless they confirm.");
    expect(tools(own)).not.toContain("a minute");
  });

  // And the class: whatever a page may call without a gesture (on load, on a timer) is bounded
  // by a rate unless the host says otherwise; only its size, which carries nothing, isn't.
  test("every capability a page may call without a gesture has a rate by default (P103)", () => {
    for (const name of CAPABILITY_NAMES) {
      const gates = capabilitySpec(name).defaultGates;
      if (name === "resize" || gates.includes("user-activation")) {
        continue;
      }
      expect(
        gates.some((gate) => typeof gate === "object"),
        `${name}: ${JSON.stringify(gates)}`,
      ).toBe(true);
    }
  });

  test("dropping a capability removes its global from the shell and the manual", () => {
    const withPrompt = compile(presets.inlineWidget({ capabilities: { sendPrompt: {} } }));
    const without = compile(presets.inlineWidget());
    expect(withPrompt.shell?.globals).toContain("sendPrompt");
    expect(manual(withPrompt)).toContain("sendPrompt(text)");
    expect(without.shell?.globals).not.toContain("sendPrompt");
    expect(manual(without)).not.toContain("sendPrompt");
    expect(manual(without)).not.toContain("openLink");
  });

  test("a variable the theme drops leaves the shell and every sentence that needs it", () => {
    const base = presets.inlineWidget();
    const {
      "--color-chart-1": _chart,
      "--color-background-primary": _surface,
      ...rest
    } = base.theme.variables;
    const reduced = compile({ ...base, theme: { ...base.theme, variables: rest } });
    expect(reduced.shell?.themeVariables).not.toContain("--color-chart-1");
    expect(manual(reduced)).not.toContain("--color-chart-1 ");
    expect(manual(reduced)).not.toContain("--color-background-primary");
    // Examples that need a dropped variable are left out rather than taught.
    expect(manual(reduced)).not.toContain(GUIDE_EXAMPLES.line);
  });

  test("a host's own guide entry replaces the generated one", () => {
    const compiled = compile(
      presets.inlineWidget({
        capabilities: { reportError: { guide: "Errors: reported to you at your next turn." } },
      }),
    );
    expect(compiled.guide(["interactive"])).toContain(
      "- Errors: reported to you at your next turn.",
    );
    expect(compiled.guide(["interactive"])).not.toContain("reported to the app");
  });
});

describe("the manual's examples", () => {
  test("use only the default theme's variables and load nothing", () => {
    const variables = Object.keys(presets.inlineWidget().theme.variables);
    for (const [name, code] of Object.entries(GUIDE_EXAMPLES)) {
      for (const variable of variablesIn(code)) {
        expect(variables, `${name} uses ${variable}`).toContain(variable);
      }
      expect(code, name).not.toMatch(/https?:\/\//u);
    }
  });
});
