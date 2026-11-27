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
  savedNonce: string;
  savedText: string;
  attributes: Map<string, string>;
  isConnected: boolean;
}

function runShellTouchSelection(options: { readonly nonce?: string } = {}) {
  const headChildren: FakeStyleEl[] = [];
  const created: FakeStyleEl[] = [];
  const dispatchedThemeEvents: unknown[] = [];
  const rootAttrs = new Map<string, string>();
  const rootStyles = new Map<string, string>();

  class FakeNode {
    isConnected = false;
    savedText = "";
    get textContent(): string {
      return this.savedText;
    }
    set textContent(value: string) {
      this.savedText = value;
    }
    get firstChild(): FakeStyleEl | null {
      return headChildren[0] ?? null;
    }
    appendChild(el: FakeStyleEl) {
      if (!headChildren.includes(el)) {
        headChildren.push(el);
      }
      el.isConnected = true;
      return el;
    }
    insertBefore(el: FakeStyleEl, ref: FakeStyleEl | null) {
      const existing = headChildren.indexOf(el);
      if (existing !== -1) {
        headChildren.splice(existing, 1);
      }
      const at = ref === null ? -1 : headChildren.indexOf(ref);
      if (at === -1) {
        headChildren.push(el);
      } else {
        headChildren.splice(at, 0, el);
      }
      el.isConnected = true;
      return el;
    }
  }

  class FakeElement extends FakeNode {
    attributes = new Map<string, string>();
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    remove() {
      const idx = headChildren.indexOf(this as unknown as FakeStyleEl);
      if (idx !== -1) {
        headChildren.splice(idx, 1);
      }
      this.isConnected = false;
    }
  }

  class FakeHTMLElement extends FakeElement {
    tagName = "STYLE";
    savedNonce = "";
    get nonce(): string {
      return this.savedNonce;
    }
    set nonce(value: string) {
      this.savedNonce = value;
    }
  }

  const head = Object.assign(new FakeElement(), {
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
  });

  class FakeDocument {
    get head() {
      return head;
    }
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
      const el = new FakeHTMLElement();
      created.push(el);
      return el;
    }
  }

  const doc = new FakeDocument();
  const code = [
    "const callOf = Reflect.apply;",
    "const hasOwn = Object.prototype.hasOwnProperty;",
    "const createIn = Document.prototype.createElement;",
    "const setAttributeOfShell = Element.prototype.setAttribute;",
    "const removeIn = Element.prototype.remove;",
    `const nonce = ${JSON.stringify(options.nonce ?? "")};`,
    'const plan = { content: "document", themeVariables: [], themeEvent: "porthole:theme" };',
    "let lastContext = null;",
    "let themed = false;",
    shellPart("  const getterOf =", "\n  const navigateProto"),
    "const connected = (node) => Boolean(node && node.isConnected);",
    shellPart("  const schemeFollows =", "\n  // A whole document,"),
    shellPart("  const themeNames =", "\n  // No size before"),
    "({ applyTheme, controlSelectDefaults, touchSelectionFollows });",
  ].join("\n");

  const api = runInNewContext(code, {
    Node: FakeNode,
    Document: FakeDocument,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
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
    controlSelectDefaults(): void;
    touchSelectionFollows(): void;
  };

  return {
    api,
    doc,
    head,
    headChildren,
    created,
    dispatchedThemeEvents,
    FakeHTMLElement,
    FakeElement,
    FakeNode,
  };
}

