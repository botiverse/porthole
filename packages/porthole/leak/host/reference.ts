import { createHost, type AnnotateMode, type AnnotationMark } from "../../src/index.ts";
import type { CapabilityHandlers, ConfirmRequest } from "../../src/bridge/types.ts";
import type { LaunchSpec, RecordedCall, RecordedEvent } from "../../src/conformance/index.ts";
import type { DisplayEvents, DisplayHandle } from "../../src/host/types.ts";

/**
 * Porthole's reference host, in the browser: the real core (`createHost`, served as stripped
 * TypeScript), mounting each display the suite asks for, recording what reaches its handlers and
 * holding each confirmation until the test answers it.
 */

interface Display {
  readonly handle: DisplayHandle;
  readonly calls: RecordedCall[];
  /** What the host put in front of the person (`show`, P100). */
  readonly shown: ConfirmRequest[];
  readonly events: RecordedEvent[];
  readonly confirmations: { request: ConfirmRequest; resolve: (accepted: boolean) => void }[];
}

const displays = new Map<number, Display>();
let next = 0;

const EVENTS: readonly (keyof DisplayEvents)[] = [
  "initialized",
  "resize",
  "error",
  "navigated",
  "refused",
  "muted",
  "annotation",
];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const reference = {
  async launch(spec: LaunchSpec): Promise<number> {
    const id = next;
    next += 1;
    const box = document.createElement("section");
    box.id = `display-${id}`;
    box.style.width = `${spec.widthPx ?? 600}px`;
    if (spec.heightPx !== undefined) {
      box.style.height = `${spec.heightPx}px`;
    }
    document.getElementById("displays")?.append(box);

    const calls: RecordedCall[] = [];
    const record =
      <T>(capability: RecordedCall["capability"], value: T) =>
      (args: unknown): T => {
        calls.push({ capability, args });
        return value;
      };
    const handlers: CapabilityHandlers = {
      sendPrompt: record("sendPrompt", true),
      openLink: record("openLink", true),
      downloadFile: record("downloadFile", true),
      callTool: record("callTool", { content: [] }),
      readData: record("readData", { contents: [] }),
      setModelContext: record("setModelContext", undefined),
      copyText: record("copyText", true),
    };
    const confirmations: Display["confirmations"] = [];
    const shown: ConfirmRequest[] = [];
    const host = createHost(spec.config, {
      handlers,
      ...(spec.confirms === false
        ? {}
        : {
            confirm: (request: ConfirmRequest) =>
              new Promise<boolean>((resolve) => confirmations.push({ request, resolve })),
          }),
      ...(spec.shows === false
        ? {}
        : { show: (request: ConfirmRequest) => void shown.push(request) }),
      theme: (scheme) => spec.hostTheme?.[scheme] ?? {},
      hostInfo: { name: "porthole-reference", version: "0" },
      // A page served with a nonce-based script-src (`?nonce=1`) gives its nonce (P054).
      nonce: () => document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || undefined,
    });
    const handle = host.mount(box, {
      displayId: `display-${id}`,
      title: spec.title ?? "Probe",
      scheme: spec.scheme ?? "light",
      ...(spec.document === undefined ? {} : { document: spec.document }),
    });
    const events: RecordedEvent[] = [];
    const initialized = new Promise<void>((resolve) => {
      for (const type of EVENTS) {
        handle.on(type, (detail) => {
          events.push({ type, detail } as RecordedEvent);
          if (type === "initialized") {
            resolve();
          }
        });
      }
    });
    displays.set(id, { handle, calls, shown, events, confirmations });
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
  setContent(id: number, html: string, partial: boolean) {
    displays.get(id)?.handle.setContent(html, { partial });
  },
  calls: (id: number) => displays.get(id)?.calls ?? [],
  shown: (id: number) => displays.get(id)?.shown ?? [],
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
  /** Drives a display's annotations (`annotate`); what it throws comes back as a string. */
  annotate(
    id: number,
    operation: "start" | "stop" | "show" | "focus" | "track" | "clear" | "clearSelection",
    argument?: AnnotateMode | readonly AnnotationMark[] | string,
  ): string | null {
    const controls = displays.get(id)?.handle.annotations;
    if (controls === undefined) {
      return "no display";
    }
    try {
      switch (operation) {
        case "start":
          controls.start(argument as AnnotateMode | undefined);
          break;
        case "stop":
          controls.stop();
          break;
        case "show":
          controls.show(argument as readonly AnnotationMark[]);
          break;
        case "focus":
          controls.focus(argument as string);
          break;
        case "track":
          controls.track(argument as string | null);
          break;
        case "clear":
          controls.clear();
          break;
        case "clearSelection":
          controls.clearSelection();
          break;
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
  destroy(id: number) {
    displays.get(id)?.handle.destroy();
    displays.delete(id);
  },
};

(window as unknown as { reference: typeof reference }).reference = reference;
