import type { EgressConfig } from "../config/schema.ts";
import { isOriginSource } from "../config/validate.ts";

/**
 * What a host reads from an MCP Apps view's resource before showing it: the HTML, and the egress
 * the view declares, in Porthole's vocabulary so it goes into a config (P003).
 */

/**
 * The style variables MCP Apps standardizes (spec § Theming). The official App SDK refuses a
 * host context naming any other (measured: zod's record of these keys rejects an unknown one), so
 * a view is sent these and only these; Porthole's own names (`--color-accent`, the chart palette)
 * stay with its shell.
 */
export const MCP_APPS_STYLE_VARIABLES: readonly string[] = [
  ...[
    "primary",
    "secondary",
    "tertiary",
    "inverse",
    "ghost",
    "info",
    "danger",
    "success",
    "warning",
    "disabled",
  ].map((name) => `--color-background-${name}`),
  ...[
    "primary",
    "secondary",
    "tertiary",
    "inverse",
    "info",
    "danger",
    "success",
    "warning",
    "disabled",
    "ghost",
  ].map((name) => `--color-text-${name}`),
  ...[
    "primary",
    "secondary",
    "tertiary",
    "inverse",
    "ghost",
    "info",
    "danger",
    "success",
    "warning",
    "disabled",
  ].map((name) => `--color-border-${name}`),
  ...["primary", "secondary", "inverse", "info", "danger", "success", "warning"].map(
    (name) => `--color-ring-${name}`,
  ),
  "--font-sans",
  "--font-mono",
  ...["normal", "medium", "semibold", "bold"].map((name) => `--font-weight-${name}`),
  ...["xs", "sm", "md", "lg"].map((size) => `--font-text-${size}-size`),
  ...["xs", "sm", "md", "lg", "xl", "2xl", "3xl"].map((size) => `--font-heading-${size}-size`),
  ...["xs", "sm", "md", "lg"].map((size) => `--font-text-${size}-line-height`),
  ...["xs", "sm", "md", "lg", "xl", "2xl", "3xl"].map(
    (size) => `--font-heading-${size}-line-height`,
  ),
  ...["xs", "sm", "md", "lg", "xl", "full"].map((size) => `--border-radius-${size}`),
  "--border-width-regular",
  ...["hairline", "sm", "md", "lg"].map((size) => `--shadow-${size}`),
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A declared domain as a CSP source Porthole accepts, or null (`'self'`, `*`, paths, quotes). */
function originOf(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const source = value.trim().toLowerCase().replace(/\/$/u, "");
  return isOriginSource(source) ? source : null;
}

const origins = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.map(originOf).filter((each): each is string => each !== null))]
    : [];

/**
 * A view's `_meta.ui.csp` as egress: `connectDomains` to connect, `resourceDomains` to scripts,
 * styles, images, fonts and media. What isn't an exact origin (or `https://*.` one) is dropped,
 * never widened. `frameDomains` and `baseUriDomains` open nothing: the shell removes nested frames
 * (P006) and `base-uri` stays `'none'`, so a view that needs either runs without it.
 */
export function viewEgress(csp: unknown): EgressConfig {
  if (!isRecord(csp)) {
    return {};
  }
  const connect = origins(csp.connectDomains);
  const resource = origins(csp.resourceDomains);
  return {
    ...(connect.length > 0 ? { connect } : {}),
    ...(resource.length > 0
      ? { script: resource, style: resource, img: resource, font: resource, media: resource }
      : {}),
  };
}

/** A view, as `resources/read` gives it. */
export interface ViewResource {
  readonly uri: string;
  /** The view's whole document. */
  readonly html: string;
  /** What the view declares it reaches (its `_meta.ui.csp`), as egress. */
  readonly egress: EgressConfig;
  /** Whether the view asks the host for a border and background (`_meta.ui.prefersBorder`). */
  readonly prefersBorder?: boolean;
}

/** The MIME type of an MCP Apps view. */
export const VIEW_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * The view in a `resources/read` result: its first content of the MCP Apps MIME type, as text or
 * base64. Null when there is none.
 */
export function readViewResource(result: unknown): ViewResource | null {
  const contents = isRecord(result) && Array.isArray(result.contents) ? result.contents : [];
  for (const content of contents) {
    if (!isRecord(content) || typeof content.mimeType !== "string") {
      continue;
    }
    if (content.mimeType.replace(/\s/gu, "").toLowerCase() !== VIEW_MIME_TYPE) {
      continue;
    }
    const html =
      typeof content.text === "string"
        ? content.text
        : typeof content.blob === "string"
          ? new TextDecoder().decode(
              Uint8Array.from(atob(content.blob), (char) => char.charCodeAt(0)),
            )
          : null;
    if (html === null) {
      continue;
    }
    const meta = content["_meta"];
    const ui = isRecord(meta) && isRecord(meta.ui) ? meta.ui : {};
    return {
      uri: typeof content.uri === "string" ? content.uri : "",
      html,
      egress: viewEgress(ui.csp),
      ...(typeof ui.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {}),
    };
  }
  return null;
}
