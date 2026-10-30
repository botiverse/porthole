import { expect, test, type Browser, type Page } from "@playwright/test";
import type { PortholeConfig } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { MEASURED_SKIP } from "../controls.ts";
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
const hostile = (act: string, forMs = 6000): string => `<p id="a">A</p><script>
  const seen = [];
  const firstSight = new WeakSet();
  const act = (w, d, i) => { ${act} };
  const look = () => {
    for (let i = 0; i < parent.frames.length; i += 1) {
      const w = parent.frames[i];
      if (w === window) continue;
      let d = null;
      try { d = w.document; } catch (e) {
        if (!firstSight.has(w)) { firstSight.add(w); seen.push({ i, first: "unreadable", at: Date.now() - started }); }
        continue;
      }
      if (!firstSight.has(w)) {
        firstSight.add(w);
        let path = null;
        try { path = w.location.pathname; } catch (e) {}
        seen.push({ i, first: { readyState: d.readyState, hasB: !!d.querySelector("#b"), scripts: d.scripts.length, path }, at: Date.now() - started });
      }
      try { act(w, d, i); } catch (e) { seen.push({ i, act: "threw: " + e.name + ": " + e.message }); }
    }
  };
  const channel = new MessageChannel();
  const started = Date.now();
  channel.port1.onmessage = () => { look(); if (Date.now() - started < ${forMs}) channel.port2.postMessage(0); };
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
  const at = d.readyState;
  d.open();
  d.write('<!doctype html><meta data-a><body><scr' + 'ipt>' + ${JSON.stringify(source)} + '</scr' + 'ipt>');
  d.close();
  seen.push({ i, wrote: true, at });
`;

/** Wipe a readable sibling's loading document and say nothing (its silence is the test). */
const wipeOnly = `
  if (d.querySelector("#b") || d.querySelector("[data-a]") || ${PORTHOLE_PAGE}) return;
  const at = d.readyState;
  d.open();
  d.write("<!doctype html><meta data-a><p>wiped by A</p>");
  d.close();
  seen.push({ i, wiped: true, at });
`;

/**
 * An outcome only a sibling's word could have caused: A's forged block (`code: "phish"`), or a
 * `sign-in` or `framing` block (a served display's are its door's alone, P125). A sibling may still
 * cost B its run (wiped, restarted until its restarts run out: `blocked: error`, a timeout); that
 * is S7's cost of sharing a scope, never A's word.
 */
const forged = (outcome: {
  readonly state: string;
  readonly reason?: string;
  readonly code?: string;
}) =>
  outcome.state === "blocked" &&
  (outcome.code === "phish" || outcome.reason === "sign-in" || outcome.reason === "framing");

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

/**
 * The positive control of a probe whose attack is A writing into B's document: A did (`done`, one
 * of what A reports when it acted: `wrote`, `wiped`, `spokeFirst`). Then the probe is judged as on
 * every engine. Where the engine refused every write A tried in this run (each threw: on WebKit,
 * most runs), the attack didn't happen: the probe skips with that measurement, never passes, and
 * its controls take the skip as held there (`measured`, leak/controls.ts; P096, P125's review). A
 * that neither acted nor was refused never reached B: that fails. Retest with each engine version.
 */
async function requireReach(
  said: unknown[],
  done: readonly string[],
  browser: Browser,
): Promise<void> {
  // A reports over the console every 200 ms.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const reports = said as Record<string, unknown>[];
  const acted = reports.filter((each) => done.some((key) => each[key] !== undefined));
  // The attack is A's word before B's own: a write into a document that had already loaded (its
  // shell had run and spoken) lands too late to be one.
  if (acted.some((each) => each.at !== "complete")) {
    return;
  }
  const refused = reports.filter((each) => typeof each.act === "string");
  test.skip(
    refused.length + acted.length > 0,
    `${MEASURED_SKIP} on ${browser.browserType().name()} ${browser.version()} (measured): ` +
      `A's attack on B's loading document never landed: ${refused.length} tr${refused.length === 1 ? "y" : "ies"} threw, ` +
      `${acted.length} only after B's document had loaded (${JSON.stringify([...refused, ...acted].slice(0, 2))}); ` +
      "retest with each engine version",
  );
  throw new Error(`positive control: A never reached B\nA saw: ${JSON.stringify(said)}`);
}

test.use({ trace: "off" });

