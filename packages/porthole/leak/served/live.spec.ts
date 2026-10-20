import { expect, test, type Frame, type Page } from "@playwright/test";
import { httpOracle, settle, udpOracle } from "../../src/conformance/oracles.ts";
import { VENDORED_LIBRARIES, libraryPath, type PortholeConfig } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { harness } from "./harness.ts";
import { mount, type Mounted } from "./porthole-host.ts";

/**
 * A live widget in a real browser (P079): served on its own origin under the live widget preset,
 * on a host page that sends Porthole's embedder CSP and serves it data. It has no network of its
 * own (fetch, beacons, WebSocket, EventSource, images and scripts from anywhere else are refused,
 * and an oracle hears nothing), no WebRTC (no constructor, no STUN reaches a UDP oracle), and can't
 * navigate itself away, to an outside site or to another content origin (no request leaves). Its
 * scripts load from Porthole's own libraries on its origin, and its data comes from the host,
 * behind the viewer's consent.
 */

let scope = 0;
const liveInstance = (): InstanceRef => ({
  scope: `live-${process.pid}-${(scope += 1)}`,
  document: { kind: "shell", preset: "liveWidget" },
});

/** Mounts a live widget with `content`, served live data by the host page, and gives its frame. */
async function showLive(
  page: Page,
  content: string,
  live: true | "refused" = true,
): Promise<{ frame: Frame; origin: string; shown: Mounted }> {
  const served = await harness();
  const instance = liveInstance();
  const location = await served.porthole.issue(instance, { viewer: "probe" });
  const shown = await mount(
    page,
    served.hostOrigin,
    liveConfig(served.configs.liveWidget),
    location,
    instance,
    { content, live },
  );
  // A display started again has no frame for a moment: a look to repeat, so a frame that never
  // settles on its origin fails this poll by its assertion (P096: under navigate-guard, WebKit's
  // restart threw here instead).
  const seen: { frame?: Frame | null } = {};
  await expect
    .poll(
      async () => {
        seen.frame = await shown.frame().catch(() => null);
        return seen.frame?.url() ?? "";
      },
      { timeout: 10_000 },
    )
    .toContain(location.origin);
  const frame = seen.frame ?? (await shown.frame());
  await frame.waitForLoadState("load");
  return { frame, origin: location.origin, shown };
}

/** What the probe content recorded, once it says it is done. */
async function probed(frame: Frame, timeout = 20_000): Promise<Record<string, unknown>> {
  await expect
    .poll(() => frame.evaluate(() => document.documentElement.dataset.done ?? ""), { timeout })
    .toBe("1");
  return frame.evaluate(() => (window as unknown as { probe: Record<string, unknown> }).probe);
}

const js = (value: unknown): string => JSON.stringify(value);

function liveConfig(config: PortholeConfig | undefined): PortholeConfig {
  if (config === undefined) {
    throw new Error("the harness serves no liveWidget config");
  }
  return config;
}

