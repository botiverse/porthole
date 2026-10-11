import { describe, expect, test } from "vitest";
import { compile, embedderCsp, LIBRARY_CDNS, presets } from "../src/index.ts";

describe("the frame's CSP", () => {
  test("is closed by default: nothing loads, nothing connects, no frames, no forms, no WebRTC", () => {
    expect(compile(presets.inlineWidget()).csp).toBe(
      [
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval' blob:",
        "style-src 'unsafe-inline'",
        "font-src data:",
        "img-src data: blob:",
        "media-src data: blob:",
        "connect-src 'none'",
        "worker-src blob:",
        "child-src blob:",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "webrtc 'block'",
      ].join("; "),
    );
  });

  test("opens each kind only to its own origins", () => {
    const { csp } = compile(presets.inlineWidget({ egress: LIBRARY_CDNS }));
    expect(csp).toContain("font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com");
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).not.toMatch(/connect-src[^;]*fonts/u);
    expect(csp).not.toMatch(/script-src[^;]*fonts/u);
  });

  test("never allows 'self': an opaque frame has nothing of its own to load", () => {
    for (const config of [
      presets.inlineWidget({ egress: LIBRARY_CDNS }),
      presets.artifact(),
      presets.mcpApp(),
    ]) {
      expect(compile(config).csp).not.toContain("'self'");
    }
  });

  test("is empty in url mode, whose app sends its own", () => {
    const compiled = compile(presets.url({ contentOrigins: ["https://*.preview.example.com"] }));
    expect(compiled.csp).toBe("");
    expect(compiled.shell).toBeNull();
    expect(() => compiled.shellDocument({ origins: ["https://app.example.com"] })).toThrow(
      /no shell/u,
    );
  });
});

describe("the frame's attributes", () => {
  test("an opaque frame may run scripts and nothing else", () => {
    const compiled = compile(presets.inlineWidget());
    expect(compiled.sandbox).toBe("allow-scripts");
    expect(compiled.allow).toBe("");
    expect(compiled.referrerPolicy).toBe("no-referrer");
  });

  test("a served frame keeps its own origin; nothing else is granted", () => {
    const compiled = compile(
      presets.artifact({
        isolation: "domain",
        contentOrigins: ["https://*.example-usercontent.com"],
      }),
    );
    expect(compiled.sandbox).toBe("allow-scripts allow-same-origin");
  });

  test("no preset grants popups, downloads, modals or top navigation", () => {
    for (const config of [
      presets.inlineWidget(),
      presets.artifact(),
      presets.mcpApp(),
      presets.url({ contentOrigins: ["https://*.preview.example.com"] }),
    ]) {
      expect(compile(config).sandbox).not.toMatch(
        /allow-(popups|downloads|modals|top-navigation)/u,
      );
    }
  });
});

describe("the embedding page's CSP", () => {
  test("restricts frames only, and allows no navigation for opaque frames (srcdoc needs no source)", () => {
    expect(embedderCsp([presets.inlineWidget()])).toBe("frame-src 'none'");
    expect(embedderCsp([presets.inlineWidget({ embedder: { frameSrc: ["'self'"] } })])).toBe(
      "frame-src 'self'",
    );
    // Nothing a host's workers fall back to (child-src, default-src): frames only (P038).
    expect(embedderCsp([presets.inlineWidget()])).not.toMatch(/child-src|worker-src|default-src/u);
  });

  test("adds served and external content origins and the host's own frames, once each", () => {
    const csp = embedderCsp([
      presets.inlineWidget(),
      presets.artifact({
        isolation: "domain",
        contentOrigins: ["https://*.example-usercontent.com"],
      }),
      presets.url({
        contentOrigins: ["https://*.preview.example.com"],
        embedder: { frameSrc: ["https://www.youtube-nocookie.com"] },
      }),
    ]);
    expect(csp).toBe(
      "frame-src https://*.example-usercontent.com https://*.preview.example.com https://www.youtube-nocookie.com",
    );
    expect(csp).not.toContain("default-src");
  });
});
