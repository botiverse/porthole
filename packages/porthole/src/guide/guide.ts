import {
  MAX_COPY_CHARS,
  capabilitySpec,
  type CapabilityName,
  type Gate,
} from "../config/capabilities.ts";
import type { PortholeConfig } from "../config/schema.ts";
import { BUILT_IN_TOPICS } from "../config/validate.ts";
import {
  anyHttps,
  declaredCapabilities,
  effectiveGates,
  egressOrigins,
  type EgressKind,
} from "../compile/policy.ts";
import { shellPlan } from "../shell/plan.ts";
import { themeDefault } from "../theme/variables.ts";
import { GUIDE_EXAMPLES } from "./examples.ts";
import { manualLimits, sizeWords } from "./limits.ts";

/**
 * The agent manual and the tool description, generated from the config (PRINCIPLE 3, 10): the
 * theme variables it teaches are the ones the shell injects, the globals are the ones the shell
 * defines, the origins are the CSP's, the limits are the config's. A sentence that needs a
 * variable the config doesn't declare is left out, never taught. Each topic is written when asked
 * for, not when the module loads.
 */

export type BuiltInTopic = (typeof BUILT_IN_TOPICS)[number];

/** A topic name: a built-in one, or one of the config's own (`guide.topics`). */
export type GuideTopic = BuiltInTopic | (string & {});

interface Context {
  readonly config: PortholeConfig;
  /** What the content is called: widget, page or view. */
  readonly noun: string;
  readonly has: (...variables: string[]) => boolean;
  /** `text` when every variable it names is declared, else null (left out). */
  readonly when: (text: string) => string | null;
  readonly names: (prefix: string, except?: readonly string[]) => string;
  readonly declared: (name: CapabilityName) => boolean;
  /** Whether the shell defines `name` as a global for content. */
  readonly global: (name: string) => boolean;
}

const VARIABLE = /--[a-z0-9]+(?:-[a-z0-9]+)*/gu;

function context(config: PortholeConfig): Context {
  const variables = Object.keys(config.theme.variables);
  const has = (...names: string[]) => names.every((name) => variables.includes(name));
  const declared = new Set(declaredCapabilities(config));
  const globals = new Set(shellPlan(config)?.globals ?? []);
  return {
    config,
    noun: config.mode === "artifact" ? "page" : config.mode === "mcp-app" ? "view" : "widget",
    has,
    when: (text) => (has(...(text.match(VARIABLE) ?? [])) ? text : null),
    names: (prefix, except = []) =>
      variables
        .filter(
          (name) => name.startsWith(prefix) && !except.some((other) => name.startsWith(other)),
        )
        .join(", "),
    declared: (name) => declared.has(name),
    global: (name) => globals.has(name),
  };
}

/** Lines, without those left out (null); "" is a blank line, and blank lines never repeat. */
const lines = (...each: (string | null)[]): string =>
  each
    .filter((line) => line !== null)
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

const KIND_WORDS: Readonly<Record<EgressKind, string>> = {
  script: "scripts",
  style: "styles",
  font: "fonts",
  img: "images",
  media: "audio and video",
  connect: "data (fetch, WebSocket)",
};

/** What the manual calls `https:` (any https site), where a config opens passive kinds to it. */
export const ANY_HTTPS_SITE = "any https site";

/** Kinds in words, as a list: "fonts, images, audio and video" (media's two words are two items). */
const kindsInWords = (kinds: readonly EgressKind[]): string => {
  const words = kinds.flatMap((kind) =>
    kind === "media" ? ["audio", "video"] : [KIND_WORDS[kind]],
  );
  return words.length === 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
};

/** The sources content may load `kind` from, as the manual names them: origins, any https site. */
const sourcesFor = (config: PortholeConfig, kind: EgressKind): string[] => [
  ...(anyHttps(config, kind) ? [ANY_HTTPS_SITE] : []),
  ...egressOrigins(config, kind),
];

