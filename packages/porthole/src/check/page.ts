import type { CapabilityHandlers } from "../bridge/types.ts";
import {
  capabilitySpec,
  isCapabilityName,
  type HandledCapability,
} from "../config/capabilities.ts";
import { addressWithoutQuery } from "../bridge/navigation.ts";
import { createHost } from "../host/create-host.ts";
import type { PlatformHost } from "../platform/types.ts";
import { webPlatform } from "../platform/web.ts";
import type { DisplayHandle } from "../host/types.ts";
import type { FrameLocation } from "../isolation/types.ts";
import {
  contentLine,
  instrumented,
  type CheckCall,
  type CheckRunData,
  type CheckRunSpec,
} from "./instrument.ts";

export type { CheckCall, CheckRunData, CheckRunSpec } from "./instrument.ts";

/**
 * What a host that declines answers each host function with (P074): no prompt sent, no link
 * opened, nothing downloaded or copied; a tool call or a read refused.
 */
const DECLINED: { readonly [N in HandledCapability]: () => unknown } = {
  sendPrompt: () => false,
  openLink: () => false,
  downloadFile: () => false,
  copyText: () => false,
  setModelContext: () => undefined,
  callTool: () => {
    throw new Error("The host declined the tool call");
  },
  readData: () => {
    throw new Error("The host declined the read");
  },
  subscribeData: () => {
    throw new Error("The host declined the subscription");
  },
  comments: () => false,
  artifact: () => {
    throw new Error("The host declined the artifact call");
  },
  assets: () => {
    throw new Error("The host declined the asset call");
  },
  db: () => {
    throw new Error("The host declined the db call");
  },
};

/**
 * The web platform, with no person on the page: no call comes from a click (P078). The driver's
 * own evaluations count as gestures in some engines (Firefox), which would let a call on load
 * through a host's gesture check; nobody clicks in a check.
 */
const NOBODY: PlatformHost = {
  name: "web, unattended",
  createSurface(container, spec) {
    const surface = webPlatform.createSurface(container, spec);
    return { ...surface, userActivation: () => false };
  },
};

/** A handler for each host function the config declares: it notes the call and answers no. */
function declining(capabilities: readonly string[], calls: CheckCall[]): CapabilityHandlers {
  const handlers: Record<string, () => unknown> = {};
  for (const name of capabilities) {
    if (isCapabilityName(name) && capabilitySpec(name).served === "handler") {
      const answer = DECLINED[name as HandledCapability];
      handlers[name] = () => {
        calls.push({ capability: name, outcome: "answered" });
        return answer();
      };
    }
  }
  return handlers;
}

/**
 * The check page (P073): runs content in the real sandbox (the core's `createHost`, the config's
 * own CSP) at one width and scheme at a time, and hears what happens inside from a small script
 * the check puts first in the content: what it throws, what the sandbox blocks, what fails to
 * load, what it logs, and its width. Bundled into one script (`@botiverse/porthole/check/page`)
 * that `checkPage` loads into a blank page through its driver.
 */

interface Run {
  readonly display: DisplayHandle;
  readonly box: HTMLElement;
  readonly scriptLines: readonly number[];
  readonly data: {
    errors: string[];
    calls: CheckCall[];
    blocked: { url: string; directive: string }[];
    failedLoads: { url: string; tag: string }[];
    console: { level: "error" | "warning"; text: string }[];
    height: number | null;
    scrollWidth: number | null;
    clientWidth: number | null;
    outcome: string | null;
  };
}

const runs = new Map<number, Run>();
let next = 0;

const frameOf = (run: Run) => run.box.querySelector("iframe");

addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { portholeCheck?: unknown; data?: unknown } | null;
  if (data === null || typeof data !== "object" || typeof data.portholeCheck !== "string") {
    return;
  }
  for (const run of runs.values()) {
    if (frameOf(run)?.contentWindow !== event.source) {
      continue;
    }
    const said = data.data as Record<string, unknown>;
    switch (data.portholeCheck) {
      case "error": {
        const error = data.data as {
          message?: unknown;
          file?: unknown;
          line?: unknown;
          stack?: unknown;
        };
        const line = contentLine(
          {
            file: typeof error.file === "string" ? error.file : "",
            line: typeof error.line === "number" ? error.line : 0,
            stack: typeof error.stack === "string" ? error.stack : "",
          },
          run.scriptLines,
        );
        const message = typeof error.message === "string" ? error.message : "Error";
        run.data.errors.push(`${message}${line === null ? "" : ` (line ${line})`}`);
        break;
      }
      case "blocked":
        run.data.blocked.push({ url: String(said.url), directive: String(said.directive) });
        break;
      case "load":
        run.data.failedLoads.push({ url: String(said.url), tag: String(said.tag) });
        break;
      case "console":
        run.data.console.push({
          level: said.level === "warning" ? "warning" : "error",
          text: String(said.text),
        });
        break;
      case "measure":
        run.data.scrollWidth = Number(said.scrollWidth);
        run.data.clientWidth = Number(said.clientWidth);
        break;
      default:
        break;
    }
  }
});

