import { expect, test, type Frame } from "@playwright/test";
import { presets, type LinkLabel } from "../src/index.ts";
import { referenceHost, type ReferenceDisplay } from "./reference-host.ts";

/**
 * Link labels (P151) in real frames, on Chromium, WebKit and Firefox: a bare link shows the host's
 * title, a link with words of its own keeps them and is tagged, another address is left alone,
 * malformed and oversized labels are dropped (the rest apply), bidirectional controls are taken
 * out, a link the page adds later is labelled, a new set gives links their own words back, a label
 * is text and never markup, and a new run forgets them.
 */

const config = () => presets.artifact({ capabilities: { linkLabels: {} } });

const A = "https://raft.example/artifacts/a";
const B = "https://raft.example/artifacts/b";
const C = "https://raft.example/artifacts/c";
const D = "https://raft.example/artifacts/d";
const OTHER = "https://elsewhere.example/page";

const PAGE = `<p><a id="bare" href="${A}">${A}</a></p>
<p><a id="spaced" href="${B}">
  ${B}
</a></p>
<p><a id="worded" href="${A}">our plan</a></p>
<p><a id="nested" href="${A}"><b>${A}</b></a></p>
<p><a id="other" href="${OTHER}">${OTHER}</a></p>
<p><a id="dropped" href="${C}">${C}</a></p>
<p><a id="last" href="${D}">${D}</a></p>`;

/** A link's words and its tag, as the frame has them. */
const linkOf = (frame: Frame, id: string) =>
  frame.evaluate((which) => {
    const link = document.getElementById(which);
    return {
      text: link?.textContent ?? null,
      tag: link?.getAttribute("data-porthole-label") ?? null,
      elements: link?.children.length ?? -1,
    };
  }, id);

/** A display showing PAGE, its last link drawn. */
async function launch(page: Parameters<typeof referenceHost.launch>[0]): Promise<{
  display: ReferenceDisplay;
  frame: Frame;
}> {
  const display = await referenceHost.launch(page, {
    config: config(),
    heightPx: 400,
    content: PAGE,
  });
  const frame = await display.frame();
  await expect(frame.locator("#last")).toBeAttached();
  return { display, frame };
}

test("link labels: a bare link shows its label, a link with words of its own keeps them and is tagged, another address is left alone; malformed labels are dropped and the rest apply; bidi controls are taken out (P151)", async ({
  page,
}) => {
  const { display, frame } = await launch(page);
  const labels: LinkLabel[] = [
    { href: A, text: "Q3 ‮plan‬", tag: "artifact" },
    { href: B, text: "Roadmap", tag: "Not A Tag" },
    // Too long, not an address, not http(s), not text: dropped whole.
    { href: C, text: "x".repeat(301) },
    { href: "not an address", text: "Nothing" },
    { href: "javascript:alert(1)", text: "Nothing" },
    { href: D, text: 42 as unknown as string },
  ];
  expect(await display.links(labels)).toBeNull();

  await expect
    .poll(() => linkOf(frame, "bare"), { message: "the bare link shows its label" })
    .toEqual({ text: "Q3 plan", tag: "artifact", elements: 0 });
  // White space around the address is still a bare link; a tag that isn't one is left out.
  expect(await linkOf(frame, "spaced")).toEqual({ text: "Roadmap", tag: null, elements: 0 });
  // Words of its own, or markup around the address: kept, tagged.
  expect(await linkOf(frame, "worded")).toEqual({ text: "our plan", tag: "artifact", elements: 0 });
  expect(await linkOf(frame, "nested")).toEqual({ text: A, tag: "artifact", elements: 1 });
  // Another address, and the dropped labels' links: as they were.
  expect(await linkOf(frame, "other")).toEqual({ text: OTHER, tag: null, elements: 0 });
  expect(await linkOf(frame, "dropped")).toEqual({ text: C, tag: null, elements: 0 });
  expect(await linkOf(frame, "last")).toEqual({ text: D, tag: null, elements: 0 });
  // Labels that aren't a list: the host's own error, nothing sent.
  expect(await display.links("no" as unknown as LinkLabel[])).toMatch(/a list/u);
  expect(await linkOf(frame, "bare")).toEqual({ text: "Q3 plan", tag: "artifact", elements: 0 });
});

