/**
 * The manual's examples, each a whole widget. They use only the default theme's variables and no
 * network, so they render under every preset; the leak suite renders each through the real
 * sandbox at phone and desktop widths, in light and dark, and measures its text (the examples are
 * conformance cases, PRINCIPLE 10).
 */
export const GUIDE_EXAMPLES = {
  /** Stat cards that wrap: three across on a desktop, fewer on a phone. */
  stats: `<style>
  .stats { display: flex; flex-wrap: wrap; gap: 8px; }
  .stat { flex: 1 1 100px; background: var(--color-background-secondary); border: var(--border-width-regular) solid var(--color-border-tertiary); border-radius: var(--border-radius-lg); padding: 12px 16px; }
  .stat div { font-size: var(--font-text-sm-size); color: var(--color-text-secondary); }
  .stat b { font-size: var(--font-heading-md-size); font-weight: var(--font-weight-semibold); }
</style>
<div class="stats">
  <div class="stat"><div>Monthly cost</div><b>$1,240</b></div>
  <div class="stat"><div>Failed builds</div><b>2.4%</b></div>
</div>`,

  /** A diagram drawn for the phone: top to bottom, two boxes a row at most, scaled at most 1.25×. */
  diagram: `<div style="font-weight: var(--font-weight-semibold); margin-bottom: 8px">Uploads reach storage only through the API</div>
<svg viewBox="0 0 320 260" width="100%" style="max-width: 400px" font-size="13" role="img" aria-label="Uploads reach storage only through the API">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--color-text-tertiary)"/></marker></defs>
  <g fill="none" stroke="var(--color-border-secondary)" stroke-width="1.25"><rect x="16" y="8" width="136" height="52" rx="8"/><rect x="168" y="8" width="136" height="52" rx="8"/><rect x="16" y="200" width="136" height="52" rx="8"/><rect x="168" y="200" width="136" height="52" rx="8"/></g>
  <rect x="16" y="104" width="288" height="52" rx="8" fill="var(--color-chart-1)" fill-opacity="0.12" stroke="var(--color-chart-1)" stroke-width="2"/>
  <g fill="none" stroke="var(--color-text-tertiary)" stroke-width="1.25" marker-end="url(#arrow)"><path d="M84 60V102"/><path d="M236 60V102"/><path d="M84 156V198"/><path d="M236 156V198"/></g>
  <g text-anchor="middle" font-size="14" font-weight="600" fill="var(--color-text-primary)"><text x="84" y="30">Phone app</text><text x="236" y="30">Web app</text><text x="160" y="126">API server</text><text x="84" y="222">Object storage</text><text x="236" y="222">Database</text></g>
  <g text-anchor="middle" fill="var(--color-text-secondary)"><text x="84" y="48">iOS, Android</text><text x="236" y="48">any browser</text><text x="160" y="144">checks every upload</text><text x="84" y="240">the files</text><text x="236" y="240">who sent what</text></g>
  <g fill="var(--color-text-secondary)"><text x="92" y="86">HTTPS</text><text x="244" y="86">HTTPS</text><text x="92" y="182">writes</text><text x="244" y="182">records</text></g>
</svg>`,

  /** A line chart drawn at the frame's width (1 unit = 1 px), its numbers on a tap. */
  line: `<style>
  .note { font-size: var(--font-text-sm-size); color: var(--color-text-secondary); }
</style>
<div style="font-weight: var(--font-weight-semibold)">Failed builds fell from 9 to 2 a week</div>
<div class="note">Builds per week, last 8 weeks</div>
<div class="note"><b style="color: var(--color-chart-1)">━</b> Failed &nbsp; <b style="color: var(--color-text-disabled)">━</b> All builds</div>
<div id="plot" style="height: 200px"></div>
<div class="note" id="readout"></div>
<script>
  const rows = [["W1", 41, 9], ["W2", 44, 8], ["W3", 39, 7], ["W4", 47, 6], ["W5", 52, 4], ["W6", 49, 3], ["W7", 55, 3], ["W8", 58, 2]];
  const series = [[1, "builds", "var(--color-text-disabled)"], [2, "failed", "var(--color-chart-1)"]];
  const plot = document.getElementById("plot");
  const show = (i) => (document.getElementById("readout").textContent = \`\${rows[i][0]}: \${series.map(([at, name]) => \`\${rows[i][at]} \${name}\`).join(", ")}\`);
  function draw() {
    const w = plot.clientWidth, h = plot.clientHeight, left = 36, base = h - 24;
    const x = (i) => left + 12 + (i * (w - left - 36)) / (rows.length - 1);
    const y = (v) => base - (v / 60) * (base - 8);
    const step = Math.ceil((rows.length * 44) / w); // x labels at least 44 px apart
    let svg = \`<svg width="\${w}" height="\${h}" font-size="12" fill="var(--color-text-secondary)">\`;
    for (const v of [0, 30, 60]) svg += \`<line x1="\${left}" x2="\${w}" y1="\${y(v)}" y2="\${y(v)}" stroke="var(--color-border-tertiary)"/><text x="\${left - 6}" y="\${y(v) + 4}" text-anchor="end">\${v}</text>\`;
    rows.forEach((row, i) => { if (i % step === 0) svg += \`<text x="\${x(i)}" y="\${h - 6}" text-anchor="middle">\${row[0]}</text>\`; });
    for (const [at, , color] of series) svg += \`<polyline points="\${rows.map((row, i) => \`\${x(i)},\${y(row[at])}\`).join(" ")}" fill="none" stroke="\${color}" stroke-width="2"/>\`;
    // The two values the title rests on; then a column per week to tap.
    for (const i of [0, rows.length - 1]) svg += \`<text x="\${x(i)}" y="\${y(rows[i][2]) - 10}" text-anchor="middle" fill="var(--color-text-primary)">\${rows[i][2]}</text>\`;
    const band = (w - left) / rows.length;
    rows.forEach((row, i) => (svg += \`<rect data-i="\${i}" x="\${x(i) - band / 2}" width="\${band}" height="\${base}" fill="transparent"/>\`));
    plot.innerHTML = svg + "</svg>";
  }
  plot.addEventListener("click", (event) => event.target.dataset.i && show(Number(event.target.dataset.i)));
  show(rows.length - 1);
  new ResizeObserver(draw).observe(plot);
</script>`,

  /** Horizontal bars in HTML: no SVG, so they read at any width. */
  bars: `<div style="display: grid; grid-template-columns: 5em 1fr 3em; gap: 8px; align-items: center; font-size: var(--font-text-sm-size)">
  <span>Web</span><div style="height: 12px; width: 100%; background: var(--color-chart-1)"></div><span>412</span>
  <span>iOS</span><div style="height: 12px; width: 77%; background: var(--color-text-disabled)"></div><span>318</span>
  <span>Docs</span><div style="height: 12px; width: 16%; background: var(--color-text-disabled)"></div><span>64</span>
</div>`,
} as const;

export type GuideExample = keyof typeof GUIDE_EXAMPLES;