test.describe("a live widget (P079)", () => {
  test("has no network of its own, no WebRTC, and loads Porthole's libraries", async ({ page }) => {
    const canary = await httpOracle();
    const udp = await udpOracle();
    const c = canary.origin;
    const scripts = VENDORED_LIBRARIES.map(
      (library) => `<script src="${libraryPath(library)}"></script>`,
    ).join("\n");
    const { frame } = await showLive(
      page,
      `${scripts}
<script src="${c}/external.js?d=secret"></script>
<link rel="stylesheet" href="${c}/style.css?d=secret">
<canvas id="chart" width="240" height="120"></canvas>
<script>
(async () => {
  const C = ${js(c)};
  const r = {};
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const outcome = (promise) => Promise.race([promise.then(() => "ok", (e) => "refused " + (e && e.name)), wait(1500).then(() => "timeout")]);
  r.chart = typeof Chart;
  r.d3 = typeof d3 === "object" ? typeof d3.scaleLinear : "absent";
  try {
    new Chart(document.getElementById("chart"), { type: "bar", data: { labels: ["a", "b"], datasets: [{ data: [1, 2] }] }, options: { animation: false, responsive: false } });
    r.drew = "drew";
  } catch (e) { r.drew = String(e); }
  r.externalScript = typeof __portholeOracleScript;
  r.fetch = await outcome(fetch(C + "/fetch?d=secret"));
  r.fetchNoCors = await outcome(fetch(C + "/fetch-no-cors?d=secret", { mode: "no-cors" }));
  r.xhr = await new Promise((resolve) => { try { const x = new XMLHttpRequest(); x.open("GET", C + "/xhr?d=secret"); x.onload = () => resolve("load"); x.onerror = () => resolve("error"); x.send(); } catch (e) { resolve("threw " + e.name); } setTimeout(() => resolve("timeout"), 1500); });
  try { r.beacon = navigator.sendBeacon(C + "/beacon?d=secret", "secret"); } catch (e) { r.beacon = "threw " + e.name; }
  r.ws = await new Promise((resolve) => { try { const ws = new WebSocket(C.replace("http", "ws") + "/ws?d=secret"); ws.onopen = () => resolve("open"); ws.onerror = () => resolve("error"); } catch (e) { resolve("threw " + e.name); } setTimeout(() => resolve("timeout"), 1500); });
  r.eventSource = await new Promise((resolve) => { try { const es = new EventSource(C + "/es?d=secret"); es.onopen = () => resolve("open"); es.onerror = () => { es.close(); resolve("error"); }; } catch (e) { resolve("threw " + e.name); } setTimeout(() => resolve("timeout"), 1500); });
  r.img = await new Promise((resolve) => { const img = new Image(); img.onload = () => resolve("load"); img.onerror = () => resolve("error"); img.src = C + "/img.png?d=secret"; setTimeout(() => resolve("timeout"), 1500); });
  r.cssImage = await new Promise((resolve) => { const box = document.createElement("div"); box.style.cssText = "width:10px;height:10px;background:url(" + C + "/bg.png?d=secret)"; document.body.append(box); setTimeout(() => resolve("tried"), 800); });
  r.rtc = [typeof RTCPeerConnection, typeof webkitRTCPeerConnection, typeof RTCDataChannel].join(",");
  try {
    const Peer = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    const peer = new Peer({ iceServers: [{ urls: ${js(udp.stun)} }], iceCandidatePoolSize: 4 });
    peer.createDataChannel("x");
    await peer.setLocalDescription(await peer.createOffer());
    r.peer = "made";
  } catch (e) { r.peer = "threw " + e.name; }
  // A fresh realm would have its own constructors: no frame of its own survives.
  const child = document.createElement("iframe");
  document.body.append(child);
  r.child = child.isConnected ? (child.contentWindow ? typeof child.contentWindow.RTCPeerConnection : "no window") : "removed";
  await wait(1500);
  window.probe = r;
  document.documentElement.dataset.done = "1";
})();
</script>`,
    );
    const r = await probed(frame);
    await settle(800);
    // Porthole's libraries load from the frame's own origin, and draw.
    expect(r.chart).toBe("function");
    expect(r.d3).toBe("function");
    expect(r.drew).toBe("drew");
    // Nothing else loads, or leaves.
    expect(r.externalScript).toBe("undefined");
    expect(r.fetch).toMatch(/^refused/u);
    expect(r.fetchNoCors).toMatch(/^refused/u);
    expect(r.xhr).not.toBe("load");
    expect(r.ws).not.toBe("open");
    expect(r.eventSource).not.toBe("open");
    expect(r.img).not.toBe("load");
    expect(r.rtc).toBe("undefined,undefined,undefined");
    expect(r.peer).toMatch(/^threw/u);
    expect(r.child).toBe("removed");
    expect(canary.requests(), "a request reached the canary").toEqual([]);
    expect(canary.connections(), "a connection reached the canary").toBe(0);
    expect(udp.packets(), "STUN reached the oracle").toBe(0);
    await canary.close();
    await udp.close();
  });

  for (const [name, code] of [
    ["location", (url: string) => `location.href = ${js(url)};`],
    ["replace", (url: string) => `location.replace(${js(url)});`],
    ["open-self", (url: string) => `window.open(${js(url)}, "_self");`],
    ["navigation-api", (url: string) => `window.navigation.navigate(${js(url)});`],
  ] as const) {
    test(`can't navigate itself away (${name}): to a site, or to another content origin`, async ({
      page,
      browserName,
    }) => {
      const served = await harness();
      const canary = await httpOracle();
      const port = new URL(served.hostOrigin).port;
      // Another content origin: the embedding page's frame-src lets frames load it.
      const sibling = `http://sibling-${name}.localhost:${port}/?d=secret-${name}`;
      const outside = `${canary.origin}/nav.html?d=secret-${name}`;
      const { frame, shown } = await showLive(
        page,
        `<p id="marker">here</p>
<script>
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(150);
  try { ${code(sibling)} } catch (e) {}
  await wait(600);
  try { ${code(outside)} } catch (e) {}
  await wait(600);
  window.probe = { at: location.href };
  document.documentElement.dataset.done = "1";
})();
</script>`,
      );
      // The oracles first: a navigation that went out has replaced the frame's document.
      await settle(2_500);
      expect(
        served.requests.filter((url) => url.includes(`secret-${name}`)),
        "probe: the navigation reached another content origin",
      ).toEqual([]);
      expect(canary.requests(), "probe: the navigation reached the outside site").toEqual([]);
      // Then the frame: kept, or started again from its content (P031) where the engine
      // replaced its document on a navigation the page's frame-src blocked (measured: WebKit,
      // for navigation.navigate() to an outside site, which fires no navigate event first).
      // The host was told (P080): the sibling's address whole, and a content error naming it
      // without its query (where the secret is). Waited for, not read once after the settle: on
      // a busy machine the report can come later than it (P098).
      const toldOf = async () =>
        (await shown.read()).contentErrors.find((message) =>
          message.includes("navigate its frame"),
        );
      await expect
        .poll(async () => (await shown.read()).navigationsBlocked, {
          message: "probe: the host was told of the blocked navigation",
        })
        .toContain(sibling);
      await expect
        .poll(toldOf, { message: "probe: the host was told a content error naming the navigation" })
        .toBeDefined();
      const told = await toldOf();
      // Its script ran to the end in the frame, or the frame was started again (its document
      // replaced, so the script never ends): which one, once it is so.
      await expect
        .poll(
          async () =>
            (await shown.read()).outcomes.length > 1 ||
            (await frame
              .evaluate(() => document.documentElement.dataset.done === "1")
              .catch(() => false)),
          { timeout: 20_000 },
        )
        .toBe(true);
      const record = await shown.read();
      expect(told, "probe: the content error names the sibling's address").toContain(
        `http://sibling-${name}.localhost:${port}/?…`,
      );
      expect(told, "probe: the content error carried the secret").not.toContain("secret");
      if (record.outcomes.length > 1) {
        expect(record.outcomes[0]).toEqual({ state: "loaded" });
        test.info().annotations.push({
          type: "measured",
          description: `${browserName}: the frame's document was replaced; the display was started again`,
        });
      } else {
        const r = await probed(frame);
        expect(String(r.at), "probe: the frame navigated away").not.toContain("secret");
        await expect(
          frame.locator("#marker"),
          "probe: the frame's document was replaced",
        ).toHaveCount(1);
      }
      await canary.close();
    });
  }

  test("reads and follows the host's data, as the viewer allowed, once", async ({ page }) => {
    const { frame } = await showLive(
      page,
      `<script>
window.seen = [];
window.probe = {};
readData("app://counter").then((value) => { window.probe.read = value; });
subscribeData("app://counter", (value, info) => window.seen.push({ value, stale: info.stale }));
document.documentElement.dataset.done = "1";
</script>`,
    );
    await probed(frame);
    await expect
      .poll(() => frame.evaluate(() => (window as unknown as { seen: unknown[] }).seen))
      .toEqual([{ value: { n: 1 }, stale: false }]);
    expect(await frame.evaluate(() => (window as unknown as { probe: unknown }).probe)).toEqual({
      read: { n: 1 },
    });
    await page.evaluate(() =>
      (window as unknown as { liveData: { set(uri: string, value: unknown): void } }).liveData.set(
        "app://counter",
        { n: 2 },
      ),
    );
    await expect
      .poll(() => frame.evaluate(() => (window as unknown as { seen: unknown[] }).seen))
      .toEqual([
        { value: { n: 1 }, stale: false },
        { value: { n: 2 }, stale: false },
      ]);
    expect(
      await page.evaluate(
        () => (window as unknown as { liveData: { asked: number } }).liveData.asked,
      ),
    ).toBe(1);
  });

  test("shows the host's cached copy first, marked stale, then the fresh one", async ({ page }) => {
    const served = await harness();
    await page.goto(`${served.hostOrigin}/porthole-host`);
    await page.waitForFunction(() => "liveData" in window);
    await page.evaluate(() =>
      (window as unknown as { liveData: { cache: Map<string, unknown> } }).liveData.cache.set(
        "app://counter",
        { n: 0 },
      ),
    );
    const { frame } = await showLive(
      page,
      `<script>
window.seen = [];
subscribeData("app://counter", (value, info) => window.seen.push({ value, stale: info.stale }));
window.probe = {};
document.documentElement.dataset.done = "1";
</script>`,
    );
    await probed(frame);
    await expect
      .poll(() => frame.evaluate(() => (window as unknown as { seen: unknown[] }).seen))
      .toEqual([
        { value: { n: 0 }, stale: true },
        { value: { n: 1 }, stale: false },
      ]);
  });

  test("a viewer who says no: every data call is refused, and the content hears why", async ({
    page,
  }) => {
    const served = await harness();
    await page.goto(`${served.hostOrigin}/porthole-host`);
    await page.waitForFunction(() => "liveData" in window);
    await page.evaluate(() => {
      (window as unknown as { liveData: { consent: boolean } }).liveData.consent = false;
    });
    const { frame } = await showLive(
      page,
      `<script>
(async () => {
  const r = {};
  r.read = await readData("app://counter").then(() => "read", (e) => e.code + ": " + e.message);
  r.follow = await new Promise((resolve) => subscribeData("app://counter", () => resolve("data"), (e) => resolve(e.code + ": " + e.message)));
  window.probe = r;
  document.documentElement.dataset.done = "1";
})();
</script>`,
    );
    const r = await probed(frame);
    // Why, as a code and a sentence to show (P080).
    expect(r.read).toBe("denied: You didn't allow this to read your data.");
    expect(r.follow).toBe("denied: You didn't allow this to read your data.");
    const asked = await page.evaluate(
      () => (window as unknown as { liveData: { asked: number; reads: string[] } }).liveData,
    );
    expect(asked.asked).toBe(1);
    expect(asked.reads).toEqual([]);
  });

  test("a host that refuses every data call, with no handlers: the content is told why (P080)", async ({
    page,
  }) => {
    const { frame, shown } = await showLive(
      page,
      `<script>
(async () => {
  const r = {};
  r.read = await readData("app://counter").then(() => "read", (e) => e.code + ": " + e.message);
  r.follow = await new Promise((resolve) => subscribeData("app://counter", () => resolve("data"), (e) => resolve(e.code + ": " + e.message)));
  window.probe = r;
  document.documentElement.dataset.done = "1";
})();
</script>`,
      "refused",
    );
    const r = await probed(frame);
    expect(r.read).toBe("not_allowed: Live data shows on the dashboard.");
    expect(r.follow).toBe("not_allowed: Live data shows on the dashboard.");
    expect((await shown.read()).hostErrors).toEqual([]);
  });

  test("a read the host's handler refuses: its code and sentence reach the content (P080)", async ({
    page,
  }) => {
    const served = await harness();
    await page.goto(`${served.hostOrigin}/porthole-host`);
    await page.waitForFunction(() => "liveData" in window);
    await page.evaluate(() =>
      (window as unknown as { liveData: { refusals: Map<string, unknown> } }).liveData.refusals.set(
        "app://secrets",
        {
          code: "not_allowed",
          message: "Only issues are shown here.",
        },
      ),
    );
    const { frame } = await showLive(
      page,
      `<script>
(async () => {
  const r = {};
  r.secrets = await readData("app://secrets").then(() => "read", (e) => e.code + ": " + e.message);
  r.counter = await readData("app://counter").then((value) => value.n, (e) => e.code);
  window.probe = r;
  document.documentElement.dataset.done = "1";
})();
</script>`,
    );
    expect(await probed(frame)).toEqual({
      secrets: "not_allowed: Only issues are shown here.",
      counter: 1,
    });
  });
});
