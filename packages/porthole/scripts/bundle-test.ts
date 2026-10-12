/**
 * The built package, bundled as adopters bundle it (P075): every entry point through rolldown (a
 * single executable: Ferry's CLI, rolldown then Node SEA) and through esbuild for Workers. A
 * bundle has no files beside its modules, so any load left for run time (an `import()` of a
 * computed path, `require`, `createRequire`, the module's own location: `import.meta`,
 * `__filename`, `__dirname`) fails only on someone's machine. This lists every such site and
 * fails on any not reviewed below, then runs the bundles from a directory with nothing else in it:
 * each imports, and `/check` checks a page in Chromium with the check page it carries.
 *
 *   pnpm --filter @botiverse/porthole run build && pnpm --filter @botiverse/porthole run test:bundle
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, isBuiltin } from "node:module";
import { build } from "esbuild";
import { rolldown } from "rolldown";
import { parseSync } from "rolldown/utils";
import type * as Check from "../src/check/index.ts";
import type * as Conformance from "../src/conformance/index.ts";
import type * as Core from "../src/index.ts";

const root = new URL("../", import.meta.url);
const work = new URL(".dev/bundles/", root);

const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as {
  publishConfig: { exports: Record<string, { default: string }> };
};
/** The published entry points: `.` → `./dist/index.js`. */
const entries = Object.entries(manifest.publishConfig.exports).map(([name, target]) => ({
  name,
  file: new URL(target.default, root).pathname,
  slug: name === "." ? "index" : name.slice(2).replaceAll("/", "-"),
}));

/** Left to the app: Node's builtins, and the peers an app installs itself. */
const EXTERNAL = [
  /^node:/u,
  ...builtinModules,
  "react",
  "react-dom",
  /^react\//u,
  /^react-dom\//u,
  "@playwright/test",
];
const externalTo = (id: string) =>
  EXTERNAL.some((each) => (typeof each === "string" ? each === id : each.test(id)));

/** How a site loads at run time. `self`: the module's own location, the base of a path beside it. */
type LoadForm = "import" | "require" | "require.resolve" | "createRequire" | "self";

/**
 * The loads left for run time on purpose, by entry: each says why a bundle without the file is
 * fine. Anything else fails.
 */
const REVIEWED: Readonly<Record<string, Partial<Record<LoadForm, number>>>> = {
  // The official MCP Apps App SDK, which the MCP probes serve to their views where it is
  // installed beside the suite (an optional development dependency); without it they say so and
  // skip. The runner runs under Playwright, from node_modules.
  "./conformance": { createRequire: 1, self: 1 },
};

