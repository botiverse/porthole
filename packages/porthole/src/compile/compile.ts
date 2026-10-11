import type { PortholeConfig } from "../config/schema.ts";
import { validateConfig } from "../config/validate.ts";
import { generateGuide, generateToolDescription, type GuideTopic } from "../guide/guide.ts";
import { shellDocument, type ShellDocumentOptions } from "../shell/document.ts";
import { shellPlan, type ShellPlan } from "../shell/plan.ts";
import {
  allowAttribute,
  embedderFrameSources,
  frameCspDirectives,
  sandboxTokens,
  serializeCsp,
  type CspDirective,
} from "./policy.ts";

/**
 * Everything derived from one config (PRINCIPLE 3): the frame's policies, the shell's wiring and
 * document, and the agent manual and tool description. Compiled together from a validated config,
 * so they cannot disagree; the agreement test checks that they don't.
 */
export interface CompiledConfig {
  readonly config: PortholeConfig;
  /** The frame's CSP, directive by directive; empty in url mode (the app sends its own). */
  readonly cspDirectives: readonly CspDirective[];
  /** The frame's CSP: in the shell's `<meta>`, or a served document's header. */
  readonly csp: string;
  /** The frame's `sandbox` attribute. */
  readonly sandbox: string;
  /** The frame's `allow` attribute (Permissions Policy). */
  readonly allow: string;
  /** The frame's `referrerpolicy` attribute. */
  readonly referrerPolicy: "no-referrer";
  /** The `frame-src` sources the embedding page must allow (see `embedderCsp`). */
  readonly embedderFrameSources: readonly string[];
  /** What the shell wires; null in url mode, which has no shell. */
  readonly shell: ShellPlan | null;
  /** The frame's document: the policy, the base styles and the shell's runtime. */
  shellDocument(options: ShellDocumentOptions): string;
  /** The agent manual for `topics` (every built-in topic by default). */
  guide(topics?: readonly GuideTopic[]): string;
  /** The description of the host's show tool. */
  toolDescription(): string;
}

/** Validates `config` and derives everything from it. Throws a `ConfigError` on a bad config. */
export function compile(config: PortholeConfig): CompiledConfig {
  validateConfig(config);
  const cspDirectives = frameCspDirectives(config);
  const csp = serializeCsp(cspDirectives);
  const shell = shellPlan(config);
  return {
    config,
    cspDirectives,
    csp,
    sandbox: sandboxTokens(config).join(" "),
    allow: allowAttribute(config),
    referrerPolicy: "no-referrer",
    embedderFrameSources: embedderFrameSources(config),
    shell,
    shellDocument: (options) => {
      if (shell === null) {
        throw new TypeError("url mode has no shell: the frame loads the app's own document");
      }
      return shellDocument(shell, csp, options);
    },
    guide: (topics) => generateGuide(config, topics),
    toolDescription: () => generateToolDescription(config),
  };
}
