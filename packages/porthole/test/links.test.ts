import { runInNewContext, Script } from "node:vm";
import { afterEach, describe, expect, test } from "vitest";
import { createBridge, type BridgeEvent } from "../src/bridge/bridge.ts";
import {
  LINK_LABEL_LIMITS,
  capabilitySpec,
  checkLinkLabel,
  checkLinkLabels,
  compile,
  createHost,
  presets,
  type DisplayHandle,
  type PlatformHost,
} from "../src/index.ts";
import { composedRuntime } from "../src/shell/document.ts";
import { FIND_RUNTIME } from "../src/shell/find.ts";
import { LINK_BARE, LINK_LABELS_OF, LINKS_RUNTIME } from "../src/shell/links.ts";
import { SHELL_RUNTIME } from "../src/shell/runtime.ts";

/** Link labels (P151): the shell's rules, what the host sends, and when it forgets. */

type Label = { text: string; tag: string | null };
const realm = runInNewContext(
  `({ bare: ${LINK_BARE}, of: ${LINK_LABELS_OF}, slice: String.prototype.slice, apply: Reflect.apply, isList: Array.isArray, hasOwn: Object.prototype.hasOwnProperty })`,
) as {
  readonly bare: (
    data: unknown,
    raw: unknown,
    resolved: unknown,
    slice: unknown,
    apply: unknown,
  ) => boolean;
  readonly of: (
    labels: unknown,
    own: (object: unknown, name: string | number) => unknown,
    isList: (value: unknown) => boolean,
    most: number,
    hrefMost: number,
    textMost: number,
    table: Record<string, Label>,
  ) => number;
  readonly slice: unknown;
  readonly apply: typeof Reflect.apply;
  readonly isList: (value: unknown) => boolean;
  readonly hasOwn: (this: object, name: PropertyKey) => boolean;
};
const bare = (data: unknown, raw: unknown, resolved: unknown) =>
  realm.bare(data, raw, resolved, realm.slice, realm.apply);
const own = (object: unknown, name: string | number): unknown =>
  object !== null && typeof object === "object" && realm.apply(realm.hasOwn, object, [name])
    ? (object as Record<string | number, unknown>)[name]
    : undefined;
const labelsOf = (labels: unknown) => {
  const table = Object.create(null) as Record<string, Label>;
  const kept = realm.of(labels, own, realm.isList, 500, 2048, 300, table);
  return { kept, table: { ...table } };
};

describe("which links are bare", () => {
  test("the only text is the address, as written or as resolved, white space around it allowed", () => {
    const a = "https://raft.example/a";
    expect(bare(a, a, a)).toBe(true);
    expect(bare(`\n  ${a} \t`, a, a)).toBe(true);
    expect(bare(a, ` ${a} `, a)).toBe(true);
    // The platform's own writing of it: an empty path gets its slash.
    expect(bare("https://raft.example", "https://raft.example", "https://raft.example/")).toBe(
      true,
    );
    expect(bare("https://raft.example/", "/", "https://raft.example/")).toBe(true);
  });

  test("words of its own, an empty text, a near miss: not bare", () => {
    const a = "https://raft.example/a";
    expect(bare("our plan", a, a)).toBe(false);
    expect(bare("", a, a)).toBe(false);
    expect(bare("   ", " ", a)).toBe(false);
    expect(bare(`${a}/`, a, a)).toBe(false);
    expect(bare("HTTPS://RAFT.EXAMPLE/A", a, a)).toBe(false);
    expect(bare(`see ${a}`, a, a)).toBe(false);
    expect(bare(null, a, a)).toBe(false);
  });
});

describe("the labels the shell reads", () => {
  test("own fields only, within the bounds, bidi controls out, the first for an address", () => {
    const { kept, table } = labelsOf([
      { href: "https://a/", text: "‮evil‬ plan", tag: "artifact" },
      { href: "https://b/", text: "x".repeat(301) },
      { href: 5, text: "number" },
      { href: "https://c/", text: "‎ ‏" },
      { href: "https://d/", text: "D", tag: "Not A Tag" },
      { href: "https://a/", text: "second" },
      null,
      "https://e/",
    ]);
    expect(kept).toBe(2);
    expect(table).toEqual({
      "https://a/": { text: "evil plan", tag: "artifact" },
      "https://d/": { text: "D", tag: null },
    });
  });

  test("a prototype's fields are no label's; anything but a list is none", () => {
    const inherited = Object.create({ href: "https://a/", text: "A" }) as object;
    expect(labelsOf([inherited]).kept).toBe(0);
    expect(labelsOf({ length: 1, 0: { href: "https://a/", text: "A" } }).kept).toBe(0);
    expect(labelsOf(undefined).kept).toBe(0);
  });

  test("at most 500 entries are read", () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ href: `https://x/${i}`, text: "t" }));
    expect(labelsOf(many).kept).toBe(500);
  });
});

