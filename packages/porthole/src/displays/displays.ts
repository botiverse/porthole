import { embedderFrameSourcesOf } from "../compile/policy.ts";
import type { PortholeConfig } from "../config/schema.ts";
import { ConfigError } from "../config/validate.ts";
import type { InstanceRef } from "../isolation/types.ts";
import { presets, type PresetOptions, type UrlPresetOptions } from "../presets/presets.ts";

/**
 * Every kind of display an app shows, in one registry (P072): the server serves under it, the
 * page frames under it, its CSP and the agent's manual come from it, and the conformance runner
 * checks it. One place for a kind's options, where apps kept four copies that drifted.
 *
 *   const displays = defineDisplays({
 *     widget: { preset: "inlineWidget", options: { capabilities: { sendPrompt: {} } } },
 *     page: { preset: "artifact", options: { layout: { kind: "fill" } } },
 *     preview: { preset: "url" },                      // url mode: served only
 *   });
 *
 * A kind's name is the preset name its documents carry (`ServedDocument`'s `preset`): an
 * artifact names `artifact` unless it says otherwise, so a stored-pages app calls its kind
 * `artifact`, or puts `preset: "page"` in its instances.
 */

export type DisplayKind =
  | {
      readonly preset: "inlineWidget" | "artifact" | "mcpApp";
      readonly options?: PresetOptions;
      /** Options added when served on content origins (domain isolation): storage, egress. */
      readonly served?: Omit<PresetOptions, "isolation" | "contentOrigins">;
    }
  | {
      /** A running app by URL: served only. */
      readonly preset: "url";
      readonly options?: Omit<UrlPresetOptions, "contentOrigins">;
    };

/** A content source for a manual written before any content origin exists. */
const GUIDE_SOURCE = "https://*.porthole-content.invalid";

export interface Displays<N extends string = string> {
  readonly kinds: readonly N[];
  /** The kind's config in an opaque frame (no content origins). Url kinds have none: throws. */
  opaque(kind: N): PortholeConfig;
  /**
   * Every kind's config served from `contentSource` (`https://*.example-usercontent.com`): made
   * once per source. Null, with `problem(source)` saying why, where a kind can't be served so.
   */
  served(contentSource: string): Readonly<Record<N, PortholeConfig>> | null;
  /** Why `served(contentSource)` is null, or null. */
  problem(contentSource: string): string | null;
  /** The config an instance shows under: its kind, served (a source) or opaque (null). */
  configFor(instance: InstanceRef, contentSource: string | null): PortholeConfig;
  /** The kind an instance's document names, or null. */
  kindOf(instance: InstanceRef): N | null;
  /**
   * The page's `frame-src`, without a ContentHost (a dev server, a desktop shell): every kind's
   * frames, served or opaque, and the authorize route's path when clean addresses frame.
   */
  frameSources(
    contentSource: string | null,
    options?: { readonly authorizeUrl?: string },
  ): readonly string[];
  /** The same, as a `frame-src` directive. */
  embedderCsp(contentSource: string | null, options?: { readonly authorizeUrl?: string }): string;
  /**
   * The kind's config for the agent's manual and tool description, served or opaque, without a
   * real content origin (the manual names none).
   */
  guideConfig(kind: N, mode: "served" | "opaque"): PortholeConfig;
}

export function defineDisplays<N extends string>(
  kinds: Readonly<Record<N, DisplayKind>>,
): Displays<N> {
  const names = Object.keys(kinds) as N[];
  if (names.length === 0) {
    throw new TypeError("defineDisplays needs at least one kind");
  }
  const kindOf = (name: N): DisplayKind => {
    const kind = kinds[name];
    if (kind === undefined) {
      throw new TypeError(`No display kind ${JSON.stringify(name)} (defineDisplays)`);
    }
    return kind;
  };
  const build = (name: N, source: string | null): PortholeConfig => {
    const kind = kindOf(name);
    if (kind.preset === "url") {
      if (source === null) {
        throw new TypeError(
          `The display kind ${JSON.stringify(name)} is a url-mode app: served only`,
        );
      }
      return presets.url({ ...kind.options, contentOrigins: [source] });
    }
    const options = kind.options ?? {};
    return presets[kind.preset](
      source === null
        ? options
        : { ...options, ...kind.served, isolation: "domain", contentOrigins: [source] },
    );
  };
  // Made once each: a page that asks every render gets the same objects.
  const opaque = new Map<N, PortholeConfig>();
  const served = new Map<string, Readonly<Record<N, PortholeConfig>> | string>();
  const servedOf = (source: string) => {
    let found = served.get(source);
    if (found === undefined) {
      try {
        found = Object.fromEntries(names.map((name) => [name, build(name, source)])) as Record<
          N,
          PortholeConfig
        >;
      } catch (error) {
        if (!(error instanceof ConfigError) && !(error instanceof TypeError)) {
          throw error;
        }
        found = error.message;
      }
      served.set(source, found);
    }
    return found;
  };
  const displays: Displays<N> = {
    kinds: names,
    opaque(name) {
      let found = opaque.get(name);
      if (found === undefined) {
        found = build(name, null);
        opaque.set(name, found);
      }
      return found;
    },
    served(source) {
      const found = servedOf(source);
      return typeof found === "string" ? null : found;
    },
    problem(source) {
      const found = servedOf(source);
      return typeof found === "string" ? found : null;
    },
    kindOf(instance) {
      const { document } = instance;
      const named =
        document.kind === "shell"
          ? document.preset
          : document.kind === "artifact"
            ? (document.preset ?? "artifact")
            : document.kind === "mcp-proxy"
              ? (document.preset ?? "mcpApp")
              : (names.find((name) => kinds[name]?.preset === "url") ?? null);
      return named !== null && names.includes(named as N) ? (named as N) : null;
    },
    configFor(instance, source) {
      const name = displays.kindOf(instance);
      if (name === null) {
        throw new TypeError(
          `No display kind for an instance of kind ${instance.document.kind} (defineDisplays: ${names.join(", ")})`,
        );
      }
      if (source === null) {
        return displays.opaque(name);
      }
      const all = displays.served(source);
      if (all === null) {
        throw new TypeError(displays.problem(source) ?? "Not servable");
      }
      return all[name];
    },
    frameSources(source, options = {}) {
      const configs =
        source === null
          ? names
              .filter((name) => kinds[name]?.preset !== "url")
              .map((name) => displays.opaque(name))
          : Object.values<PortholeConfig>(displays.served(source) ?? {});
      const authorize =
        options.authorizeUrl === undefined
          ? []
          : [`${new URL(options.authorizeUrl).origin}${new URL(options.authorizeUrl).pathname}`];
      return [...embedderFrameSourcesOf(configs), ...authorize];
    },
    embedderCsp(source, options = {}) {
      const sources = displays.frameSources(source, options);
      return `frame-src ${sources.length === 0 ? "'none'" : sources.join(" ")}`;
    },
    guideConfig(name, mode) {
      return mode === "opaque" ? displays.opaque(name) : build(name, GUIDE_SOURCE);
    },
  };
  return displays;
}
