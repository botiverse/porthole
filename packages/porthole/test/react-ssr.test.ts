import { createElement, createRef } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDisplays, portholeClient, presets } from "../src/index.ts";
import { tabLinkOf } from "../src/react/view.tsx";
import {
  PortholeFrame,
  PortholeProvider,
  PortholeView,
  type PortholeFrameHandle,
  type PortholeFrameProps,
  type PortholeViewProps,
} from "../src/react/index.ts";

/** PortholeView rendered on a server (P074): what an SSR'd page, and its tests, see. */

const displays = defineDisplays({
  artifact: { preset: "artifact" },
  preview: { preset: "url" },
});
const SOURCE = "https://*.usercontent.example.net";
const instance = { scope: "abc", document: { kind: "artifact", id: "abc", version: "1" } } as const;

const render = (
  meta: Parameters<typeof portholeClient>[0]["meta"],
  view: Record<string, unknown>,
) =>
  renderToString(
    createElement(
      PortholeProvider,
      {
        client: portholeClient({
          displays,
          ...(meta === undefined ? {} : { meta }),
          fetch: () => Promise.reject(new Error("no network on the server")),
        }),
      },
      createElement(PortholeView, {
        displayId: "abc",
        title: "A page",
        display: "artifact",
        ...view,
      }),
    ),
  );

describe("PortholeView on the server", () => {
  const served = { served: true, contentSource: SOURCE, frameSources: [SOURCE], health: null };
  const opaque = { served: false, contentSource: null, frameSources: [], health: null };

  it("draws the frame's placeholder from the meta it is given", () => {
    const html = render(served, { instance });
    expect(html).toContain('data-porthole-display="abc"');
    expect(html).toContain('data-porthole-state="waiting"');
  });

  it("draws the fallback where nothing can be shown", () => {
    expect(render(opaque, { instance })).toContain("data-porthole-fallback");
    expect(render(served, { display: "preview" })).toContain('data-porthole-display="abc"');
    expect(render(opaque, { display: "preview" })).toContain("This can&#x27;t be shown now");
  });

  it("draws `pending` while the meta isn't known", () => {
    const html = render(undefined, { instance, pending: createElement("p", null, "Loading") });
    expect(html).toMatch(/^<p>Loading<\/p>/u);
    expect(html).not.toContain("data-porthole-display");
  });
});

describe("a page published before 0.7", () => {
  it("is mounted with `declaration: null`, as MountOptions takes it (porthole#17)", () => {
    // The types: null is the host's word for a page with no declaration (P091 §10), no cast.
    const view = { displayId: "abc", title: "A page", display: "artifact", declaration: null };
    view satisfies PortholeViewProps;
    const legacy: PortholeFrameProps["declaration"] = null;
    const served = { served: true, contentSource: SOURCE, frameSources: [SOURCE], health: null };
    expect(render(served, { instance, declaration: legacy })).toContain(
      'data-porthole-display="abc"',
    );
  });
});

describe("trackedAnnotation and the handle (P118)", () => {
  const served = { served: true, contentSource: SOURCE, frameSources: [SOURCE], health: null };

  it("types: a mark's id or null, and a ref to exactly `clearSelection`", () => {
    expectTypeOf<PortholeFrameProps["trackedAnnotation"]>().toEqualTypeOf<
      string | null | undefined
    >();
    expectTypeOf<PortholeViewProps["trackedAnnotation"]>().toEqualTypeOf<
      string | null | undefined
    >();
    // The display's calls, never the display: one method, nothing more.
    expectTypeOf<keyof PortholeFrameHandle>().toEqualTypeOf<"clearSelection">();
    expectTypeOf<PortholeFrameHandle["clearSelection"]>().toEqualTypeOf<() => void>();
    const ref = createRef<PortholeFrameHandle>();
    ({ displayId: "a", title: "A", display: "artifact", ref }) satisfies PortholeViewProps;
    ({ config: presets.artifact(), displayId: "a", title: "A", ref }) satisfies PortholeFrameProps;
  });

  it("renders on the server with both, calling nothing (no display runs there)", () => {
    const ref = createRef<PortholeFrameHandle>();
    const html = render(served, { instance, trackedAnnotation: "c1", ref });
    expect(html).toContain('data-porthole-display="abc"');
    expect(html).toContain('data-porthole-state="waiting"');
    // No effects on the server: the handle is given only once the view is mounted in a browser.
    expect(ref.current).toBeNull();
    const frameRef = createRef<PortholeFrameHandle>();
    const frame = renderToString(
      createElement(PortholeFrame, {
        config: presets.artifact({ capabilities: { annotate: {} } }),
        displayId: "f",
        title: "F",
        trackedAnnotation: null,
        ref: frameRef,
      }),
    );
    expect(frame).toContain('data-porthole-display="f"');
    expect(frameRef.current).toBeNull();
  });
});

describe("<PortholeView address>'s fallback link (P125)", () => {
  it("offers the clean address as the tab link only on the served content domain", () => {
    const source = "https://*.usercontent.example.net";
    expect(tabLinkOf("https://a-abc.usercontent.example.net/v/1", source)).toBe(
      "https://a-abc.usercontent.example.net/v/1",
    );
    for (const address of [
      // Another site, another scheme or port, the bare domain, Porthole's own paths, no URL.
      "https://evil.example/",
      "http://a-abc.usercontent.example.net/",
      "https://a-abc.usercontent.example.net:8443/",
      "https://usercontent.example.net/",
      "https://a-abc.usercontent.example.net/__porthole/d/aaaaaaaaaaaaaaaa",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(tabLinkOf(address, source), address).toBeNull();
    }
    // Content not served (no source known): no link.
    expect(tabLinkOf("https://a-abc.usercontent.example.net/", null)).toBeNull();
    // A dev content domain over http on localhost: its own scheme and port.
    expect(tabLinkOf("http://a-1.content.localhost:8796/", "http://*.content.localhost:8796")).toBe(
      "http://a-1.content.localhost:8796/",
    );
  });
});
