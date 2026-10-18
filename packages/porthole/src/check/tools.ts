import type { PortholeConfig } from "../config/schema.ts";
import { builtInTopics, generateGuide, generateToolDescription } from "../guide/guide.ts";
import { fragmentOf, lintContent, type Finding } from "./lint.ts";
import { lintFiles, whereOf, type FileContents, type FileFinding } from "./files.ts";

/**
 * The agent's tools, as a tool list names them (P073): a name, a description and a JSON Schema
 * for each, from the config, so a host lists them in one line (an MCP server's `tools/list`, an
 * agent framework's tool array). The descriptions are the manual's own words.
 */

/** A JSON Schema (draft 2020-12), as tool lists take it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

const noun = (config: PortholeConfig) =>
  config.mode === "artifact" ? "page" : config.mode === "mcp-app" ? "view" : "widget";

/** The show tool's name: the config's `guide.toolName`, else `show_<noun>`. */
const showName = (config: PortholeConfig) => config.guide.toolName ?? `show_${noun(config)}`;
/** The guide tool's name: the config's `guide.guideToolName`, else `<noun>_guide`. */
const guideName = (config: PortholeConfig) => config.guide.guideToolName ?? `${noun(config)}_guide`;

/** The topics the manual has: the built-in ones and the config's own. */
export function guideTopics(config: PortholeConfig): string[] {
  return [...builtInTopics(config), ...Object.keys(config.guide.topics ?? {})];
}

/** The tool that shows content: `{ title, html }`. */
export function showTool(
  config: PortholeConfig,
  options: { readonly name?: string } = {},
): ToolDefinition {
  const it = noun(config);
  return {
    name: options.name ?? showName(config),
    description: generateToolDescription(config),
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: `A short title for the ${it}, as people see it.` },
        html: {
          type: "string",
          description:
            config.mode === "inline"
              ? "The widget: an HTML fragment (styles, then markup, then scripts) or SVG. No <!doctype>, <html>, <head> or <body>."
              : `The whole HTML ${config.mode === "mcp-app" ? "view" : "page"}.`,
        },
      },
      required: ["title", "html"],
      additionalProperties: false,
    },
  };
}

/** The tool that answers the manual: `{ topics? }`. */
export function guideTool(
  config: PortholeConfig,
  options: { readonly name?: string } = {},
): ToolDefinition {
  const topics = guideTopics(config);
  return {
    name: options.name ?? guideName(config),
    description: `The manual for ${showName(config)}: where a ${noun(config)} runs and how wide, sizes that read on a phone, colors, what the sandbox allows, and examples. Call it once before your first ${noun(config)}; ask for topics (${topics.join(", ")}) to read only those.`,
    inputSchema: {
      type: "object",
      properties: {
        topics: {
          type: "array",
          items: { type: "string", enum: topics },
          description: "The topics to read. Default: all of them.",
        },
      },
      additionalProperties: false,
    },
  };
}

/** The tool that checks content before it is shown (`checkPage`): `{ html, widths?, schemes? }`. */
export function checkTool(
  config: PortholeConfig,
  options: { readonly name?: string } = {},
): ToolDefinition {
  const it = noun(config);
  return {
    name: options.name ?? `check_${it}`,
    description: `Runs a ${it} in the real sandbox before anyone sees it, at phone and desktop width, in light and dark, and says what went wrong: what it throws, what the sandbox blocks, what fails to load, what overflows its width or gets cut. Call it with the ${it} you mean to show with ${showName(config)}, fix what it reports, then show it.`,
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: `The ${it}, as you would show it.` },
        widths: {
          type: "array",
          items: { type: "integer", minimum: 200, maximum: 2_000 },
          description: "Widths to run it at, px. Default: the phone's and the desktop's.",
        },
        schemes: {
          type: "array",
          items: { type: "string", enum: ["light", "dark"] },
          description:
            "Color schemes to run it in. Default: both (light only where the app doesn't theme it).",
        },
      },
      required: ["html"],
      additionalProperties: false,
    },
  };
}

/** The guide tool's answer: the manual for the topics asked, or what was wrong with the call. */
export function answerGuide(
  config: PortholeConfig,
  args: unknown,
): { readonly text: string } | { readonly error: string } {
  const topics = guideTopics(config);
  const asked =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as { topics?: unknown }).topics
      : undefined;
  if (asked === undefined) {
    return { text: generateGuide(config, topics) };
  }
  if (!Array.isArray(asked) || asked.some((each) => typeof each !== "string")) {
    return { error: `topics is a list of topic names: ${topics.join(", ")}.` };
  }
  const unknown = (asked as string[]).filter((each) => !topics.includes(each));
  if (unknown.length > 0) {
    return {
      error: `No topic ${unknown.map((each) => JSON.stringify(each)).join(", ")}: the topics are ${topics.join(", ")}.`,
    };
  }
  return { text: generateGuide(config, asked.length === 0 ? topics : (asked as string[])) };
}