function fakeHostHarness(
  config: PortholeConfig,
  extraHostOptions: { readonly hostContext?: () => Partial<HostContext> } = {},
) {
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

  const host = createHost(config, { platform, ...extraHostOptions });
  const sendInitialize = () => {
    onMessage?.({
      jsonrpc: "2.0",
      id: "init-1",
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26" },
    });
  };
  const sendInitialized = () => {
    onMessage?.({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  };
  const handshake = () => {
    sendInitialize();
    sendInitialized();
  };

  return {
    host,
    container,
    handshake,
    sendInitialize,
    sendInitialized,
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

  it("injects and removes the zero-specificity coarse-pointer style without firing themeEvent", () => {
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
    expect(style.savedNonce).toBe("nonce1234");
    expect(style.attributes.get("data-porthole-touch-selection")).toBe("");
    expect(style.savedText).toContain("@media (pointer: coarse)");
    expect(style.savedText).toContain("-webkit-touch-callout:none");
    expect(style.savedText).toContain("user-select:none");
    expect(style.savedText).toContain(':where(input,textarea,[contenteditable=""]');
    expect(style.savedText).toContain('[contenteditable="plaintext-only" i] *');

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

  it("uses pre-content native setters/methods so tampered prototypes cannot steal nonce or abort applyTheme", () => {
    const { api, headChildren, FakeHTMLElement, FakeElement, FakeNode } = runShellTouchSelection({
      nonce: "secret-nonce",
    });
    const stolen: string[] = [];
    Object.defineProperty(FakeHTMLElement.prototype, "nonce", {
      configurable: true,
      set(v: string) {
        stolen.push(v);
      },
    });
    FakeElement.prototype.remove = () => {
      throw new Error("tampered remove");
    };
    FakeNode.prototype.appendChild = () => {
      throw new Error("tampered appendChild");
    };

    api.applyTheme({
      theme: "light",
      styles: { variables: {} },
      [PORTHOLE_TOUCH_SELECTION]: "none",
    });
    expect(stolen).toEqual([]);
    expect(headChildren).toHaveLength(1);
    expect(headChildren[0]!.savedNonce).toBe("secret-nonce");

    expect(() => api.applyTheme({ theme: "light", styles: { variables: {} } })).not.toThrow();
    expect(headChildren).toHaveLength(0);
  });
});

describe("SHELL_RUNTIME controlSelectDefaults (P160)", () => {
  it("prepends the zero-specificity control rule ahead of author stylesheets and carries CSP nonce", () => {
    const { api, doc, headChildren } = runShellTouchSelection({ nonce: "nonce5678" });
    const authorStyle = doc.createElement("style");
    authorStyle.savedText = "* { user-select: text }";
    doc.head.replaceChildren(authorStyle);

    api.controlSelectDefaults();
    expect(headChildren).toHaveLength(2);
    const injected = headChildren[0]!;
    expect(injected.attributes.get("data-porthole-control-select")).toBe("");
    expect(injected.savedNonce).toBe("nonce5678");
    expect(injected.savedText).toBe(
      ':where(button,input[type="range" i],[role="slider"],[role="button"]){-webkit-user-select:none;user-select:none}',
    );
    expect(headChildren[1]).toBe(authorStyle);

    // Re-attaches at the front after another document.head.replaceChildren().
    const nextAuthor = doc.createElement("style");
    doc.head.replaceChildren(nextAuthor);
    api.controlSelectDefaults();
    expect(headChildren).toEqual([injected, nextAuthor]);
  });

  it("uses pre-content native DOM methods so tampered prototypes cannot steal nonce or throw", () => {
    const { api, headChildren, FakeHTMLElement, FakeNode } = runShellTouchSelection({
      nonce: "secret-nonce-2",
    });
    const stolen: string[] = [];
    Object.defineProperty(FakeHTMLElement.prototype, "nonce", {
      configurable: true,
      set(v: string) {
        stolen.push(v);
      },
    });
    FakeNode.prototype.insertBefore = () => {
      throw new Error("tampered insertBefore");
    };

    expect(() => api.controlSelectDefaults()).not.toThrow();
    expect(stolen).toEqual([]);
    expect(headChildren).toHaveLength(1);
    expect(headChildren[0]!.savedNonce).toBe("secret-nonce-2");
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
    expect(
      guardedHarness.sentToFrame.filter(
        (msg) => (msg as { method?: string }).method === "ui/notifications/host-context-changed",
      ),
    ).toHaveLength(1);

    // Toggle back on sends host-context-changed with "none".
    d2.setTouchSelection("none");
    const afterOn = guardedHarness.sentToFrame.filter(
      (msg) => (msg as { method?: string }).method === "ui/notifications/host-context-changed",
    ) as { params?: HostContext }[];
    expect(afterOn).toHaveLength(2);
    expect(afterOn[1]?.params?.[PORTHOLE_TOUCH_SELECTION]).toBe("none");
    d2.destroy();
  });

  it("reconciles mid-handshake setTouchSelection and clears options.hostContext override", () => {
    const harness = fakeHostHarness(config, {
      hostContext: () => ({ [PORTHOLE_TOUCH_SELECTION]: "none" }),
    });
    const d = harness.host.mount(harness.container, {
      displayId: "d-mid",
      title: "Mid",
      scheme: "light",
      touchSelection: "auto",
    });
    // Even if options.hostContext sets "none", mount.touchSelection ("auto") wins.
    harness.sendInitialize();
    expect(harness.initContext()?.[PORTHOLE_TOUCH_SELECTION]).toBeUndefined();

    // Toggled after ui/initialize but before ui/notifications/initialized: synced on initialized.
    d.setTouchSelection("none");
    harness.sendInitialized();
    const changed = harness.sentToFrame.filter(
      (msg) => (msg as { method?: string }).method === "ui/notifications/host-context-changed",
    ) as { params?: HostContext }[];
    expect(changed).toHaveLength(1);
    expect(changed[0]?.params?.[PORTHOLE_TOUCH_SELECTION]).toBe("none");
    d.destroy();
  });
});