describe("the host's checks", () => {
  test("an absolute http(s) address, as the platform writes it; text without bidi controls; a tag of its pattern", () => {
    expect(checkLinkLabel({ href: "HTTPS://Raft.Example", text: "⁦Plan⁩", tag: "art-1" })).toEqual({
      href: "https://raft.example/",
      text: "Plan",
      tag: "art-1",
    });
    expect(checkLinkLabel({ href: "https://raft.example/a", text: "A", tag: "Bad Tag" })).toEqual({
      href: "https://raft.example/a",
      text: "A",
    });
    expect(
      checkLinkLabel({ href: "https://raft.example/a", text: "A", tag: "x".repeat(33) }),
    ).toEqual({ href: "https://raft.example/a", text: "A" });
    // Markup is text: kept as written, the shell writes it as text.
    expect(checkLinkLabel({ href: "https://raft.example/a", text: "<b>A</b>" })?.text).toBe(
      "<b>A</b>",
    );
  });

  test("anything malformed is null", () => {
    for (const label of [
      null,
      "https://raft.example/a",
      { href: "/relative", text: "A" },
      { href: "javascript:alert(1)", text: "A" },
      { href: "data:text/html,x", text: "A" },
      { href: `https://raft.example/${"a".repeat(LINK_LABEL_LIMITS.href)}`, text: "A" },
      { href: "https://raft.example/a", text: "x".repeat(LINK_LABEL_LIMITS.text + 1) },
      { href: "https://raft.example/a", text: "  " },
      { href: "https://raft.example/a", text: "‪‬" },
      { href: "https://raft.example/a", text: 5 },
    ]) {
      expect(checkLinkLabel(label), JSON.stringify(label)).toBeNull();
    }
  });

  test("a set drops the malformed and keeps the rest, the first for each address, at most 500; anything but a list throws", () => {
    expect(
      checkLinkLabels([
        { href: "https://raft.example/a", text: "A" },
        { href: "nope", text: "B" },
        { href: "https://raft.example/a", text: "again" },
        { href: "https://raft.example/c", text: "C" },
      ]),
    ).toEqual([
      { href: "https://raft.example/a", text: "A" },
      { href: "https://raft.example/c", text: "C" },
    ]);
    const many = Array.from({ length: 600 }, (_, i) => ({ href: `https://x/${i}`, text: "t" }));
    expect(checkLinkLabels(many)).toHaveLength(LINK_LABEL_LIMITS.labels);
    expect(() => checkLinkLabels("labels")).toThrow(TypeError);
    expect(() => checkLinkLabels({ href: "https://x/", text: "t" })).toThrow(TypeError);
  });
});

