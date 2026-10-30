import { expect, test, type Page } from "@playwright/test";
import type { PortholeConfig } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { storedFiles } from "./files.ts";
import { harness } from "./harness.ts";
import { unique } from "./nested-pages.ts";
import { mount, outcomeOf, type Mounted } from "./porthole-host.ts";

/**
 * A served display's word comes from a door no content of its scope can reach (P125). A served
 * display that isn't nested (a served shell, a page, a view through the sandbox proxy) is framed on
 * its scope's origin, where the scope's other displays run content with `allow-same-origin`. One of
 * them (A) reaches a new document of another's (B) before its first script runs, so nothing B's
 * frame says, and nothing its silence suggests, is Porthole's word: B's door said how loading went,
 * in a frame of the host's that A can't reach.
 *
 * A is a hostile served display of B's scope; B is honest. A wins the race for B's first word
 * deterministically: it wipes B's committing document (so B's own shell never runs) and, for the
 * status probes, writes one that posts a forged block. Each probe on Chromium (WebKit and Firefox
 * in CI, where the system libraries are). The negative controls (`content-status`, `door-status`,
 * `door-silence`, `door-opaque`) make each probe red, as the base was.
 */

const UNTRUSTED = {
  kind: "frame-status",
  message:
    "A frame status (porthole/notifications/frame-status) came from the frame's content, not from a page of Porthole's server: not taken (P124)",
};

/** A script, run in B's realm, that posts a forged block to the host as B's first word. */
const POST_BLOCKED = `parent.postMessage({ jsonrpc: "2.0", method: "porthole/notifications/frame-status", params: { state: "blocked", reason: "sign-in", status: 401, code: "phish" } }, "*");`;

/**
 * A hostile sibling's content: a tight MessageChannel loop (so it reads a sibling's new document in
 * the gap between its commit and its own shell's first script), doing `act` to each readable
 * same-origin frame that isn't itself. What it saw goes over the console (`__A`).
 */
const hostile = (act: string): string => `<p id="a">A</p><script>
  const seen = [];
  const act = (w, d) => { ${act} };
  const look = () => {
    for (let i = 0; i < parent.frames.length; i += 1) {
      const w = parent.frames[i];
      if (w === window) continue;
      let d = null;
      try { d = w.document; } catch (e) { seen.push({ i, read: "blocked: " + e.name }); continue; }
      try { act(w, d); } catch (e) { seen.push({ i, act: "threw: " + e.name }); }
    }
  };
  const channel = new MessageChannel();
  const started = Date.now();
  channel.port1.onmessage = () => { look(); if (Date.now() - started < 6000) channel.port2.postMessage(0); };
  channel.port2.postMessage(0);
  setInterval(() => { if (seen.length > 0) console.log("__A " + JSON.stringify(seen.splice(0))); }, 200);
</script>`;

/**
 * Wipe a readable sibling's loading document and write one that posts `source` (A's deterministic
 * first word: B's own shell never runs, so A's word is first, as a sibling that wins the commit
 * race is). B's honest content carries `#b`; A acts only on a fresh document, once.
 */
/**
 * Porthole's own door page, by its address (available at commit, before its body parses) or its
 * marker: never B's content (A must not wreck B's door while it reads a sibling mid-parse).
 */
const PORTHOLE_PAGE = `(d.querySelector("[data-porthole-door]") || (() => { try { return w.location.pathname.indexOf("/__porthole/door/") === 0; } catch (e) { return false; } })())`;

const wipePost = (source: string): string => `
  if (d.querySelector("#b") || d.querySelector("[data-a]") || ${PORTHOLE_PAGE}) return;
  d.open();
  d.write('<!doctype html><meta data-a><body><scr' + 'ipt>' + ${JSON.stringify(source)} + '</scr' + 'ipt>');
  d.close();
  seen.push({ i, wrote: true });
`;