interface Node {
  readonly type: string;
  readonly start: number;
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string" &&
  typeof (value as { start?: unknown }).start === "number";

/** A string a bundler can see: a literal, or a template literal with nothing in it. */
function staticString(node: unknown): string | undefined {
  if (!isNode(node)) {
    return undefined;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
    return (node.quasis as { value: { cooked: string | null } }[])[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function callee(node: Node): unknown {
  let target = node.callee;
  while (
    isNode(target) &&
    (target.type === "SequenceExpression" || target.type === "ParenthesizedExpression")
  ) {
    target =
      target.type === "SequenceExpression"
        ? (target.expressions as unknown[]).at(-1)
        : target.expression;
  }
  return target;
}

const propertyName = (node: unknown): string | undefined =>
  isNode(node) &&
  node.type === "MemberExpression" &&
  node.computed !== true &&
  isNode(node.property) &&
  node.property.type === "Identifier"
    ? (node.property.name as string)
    : undefined;

function formOf(node: Node, parent: Node | undefined, key: string): LoadForm | undefined {
  switch (node.type) {
    case "ImportExpression": {
      const specifier = staticString(node.source);
      return specifier !== undefined && isBuiltin(specifier) ? undefined : "import";
    }
    case "CallExpression": {
      const target = callee(node);
      if (isNode(target) && target.type === "Identifier" && target.name === "require") {
        const specifier = staticString((node.arguments as unknown[])[0]);
        return specifier !== undefined && isBuiltin(specifier) ? undefined : "require";
      }
      if (
        isNode(target) &&
        target.type === "MemberExpression" &&
        isNode(target.object) &&
        target.object.type === "Identifier" &&
        target.object.name === "require" &&
        propertyName(target) === "resolve"
      ) {
        return "require.resolve";
      }
      return (isNode(target) && target.type === "Identifier" && target.name === "createRequire") ||
        propertyName(target) === "createRequire"
        ? "createRequire"
        : undefined;
    }
    case "Identifier": {
      if (node.name !== "__dirname" && node.name !== "__filename") {
        return undefined;
      }
      const named =
        parent !== undefined &&
        ((parent.type === "MemberExpression" && key === "property" && parent.computed !== true) ||
          (parent.type === "Property" && key === "key" && parent.computed !== true));
      return named ? undefined : "self";
    }
    case "MetaProperty":
      return isNode(node.meta) && node.meta.name === "import" ? "self" : undefined;
    default:
      return undefined;
  }
}

/** Every load a bundle leaves for run time, with its line. */
function looseLoads(code: string): { form: LoadForm; line: number; code: string }[] {
  const parsed = parseSync("bundle.js", code, { lang: "js", sourceType: "module" });
  if (parsed.errors.length > 0) {
    throw new Error(`the bundle doesn't parse: ${parsed.errors[0]?.message}`);
  }
  const found: { form: LoadForm; line: number; code: string }[] = [];
  const visit = (node: unknown, parent: Node | undefined, key: string) => {
    if (Array.isArray(node)) {
      for (const each of node) {
        visit(each, parent, key);
      }
      return;
    }
    if (!isNode(node)) {
      return;
    }
    const form = formOf(node, parent, key);
    if (form !== undefined) {
      const line = code.slice(0, node.start).split("\n").length;
      found.push({ form, line, code: (code.split("\n")[line - 1] ?? "").trim().slice(0, 160) });
    }
    for (const [child, value] of Object.entries(node)) {
      if (child !== "type" && child !== "start" && child !== "end" && typeof value === "object") {
        visit(value, node, child);
      }
    }
  };
  visit(parsed.program, undefined, "");
  return found;
}

const problems: string[] = [];
const counted = (loads: { form: LoadForm }[]) => {
  const counts: Partial<Record<LoadForm, number>> = {};
  for (const { form } of loads) {
    counts[form] = (counts[form] ?? 0) + 1;
  }
  return counts;
};

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

for (const entry of entries) {
  // A single executable's way: rolldown, for Node, every dynamic import inlined.
  const bundle = await rolldown({ input: entry.file, platform: "node", external: externalTo });
  const { output } = await bundle.generate({ format: "esm", codeSplitting: false });
  await bundle.close();
  const code = output[0].code;
  await writeFile(new URL(`${entry.slug}.mjs`, work), code);
  const loads = looseLoads(code);
  const expected = REVIEWED[entry.name] ?? {};
  if (JSON.stringify(counted(loads)) !== JSON.stringify(expected)) {
    problems.push(
      `${entry.name} (rolldown) leaves loads for run time that a bundle doesn't have (expected ${JSON.stringify(expected)}):\n${loads.map((each) => `  ${each.form} at line ${each.line}: ${each.code}`).join("\n")}`,
    );
  }
  // A Worker's way: esbuild, for the browser-like runtimes (no Node builtins but the externals).
  if (!["./node", "./conformance", "./conformance/reporter"].includes(entry.name)) {
    const worker = await build({
      entryPoints: [entry.file],
      bundle: true,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      external: ["react", "react-dom", "react/*", "react-dom/*"],
      write: false,
      logLevel: "silent",
    }).catch((error: unknown) => {
      problems.push(`${entry.name} (esbuild, Workers) doesn't bundle: ${String(error)}`);
      return null;
    });
    const text = worker?.outputFiles[0]?.text;
    if (text !== undefined) {
      const workerLoads = looseLoads(text);
      if (workerLoads.length > 0) {
        problems.push(
          `${entry.name} (esbuild, Workers) leaves loads for run time:\n${workerLoads.map((each) => `  ${each.form} at line ${each.line}: ${each.code}`).join("\n")}`,
        );
      }
    }
  }
}

// Each bundle runs from a directory with nothing beside it.
for (const entry of entries) {
  try {
    await import(new URL(`${entry.slug}.mjs`, work).href);
  } catch (error) {
    problems.push(`${entry.name}: its bundle doesn't load: ${String(error)}`);
  }
}

// And checks a page with the check page it carries (no `page` given).
try {
  const { checkPage, playwrightDriver } = (await import(
    new URL("check.mjs", work).href
  )) as typeof Check;
  const { presets } = (await import(new URL("index.mjs", work).href)) as typeof Core;
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const report = await checkPage({
      config: presets.inlineWidget(),
      content: "<p>fine</p>\n<script>\nnull.boom;\n</script>",
      driver: playwrightDriver(browser),
      widths: [400],
      schemes: ["light"],
      settleMs: 500,
    });
    if (report.runs.length !== 1 || !report.text.includes("(line 3)")) {
      problems.push(`/check from its bundle didn't check the page:\n${report.text}`);
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  problems.push(`/check from its bundle couldn't check a page: ${String(error)}`);
}
try {
  const { harnessScript } = (await import(
    new URL("conformance.mjs", work).href
  )) as typeof Conformance;
  if (!(await harnessScript()).includes("portholeConformance")) {
    problems.push("/conformance from its bundle has no harness");
  }
} catch (error) {
  problems.push(`/conformance from its bundle has no harness: ${String(error)}`);
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `bundle-test: ${entries.length} entry points bundled (rolldown, and esbuild for Workers) with no loads left for run time but those reviewed; /check checked a page from its bundle.\n`,
);