describe("the shell", () => {
  const origins = ["https://a.example"];
  test("carries the link-label runtime only where linkLabels is declared, after find's, the runtime's own bytes unchanged", () => {
    const plain = compile(presets.artifact()).shellDocument({ origins });
    const labelled = compile(presets.artifact({ capabilities: { linkLabels: {} } })).shellDocument({
      origins,
    });
    expect(plain).not.toContain("porthole/links.label");
    expect(labelled).toContain('"porthole/links.label"');
    expect(labelled).not.toContain("__FIND__");
    const both = compile(presets.artifact({ capabilities: { find: {}, linkLabels: {} } }));
    const runtime = composedRuntime(both.shell ?? ({} as never));
    expect(runtime.indexOf(FIND_RUNTIME)).toBeGreaterThan(-1);
    expect(runtime.indexOf(LINKS_RUNTIME)).toBeGreaterThan(runtime.indexOf(FIND_RUNTIME));
    // SHELL_RUNTIME has no placeholder of its own for it (its bytes are pinned, P145).
    expect(SHELL_RUNTIME).not.toContain("__LINKS__");
  });

  test("with it in, is still a plain script", () => {
    const compiled = compile(presets.artifact({ capabilities: { linkLabels: {} } }));
    expect(
      () => new Script(composedRuntime(compiled.shell ?? ({} as never)).replace("__PLAN__", "{}")),
    ).not.toThrow();
  });

  test("splices its rules as they are", () => {
    expect(LINKS_RUNTIME).toContain(`const isBare = ${LINK_BARE};`);
    expect(LINKS_RUNTIME).toContain(`const labelsOf = ${LINK_LABELS_OF};`);
  });

  test("writes a label as text, through the kept nodeValue setter, never as markup", () => {
    expect(LINKS_RUNTIME).toContain(
      "const writeLabel = (link, child, text) => {\n        setText(child, text);\n      };",
    );
    expect(LINKS_RUNTIME).toContain("callOf(nodeValueTo, node, [text])");
    for (const markup of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "createContextualFragment",
      "DOMParser",
    ]) {
      expect(LINKS_RUNTIME, markup).not.toContain(markup);
    }
  });

  test("calls only built-ins it took before content ran, through callOf (P129); inserts no node", () => {
    for (const source of [LINKS_RUNTIME, LINK_BARE, LINK_LABELS_OF]) {
      for (const live of [
        ".call(",
        ".apply(",
        ".bind(",
        ".map(",
        ".concat(",
        ".indexOf(",
        ".includes(",
        ".forEach(",
        ".filter(",
        ".push(",
        ".trim(",
        ".replace(",
        ".slice(",
        "for (const ",
        "Array.from(",
        "Object.assign(",
        "Object.keys(",
        "Math.",
        ".observe(",
        ".takeRecords(",
        ".getAttribute(",
        ".setAttribute(",
        ".removeAttribute(",
        ".querySelectorAll(",
        ".childNodes",
        ".nodeValue.",
        ".textContent",
        "appendChild",
        "insertBefore",
        "replaceChildren",
        "event.data",
        "event.origin",
        "event.source",
        "window.parent.postMessage",
        "postMessage(",
      ]) {
        expect(source, live).not.toContain(live);
      }
    }
    for (const used of [
      "callOf(queryAllDocument, document, [SELECTOR])",
      "callOf(observeIn, contentWatch, [document,",
      "callOf(takeRecordsIn, contentWatch, [])",
      "callOf(getAttributeIn, element, [name])",
      "callOf(setAttributeOn, link, [TAG, label.tag])",
      "callOf(removeAttributeOn, entry.element, [TAG])",
      "callOf(weakMapGet, writtenOf, [child])",
      "callOf(timeoutIn, window,",
      "resolveHere(raw)",
    ]) {
      expect(LINKS_RUNTIME, used).toContain(used);
    }
    // Taken before the message listener (and so before any content ran).
    const handler = LINKS_RUNTIME.indexOf('window.addEventListener("message"');
    for (const line of [
      'const nodeValueTo = setterOf(Node.prototype, "nodeValue");',
      "const takeRecordsIn = MutationObserver.prototype.takeRecords;",
      "const removeAttributeOn = Element.prototype.removeAttribute;",
      "const isList = Array.isArray;",
      "const Written = WeakMap;",
    ]) {
      const at = LINKS_RUNTIME.indexOf(line);
      expect(at, line).toBeGreaterThan(-1);
      expect(at, line).toBeLessThan(handler);
    }
  });

  test("takes labels only from its parent and the plan's origins, as a notification; says nothing back", () => {
    expect(LINKS_RUNTIME).toContain(
      'if (!fromHostWindow(get(messageSourceOf, event, "source")) || !fromHost(get(messageOriginOf, event, "origin"))) {',
    );
    expect(LINKS_RUNTIME).toContain('own(data, "id") !== undefined');
    expect(LINKS_RUNTIME).not.toContain("postIn");
  });

  test("declares linkLabels as an event, rate-limited, taught to the agent", () => {
    const compiled = compile(presets.artifact({ capabilities: { linkLabels: {} } }));
    expect(compiled.shell?.capabilities.linkLabels).toEqual({ userActivation: false });
    expect(compiled.guide(["interactive"])).toContain("- Link labels: a link in the page");
  });
});

