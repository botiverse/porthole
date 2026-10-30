import type { CapabilityHandlers, ConfirmRequest } from "../../bridge/types.ts";
import type { PortholeConfig } from "../../config/schema.ts";
import { createHost } from "../../host/create-host.ts";
import { httpLocator, resolveAddress } from "../../host/locator.ts";
import type { DisplayEvents, DisplayHandle } from "../../host/types.ts";
import type { FrameLocation, InstanceLocator, InstanceRef } from "../../isolation/types.ts";
import type { LaunchSpec, RecordedCall, RecordedEvent } from "../index.ts";

/**
 * The conformance harness (P066), injected into an app's real page under its nonce: framework-
 * free, on the core's own mount (`createHost`), it shows each display the suite asks for (an
 * opaque one with the suite's content; a served one located by the app's issue endpoint),
 * records what reaches its handlers and holds each confirmation until the test answers it. Built
 * into one script (`dist/conformance/harness.js`); `defineHostConformance` injects it.
 */

interface Shown {
  readonly handle: DisplayHandle;
  readonly calls: RecordedCall[];
  readonly events: RecordedEvent[];
  readonly confirmations: { request: ConfirmRequest; resolve: (accepted: boolean) => void }[];
  /** What the host put in front of the person (`show`, P100). */
  readonly disclosed: ConfirmRequest[];
  readonly received: unknown[];
  origin: string | null;
  /** Why the instance couldn't be located (the issue endpoint's refusal). */
  failure: string | null;
  frame: HTMLIFrameElement | null;
}

const EVENTS: readonly (keyof DisplayEvents)[] = [
  "initialized",
  "resize",
  "error",
  "contentError",
  "hostError",
  "navigated",
  "refused",
  "muted",
  "outcome",
  "annotation",
];

const nonce =
  document.currentScript instanceof HTMLScriptElement && document.currentScript.nonce !== ""
    ? document.currentScript.nonce
    : undefined;
const displays = new Map<number, Shown>();
let next = 0;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The harness's own layer, over the app's page, so the app's UI never takes a click. */
function layer(): HTMLElement {
  let element = document.getElementById("porthole-conformance");
  if (element === null) {
    element = document.createElement("main");
    element.id = "porthole-conformance";
    element.style.cssText =
      "position:fixed;inset:0;overflow:auto;z-index:2147483000;background:#fff;color:#000;padding:8px";
    document.body.append(element);
  }
  return element;
}

function box(id: number, widthPx: number, heightPx?: number): HTMLElement {
  const element = document.createElement("section");
  element.id = `porthole-display-${id}`;
  element.style.width = `${widthPx}px`;
  if (heightPx !== undefined) {
    element.style.height = `${heightPx}px`;
  }
  layer().append(element);
  return element;
}

function recorder(calls: RecordedCall[]): CapabilityHandlers {
  const record =
    <T>(capability: RecordedCall["capability"], value: T) =>
    (args: unknown): T => {
      calls.push({ capability, args });
      return value;
    };
  return {
    sendPrompt: record("sendPrompt", true),
    openLink: record("openLink", true),
    downloadFile: record("downloadFile", true),
    callTool: record("callTool", { content: [] }),
    readData: record("readData", { contents: [] }),
    subscribeData: record("subscribeData", undefined),
    setModelContext: record("setModelContext", undefined),
    copyText: record("copyText", true),
  };
}

function watch(id: number, shown: Shown): void {
  for (const type of EVENTS) {
    shown.handle.on(type, (detail) => shown.events.push({ type, detail } as RecordedEvent));
  }
  displays.set(id, shown);
}

/** The frame's messages, from its window and its located origin only, as a host takes them. */
addEventListener("message", (event) => {
  for (const shown of displays.values()) {
    if (shown.frame?.contentWindow === event.source && event.origin === shown.origin) {
      shown.received.push(event.data);
    }
  }
});

/** A display's record, before anything is mounted for it (a no-op handle until then). */
function recordOf(id: number): Shown {
  box(id, 600, 400);
  const idle = { destroy() {}, setContent() {}, setTheme() {}, on: () => () => {} };
  const shown: Shown = {
    handle: idle as unknown as DisplayHandle,
    calls: [],
    events: [],
    confirmations: [],
    disclosed: [],
    received: [],
    origin: null,
    failure: null,
    frame: null,
  };
  displays.set(id, shown);
  return shown;
}

/** Mounts a served display in its box, located by `asked` (the issue endpoint, or a location). */
function mountServed(
  id: number,
  shown: Shown,
  config: PortholeConfig,
  instance: InstanceRef,
  asked: InstanceLocator,
  content?: string,
): void {
  const container = document.getElementById(`porthole-display-${id}`) as HTMLElement;
  const locator: InstanceLocator = {
    async locate(each, signal) {
      try {
        const location = await asked.locate(each, signal);
        shown.origin = location.origin;
        return location;
      } catch (error) {
        shown.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        throw error;
      }
    },
  };
  const handle = createHost(config, {
    handlers: recorder(shown.calls),
    locator,
    hostInfo: { name: "porthole-conformance", version: "1" },
    ...(nonce === undefined ? {} : { nonce }),
  }).mount(container, {
    displayId: `display-${id}`,
    title: "Probe",
    scheme: "light",
    instance,
  });
  (shown as { handle: DisplayHandle }).handle = handle;
  watch(id, shown);
  // The frame element, once it exists, so its messages can be told from others' (never a door).
  const found = () => {
    shown.frame = container.querySelector("iframe:not([data-porthole-door])");
    if (shown.frame === null) {
      requestAnimationFrame(found);
    }
  };
  found();
  if (content !== undefined) {
    handle.setContent(content);
  }
}

