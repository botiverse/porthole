/**
 * The manual's own library lines, run in the sandbox against the real CDNs (P078): Tailwind's
 * Play CDN, jQuery and a Plotly map with the topojson copy the manual gives, under each preset,
 * opaque and served. Not part of CI (it reaches the network); run it when those lines change.
 *
 *   PORTHOLE_ENGINES=chromium,webkit,firefox node scripts/verify-libraries.ts
 */
import { chromium, firefox, webkit } from "@playwright/test";
import { checkPage, playwrightDriver } from "../src/check/index.ts";
import { generateGuide } from "../src/guide/guide.ts";
import { LIBRARY_CDNS, presets, type PortholeConfig } from "../src/index.ts";

// The manual's own lines: the exact URLs it tells agents to use.
const guide = generateGuide(presets.artifact({ egress: LIBRARY_CDNS }));
const src = (name: string) =>
  new RegExp(`- ${name}: <script src="([^"]+)"`, "u").exec(guide)?.[1] ?? "";
const topojson = /topojsonURL: "([^"]+)"/u.exec(guide)?.[1] ?? "";
const TW = src("Tailwind"),
  JQ = src("jQuery"),
  PL = src("Plotly");
process.stdout.write(`${JSON.stringify({ TW, JQ, PL, topojson })}\n`);

const SERVED = {
  isolation: "domain",
  contentOrigins: ["https://*.example-usercontent.com"],
} as const;
const configs: Record<string, PortholeConfig> = {
  "inlineWidget opaque": presets.inlineWidget({ egress: LIBRARY_CDNS }),
  "inlineWidget served": presets.inlineWidget({ ...SERVED, egress: LIBRARY_CDNS }),
  "artifact opaque": presets.artifact({ egress: LIBRARY_CDNS }),
  "artifact served": presets.artifact({ ...SERVED, egress: LIBRARY_CDNS }),
  mcpApp: presets.mcpApp({ egress: LIBRARY_CDNS }),
};
const doc = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
const report = (ok: string, bad: string) =>
  `(ok ? console.warn : console.error)(ok ? ${JSON.stringify(ok)} : ${JSON.stringify(bad)} + detail)`;
const cases: Record<string, string> = {
  tailwind: `<script src="${TW}"></script>
<p id="tw" class="text-red-500 font-bold p-4 rounded-lg bg-blue-100">Tailwind</p>
<script>setTimeout(() => { const s = getComputedStyle(document.getElementById("tw")); const ok = s.color === "rgb(239, 68, 68)" && s.fontWeight === "700" && s.paddingTop === "16px"; const detail = s.color; ${report("TAILWIND styled", "TAILWIND NOT styled ")}; }, 1500);</script>`,
  jquery: `<script src="${JQ}"></script><p id="jq">x</p>
<script>$("#jq").text("v" + $.fn.jquery); const ok = document.getElementById("jq").textContent === "v3.7.1"; const detail = ""; ${report("JQUERY ran", "JQUERY didn't run")};</script>`,
  "plotly geo": `<div id="map" style="width:100%;height:300px"></div><script src="${PL}"></script>
<script>Plotly.newPlot("map", [{ type: "scattergeo", lon: [2.35, -74], lat: [48.85, 40.7], mode: "markers" }], { geo: { scope: "world" }, margin: { t: 0, b: 0, l: 0, r: 0 } }, { topojsonURL: ${JSON.stringify(topojson)} }).then(() => setTimeout(() => { const n = [...document.querySelectorAll(".geo path")].filter((p) => (p.getAttribute("d") || "").length > 1000).length; const ok = n > 0; const detail = String(n); ${report("PLOTLY map drawn", "PLOTLY no map ")}; }, 1000), (e) => console.error("PLOTLY failed: " + e));</script>`,
};
const engines = { chromium, webkit, firefox };
let failures = 0;
for (const engine of (process.env.PORTHOLE_ENGINES ?? "chromium").split(",")) {
  const browser = await engines[engine as keyof typeof engines].launch();
  try {
    for (const [name, content] of Object.entries(cases)) {
      for (const [preset, config] of Object.entries(configs)) {
        const result = await checkPage({
          config,
          content: config.mode === "inline" ? content : doc(content),
          driver: playwrightDriver(browser),
          widths: [400],
          schemes: ["light"],
          settleMs: name.startsWith("plotly") ? 15_000 : 4_000,
        });
        const run = result.runs[0];
        const said = (run?.console ?? []).map((each) => `${each.level}: ${each.text.slice(0, 60)}`);
        const good =
          result.ok &&
          said.some((each) =>
            /^warning: (TAILWIND styled|JQUERY ran|PLOTLY map drawn)/u.test(each),
          );
        if (!good) failures += 1;
        process.stdout.write(
          `${good ? "PASS" : "FAIL"} ${engine}: ${name} under ${preset} | ${said.join(" | ")} | blocked ${JSON.stringify(run?.blocked)} errors ${JSON.stringify(run?.errors)}\n`,
        );
      }
    }
  } finally {
    await browser.close();
  }
}
process.stdout.write(failures === 0 ? "ALL PASS\n" : `${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
