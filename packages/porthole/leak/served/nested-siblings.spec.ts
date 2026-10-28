import { expect, test } from "@playwright/test";
import type { PortholeConfig } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { harness } from "./harness.ts";
import { show, unique } from "./nested-pages.ts";
import { mount, outcomeOf } from "./porthole-host.ts";

/**
 * A nested page's shell beside other displays of its own scope (P114, porthole#56). Every other
 * domain-mode display of a scope (an inline widget, a live widget, an MCP app, an artifact that
 * isn't nested) runs agent-made content on the scope's origin with `allow-same-origin`. The shell
 * is served on a label of its own, so none of them is same-origin with it: none can read its
 * document (its state, the page's sealed files' address in it) or its child's address.
 *
 * The siblings look at every frame of the host's page from their own content, as a hostile one
 * would, and say what they saw over the console. Each one reading the other (they share the
 * scope's origin, as they should) is the positive control: a probe that reads nothing proves
 * nothing.
 */

test.use({ trace: "off" });

/** A sealed files' address: the page's bearer access (P083). */
const SEALED = /\/__porthole\/f\/[A-Za-z0-9_-]{40,}/u;

/** What a sibling sees of each other frame of the host's page. */
interface Look {
  readonly index: number;
  readonly sameOrigin: boolean;
  readonly title?: string;
  /** The frame holds a frame of its own (the shell's page). */
  readonly childFrame?: boolean;
  /** A sealed files' address (`/__porthole/f/<token>`) anywhere in the frame's document. */
  readonly sealed?: boolean;
  /** Its child's address, where it could be read. */
  readonly childHref?: string;
}

interface Report {
  readonly who: string;
  readonly frames: readonly Look[];
}

/** A sibling's content: it looks at every frame of its parent, once the others have loaded. */
const sibling = (who: string): string => `<p id="sibling">${who}</p>
<script>
  const look = () => {
    const frames = [];
    for (let index = 0; index < parent.frames.length; index += 1) {
      const other = parent.frames[index];
      if (other === window) continue;
      const each = { index, sameOrigin: false };
      try {
        const doc = other.document;
        each.sameOrigin = true;
        each.title = doc.title;
        each.childFrame = doc.querySelector("iframe") !== null;
        each.sealed = new RegExp("/__porthole/f/[A-Za-z0-9_-]{40,}").test(doc.documentElement.outerHTML);
      } catch (_) {}
      try {
        each.childHref = String(other.frames[0].location.href);
      } catch (_) {}
      frames.push(each);
    }
    console.log("__S " + JSON.stringify({ who: ${JSON.stringify(who)}, frames }));
  };
  let rounds = 0;
  const again = () => {
    look();
    rounds += 1;
    if (rounds < 6) setTimeout(again, 400);
  };
  again();
</script>`;

test.describe("a nested page's shell beside displays of its own scope (P114)", () => {
  test.setTimeout(90_000);

  test("[nested-siblings] a same-scope inline widget and artifact can't read the nested page's shell or reach its sealed address", async ({
    page,
  }) => {
    const served = await harness();
    const scope = unique("shared");
    const reports: Report[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("__S ")) {
        reports.push(JSON.parse(text.slice(4)) as Report);
      }
    });
    // The nested page first (the host page's first frame), then its scope's other displays.
    const nested = await show(page, "", undefined, {}, scope);
    const widget: InstanceRef = { scope, document: { kind: "shell", preset: "inlineWidget" } };
    const shownWidget = await mount(
      page,
      served.hostOrigin,
      served.configs.inlineWidget as PortholeConfig,
      await served.porthole.issue(widget, { viewer: "probe" }),
      widget,
      { content: sibling("widget") },
    );
    const id = unique("plain");
    served.pages.set(`${id}@1`, `<!doctype html><html><body>${sibling("artifact")}</body></html>`);
    const artifact: InstanceRef = {
      scope,
      document: { kind: "artifact", id, version: "1", preset: "artifact" },
    };
    const shownArtifact = await mount(
      page,
      served.hostOrigin,
      served.configs.artifact as PortholeConfig,
      await served.porthole.issue(artifact, { viewer: "probe" }),
      artifact,
    );
    expect(await outcomeOf(shownWidget.read)).toEqual({ state: "loaded" });
    expect(await outcomeOf(shownArtifact.read)).toEqual({ state: "loaded" });
    // The siblings share their scope's origin, as they should: each reads the other (the positive
    // control). The last rounds are taken once both have loaded.
    const latest = (who: string) => reports.filter((each) => each.who === who).at(-1);
    await expect
      .poll(
        () =>
          ["widget", "artifact"].every(
            (who) =>
              latest(who)?.frames.some(
                (each) => each.sameOrigin && each.title !== "Porthole" && !each.childFrame,
              ) === true,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect.poll(() => reports.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(12);
    const widgetOrigin = await (await shownWidget.frame()).evaluate(() => self.origin);
    expect(widgetOrigin, "the siblings are on the scope's origin").toBe(
      served.porthole.originFor(scope),
    );
    for (const report of reports) {
      const shell = report.frames.find((each) => each.index === 0);
      expect(shell, `${report.who} sees the nested page's frame`).toBeDefined();
      expect(
        shell?.sameOrigin,
        `probe: ${report.who}, on the scope's origin, can't read the nested page's shell`,
      ).toBe(false);
      for (const each of report.frames) {
        expect(
          each.title === "Porthole" || each.sealed === true,
          `probe: ${report.who} read no shell and no sealed address (frame ${each.index})`,
        ).toBe(false);
        expect(
          each.childHref ?? "",
          `probe: ${report.who} read no frame's page address (frame ${each.index})`,
        ).not.toMatch(SEALED);
      }
    }
    expect(new URL(nested.origin).origin, "the shell isn't on the scope's origin").not.toBe(
      served.porthole.originFor(scope),
    );
  });
});