const check = {
  /** Shows the content at one width and scheme; returns its run id. */
  run(spec: CheckRunSpec): number {
    const id = next;
    next += 1;
    const box = document.createElement("section");
    box.id = `porthole-check-${id}`;
    box.style.cssText = `width:${spec.widthPx}px;${spec.heightPx === undefined ? "" : `height:${spec.heightPx}px;`}`;
    document.body.append(box);
    const theme = spec.hostTheme ?? {};
    const calls: CheckCall[] = [];
    const display = createHost(spec.config, {
      theme: () => theme,
      hostInfo: { name: "porthole-check", version: "1" },
      // Every host function the config declares, answered as a host that declines (P074): a
      // person asked to confirm says no, a handler says no, and each call is noted.
      handlers: declining(Object.keys(spec.config.capabilities), calls),
      platform: NOBODY,
      confirm: () => Promise.resolve("declined"),
      // A viewer who doesn't allow a live widget their data (P079): its calls are refused.
      consent: () => false,
      // Model context goes to a surface nobody reads here (P100): the check has no person.
      show: () => {},
      // A served config's instance, issued by the check's own server on this page's origin.
      locator: {
        locate: async (instance) =>
          (await (
            await fetch("/issue", { method: "POST", body: JSON.stringify({ instance }) })
          ).json()) as FrameLocation,
      },
    }).mount(box, {
      displayId: `check-${id}`,
      title: "Check",
      scheme: spec.scheme,
      ...(spec.instance === undefined ? {} : { instance: spec.instance }),
      // Under a runtime: the page's declaration (none by default), a viewer who only views.
      ...(spec.config.runtime === undefined
        ? {}
        : { declaration: spec.declaration ?? null, viewer: { level: "view" as const } }),
    });
    const run: Run = {
      display,
      box,
      scriptLines: spec.scriptLines,
      data: {
        errors: [],
        calls,
        blocked: [],
        failedLoads: [],
        console: [],
        height: null,
        scrollWidth: null,
        clientWidth: null,
        outcome: null,
      },
    };
    display.on("resize", ({ height }) => {
      run.data.height = height;
    });
    display.on("refused", ({ capability, refusal }) => {
      // "failed": the declining handler's own no, already noted.
      if (refusal !== "failed") {
        calls.push({ capability, outcome: refusal });
      }
    });
    // A navigation the shell stopped (P080): the content tried to leave its page.
    display.on("navigationBlocked", ({ url }) => {
      run.data.errors.push(
        `It tried to navigate its frame to ${addressWithoutQuery(url)}, and was stopped: content never leaves its page`,
      );
    });
    display.on("outcome", (outcome) => {
      run.data.outcome = outcome.state === "blocked" ? `blocked: ${outcome.reason}` : outcome.state;
    });
    runs.set(id, run);
    // A stored page comes from the check's server; a shell (served or opaque) gets the content.
    if (spec.instance?.document.kind !== "artifact") {
      display.on("initialized", () => display.setContent(instrumented(spec.content)));
    }
    return id;
  },
  /** Asks the frame for its width; resolves when it answers (or after a second). */
  async measure(id: number): Promise<void> {
    const run = runs.get(id);
    const frame = run === undefined ? null : frameOf(run);
    if (run === undefined || frame?.contentWindow === null || frame === null) {
      return;
    }
    frame.contentWindow.postMessage({ portholeCheck: "measure" }, "*");
    const started = Date.now();
    while (run.data.scrollWidth === null && Date.now() - started < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },
  /** What the run saw. */
  result(id: number): CheckRunData | null {
    return runs.get(id)?.data ?? null;
  },
  /** Removes a run's display. */
  end(id: number): void {
    const run = runs.get(id);
    run?.display.destroy();
    run?.box.remove();
    runs.delete(id);
  },
};

export type CheckPageApi = typeof check;

(window as unknown as { portholeCheck: CheckPageApi }).portholeCheck = check;
document.documentElement.dataset.portholeCheck = "ready";
