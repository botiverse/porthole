import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  PORTHOLE_TOUCH_SELECTION,
  presets,
  type HostContext,
  type PortholeConfig,
} from "../src/index.ts";
import { createHost } from "../src/host/create-host.ts";
import type { PlatformHost, Surface } from "../src/platform/types.ts";
import { SHELL_RUNTIME } from "../src/shell/runtime.ts";

const HOST = "https://app.example.com";

const shellPart = (start: string, end: string): string => {
  const at = SHELL_RUNTIME.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  const stop = SHELL_RUNTIME.indexOf(end, at);
  expect(stop, end).toBeGreaterThan(at);
  return SHELL_RUNTIME.slice(at, stop);
};

interface FakeStyleEl {
  tagName: string;
  nonce: string;
  textContent: string;
  attributes: Map<string, string>;
  isConnected: boolean;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

function runShellTouchSelection(options: { readonly nonce?: string } = {}) {
  const headChildren: FakeStyleEl[] = [];
  const created: FakeStyleEl[] = [];
  const dispatchedThemeEvents: unknown[] = [];
  const rootAttrs = new Map<string, string>();
  const rootStyles = new Map<string, string>();

  const makeStyle = (): FakeStyleEl => {
    const el: FakeStyleEl = {
      tagName: "STYLE",
      nonce: "",
      textContent: "",
      attributes: new Map(),
      isConnected: false,
      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      },
      remove() {
        const idx = headChildren.indexOf(el);
        if (idx !== -1) {
          headChildren.splice(idx, 1);
        }
        el.isConnected = false;
      },
    };
    created.push(el);
    return el;
  };

  class FakeDocument {
    readonly head = {
      appendChild(el: FakeStyleEl) {
        if (!headChildren.includes(el)) {
          headChildren.push(el);
        }
        el.isConnected = true;
        return el;
      },
      replaceChildren(...nodes: FakeStyleEl[]) {
        for (const existing of headChildren) {
          existing.isConnected = false;
        }
        headChildren.length = 0;
        for (const node of nodes) {
          node.isConnected = true;
          headChildren.push(node);
        }
      },
    };
    readonly documentElement = {
      style: {
        colorScheme: "",
        setProperty(name: string, value: string) {
          rootStyles.set(name, value);
        },
        removeProperty(name: string) {
          rootStyles.delete(name);
        },
      },
      setAttribute(name: string, value: string) {
        rootAttrs.set(name, value);
      },
      removeAttribute(name: string) {
        rootAttrs.delete(name);
      },
    };
    createElement(tag: string) {
      if (tag !== "style") {
        throw new Error(`unexpected tag ${tag}`);
      }
      return makeStyle();
    }
  }

  class FakeElement {
    setAttribute(name: string, value: string) {
      (this as unknown as FakeStyleEl).attributes.set(name, value);
    }
  }

  const doc = new FakeDocument();
  const code = [
    "const callOf = Reflect.apply;",
    "const createIn = Document.prototype.createElement;",
    "const setAttributeOfShell = Element.prototype.setAttribute;",
    `const nonce = ${JSON.stringify(options.nonce ?? "")};`,
    'const plan = { content: "document", themeVariables: [], themeEvent: "porthole:theme" };',
    "let lastContext = null;",
    "let themed = false;",
    shellPart("  const schemeFollows =", "\n  // A whole document,"),
    shellPart("  const themeNames =", "\n  // No size before"),
    "({ applyTheme, touchSelectionFollows });",
  ].join("\n");