test.describe("a served display's word comes from a door no sibling can reach (P125)", () => {
  test.setTimeout(60_000);

  test("[sibling-inject] a sibling that speaks first in B's frame moves nothing: B is never blocked, the host hears it", async ({
    page,
    browser,
  }) => {
    const served = await harness();
    const scope = unique("inject");
    const said = watchA(page);
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
    await requireReach(said, ["wrote"], browser);
    await expect
      .poll(async () => (await bHandle.read()).hostErrors.length, {
        message: "probe: the host heard A's status, as a frame-status error",
      })
      .toBeGreaterThan(0)
      .catch((error: Error) => {
        // The positive control: did A reach B at all? What A saw first of each frame says why not.
        throw new Error(`${error.message}\nA saw: ${JSON.stringify(said)}`);
      });
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
    browser,
  }) => {
    // After Ferryman's probe (the audit of P125): honest B loads; hostile A, of B's scope, mounted
    // after, puts `location.reload()` into B (a reload passes the shell's guard, and the host starts
    // B again, P031, through a new door and a new frame). In the new run A acts on B's first
    // readable document: it wipes it and writes one that posts a block, its first word. A also sends
    // every window it can't read (the new door) to a page that speaks a block.
    const served = await harness();
    const scope = unique("reload");
    const id = unique("reloadpage");
    served.pages.set(`${id}@1`, `<!doctype html><html><body>${BENIGN}</body></html>`);
    const instance = artifact(scope, id);
    const bHandle = await mount(
      page,
      served.hostOrigin,
      presetWithTimeout(served.configs.artifact as PortholeConfig),
      await served.porthole.issue(instance, { viewer: "probe" }),
      instance,
    );
    expect(await outcomeOf(bHandle.read), "B's first run loaded").toEqual({ state: "loaded" });
    const said = watchA(page);
    const act = `
      if (window.__kicked === undefined) { window.__kicked = new Set(); window.__done = new Set(); }
      if (window.__done.has(w) || ${PORTHOLE_PAGE}) return;
      if (d.readyState === "complete" && !window.__kicked.has(w) && window.__kicked.size < 3) {
        window.__kicked.add(w);
        const s = d.createElement("script"); s.textContent = "location.reload()";
        (d.documentElement || d).appendChild(s);
        seen.push({ i, kicked: true });
        return;
      }
      if (window.__kicked.has(w)) return;
      window.__done.add(w);
      const at = d.readyState;
      d.open();
      d.write("<!doctype html><body><scr" + "ipt>" + ${JSON.stringify(POST_BLOCKED)} + "</scr" + "ipt>");
      d.close();
      seen.push({ i, spokeFirst: at, at });
    `;
    const aInstance = shell(scope);
    const shownA = await mount(
      page,
      served.hostOrigin,
      served.configs.inlineWidget as PortholeConfig,
      await served.porthole.issue(aInstance, { viewer: "probe" }),
      aInstance,
      { content: hostile(act, 15_000) },
    );
    expect(await outcomeOf(shownA.read), "A loaded").toEqual({ state: "loaded" });
    // A restart happened (the positive control), and A spoke first in a new run of B's.
    await expect
      .poll(async () => (await bHandle.read()).outcomes.length, {
        message: "A's reload started B again",
        timeout: 15_000,
      })
      .toBeGreaterThan(1);
    await expect
      .poll(
        () => said.some((each) => (each as { spokeFirst?: unknown }).spokeFirst !== undefined),
        {
          message: "A spoke first in a new run of B's",
          timeout: 15_000,
        },
      )
      .toBe(true)
      .catch(async (error: Error) => {
        await requireReach(said, ["spokeFirst"], browser);
        throw error;
      });
    await page.waitForTimeout(4_000);
    const record = await bHandle.read();
    expect(
      record.outcomes.filter(forged),
      `probe: no run of B was blocked by A's word (${JSON.stringify(record.outcomes)})`,
    ).toEqual([]);
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
    browser,
  }) => {
    const served = await harness();
    const scope = unique("wipe");
    const said = watchA(page);
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
    await requireReach(said, ["wiped"], browser);
    const record = await bHandle.read();
    expect(
      record.outcomes.some((each) => each.state === "blocked"),
      "probe: B's silence never read as a block (framing)",
    ).toBe(false);
  });

  test("[proxy] a sibling can't forge a block or framing against a sandbox-proxy view", async ({
    page,
    browser,
  }) => {
    const served = await harness();
    const scope = unique("proxy");
    const said = watchA(page);
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
    // Every display ends with an outcome (P125): loaded, or one the host can draw a fallback for.
    await expect
      .poll(async () => (await bHandle.read()).outcomes.length, { timeout: 8_000 })
      .toBeGreaterThan(0)
      .catch(async (error: Error) => {
        const record = await bHandle.read();
        throw new Error(
          `${error.message}\nB: ${JSON.stringify({ outcomes: record.outcomes, hostErrors: record.hostErrors })}\nA saw: ${JSON.stringify(said)}`,
        );
      });
    await requireReach(said, ["wrote"], browser);
    const { outcomes } = await bHandle.read();
    expect(
      outcomes.filter(forged),
      `probe: the proxy view was never blocked by a sibling's word (${JSON.stringify(outcomes)})`,
    ).toEqual([]);
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
    const opened: string[] = [];
    page.context().on("page", (each) => opened.push(each.url()));
    // A knows the door's address here (the worst case: the door has no name to target, so
    // knowing where it is must not be enough) and tries, once each, a window.open into a guessed
    // name and a form submitted into one, as well as an empty name.
    const doorUrl = location.door?.url ?? "";
    const act = `
      const isDoor = (() => { try { return !!d.querySelector("[data-porthole-door]") || w.location.pathname.indexOf("/__porthole/door/") === 0; } catch (e) { return false; } })();
      if (isDoor && !window.__doorDone) {
        // Readable only if the door isn't opaque (\`door-opaque\`): A rewrites it into Porthole's
        // own status page for that door (a used ticket), which then says blocked: session from
        // the door's own window (Ferryman's probe). Under P125 A never gets here.
        window.__doorDone = true;
        seen.push({ i, reachedDoor: true });
        try {
          const at = w.location.pathname + "?ticket=nope";
          d.open(); d.write('<meta http-equiv="refresh" content="0;url=' + at + '">'); d.close();
        } catch (e) { seen.push({ i, rewrite: "threw: " + e.name }); }
      }
      try { parent.postMessage({ jsonrpc: "2.0", method: "porthole/notifications/frame-status", params: { state: "open" } }, "*"); } catch (e) {}
      try { parent.postMessage({ jsonrpc: "2.0", method: "porthole/notifications/frame-status", params: { state: "blocked", reason: "sign-in", status: 401, code: "phish" } }, "*"); } catch (e) {}
    `;
    const target = `<script>
      let tries = 0;
      const forged = "data:text/html," + encodeURIComponent("<scr" + "ipt>" + ${JSON.stringify(POST_BLOCKED)} + "</scr" + "ipt>");
      const navigated = new Set();
      const tryAll = () => {
        // By reference: every window A can't read (B's door while it lingers) sent to a page that
        // speaks a block, once each. A's own sandbox stops it navigating a frame not its own.
        for (let i = 0; i < top.length; i += 1) {
          const w = top[i];
          if (w === window || navigated.has(w)) continue;
          let readable = true;
          try { void w.document.readyState; } catch (e) { readable = false; }
          if (readable) continue;
          navigated.add(w);
          const r = { nav: i };
          try { w.location.href = forged; r.href = "no throw"; } catch (e) { r.href = e.name; }
          try { w.location.replace(forged); r.replace = "no throw"; } catch (e) { r.replace = e.name; }
          console.log("__A " + JSON.stringify([r]));
        }
        for (const name of ["porthole-door", "door", ""]) {
          let got;
          try { got = window.open(${JSON.stringify(doorUrl)}, name) !== null; } catch (e) { got = "threw: " + e.name; }
          let submitted;
          try {
            const form = document.createElement("form");
            form.method = "GET";
            form.action = ${JSON.stringify(doorUrl)};
            form.target = name || "_blank";
            document.body.append(form);
            form.submit();
            form.remove();
            submitted = true;
          } catch (e) { submitted = "threw: " + e.name; }
          if (tries === 0) console.log("__A " + JSON.stringify([{ open: name, got }, { form: name, submitted }]));
        }
        if ((tries += 1) < 30) setTimeout(tryAll, 200);
      };
      tryAll();
    </script>`;
    const bHandle = await mountAthenB(page, served, scope, hostile(act) + target, async () =>
      mount(
        page,
        served.hostOrigin,
        presetWithTimeout(served.configs.artifact as PortholeConfig),
        location,
        instance,
      ),
    );
    // B's silent door makes it framing (the door said nothing): never A's forged sign-in, and
    // never another word from a door A replaced (its ticket is used, so a replaced door would say
    // `session`); and A never read the door, and opened no window.
    const outcome = await outcomeOf(bHandle.read, 10_000);
    expect(
      outcome,
      `probe: B's door stayed its own (its silence), not replaced or spoken for by A (${JSON.stringify(outcome)})`,
    ).toEqual({ state: "blocked", reason: "framing" });
    await page.waitForTimeout(400);
    expect(
      reaches.filter((each) => "open" in (each as object) || "form" in (each as object)),
      "A tried window.open and a form into each guessed name",
    ).toHaveLength(6);
    expect(opened, "probe: A's window.open and form submits opened no window").toEqual([]);
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