/** Wipe a readable sibling's loading document and say nothing (its silence is the test). */
const wipeOnly = `
  if (d.querySelector("#b") || d.querySelector("[data-a]") || ${PORTHOLE_PAGE}) return;
  d.open();
  d.write("<!doctype html><meta data-a><p>wiped by A</p>");
  d.close();
  seen.push({ i, wiped: true });
`;

/** B's honest content: a marker so A (and the harness) can tell B's own document apart. */
const BENIGN = '<p id="b">B honest content</p>';

const shell = (scope: string): InstanceRef => ({
  scope,
  document: { kind: "shell", preset: "inlineWidget" },
});
const artifact = (scope: string, id: string): InstanceRef => ({
  scope,
  document: { kind: "artifact", id, version: "1", preset: "artifact" },
});

/** A config like `base`, but with a short load timeout, so a timeout verdict comes quickly. */
function presetWithTimeout(base: PortholeConfig): PortholeConfig {
  return { ...base, limits: { ...base.limits, loadTimeoutMs: 3_000 } };
}

/** Mounts A (hostile) then B (honest), same scope; returns B's handle. */
async function mountAthenB(
  page: Page,
  served: Awaited<ReturnType<typeof harness>>,
  scope: string,
  aContent: string,
  b: () => Promise<Mounted>,
): Promise<Mounted> {
  // A and B share one scope: the same origin, as a scope's displays do.
  const aInstance = shell(scope);
  const shownA = await mount(
    page,
    served.hostOrigin,
    served.configs.inlineWidget as PortholeConfig,
    await served.porthole.issue(aInstance, { viewer: "probe" }),
    aInstance,
    { content: aContent },
  );
  expect(await outcomeOf(shownA.read), "A loaded").toEqual({ state: "loaded" });
  return b();
}

/** A's console reports, parsed from the page (`__A`). */
function watchA(page: Page): unknown[] {
  const seen: unknown[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("__A ")) {
      for (const each of JSON.parse(text.slice(4)) as unknown[]) {
        seen.push(each);
      }
    }
  });
  return seen;
}

test.use({ trace: "off" });

