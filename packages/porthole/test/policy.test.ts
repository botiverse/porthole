import { describe, expect, test } from "vitest";
import {
  compile,
  embedderCsp,
  embedderFrameSourcesOf,
  LIBRARY_CDNS,
  presets,
} from "../src/index.ts";
import {
  servedDocumentCsp,
  servedPermissionsPolicy,
  servedSandboxDirective,
} from "../src/compile/policy.ts";

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

  test("opens the libraries' own CDNs to scripts only (P078)", () => {
    const directives = new Map(
      compile(presets.artifact({ egress: LIBRARY_CDNS }))
        .csp.split("; ")
        .map((each) => [each.split(" ")[0] ?? "", each] as const),
    );
    for (const host of [
      "https://cdn.tailwindcss.com",
      "https://code.jquery.com",
      "https://cdn.plot.ly",
    ]) {
      expect(directives.get("script-src"), host).toContain(host);
      for (const other of ["style-src", "img-src", "connect-src", "font-src", "media-src"]) {
        expect(directives.get(other), `${host} in ${other}`).not.toContain(host);
      }
    }
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
    // No feature delegated; the clipboard denied by name (P051).
    expect(compiled.allow).toBe("clipboard-read 'none'; clipboard-write 'none'");
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
    expect(compiled.allow).toBe("clipboard-read 'none'; clipboard-write 'none'");
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

describe("a served page's own sandbox (P099, the review's S4)", () => {
  const CONTENT = ["https://*.example-usercontent.com"];
  test("is the frame's own tokens, in the page's CSP header, for every served preset", () => {
    for (const config of [
      presets.inlineWidget({ isolation: "domain", contentOrigins: CONTENT }),
      presets.artifact({ isolation: "domain", contentOrigins: CONTENT }),
      presets.mcpApp({ isolation: "domain", contentOrigins: CONTENT }),
      presets.liveWidget({ isolation: "domain", contentOrigins: CONTENT }),
    ]) {
      const compiled = compile(config);
      expect(servedSandboxDirective(config)).toEqual(["sandbox", ...compiled.sandbox.split(" ")]);
      expect(servedSandboxDirective(config)).toEqual([
        "sandbox",
        "allow-scripts",
        "allow-same-origin",
      ]);
      expect(servedDocumentCsp(config, compiled.cspDirectives)).toBe(
        `${compiled.csp}; sandbox allow-scripts allow-same-origin`,
      );
      // The frame's CSP (an opaque frame's <meta>, where browsers ignore a sandbox) has none.
      expect(compiled.csp).not.toContain("sandbox");
    }
  });

  test("is none for content never served (opaque) and for a url-mode app's own documents", () => {
    for (const config of [
      presets.inlineWidget(),
      presets.url({ contentOrigins: ["https://*.preview.example.com"] }),
    ]) {
      expect(servedSandboxDirective(config)).toBeNull();
      expect(servedPermissionsPolicy(config)).toBeNull();
    }
  });

  test("its Permissions-Policy denies the camera, the microphone, location, full screen and the clipboard", () => {
    const header =
      servedPermissionsPolicy(presets.artifact({ isolation: "domain", contentOrigins: CONTENT })) ??
      "";
    for (const feature of [
      "camera",
      "microphone",
      "geolocation",
      "display-capture",
      "fullscreen",
      "clipboard-read",
      "clipboard-write",
      "payment",
    ]) {
      expect(header.split(", "), feature).toContain(`${feature}=()`);
    }
    // A video's picture-in-picture is a frame's by default (`*`): left alone, so frames don't change.
    expect(header).not.toContain("picture-in-picture");
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

describe("the embedding page's frame sources as a list (0.1.4)", () => {
  test("are embedderCsp's, for a host that writes its own policy", () => {
    const served = presets.artifact({
      isolation: "domain",
      contentOrigins: ["https://*.example-usercontent.com"],
    });
    expect(embedderFrameSourcesOf([served, presets.inlineWidget()])).toEqual([
      "https://*.example-usercontent.com",
    ]);
    expect(embedderFrameSourcesOf([presets.inlineWidget()])).toEqual([]);
    expect(embedderCsp([presets.inlineWidget()])).toBe("frame-src 'none'");
  });
});
