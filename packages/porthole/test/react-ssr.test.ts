import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defineDisplays, portholeClient } from "../src/index.ts";
import { PortholeProvider, PortholeView } from "../src/react/index.ts";

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