export type AdmitResult =
  | {
      readonly ok: true;
      /** The content to show: as given, or a whole document taken as its body (a widget). */
      readonly content: string;
      /** Warnings (and errors, with `refuseOn: "never"`), for the tool's answer. */
      readonly findings: readonly Finding[];
      /** One line for the agent, or null when there's nothing to say. */
      readonly note: string | null;
    }
  | {
      readonly ok: false;
      readonly findings: readonly Finding[];
      /** What to tell the agent: what to change, and to call the tool again. */
      readonly refusal: string;
    };

const said = (finding: Finding) =>
  `${finding.line === undefined ? "" : `line ${finding.line}: `}${finding.message}`;

/**
 * The show tool's check before it shows content (P073): refuses only what certainly fails or is
 * cut (over the size, a document with no body where a fragment goes, nested frames,
 * `document.write`); the rest is returned as warnings. `refuseOn: "never"` refuses nothing.
 */
export function admitContent(
  config: PortholeConfig,
  content: string,
  options: { readonly refuseOn?: "error" | "never" } = {},
): AdmitResult {
  const findings = lintContent(config, content);
  const errors = findings.filter((each) => each.severity === "error");
  if (errors.length > 0 && (options.refuseOn ?? "error") === "error") {
    return {
      ok: false,
      findings,
      refusal: `Not shown. Change this, then call ${showName(config)} again:\n${errors.map((each) => `- ${said(each)}`).join("\n")}`,
    };
  }
  const document = findings.some((each) => each.rule === "document" && each.severity === "warning");
  const shown = document ? (fragmentOf(content) ?? content) : content;
  return {
    ok: true,
    content: shown,
    findings,
    note:
      findings.length === 0
        ? null
        : `Shown. Fix these next time:\n${findings.map((each) => `- ${said(each)}`).join("\n")}`,
  };
}

export type AdmitFilesResult =
  | {
      readonly ok: true;
      /** Warnings (and errors, with `refuseOn: "never"`), for the tool's answer. */
      readonly findings: readonly FileFinding[];
      /** One line for the agent, or null when there's nothing to say. */
      readonly note: string | null;
    }
  | {
      readonly ok: false;
      readonly findings: readonly FileFinding[];
      /** What to tell the agent: what to change, and to call the tool again. */
      readonly refusal: string;
    };

/**
 * A publish tool's check before it takes a page with files (P081): refuses only what certainly
 * fails (a path or limit the server won't take, no entry, a page `admitContent` would refuse, a
 * page's reference that starts with /); the rest, references to files that aren't in the set
 * among them, are warnings. `refuseOn: "never"` refuses nothing.
 */
export function admitFiles(
  config: PortholeConfig,
  files: FileContents,
  options: { readonly entry?: string; readonly refuseOn?: "error" | "never" } = {},
): AdmitFilesResult {
  const findings = lintFiles(
    config,
    files,
    options.entry === undefined ? {} : { entry: options.entry },
  );
  const errors = findings.filter((each) => each.severity === "error");
  if (errors.length > 0 && (options.refuseOn ?? "error") === "error") {
    return {
      ok: false,
      findings,
      refusal: `Not published. Change this, then publish again:\n${errors.map((each) => `- ${whereOf(each)}${each.message}`).join("\n")}`,
    };
  }
  return {
    ok: true,
    findings,
    note:
      findings.length === 0
        ? null
        : `Published. Fix these next time:\n${findings.map((each) => `- ${whereOf(each)}${each.message}`).join("\n")}`,
  };
}

/**
 * What to tell the agent when its manual changes (a display kind flipped between served and
 * opaque, P073): the lines that are new, or null when the manual reads the same.
 */
export function guideChanges(from: PortholeConfig, to: PortholeConfig): string | null {
  const text = (config: PortholeConfig) =>
    [generateToolDescription(config), generateGuide(config, guideTopics(config))].join("\n");
  const before = new Set(text(from).split("\n"));
  const after = text(to).split("\n");
  const added = after.filter((line) => line.trim() !== "" && !before.has(line));
  if (added.length === 0) {
    return null;
  }
  return `The manual for ${showName(to)} changed. It now says:\n${added.map((line) => `- ${line.replace(/^- /u, "")}`).join("\n")}`;
}
