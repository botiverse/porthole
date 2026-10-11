import type { ColorScheme, ThemeConfig, ThemeValue } from "../config/schema.ts";

/**
 * The default theme vocabulary: the MCP Apps style variable names (`styles.variables`,
 * 2026-01-26), so content written for any MCP Apps host reads here too, plus Porthole's own accent
 * and chart colors. Each has a neutral default per scheme; a host supplies its live values for the
 * same names (`HostOptions.theme`). The shell injects exactly the config's names and the manual
 * teaches exactly them (PRINCIPLE 3).
 */

const both = (value: string): ThemeValue => value;
const pair = (light: string, dark: string): ThemeValue => ({ light, dark });

/**
 * A data palette for charts: eight categorical slots in a fixed order (it keeps adjacent series
 * apart for color-blind readers), a sequential blue ramp (1 is the step nearest zero, nearest the
 * surface in each scheme), and a diverging pair around a gray midpoint. Each scheme's values are
 * chosen for its own surface, not flipped.
 */
export const CHART_PALETTE = {
  categorical: [
    { hue: "blue", light: "#2a78d6", dark: "#3987e5" },
    { hue: "orange", light: "#eb6834", dark: "#d95926" },
    { hue: "aqua", light: "#1baf7a", dark: "#199e70" },
    { hue: "yellow", light: "#eda100", dark: "#c98500" },
    { hue: "magenta", light: "#e87ba4", dark: "#d55181" },
    { hue: "green", light: "#008300", dark: "#008300" },
    { hue: "violet", light: "#4a3aa7", dark: "#9085e9" },
    { hue: "red", light: "#e34948", dark: "#e66767" },
  ],
  sequential: {
    light: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
    dark: ["#0d366b", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"],
  },
  diverging: {
    neg: { light: "#e34948", dark: "#e66767" },
    mid: { light: "#f0efec", dark: "#383835" },
    pos: { light: "#2a78d6", dark: "#3987e5" },
  },
} as const;

const families = (
  kind: string,
  values: Record<"info" | "success" | "warning" | "danger", ThemeValue>,
): [string, ThemeValue][] =>
  Object.entries(values).map(([family, value]) => [`--color-${kind}-${family}`, value]);

const heading = (size: string, px: number, line: number): [string, ThemeValue][] => [
  [`--font-heading-${size}-size`, both(`${px}px`)],
  [`--font-heading-${size}-line-height`, both(`${line}px`)],
];

/** Every default variable, in the order the manual lists them. */
export const DEFAULT_THEME_VARIABLES: Readonly<Record<string, ThemeValue>> = Object.fromEntries([
  // Surfaces. The content's own background stays transparent: it sits on the host's surface,
  // which is --color-background-primary.
  ["--color-background-primary", pair("#f9f9f7", "#191918")],
  ["--color-background-secondary", pair("#ffffff", "#232321")],
  ["--color-background-tertiary", pair("#f3f3f1", "#2b2b29")],
  ["--color-background-inverse", pair("#1a1a19", "#f4f4f2")],
  ["--color-background-ghost", pair("rgba(11, 11, 11, 0.04)", "rgba(255, 255, 255, 0.05)")],
  ["--color-background-disabled", pair("#efefec", "#2e2e2c")],
  ...families("background", {
    info: pair("#e8f1fc", "#16283d"),
    success: pair("#e7f5ec", "#15301f"),
    warning: pair("#fdf3e1", "#3a2a10"),
    danger: pair("#fdecec", "#3a1a18"),
  }),
  // Text.
  ["--color-text-primary", pair("#0b0b0b", "#f4f4f2")],
  ["--color-text-secondary", pair("#52514e", "#b5b4ae")],
  ["--color-text-tertiary", pair("#898781", "#8f8e88")],
  ["--color-text-inverse", pair("#ffffff", "#0b0b0b")],
  ["--color-text-ghost", pair("#a3a29c", "#6e6d68")],
  ["--color-text-disabled", pair("#b5b4ae", "#5c5b57")],
  ...families("text", {
    info: pair("#1f5fae", "#8cbcf5"),
    success: pair("#1d7a3e", "#86d3a2"),
    warning: pair("#8a5a00", "#e8b85c"),
    danger: pair("#b42318", "#f19a92"),
  }),
  // Borders and focus rings.
  ["--color-border-primary", pair("#c3c2b7", "#4a4a46")],
  ["--color-border-secondary", pair("#e1e0d9", "#393936")],
  ["--color-border-tertiary", pair("#ebeae5", "#2f2f2d")],
  ["--color-border-inverse", pair("#3a3a37", "#d6d5cf")],
  ["--color-border-ghost", pair("rgba(11, 11, 11, 0.06)", "rgba(255, 255, 255, 0.08)")],
  ["--color-border-disabled", pair("#e6e5e0", "#333331")],
  ...families("border", {
    info: pair("#a9c8f0", "#2e5584"),
    success: pair("#a6d9b8", "#2c6141"),
    warning: pair("#f0cf8c", "#6e5221"),
    danger: pair("#f1b0ab", "#7a2f29"),
  }),
  ["--color-ring-primary", pair("#2a78d6", "#3987e5")],
  ["--color-ring-secondary", pair("#898781", "#8f8e88")],
  ["--color-ring-inverse", pair("#ffffff", "#0b0b0b")],
  ...families("ring", {
    info: pair("#2a78d6", "#3987e5"),
    success: pair("#1d7a3e", "#86d3a2"),
    warning: pair("#b07400", "#e8b85c"),
    danger: pair("#d92d20", "#f19a92"),
  }),
  // Porthole's own: the accent (a button), and the chart colors.
  ["--color-accent", pair("#2a78d6", "#3987e5")],
  ["--color-accent-soft", pair("#e8f1fc", "#16283d")],
  ...CHART_PALETTE.categorical.map((slot, index): [string, ThemeValue] => [
    `--color-chart-${index + 1}`,
    pair(slot.light, slot.dark),
  ]),
  ...CHART_PALETTE.sequential.light.map((light, index): [string, ThemeValue] => [
    `--color-chart-seq-${index + 1}`,
    pair(light, CHART_PALETTE.sequential.dark[index] ?? light),
  ]),
  ...(["neg", "mid", "pos"] as const).map((pole): [string, ThemeValue] => [
    `--color-chart-${pole}`,
    CHART_PALETTE.diverging[pole],
  ]),
  // Type.
  ["--font-sans", both('system-ui, -apple-system, "Segoe UI", Roboto, sans-serif')],
  ["--font-mono", both('ui-monospace, "SF Mono", Menlo, Consolas, monospace')],
  ["--font-weight-normal", both("400")],
  ["--font-weight-medium", both("500")],
  ["--font-weight-semibold", both("600")],
  ["--font-weight-bold", both("700")],
  ["--font-text-xs-size", both("12px")],
  ["--font-text-xs-line-height", both("16px")],
  ["--font-text-sm-size", both("13px")],
  ["--font-text-sm-line-height", both("18px")],
  ["--font-text-md-size", both("14px")],
  ["--font-text-md-line-height", both("20px")],
  ["--font-text-lg-size", both("16px")],
  ["--font-text-lg-line-height", both("24px")],
  ...heading("xs", 14, 20),
  ...heading("sm", 16, 24),
  ...heading("md", 20, 28),
  ...heading("lg", 24, 32),
  ...heading("xl", 28, 36),
  ...heading("2xl", 32, 40),
  ...heading("3xl", 40, 48),
  // Shape.
  ["--border-radius-xs", both("4px")],
  ["--border-radius-sm", both("6px")],
  ["--border-radius-md", both("8px")],
  ["--border-radius-lg", both("12px")],
  ["--border-radius-xl", both("16px")],
  ["--border-radius-full", both("9999px")],
  ["--border-width-regular", both("1px")],
  [
    "--shadow-hairline",
    pair("0 0 0 1px rgba(11, 11, 11, 0.06)", "0 0 0 1px rgba(255, 255, 255, 0.08)"),
  ],
  ["--shadow-sm", pair("0 1px 2px rgba(11, 11, 11, 0.06)", "0 1px 2px rgba(0, 0, 0, 0.4)")],
  ["--shadow-md", pair("0 2px 8px rgba(11, 11, 11, 0.08)", "0 2px 8px rgba(0, 0, 0, 0.45)")],
  ["--shadow-lg", pair("0 8px 24px rgba(11, 11, 11, 0.12)", "0 8px 24px rgba(0, 0, 0, 0.5)")],
]);

/** The window event the shell fires after a theme change, by default. */
export const DEFAULT_THEME_EVENT = "porthole:theme";

export const DEFAULT_THEME: ThemeConfig = {
  variables: DEFAULT_THEME_VARIABLES,
  event: DEFAULT_THEME_EVENT,
};

/** A variable's default for `scheme`. */
export function themeDefault(value: ThemeValue, scheme: ColorScheme): string {
  return typeof value === "string" ? value : value[scheme];
}

/**
 * The values the frame gets for `scheme`: for each of the config's variables, the host's live
 * value when it has one (a non-empty string), else the variable's default. Names the config
 * doesn't declare are dropped, so the frame only ever holds what the manual teaches.
 */
export function resolveTheme(
  theme: ThemeConfig,
  scheme: ColorScheme,
  live?: Readonly<Record<string, string | null | undefined>>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(theme.variables)) {
    const given = live?.[name]?.trim();
    values[name] =
      given === undefined || given === "" || /[;{}<>]/u.test(given)
        ? themeDefault(value, scheme)
        : given;
  }
  return values;
}