/** What content may load, in prose, from the same origins the CSP lists. */
function network(config: PortholeConfig): string {
  const kinds: EgressKind[] = ["script", "style", "font", "img", "media", "connect"];
  const open = kinds
    .map((kind) => [kind, sourcesFor(config, kind)] as const)
    .filter(([, origins]) => origins.length > 0);
  if (open.length === 0) {
    return "Network: none. Nothing loads from outside (no scripts, styles, fonts, images or data from any server) and any fetch fails, so write everything inline: SVG and CSS draw charts well.";
  }
  // Origins that serve the same kinds go together: "scripts, styles and data from a, b; fonts from c".
  const byOrigin = new Map<string, EgressKind[]>();
  for (const [kind, origins] of open) {
    for (const origin of origins) {
      byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), kind]);
    }
  }
  // Any https site last, the widest: "…; fonts, images, audio and video from any https site" (P059).
  const anywhere = byOrigin.get(ANY_HTTPS_SITE);
  byOrigin.delete(ANY_HTTPS_SITE);
  const groups = new Map<string, string[]>();
  for (const [origin, each] of byOrigin) {
    const key = kindsInWords(each);
    groups.set(key, [...(groups.get(key) ?? []), origin]);
  }
  const parts = [
    ...[...groups].map(([words, origins]) => `${words} from ${origins.join(", ")}`),
    ...(anywhere === undefined ? [] : [`${kindsInWords(anywhere)} from ${ANY_HTTPS_SITE}`]),
  ];
  return `Network: only ${parts.join("; ")}. Anything else fails.`;
}

/** Whether a whole document takes the theme only when it declares support (ThemeConfig.documents). */
const optsIn = (config: PortholeConfig): boolean =>
  config.mode === "artifact" && (config.theme.documents ?? "declared") === "declared";

const loadsScripts = (config: PortholeConfig): boolean =>
  egressOrigins(config, "script").length > 0;