test.describe("a served display's word comes from a door no sibling can reach (P125)", () => {
  test.setTimeout(60_000);

  test("[sibling-inject] a sibling that speaks first in B's frame moves nothing: B is never blocked, the host hears it", async ({
    page,
  }) => {
    const served = await harness();
    const scope = unique("inject");
    const bHandle = await mountAthenB(
      page,
      served,
      scope,
      hostile(wipePost(POST_BLOCKED)),
      async () => {
        const instance = shell(scope);
        return mount(
          page,
          served.hostOrigin,
          presetWithTimeout(served.configs.inlineWidget as PortholeConfig),
          await served.porthole.issue(instance, { viewer: "probe" }),
          instance,
          { content: BENIGN },
        );
      },
    );
    // The door already said B could be framed; A's word in B's frame is dropped (a frame-status
    // host error), and B's silence is a timeout, never a block.
    const outcome = await outcomeOf(bHandle.read, 8_000);
    expect(
      outcome.state !== "blocked",
      `probe: A's injected block moved nothing (${JSON.stringify(outcome)})`,
    ).toBe(true);
    await expect
      .poll(async () => (await bHandle.read()).hostErrors.length, {
        message: "probe: the host heard A's status, as a frame-status error",
      })
      .toBeGreaterThan(0);
    const record = await bHandle.read();
    expect(
      record.outcomes.some((each) => each.state === "blocked"),
      "probe: B was never blocked by A",
    ).toBe(false);
    expect(
      record.hostErrors,
      "probe: the host heard A's status, as a frame-status error",
    ).toContainEqual(UNTRUSTED);
  });

  test("[sibling-reload] a sibling that reloads a loaded B and speaks first in the new run moves nothing", async ({
    page,
  }) => {
    const served = await harness();
    const scope = unique("reload");
    // A lets B's first document load, then reloads B and speaks first in the new run (wipes it,
    // posts a block). B's shell renders #b only after its handshake, so A counts B's documents on
    // the shared scope origin instead: the first it lets load, the second it wipes.
    const act = `
      if (d.querySelector("[data-a]") || ${PORTHOLE_PAGE}) return;
      const m = d.createElement("meta"); m.setAttribute("data-a", "");
      (d.head || d.documentElement).appendChild(m);
      const n = Number(localStorage.getItem("docs") || "0") + 1;
      localStorage.setItem("docs", String(n));
      if (n === 1) { setTimeout(() => { try { w.location.reload(); } catch (e) {} }, 500); seen.push({ i, run: 1 }); return; }
      d.open();
      d.write('<!doctype html><body><scr' + 'ipt>' + ${JSON.stringify(POST_BLOCKED)} + '</scr' + 'ipt>');
      d.close();
      seen.push({ i, run: n, wrote: true });
    `;
    const bHandle = await mountAthenB(page, served, scope, hostile(act), async () => {
      const instance = shell(scope);
      return mount(
        page,
        served.hostOrigin,
        presetWithTimeout(served.configs.inlineWidget as PortholeConfig),
        await served.porthole.issue(instance, { viewer: "probe" }),
        instance,
        { content: BENIGN },
      );
    });
    expect(await outcomeOf(bHandle.read), "probe: B's first run loaded").toEqual({
      state: "loaded",
    });
    await page.waitForTimeout(3_000);
    const record = await bHandle.read();
    expect(
      record.outcomes.some((each) => each.state === "blocked"),
      `probe: no run of B was blocked by A (${JSON.stringify(record.outcomes)})`,
    ).toBe(false);
  });

  test("[sibling-stop] a sibling that stops B's first document never makes it blocked: a timeout at worst", async ({
    page,
  }) => {
    const served = await harness();
    const scope = unique("stop");
    const act = `if (!d.querySelector("#b") && !d.querySelector("[data-a]")) { const m = d.createElement("meta"); m.setAttribute("data-a", ""); d.documentElement.appendChild(m); try { w.stop(); } catch (e) {} seen.push({ i, stopped: true }); }`;
    const bHandle = await mountAthenB(page, served, scope, hostile(act), async () => {
      const instance = shell(scope);
      return mount(
        page,
        served.hostOrigin,
        presetWithTimeout(served.configs.inlineWidget as PortholeConfig),
        await served.porthole.issue(instance, { viewer: "probe" }),
        instance,
        { content: BENIGN },
      );
    });
    const outcome = await outcomeOf(bHandle.read, 8_000);
    expect(
      outcome.state === "loaded" || outcome.state === "timeout",
      `probe: B loaded or timed out, never blocked (${JSON.stringify(outcome)})`,
    ).toBe(true);
  });

  test("[sibling-wipe] a sibling that wipes B's first document never makes it blocked (framing): a timeout", async ({
    page,
  }) => {
    const served = await harness();
    const scope = unique("wipe");
    const bHandle = await mountAthenB(page, served, scope, hostile(wipeOnly), async () => {
      const instance = shell(scope);
      return mount(
        page,
        served.hostOrigin,
        presetWithTimeout(served.configs.inlineWidget as PortholeConfig),
        await served.porthole.issue(instance, { viewer: "probe" }),
        instance,
        { content: BENIGN },
      );
    });
    const outcome = await outcomeOf(bHandle.read, 8_000);
    expect(
      outcome.state === "loaded" || outcome.state === "timeout",
      `probe: B never blocked, never framing (${JSON.stringify(outcome)})`,
    ).toBe(true);
    const record = await bHandle.read();
    expect(
      record.outcomes.some((each) => each.state === "blocked"),
      "probe: B's silence never read as a block (framing)",
    ).toBe(false);
  });

  test("[proxy] a sibling can't forge a block or framing against a sandbox-proxy view", async ({
    page,
  }) => {
    const served = await harness();
    const scope = unique("proxy");
    const bHandle = await mountAthenB(
      page,
      served,
      scope,
      hostile(wipePost(POST_BLOCKED)),
      async () => {
        const instance: InstanceRef = { scope, document: { kind: "mcp-proxy" } };
        return mount(
          page,
          served.hostOrigin,
          presetWithTimeout(served.configs.mcpApp as PortholeConfig),
          await served.porthole.issue(instance, { viewer: "probe" }),
          instance,
        );
      },
    );
    const outcome = await outcomeOf(bHandle.read, 8_000);
    expect(
      outcome.state !== "blocked",
      `probe: the proxy view was never blocked by a sibling (${JSON.stringify(outcome)})`,
    ).toBe(true);
  });

  test("[entry] a file set whose entry isn't a page is blocked (not-found) by the door, not framing", async ({
    page,
  }) => {
    const served = await harness();
    const scope = unique("entry");
    const id = unique("notpage");
    // Stored before P125's entry check (the host's publish refuses it now): the door says not-found.
    served.fileSets.set(
      `${id}@1`,
      storedFiles(
        { "note.txt": "not a page", "index.html": "<p>unused</p>" },
        { entry: "note.txt" },
      ),
    );
    const instance = artifact(scope, id);
    const bHandle = await mount(
      page,
      served.hostOrigin,
      served.configs.artifact as PortholeConfig,
      await served.porthole.issue(instance, { viewer: "probe" }),
      instance,
    );
    expect(await outcomeOf(bHandle.read), "probe: the door said not-found, never framing").toEqual({
      state: "blocked",
      reason: "not-found",
      status: 404,
    });
  });

  test("[door-reach] a sibling can't read or navigate B's door; a fake open/blocked from it moves nothing", async ({
    page,
  }) => {
    const served = await harness();
    const scope = unique("reach");
    const id = unique("reachpage");
    served.pages.set(`${id}@1`, `<!doctype html><html><body>${BENIGN}</body></html>`);
    const instance = artifact(scope, id);
    const location = await served.porthole.issue(instance, { viewer: "probe" });
    // B's door loads but says nothing, so its frame lingers (until the host frames B after
    // SETTLE_MS) while A tries to reach it. Silenced by B's own door key, so A's door is
    // unaffected. A can read or navigate the door only if it isn't opaque (the wall is gone).
    // Under P125 the door is opaque: A can't read it, can't navigate it, and a fake open/blocked
    // from A's own realm (source: A) is dropped by the transport.
    served.silentDoors.add(new URL(location.door?.url ?? "").pathname.split("/").at(-1) ?? "");
    const reaches = watchA(page);
    const act = `
      const isDoor = (() => { try { return !!d.querySelector("[data-porthole-door]") || w.location.pathname.indexOf("/__porthole/door/") === 0; } catch (e) { return false; } })();
      if (isDoor) {
        seen.push({ i, reachedDoor: true });
        try { d.open(); d.write("<p>A wiped the door</p>"); d.close(); } catch (e) {}
        try { w.location = "about:blank"; } catch (e) {}
      }
      try { parent.postMessage({ jsonrpc: "2.0", method: "porthole/notifications/frame-status", params: { state: "open" } }, "*"); } catch (e) {}
      try { parent.postMessage({ jsonrpc: "2.0", method: "porthole/notifications/frame-status", params: { state: "blocked", reason: "sign-in", status: 401, code: "phish" } }, "*"); } catch (e) {}
    `;
    const bHandle = await mountAthenB(page, served, scope, hostile(act), async () =>
      mount(
        page,
        served.hostOrigin,
        presetWithTimeout(served.configs.artifact as PortholeConfig),
        location,
        instance,
      ),
    );
    // B's silent door makes it framing (the door said nothing), never A's forged sign-in; and A
    // never read the door.
    const outcome = await outcomeOf(bHandle.read, 10_000);
    expect(
      outcome.state !== "blocked" || outcome.reason !== "sign-in",
      `probe: A's fake door word moved nothing (${JSON.stringify(outcome)})`,
    ).toBe(true);
    expect(
      reaches.some((each) => (each as { reachedDoor?: unknown }).reachedDoor === true),
      "probe: A read no door of B's (it is opaque)",
    ).toBe(false);
  });

  test("[door-sw] a same-scope sibling's service worker on the scope origin doesn't disturb B's door", async ({
    page,
  }) => {
    const served = await harness();
    const scope = unique("sw");
    const act = `
      if (!window.__sw) {
        window.__sw = true;
        try {
          navigator.serviceWorker.register("/sw.js").then(
            () => console.log("__A " + JSON.stringify([{ sw: "registered" }])),
            (e) => console.log("__A " + JSON.stringify([{ sw: "failed: " + e.name }]))
          );
        } catch (e) { console.log("__A " + JSON.stringify([{ sw: "threw: " + e.name }])); }
      }
    `;
    const swLog = watchA(page);
    const bHandle = await mountAthenB(page, served, scope, hostile(act), async () => {
      const instance = shell(scope);
      return mount(
        page,
        served.hostOrigin,
        served.configs.inlineWidget as PortholeConfig,
        await served.porthole.issue(instance, { viewer: "probe" }),
        instance,
        { content: BENIGN },
      );
    });
    expect(await outcomeOf(bHandle.read), "probe: B's door opened and B loaded").toEqual({
      state: "loaded",
    });
    // What happened to the registration is recorded: serveFile 403s a SW script and the content
    // CSP's worker-src is blob:, so it fails anyway. B is unaffected either way.
    await page.waitForTimeout(400);
    const sw = swLog.filter((each) => (each as { sw?: unknown }).sw !== undefined) as {
      sw: string;
    }[];
    expect(
      sw.every((each) => each.sw.startsWith("failed") || each.sw.startsWith("threw")),
      `probe: a SW on the scope origin didn't register; B unaffected (${JSON.stringify(sw)})`,
    ).toBe(true);
  });

  test("[busy] a busy sibling while B's door loads causes no false framing", async ({ page }) => {
    const served = await harness();
    const scope = unique("busy");
    const bHandle = await mountAthenB(
      page,
      served,
      scope,
      '<p id="a">A</p><script>const end = Date.now() + 1200; while (Date.now() < end) {}</script>',
      async () => {
        const instance = shell(scope);
        return mount(
          page,
          served.hostOrigin,
          served.configs.inlineWidget as PortholeConfig,
          await served.porthole.issue(instance, { viewer: "probe" }),
          instance,
          { content: BENIGN },
        );
      },
    );
    expect(
      await outcomeOf(bHandle.read, 12_000),
      "probe: no false framing while a sibling churns",
    ).toEqual({ state: "loaded" });
  });

  test("[nested-sibling] a nested display beside a hostile sibling is unaffected (control)", async ({
    page,
  }) => {
    const served = await harness();
    const scope = unique("nested");
    const id = unique("nestedpage");
    served.fileSets.set(
      `${id}@1`,
      storedFiles({ "index.html": "<!doctype html><html><body><p id=b>nested</p></body></html>" }),
    );
    const bHandle = await mountAthenB(
      page,
      served,
      scope,
      hostile(wipePost(POST_BLOCKED)),
      async () => {
        const instance: InstanceRef = {
          scope,
          document: { kind: "artifact", id, version: "1", preset: "artifactNested" },
        };
        return mount(
          page,
          served.hostOrigin,
          served.configs.artifactNested as PortholeConfig,
          await served.porthole.issue(instance, { viewer: "probe" }),
          instance,
          {
            runtime: {
              key: scope,
              scope,
              artifact: id,
              declaration: { capabilities: {}, runtime: "1" },
              viewer: { level: "interact", id: "ada", name: "Ada" },
            },
          },
        );
      },
    );
    expect(await outcomeOf(bHandle.read), "probe: the nested display loaded, untouched").toEqual({
      state: "loaded",
    });
  });
});
