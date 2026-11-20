import { expect, test, type Page } from "@playwright/test";
import { embedderCsp, presets } from "../src/index.ts";

/**
 * A frame's host is its parent, or that parent's opener (P154): the opener's words are heard only
 * from the plan's origins. A page outside them that opened the host's page (so it is that page's
 * `opener`) reaches the frame (`host.frames[0]`) and says a host's words to it; the shell takes
 * none of them.
 *
 * The frame is a bare shell (`app.bareShell()`): the shell's document, with find, framed by the
 * host's page with nothing of Porthole's listening, so only what a test posts can answer its
 * `ui/initialize` (a running display's host answers it at once, before any forged answer could).
 * What the shell says back to its page is kept (`app.bareSaid()`): `ui/notifications/initialized`
 * once a `ui/initialize` answer is taken, and an answer to a find query it took.
 *
 * Probes: `[opener.loads]` (the positive control: the same words from the frame's parent are
 * taken), `[opener.unheard]`. Negative control (leak/controls.ts): `opener-origins`, the shell's
 * and find's listeners without their origins check.
 */

interface App {
  bareShell(): void;
  bareSaid(): unknown[];
}

type Said = { readonly id?: unknown; readonly method?: unknown };

const port = () => new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:8797").port;

/** The host's page, as the React spec opens it: on 127.0.0.1, so its plan names that origin. */
const hostUrl = () =>
  `http://127.0.0.1:${port()}/leak/react/?csp=${encodeURIComponent(embedderCsp([presets.url({ contentOrigins: [`http://localhost:${port()}`] })]))}`;

/** Frames the bare shell and waits for its first `ui/initialize`: the id a host would answer. */
async function bareShell(host: Page): Promise<string> {
  await host.waitForFunction(() => "app" in window);
  await host.evaluate(() => (window as unknown as { app: App }).app.bareShell());
  await expect
    .poll(async () => (await saidBy(host)).find((each) => each.method === "ui/initialize")?.id)
    .toMatch(/^porthole-shell-/u);
  const asked = (await saidBy(host)).find((each) => each.method === "ui/initialize");
  return String(asked?.id);
}

const saidBy = async (host: Page): Promise<Said[]> =>
  (await host.evaluate(() => (window as unknown as { app: App }).app.bareSaid())) as Said[];

/** A host's words: the answer to the shell's `ui/initialize`, and a find query. */
const hostWords = (id: string) => [
  {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2026-01-26",
      hostInfo: { name: "forged", version: "1" },
      hostCapabilities: {},
      hostContext: {},
    },
  },
  { jsonrpc: "2.0", id: "forged-find", method: "porthole/find.query", params: { query: "needle" } },
];

/** Whether the shell took them: it said it initialized, or answered the find query. */
const took = (said: Said[]) => ({
  initialized: said.some((each) => each.method === "ui/notifications/initialized"),
  findAnswered: said.some((each) => each.id === "forged-find"),
});

test("[opener.loads] the frame's parent's words as a host's are taken: its answer initializes the shell, its find query is answered", async ({
  page,
}) => {
  await page.goto(hostUrl());
  const id = await bareShell(page);
  await page.evaluate((words) => {
    const frame = document.getElementById("bare-shell") as HTMLIFrameElement;
    for (const word of words) {
      frame.contentWindow?.postMessage(word, "*");
    }
  }, hostWords(id));
  await expect
    .poll(async () => took(await saidBy(page)))
    .toEqual({ initialized: true, findAnswered: true });
});

test("[opener.unheard] the words of an opener outside the plan's origins are dropped: no answer taken, no find query answered", async ({
  page,
}) => {
  // The outside page: this server under another name (localhost), another origin than the plan's.
  await page.goto(`http://localhost:${port()}/outside`);
  const [host] = await Promise.all([
    page.waitForEvent("popup"),
    page.evaluate((url) => {
      (window as unknown as { host: Window | null }).host = window.open(url, "host");
    }, hostUrl()),
  ]);
  const id = await bareShell(host);
  // It is the host page's opener, and reaches the frame.
  expect(await host.evaluate(() => window.opener !== null)).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as { host: Window }).host.frames.length),
  ).toBeGreaterThan(0);
  await page.evaluate((words) => {
    const frame = (window as unknown as { host: Window }).host.frames[0];
    for (const word of words) {
      frame?.postMessage(word, "*");
    }
  }, hostWords(id));
  // Time for the words to land and the shell to answer, as it does at once for its parent's.
  await page.waitForTimeout(1_000);
  expect(took(await saidBy(host)), "probe: the outside opener's words taken").toEqual({
    initialized: false,
    findAnswered: false,
  });
});