  const api = runInNewContext(code, {
    Document: FakeDocument,
    Element: FakeElement,
    document: doc,
    CustomEvent: class {
      readonly type: string;
      readonly detail: unknown;
      constructor(type: string, init?: { readonly detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    window: {
      dispatchEvent(ev: unknown) {
        dispatchedThemeEvents.push(ev);
      },
    },
  }) as {
    applyTheme(context: Record<string, unknown>): void;
    touchSelectionFollows(): void;
  };

  return { api, doc, headChildren, created, dispatchedThemeEvents };
}

function fakeHostHarness(config: PortholeConfig) {
  const sentToFrame: unknown[] = [];
  let onMessage: ((data: unknown) => void) | null = null;
  let initializeResponse: { result?: { hostContext?: HostContext } } | null = null;

  const platform: PlatformHost = {
    name: "stand-in",
    createSurface(_container, _spec): Surface {
      return {
        element: null,
        userActivation: () => false,
        transport: {
          send(message) {
            sentToFrame.push(message);
            const rec = message as { id?: unknown; result?: { hostContext?: HostContext } };
            if (rec.id === "init-1") {
              initializeResponse = rec;
            }
          },
          listen(listener) {
            onMessage = listener;
            return () => {
              onMessage = null;
            };
          },
          close() {},
        },
        setHeight() {},
        setColorScheme() {},
        onLoad() {
          return () => {};
        },
        onNavigated() {
          return () => {};
        },
        focus() {},
        destroy() {},
      };
    },
  };

  const container = {
    ownerDocument: {
      defaultView: {
        location: { origin: HOST },
        navigator: { language: "en-US" },
        requestAnimationFrame: (fn: () => void) => {
          fn();
          return 1;
        },
        cancelAnimationFrame() {},
      },
    },
    getBoundingClientRect: () => ({ width: 390, height: 844 }),
  } as unknown as HTMLElement;

  const host = createHost(config, { platform });
  const handshake = () => {
    onMessage?.({
      jsonrpc: "2.0",
      id: "init-1",
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26" },
    });
    onMessage?.({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  };

  return {
    host,
    container,
    handshake,
    sentToFrame,
    initContext: () => initializeResponse?.result?.hostContext,
  };
}

describe("SHELL_RUNTIME touchSelectionFollows (P158)", () => {
  it("leaves the document untouched when hostContext omits porthole/touch-selection", () => {
    const { api, headChildren, created } = runShellTouchSelection();
    api.applyTheme({ theme: "light", styles: { variables: {} } });
    expect(created).toHaveLength(0);
    expect(headChildren).toHaveLength(0);
  });

  it("injects and removes the coarse-pointer style on hostContext updates without firing themeEvent", () => {
    const { api, headChildren, dispatchedThemeEvents } = runShellTouchSelection({
      nonce: "nonce1234",
    });

    api.applyTheme({
      theme: "light",
      styles: { variables: {} },
      [PORTHOLE_TOUCH_SELECTION]: "none",
    });
    expect(headChildren).toHaveLength(1);
    const style = headChildren[0]!;
    expect(style.nonce).toBe("nonce1234");
    expect(style.attributes.get("data-porthole-touch-selection")).toBe("");
    expect(style.textContent).toContain("@media (pointer: coarse)");
    expect(style.textContent).toContain("-webkit-touch-callout:none");
    expect(style.textContent).toContain("user-select:none");
    expect(style.textContent).toContain("input,textarea");

    // Re-applying after head.replaceChildren (whole-document render) re-attaches the same style.
    api.touchSelectionFollows();
    expect(headChildren).toHaveLength(1);

    // Toggling back to default removes the style and emits no themeEvent.
    api.applyTheme({ theme: "light", styles: { variables: {} } });
    expect(headChildren).toHaveLength(0);
    expect(dispatchedThemeEvents).toHaveLength(0);
  });

  it("re-attaches the style after document.head.replaceChildren during renderDocument", () => {
    const { api, doc, headChildren } = runShellTouchSelection();
    api.applyTheme({
      theme: "light",
      styles: { variables: {} },
      [PORTHOLE_TOUCH_SELECTION]: "none",
    });
    expect(headChildren).toHaveLength(1);

    doc.head.replaceChildren();
    expect(headChildren).toHaveLength(0);

    api.touchSelectionFollows();
    expect(headChildren).toHaveLength(1);
  });
});

describe("createHost touchSelection option and setTouchSelection (P158)", () => {
  const config = presets.inlineWidget();

  it("omits porthole/touch-selection by default and sends it when mount.touchSelection is none", () => {
    const defaultHarness = fakeHostHarness(config);
    const d1 = defaultHarness.host.mount(defaultHarness.container, {
      displayId: "d1",
      title: "Default",
      scheme: "light",
    });
    defaultHarness.handshake();
    expect(defaultHarness.initContext()?.[PORTHOLE_TOUCH_SELECTION]).toBeUndefined();
    d1.destroy();

    const guardedHarness = fakeHostHarness(config);
    const d2 = guardedHarness.host.mount(guardedHarness.container, {
      displayId: "d2",
      title: "Guarded",
      scheme: "light",
      touchSelection: "none",
    });
    guardedHarness.handshake();
    expect(guardedHarness.initContext()?.[PORTHOLE_TOUCH_SELECTION]).toBe("none");

    // Live toggle off sends host-context-changed without porthole/touch-selection.
    d2.setTouchSelection("auto");
    const changed = guardedHarness.sentToFrame.filter(
      (msg) => (msg as { method?: string }).method === "ui/notifications/host-context-changed",
    ) as { params?: HostContext }[];
    expect(changed).toHaveLength(1);
    expect(changed[0]?.params?.[PORTHOLE_TOUCH_SELECTION]).toBeUndefined();

    // Redundant call with same mode sends nothing.
    d2.setTouchSelection("auto");
    const afterRedundant = guardedHarness.sentToFrame.filter(
      (msg) => (msg as { method?: string }).method === "ui/notifications/host-context-changed",
    );
    expect(afterRedundant).toHaveLength(1);

    // Toggle back on sends host-context-changed with "none".
    d2.setTouchSelection("none");
    const afterOn = guardedHarness.sentToFrame.filter(
      (msg) => (msg as { method?: string }).method === "ui/notifications/host-context-changed",
    ) as { params?: HostContext }[];
    expect(afterOn).toHaveLength(2);
    expect(afterOn[1]?.params?.[PORTHOLE_TOUCH_SELECTION]).toBe("none");
    d2.destroy();
  });
});