describe("link labels on createHost over a stand-in platform", () => {
  const mounted: DisplayHandle[] = [];
  afterEach(() => {
    for (const display of mounted.splice(0)) {
      display.destroy();
    }
  });
  /** A display whose frames' messages are kept, each frame's handshake by hand. */
  const mount = (given: { declared?: boolean; perMinute?: number } = {}) => {
    const sent: { id?: unknown; method?: unknown; params?: unknown }[] = [];
    let listeners = new Set<(message: unknown) => void>();
    let frames = 0;
    const platform: PlatformHost = {
      name: "stand-in",
      createSurface: () => {
        frames += 1;
        listeners = new Set();
        const mine = listeners;
        return {
          transport: {
            send: (message) => void sent.push(message),
            listen: (listener) => {
              mine.add(listener);
              return () => mine.delete(listener);
            },
            close: () => mine.clear(),
          },
          element: null,
          setHeight: () => {},
          setColorScheme: () => {},
          userActivation: () => undefined,
          viewport: () => ({ width: 600, height: 400 }),
          onNavigated: () => () => {},
          onLoad: () => () => {},
          destroy: () => {},
        };
      },
    };
    const container = {
      ownerDocument: {
        defaultView: { location: { origin: "https://app.example" }, navigator: { language: "en" } },
      },
      getBoundingClientRect: () => ({ width: 600 }),
    } as unknown as HTMLElement;
    const config =
      given.declared === false
        ? presets.artifact()
        : presets.artifact({
            capabilities: {
              linkLabels:
                given.perMinute === undefined
                  ? {}
                  : { gates: [{ rateLimit: { perMinute: given.perMinute } }] },
            },
          });
    const display = createHost(config, { platform }).mount(container, {
      displayId: "d1",
      title: "Notes",
      scheme: "light",
    });
    mounted.push(display);
    const say = (message: unknown) => {
      for (const listener of listeners) {
        listener(message);
      }
    };
    const handshake = () =>
      say({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    const labelled = () =>
      sent.filter((each) => each.method === "porthole/links.label").map((each) => each.params);
    const refused: string[] = [];
    display.on("refused", (detail) => refused.push(`${detail.capability}:${detail.refusal}`));
    return { display, sent, say, handshake, labelled, refused, frames: () => frames };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const A = { href: "https://raft.example/a", text: "Plan", tag: "artifact" };
  const B = { href: "https://raft.example/b", text: "Notes" };

  test("labels given before the frame is ready go once it is; checked; the same again sends nothing", () => {
    const { display, handshake, labelled } = mount();
    display.links.label([A, { href: "nope", text: "x" }]);
    expect(labelled()).toEqual([]);
    handshake();
    expect(labelled()).toEqual([{ labels: [A] }]);
    display.links.label([A]);
    expect(labelled()).toHaveLength(1);
    display.links.label([A, B]);
    expect(labelled()).toEqual([{ labels: [A] }, { labels: [A, B] }]);
    display.links.label([]);
    expect(labelled().at(-1)).toEqual({ labels: [] });
    expect(() => display.links.label("no" as never)).toThrow(TypeError);
  });

  test("without linkLabels declared: nothing goes to the frame", () => {
    const { display, handshake, labelled } = mount({ declared: false });
    handshake();
    display.links.label([A]);
    expect(labelled()).toEqual([]);
  });

  test("a reload forgets them: the new frame is given none until the host labels again", () => {
    const { display, handshake, labelled, frames } = mount();
    handshake();
    display.links.label([A]);
    expect(labelled()).toHaveLength(1);
    display.reload();
    expect(frames()).toBe(2);
    handshake();
    expect(labelled()).toHaveLength(1);
    display.links.label([A]);
    expect(labelled()).toEqual([{ labels: [A] }, { labels: [A] }]);
  });

  test("other content forgets them and gives the frame's links their words back; the same content continued keeps them", () => {
    const { display, handshake, labelled } = mount();
    handshake();
    display.setContent("<p>one");
    display.links.label([A]);
    display.setContent("<p>one, continued");
    expect(labelled()).toEqual([{ labels: [A] }]);
    display.setContent("<p>another page");
    expect(labelled()).toEqual([{ labels: [A] }, { labels: [] }]);
    // Labelled anew for the new content.
    display.links.label([A]);
    expect(labelled()).toHaveLength(3);
  });

  test("another page of the set, ready on the same transport, is given them again, within their rate", async () => {
    const { display, handshake, labelled, refused } = mount({ perMinute: 2 });
    handshake();
    display.links.label([A]);
    expect(labelled()).toHaveLength(1);
    // Three more pages: the first two given the labels again, the third over the rate.
    for (let page = 0; page < 3; page += 1) {
      handshake();
      await settle();
    }
    expect(labelled()).toEqual([{ labels: [A] }, { labels: [A] }, { labels: [A] }]);
    expect(refused).toEqual(["linkLabels:rate-limited"]);
  });

  test("a later page with no labels held asks nothing", async () => {
    const { handshake, labelled, refused } = mount();
    handshake();
    handshake();
    await settle();
    expect(labelled()).toEqual([]);
    expect(refused).toEqual([]);
  });
});

describe("the bridge carries a later page's readiness", () => {
  test("as an event, within the rate; nothing of the frame's is read", async () => {
    const events: BridgeEvent[] = [];
    const bridge = createBridge({
      config: presets.artifact({
        capabilities: { linkLabels: { gates: [{ rateLimit: { perMinute: 1 } }] } },
      }),
      display: { id: "d1", title: "Notes" },
      handlers: {},
      onEvent: (event) => events.push(event),
    });
    expect((await bridge.call("linkLabels", {})).ok).toBe(true);
    expect(events).toEqual([{ type: "linkLabels" }]);
    expect(await bridge.call("linkLabels", {})).toMatchObject({ ok: false });
    expect(await bridge.call("linkLabels", "x")).toMatchObject({ ok: false });
  });

  test("by default at most 60 a minute, served as an event", () => {
    expect(capabilitySpec("linkLabels")).toEqual({
      defaultGates: [{ rateLimit: { perMinute: 60 } }],
      served: "event",
    });
  });
});