function widget(c: Context): string {
  const { config, noun } = c;
  const { layout, limits } = config;
  const title = noun === "page" ? "Pages" : noun === "view" ? "Views" : "Widgets";
  const tool = config.guide.toolName === undefined ? "" : ` (${config.guide.toolName})`;
  const what =
    config.mode === "artifact"
      ? "What you pass: a whole HTML document (<!doctype html>, <head>, <body>). It is written into its frame once all of it has arrived, then its scripts run in order."
      : config.mode === "mcp-app"
        ? "What you pass: an MCP Apps view, a whole HTML document that talks to its host through the official App SDK (@modelcontextprotocol/ext-apps) or the protocol's own messages."
        : "What you pass: SVG that starts with <svg, or an HTML fragment: no <!doctype>, <html>, <head> or <body>. Order it styles, then markup, then scripts: people see the styled markup as you write it, and scripts run once all of it is written, in order, each external one loaded before the next runs.";
  const stated = manualLimits(config, network(config));
  const said = (id: string) => stated.find((limit) => limit.id === id)?.text ?? "";
  const fills = layout.kind === "fill";
  const themeless = config.theme.documents === "never";
  const viewBox = layout.narrowWidthPx + 20;
  const smallest = Math.round(((13 * layout.minWidthPx) / viewBox) * 10) / 10;
  const largest = Math.round(((13 * 400) / viewBox) * 10) / 10;
  const textSize = themeDefault(
    config.theme.variables["--font-text-md-size"] ?? "14px",
    "light",
  ).replace(/^(\d+(?:\.\d+)?)px$/u, "$1 px");

  return lines(
    `# ${title}${tool}`,
    "",
    what,
    "",
    `Where it runs: ${fills ? `in a sandboxed frame that fills the app's viewer (often smaller than the window: toolbars and side panels take room), about ${layout.narrowWidthPx} px wide on a phone (${layout.minWidthPx} on a small one) and wider on a desktop` : `in a sandboxed frame as wide as the column it sits in, about ${layout.narrowWidthPx} px on a phone (${layout.minWidthPx} on a small one) and ${layout.wideWidthPx} on a desktop`}; the same ${noun} is read on both, so never write for one of them. Design for ${layout.narrowWidthPx} first; where the layout depends on the width, read it as it runs (the ${fills ? "frame's own innerWidth, again on resize" : "box's clientWidth, again from a ResizeObserver"}). ${said("layout")} ${said("theme")} It runs again each time it is shown${loadsScripts(config) ? ": pin library versions" : ""}.`,
    "",
    "Sizes that read on a phone:",
    c.when(
      `- Words go in HTML (titles, notes, legends, readouts): it keeps its size and wraps. The frame's text is already ${textSize} --font-sans in --color-text-primary; notes --font-text-sm-size, never under 12 px.`,
    ),
    `- An SVG scales with the frame: its text shows at font-size × frame width ÷ viewBox width, so a 680-wide viewBox turns 12 into 5 px on a phone. Draw it for the phone: viewBox="0 0 ${viewBox} H", no text under 13, width="100%" style="max-width: 400px"; its text then shows at ${smallest} to ${largest} px on every screen. Or draw it 1 unit = 1 px with a script (topic chart).`,
    `- The frame never scrolls sideways: nothing fixed wider than ${layout.minWidthPx} px; images max-width: 100%; a grid or flex child with long text min-width: 0; a wide table or code block in its own box with overflow-x: auto.`,
    "- Cards in a row wrap (flex-wrap: wrap; flex: 1 1 100px), or a grid of repeat(auto-fit, minmax(160px, 1fr)): at most 2 columns under 500 px, never a fixed repeat(3, …).",
    "- Touch: anything clickable is at least 44 px tall. Phones don't hover: what a hover shows, a tap (click) shows too.",
    fills
      ? null
      : "- No position: fixed: the frame grows with its content, so a fixed element covers it.",
    "",
    "The sandbox:",
    ...stated.filter((limit) => limit.topic === "sandbox").map((limit) => `- ${limit.text}`),
    `Keep it under ${sizeWords(limits.maxBytes)}.`,
    loadsScripts(config)
      ? "\nLibraries: pin an exact version at least two weeks old (chart.js@4.4.1 in its URL), never @latest or a range, so the code can't be swapped under you and draws the same every time."
      : null,
    "",
    themeless
      ? `Colors: these variables hold the app's palette; use them, or colors of your own. Give the ${noun} its own background.`
      : optsIn(config)
        ? `Colors, for a ${noun} that declares light and dark: every color from these variables, never hard-coded, so both work; its own background then stays transparent (it sits on the app's surface).`
        : `Colors: every color from these variables, never hard-coded, so light and dark both work. The ${noun}'s own background is transparent (it sits on the app's surface).`,
    c.names("--color-background-") === "" ? null : `- Surfaces: ${c.names("--color-background-")}`,
    c.names("--color-text-") === "" ? null : `- Text: ${c.names("--color-text-")}`,
    c.names("--color-border-") === ""
      ? null
      : `- Borders: ${c.names("--color-border-")}${c.names("--color-ring-") === "" ? "" : `; focus rings: ${c.names("--color-ring-")}`}`,
    c.names("--color-accent") === ""
      ? null
      : `- Accent: ${[
          c.when("--color-accent (a button)"),
          c.when("--color-accent-soft (a selected item's fill)"),
          c.when("in a figure, --color-chart-1 (topic chart)"),
        ]
          .filter((part) => part !== null)
          .join("; ")}`,
    c.names("--font-") === "" ? null : `- Type: ${c.names("--font-")}`,
    c.names("--border-") === "" && c.names("--shadow-") === ""
      ? null
      : `- Shape: ${[c.names("--border-"), c.names("--shadow-")].filter((each) => each !== "").join(", ")}`,
    otherVariables(c) === "" ? null : `- Also: ${otherVariables(c)}`,
    "",
    exampleFits(c, GUIDE_EXAMPLES.stats)
      ? `Cards that ${themeless ? "" : "read in both themes, and "}wrap on a phone:\n${GUIDE_EXAMPLES.stats}\n`
      : null,
    c.when(
      `Don't use --color-background-primary as a card's fill: it is the app's own surface, so a card on it vanishes.`,
    ),
    themeless
      ? null
      : `A theme change updates the variables in place and fires window "${config.theme.event}": CSS that uses var(...) follows by itself; a canvas or a library you gave colors to must redraw.`,
    config.mode === "inline"
      ? "Buttons and inputs already match the app (its borders, radius, colors and focus ring, 44 px tall): use them as they are, or restyle them with your own CSS."
      : null,
    "",
    "Diagrams (boxes and arrows): show the mechanism asked about (what calls what, where data goes), only the parts the ask names; label each arrow with what moves.",
    `- Top to bottom, at most 2 boxes a row, in the phone viewBox; the title in HTML above. Too much for one glance on a phone: make two.`,
    "- SVG doesn't wrap: break lines yourself. A box is its longest line + 24 wide (13 px text takes about 7 units a character, a 14 px bold name 8.5: a 136-wide box holds 16); a name and a line, 52 tall; 16 between boxes.",
    c.when(
      "- Boxes fill none, stroke --color-border-secondary; at most one stands out: stroke --color-chart-1, 2 wide, fill --color-chart-1 at fill-opacity 0.12. Arrows --color-text-tertiary, in the gaps, never across a box, their labels beside them. Every <text> sets fill: names --color-text-primary, the rest --color-text-secondary.",
    ),
    exampleFits(c, GUIDE_EXAMPLES.diagram) ? `\n${GUIDE_EXAMPLES.diagram}` : null,
  );
}