test("link labels: a link the page adds later is labelled; a message from the page itself labels nothing (P151)", async ({
  page,
}) => {
  const { display, frame } = await launch(page);
  expect(await display.links([{ href: C, text: "Budget" }])).toBeNull();
  await expect.poll(() => linkOf(frame, "dropped")).toMatchObject({ text: "Budget" });
  await frame.evaluate((address) => {
    const link = document.createElement("a");
    link.id = "added";
    link.href = address;
    link.textContent = address;
    document.body.append(link);
  }, C);
  await expect
    .poll(() => linkOf(frame, "added"), { message: "the added link is labelled" })
    .toMatchObject({ text: "Budget" });

  // The shell takes labels only from its parent: the page's own message to its window does nothing.
  await frame.evaluate((address) => {
    window.postMessage(
      {
        jsonrpc: "2.0",
        method: "porthole/links.label",
        params: { labels: [{ href: address, text: "Forged" }] },
      },
      "*",
    );
  }, A);
  await page.waitForTimeout(1_500);
  expect(await linkOf(frame, "bare")).toMatchObject({ text: A });
});

test("link labels: a new label set gives the links it no longer labels their own words back, and none gives all of them back (P151)", async ({
  page,
}) => {
  const { display, frame } = await launch(page);
  expect(
    await display.links([
      { href: A, text: "Plan", tag: "artifact" },
      { href: D, text: "Notes" },
    ]),
  ).toBeNull();
  await expect.poll(() => linkOf(frame, "bare")).toMatchObject({ text: "Plan" });
  await expect.poll(() => linkOf(frame, "last")).toMatchObject({ text: "Notes" });

  // A new set: A keeps a new label, D's link has its address back.
  expect(await display.links([{ href: A, text: "Plan, v2" }])).toBeNull();
  await expect
    .poll(() => linkOf(frame, "last"), { message: "probe: D's link has its own words back" })
    .toEqual({ text: D, tag: null, elements: 0 });
  expect(await linkOf(frame, "bare"), "probe: A's link shows the new label").toEqual({
    text: "Plan, v2",
    tag: null,
    elements: 0,
  });

  // None: every link its own words back.
  expect(await display.links([])).toBeNull();
  await expect
    .poll(() => linkOf(frame, "bare"), { message: "probe: A's link has its own words back" })
    .toEqual({ text: A, tag: null, elements: 0 });
  expect(await linkOf(frame, "worded")).toEqual({ text: "our plan", tag: null, elements: 0 });
});

test("link labels: a label is text, never markup: its tags stay words and make no element (P151)", async ({
  page,
}) => {
  const { display, frame } = await launch(page);
  const markup = `<img src="x" onerror="document.documentElement.dataset.ran = '1'">Plan`;
  expect(await display.links([{ href: A, text: markup }])).toBeNull();
  await expect
    .poll(async () => (await linkOf(frame, "bare")).text !== A, {
      message: "the label reached the frame",
    })
    .toBe(true);
  await page.waitForTimeout(500);
  expect(await linkOf(frame, "bare"), "probe: the label is the link's words, as written").toEqual({
    text: markup,
    tag: null,
    elements: 0,
  });
  expect(
    await frame.evaluate(() => document.documentElement.dataset.ran ?? null),
    "probe: nothing of the label ran",
  ).toBeNull();
});

test("link labels: a new run forgets them: the page shows its links' addresses again until the host labels anew (P151)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { display, frame } = await launch(page);
  expect(await display.links([{ href: A, text: "Plan", tag: "artifact" }])).toBeNull();
  await expect.poll(() => linkOf(frame, "bare")).toMatchObject({ text: "Plan" });
  const initialized = async () =>
    (await display.events()).filter((event) => event.type === "initialized").length;
  const before = await initialized();

  await display.reload();
  await expect.poll(initialized, { message: "the new run's frame is ready" }).toBe(before + 1);
  const again = await display.frame();
  await expect(again.locator("#last")).toBeAttached();
  // Past the shell's settling (150 ms after the last change, at most a second).
  await page.waitForTimeout(1_500);
  expect(await linkOf(again, "bare"), "probe: the new run's link shows its address").toEqual({
    text: A,
    tag: null,
    elements: 0,
  });

  // Labelled anew: labelled again.
  expect(await display.links([{ href: A, text: "Plan" }])).toBeNull();
  await expect.poll(() => linkOf(again, "bare")).toMatchObject({ text: "Plan" });
});