const harness = {
  /** An opaque display with the suite's content (the leak suite's `launch`). */
  async launch(spec: LaunchSpec): Promise<number> {
    const id = next;
    next += 1;
    const container = box(id, spec.widthPx ?? 600, spec.heightPx);
    const calls: RecordedCall[] = [];
    const confirmations: Shown["confirmations"] = [];
    const disclosed: ConfirmRequest[] = [];
    const host = createHost(spec.config, {
      handlers: recorder(calls),
      ...(spec.confirms === false
        ? {}
        : {
            confirm: (request: ConfirmRequest) =>
              new Promise<boolean>((resolve) => confirmations.push({ request, resolve })),
          }),
      ...(spec.shows === false
        ? {}
        : { show: (request: ConfirmRequest) => void disclosed.push(request) }),
      theme: (scheme) => spec.hostTheme?.[scheme] ?? {},
      hostInfo: { name: "porthole-conformance", version: "1" },
      ...(nonce === undefined ? {} : { nonce }),
    });
    const handle = host.mount(container, {
      displayId: `display-${id}`,
      title: spec.title ?? "Probe",
      scheme: spec.scheme ?? "light",
      ...(spec.document === undefined ? {} : { document: spec.document }),
    });
    const display: Shown = {
      handle,
      calls,
      events: [],
      confirmations,
      disclosed,
      received: [],
      origin: null,
      failure: null,
      frame: null,
    };
    const initialized = new Promise<void>((resolve) => handle.on("initialized", () => resolve()));
    watch(id, display);
    if (spec.document === undefined) {
      await Promise.race([initialized, pause(5_000)]);
      for (const partial of spec.partials ?? []) {
        handle.setContent(partial, { partial: true });
        await pause(150);
      }
      if (spec.content !== undefined) {
        handle.setContent(spec.content);
      }
    }
    return id;
  },

  /**
   * A served display, located by the app's issue endpoint (`issue`, from this page with its own
   * cookies) or at a location the test got (`location`), with the suite's content for a shell.
   */
  show(
    config: PortholeConfig,
    instance: InstanceRef,
    where:
      | { readonly issue: string; readonly headers?: Readonly<Record<string, string>> }
      | { readonly location: FrameLocation },
    content?: string,
  ): number {
    const id = next;
    next += 1;
    const shown = recordOf(id);
    const asked: InstanceLocator =
      "issue" in where
        ? httpLocator(where.issue, where.headers === undefined ? {} : { headers: where.headers })
        : { locate: () => Promise.resolve(where.location) };
    mountServed(id, shown, config, instance, asked, content);
    return id;
  },

  /**
   * A clean address, shown as a host shows one (P125): resolved through the app's issue endpoint
   * first (`{ address }`, `resolveAddress`), then framed through the location it issued (its
   * door); signed out, denied or not found, the answer is the display's outcome and no frame is
   * ever made. Later runs issue afresh by the resolved instance.
   */
  showAddress(
    config: PortholeConfig,
    where: { readonly issue: string; readonly headers?: Readonly<Record<string, string>> },
    address: string,
  ): number {
    const id = next;
    next += 1;
    const shown = recordOf(id);
    const options = where.headers === undefined ? {} : { headers: where.headers };
    void resolveAddress(where.issue, address, options).then(
      (resolved) => {
        if ("outcome" in resolved) {
          shown.events.push({ type: "outcome", detail: resolved.outcome });
          return;
        }
        shown.origin = resolved.location.origin;
        let first: FrameLocation | null = resolved.location;
        const byInstance = httpLocator(where.issue, options);
        const asked: InstanceLocator = {
          locate(each, signal) {
            const given = first;
            first = null;
            return given === null ? byInstance.locate(each, signal) : Promise.resolve(given);
          },
        };
        mountServed(id, shown, config, resolved.instance, asked);
      },
      (error: unknown) => {
        shown.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      },
    );
    return id;
  },

  /** Whether a display's frame was ever made (P125: a refused clean address makes none). */
  framed: (id: number) =>
    (document.getElementById(`porthole-display-${id}`)?.querySelector("iframe") ?? null) !== null,

  origin: (id: number) => displays.get(id)?.origin ?? null,
  failure: (id: number) => displays.get(id)?.failure ?? null,
  received: (id: number) => displays.get(id)?.received ?? [],
  post(id: number, message: unknown) {
    const shown = displays.get(id);
    if (shown?.frame?.contentWindow && shown.origin !== null) {
      shown.frame.contentWindow.postMessage(message, shown.origin);
    }
  },
  setContent(id: number, html: string, partial: boolean) {
    displays.get(id)?.handle.setContent(html, { partial });
  },
  calls: (id: number) => displays.get(id)?.calls ?? [],
  shown: (id: number) => displays.get(id)?.disclosed ?? [],
  events: (id: number) => displays.get(id)?.events ?? [],
  errors: (id: number) =>
    (displays.get(id)?.events ?? []).flatMap((event) =>
      event.type === "error" ? [event.detail.message] : [],
    ),
  pendingConfirmations: (id: number) => displays.get(id)?.confirmations.length ?? 0,
  answer(id: number, accept: boolean): ConfirmRequest | null {
    const waiting = displays.get(id)?.confirmations.shift();
    if (waiting === undefined) {
      return null;
    }
    waiting.resolve(accept);
    return waiting.request;
  },
  setTheme: (id: number, scheme: "light" | "dark") => displays.get(id)?.handle.setTheme(scheme),
  destroy(id: number) {
    displays.get(id)?.handle.destroy();
    document.getElementById(`porthole-display-${id}`)?.remove();
    displays.delete(id);
  },
};

export type ConformanceHarness = typeof harness;

(window as unknown as { portholeConformance: ConformanceHarness }).portholeConformance = harness;
document.documentElement.dataset.portholeConformance = "ready";