/** Variables outside the groups the colors list names. */
function otherVariables(c: Context): string {
  const grouped = [
    "--color-background-",
    "--color-text-",
    "--color-border-",
    "--color-ring-",
    "--color-accent",
    "--color-chart-",
    "--font-",
    "--border-",
    "--shadow-",
  ];
  return Object.keys(c.config.theme.variables)
    .filter((name) => !grouped.some((prefix) => name.startsWith(prefix)))
    .join(", ");
}

/** Whether an example uses only declared variables and loads nothing. */
function exampleFits(c: Context, example: string): boolean {
  return c.has(...(example.match(VARIABLE) ?? [])) && !/https?:\/\//u.test(example);
}

function chart(c: Context): string {
  const { config } = c;
  const categorical = Object.keys(config.theme.variables).filter((name) =>
    /^--color-chart-\d+$/u.test(name),
  );
  const sequential = Object.keys(config.theme.variables).filter((name) =>
    /^--color-chart-seq-\d+$/u.test(name),
  );
  const libraries = loadsScripts(config)
    ? `Libraries (Chart.js, ECharts, d3) draw in px too, in a box with a set height (Chart.js responsive: true, maintainAspectRatio: false). They don't read CSS variables: pass in getComputedStyle(document.documentElement).getPropertyValue("${categorical[0] ?? "--color-text-primary"}").trim()${config.theme.documents === "never" ? "" : `, redraw on window "${config.theme.event}"`}, and override their palette and white background.`
    : "No chart library loads here: draw the SVG yourself, from a script, as below.";
  return lines(
    `# Charts (a chart is a ${c.noun})`,
    "",
    "Pick the form first: a trend over time → line; compare categories → horizontal bars; x against y → scatter; one number → a big number, not a chart; a few numbers → a table, not a chart.",
    "",
    "The look:",
    '- The title states the finding, with its number ("Failed builds fell from 9 to 2 a week"), not the topic; a line under it says what is measured, in what unit.',
    c.when(
      "- Grey first: the data in a quiet grey (--color-text-disabled), one accent (--color-chart-1) on what the title is about. More hues only for series that differ in kind and must each be found.",
    ),
    "- Values on the marks or a light axis, not both; label only the points the finding rests on. Bars start at zero.",
    "- Write the numbers once, as rows, and draw marks, labels and readout from them.",
    "",
    "Size: draw it at the frame's width, 1 unit = 1 px: read the box's clientWidth, draw an <svg> that wide with 12 px text, and again from a ResizeObserver. Its text stays 12 px on every screen; keep x labels 44 px apart. No script: the phone viewBox (topic widget). Bars need no SVG: an HTML grid row per category.",
    "",
    libraries,
    "",
    categorical.length === 0 ? null : "Colors:",
    categorical.length === 0
      ? null
      : `- Series of different kinds: ${categorical[0]} … ${categorical.at(-1)}, in this order, never cycled, at most ${categorical.length} (fold the rest into "Other"); a series keeps its color when a filter hides others.`,
    sequential.length === 0
      ? null
      : `- Magnitude (a heatmap): ${sequential[0]} … ${sequential.at(-1)}, 1 nearest zero.${c.has("--color-chart-neg", "--color-chart-mid", "--color-chart-pos") ? " Above or below a midpoint: --color-chart-neg, --color-chart-mid, --color-chart-pos." : ""}`,
    c.when(
      "- Never a rainbow. Status (good, bad) uses --color-text-success, --color-text-warning, --color-text-danger with a word, never as a series color.",
    ),
    c.when(
      "- Text is never in a series color: --color-text-primary or --color-text-secondary; the mark beside it carries identity.",
    ),
    "",
    c.when(
      "Marks: 2 px lines, bars with a 2 px gap; grid lines --color-border-tertiary, 1 px; one y axis (two scales: two charts); the legend in HTML.",
    ),
    "",
    'Reading values: a readout line in HTML that a tap on a column fills (each column a hit area the plot\'s height), the latest values shown before any tap; a "Table" toggle for the numbers.',
    exampleFits(c, GUIDE_EXAMPLES.line)
      ? `\nA line chart drawn at the frame's width, its numbers on a tap:\n${GUIDE_EXAMPLES.line}`
      : null,
    exampleFits(c, GUIDE_EXAMPLES.bars)
      ? `\nBars in HTML, under a title like the line chart's:\n${GUIDE_EXAMPLES.bars}`
      : null,
  );
}

/** How a capability's gates read to the author: one sentence each. */
function gateWords(gates: readonly Gate[], effect: string): string {
  const sentences: string[] = [];
  if (gates.includes("confirm")) {
    sentences.push(
      `The app shows the person ${effect} first, and nothing happens unless they confirm.`,
    );
  }
  if (gates.includes("user-activation")) {
    sentences.push("Call it from a click (it needs one).");
  }
  for (const gate of gates) {
    if (typeof gate === "object") {
      sentences.push(`At most ${gate.rateLimit.perMinute} a minute.`);
    }
  }
  return sentences.join(" ");
}

const ENTRIES: { readonly [N in CapabilityName]: (c: Context, gates: readonly Gate[]) => string } =
  {
    sendPrompt: (c, gates) =>
      c.global("sendPrompt")
        ? `- sendPrompt(text): asks to send text to you as the person's message (at most ${c.config.limits.maxPromptChars.toLocaleString("en-US")} characters). Use it for "explain this point", "try these settings". ${gateWords(gates, "the whole text")} It returns a promise: true if it was sent.`
        : `- Messages: the MCP Apps request ui/message (with the App SDK, app.sendMessage) asks to send text to you as the person's message. ${gateWords(gates, "the whole text")}`,
    openLink: (c, gates) =>
      c.global("openLink")
        ? `- openLink(url): asks to open an http(s) link in a new tab; a click on an <a href> does the same for you. ${gateWords(gates, "the link")} It returns a promise: true if it opened.`
        : `- Links: the MCP Apps request ui/open-link (with the App SDK, app.openLink) asks to open an http(s) link in a new tab. ${gateWords(gates, "the link")}`,
    downloadFile: (_c, gates) =>
      `- Downloads: the MCP Apps request ui/download-file (with the App SDK, app.downloadFile). ${gateWords(gates, "the file")}`,
    callTool: (_c, gates) =>
      `- Tools: the MCP Apps request tools/call (with the App SDK, app.callServerTool). ${gateWords(gates, "the call")}`,
    readData: (_c, gates) =>
      `- Data: the MCP Apps request resources/read (with the App SDK, app.readServerResource). ${gateWords(gates, "the request")}`,
    setModelContext: (_c, gates) =>
      `- Context for the agent: the MCP Apps request ui/update-model-context (with the App SDK, app.updateModelContext). ${gateWords(gates, "it")}`,
    copyText: (c, gates) =>
      c.global("copyText")
        ? `- copyText(text): copies text to the person's clipboard (at most ${MAX_COPY_CHARS.toLocaleString("en-US")} characters), and the app shows them what was copied. Use it for every copy button: nothing else in the ${c.noun} can write the clipboard. ${gateWords(gates, "the text")} It returns a promise: true if it was copied.`
        : `- Copying: the request porthole/copy-text with { text } (at most ${MAX_COPY_CHARS.toLocaleString("en-US")} characters) copies text to the person's clipboard, and the app shows them what was copied; nothing else in the ${c.noun} can write the clipboard. ${gateWords(gates, "the text")}`,
    annotate: (c) =>
      `- Comments: the person may point at parts of the ${c.noun} to comment on them. Give headings and the parts that matter stable ids (id="revenue"), so comments stay on them when the ${c.noun} is written again.`,
    reportError: (c) =>
      `- ${manualLimits(c.config, "").find((limit) => limit.id === "errors")?.text ?? ""}`,
    resize: () => "",
  };

function interactive(c: Context): string {
  const { config, noun } = c;
  const entries = declaredCapabilities(config)
    .map((name) => {
      const own = config.capabilities[name]?.guide;
      return own === undefined ? ENTRIES[name](c, effectiveGates(config, name)) : `- ${own}`;
    })
    .filter((entry) => entry !== "");
  const stated = manualLimits(config, "");
  const stored = stated.find((limit) => limit.id === "storage");
  const state = stored === undefined ? null : `- ${stored.text}`;
  // Without reportError the capability list has no errors entry: say that nothing reports them.
  const errors = c.declared("reportError")
    ? null
    : `- ${stated.find((limit) => limit.id === "errors")?.text ?? ""}`;
  const none =
    entries.length === 0
      ? `- It can only draw: it has no way to send anything to you or the app.`
      : null;
  return lines(`# Interactive ${noun}s`, "", ...entries, errors, none, state);
}

const TOPICS: Readonly<Record<BuiltInTopic, (c: Context) => string>> = {
  widget,
  chart,
  interactive,
};

/** The manual for `topics`, in the order asked (all built-in topics by default). */
export function generateGuide(config: PortholeConfig, topics?: readonly GuideTopic[]): string {
  const c = context(config);
  const own = config.guide.topics ?? {};
  return (topics ?? BUILT_IN_TOPICS)
    .map((topic) => {
      if (Object.hasOwn(TOPICS, topic)) {
        return TOPICS[topic as BuiltInTopic](c);
      }
      const text = own[topic];
      if (text === undefined) {
        throw new RangeError(`No guide topic ${JSON.stringify(topic)}`);
      }
      return text;
    })
    .join("\n\n");
}

/** The description of the host's show tool, for the agent's tool list. */
export function generateToolDescription(config: PortholeConfig): string {
  const c = context(config);
  const { layout } = config;
  const what =
    config.mode === "artifact"
      ? "Show a whole HTML page you write: a report, a document, a small app."
      : config.mode === "mcp-app"
        ? "Show an MCP Apps view."
        : "Render an SVG or an HTML fragment you write, shown inline: charts, diagrams, explainers, small interactive tools.";
  const origins = [
    ...new Set(
      (["script", "style", "font", "img", "media", "connect"] as const).flatMap((kind) =>
        egressOrigins(config, kind),
      ),
    ),
  ];
  // The same words, in the same order, as the manual's Network line.
  const passive = (["font", "img", "media"] as const).filter((kind) => anyHttps(config, kind));
  const fromAnywhere =
    passive.length === 0 ? "" : `${kindsInWords(passive)} from ${ANY_HTTPS_SITE}`;
  const net =
    origins.length === 0 && fromAnywhere === ""
      ? "with no network (nothing loads from outside)"
      : origins.length === 0
        ? `loading only ${fromAnywhere}`
        : `loading only from ${origins.join(", ")}${fromAnywhere === "" ? "" : `, and ${fromAnywhere}`}`;
  const globals = declaredCapabilities(config).flatMap((name) => {
    const spec = capabilitySpec(name);
    if (spec.global === undefined || !c.global(spec.global)) {
      return [];
    }
    if (spec.global === "sendPrompt") {
      return ["sendPrompt(text) asks the person to send text to you as their message."];
    }
    if (spec.global === "openLink") {
      return ["openLink(url) asks the person to open a link."];
    }
    return [];
  });
  const read =
    config.guide.guideToolName === undefined
      ? ""
      : ` Call ${config.guide.guideToolName} once before your first ${c.noun}${config.mode === "inline" ? " (topic chart before your first chart)" : ""}.`;
  const where =
    layout.kind === "fill"
      ? `It fills the viewer in a sandbox about ${layout.narrowWidthPx} px wide on a phone, from the same code on every screen`
      : `It runs in a sandbox about ${layout.narrowWidthPx} px wide on a phone and ${layout.wideWidthPx} on a desktop, from the same code${c.declared("resize") ? " (its height follows the content)" : ""}`;
  const theme =
    config.theme.documents === "never"
      ? "always in light (the app doesn't theme it)"
      : "in the person's light or dark theme through CSS variables";
  return `${what} ${where}, ${theme}, ${net}. ${globals.join(" ")}${read} Each time it is shown it runs again from this code.`.replace(
    / {2,}/gu,
    " ",
  );
}
