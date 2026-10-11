import { describe, expect, test } from "vitest";
import {
  compile,
  ConfigError,
  createHost,
  isOriginSource,
  presets,
  validateConfig,
  type PortholeConfig,
} from "../src/index.ts";

const base = presets.inlineWidget();
const withField = (patch: Record<string, unknown>): unknown => ({ ...base, ...patch });
const refusal = (input: unknown): string => {
  try {
    validateConfig(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error("expected the config to be refused");
};

describe("origin sources", () => {
  test.each([
    "https://cdn.example.com",
    "https://cdn.example.com:8443",
    "https://*.example-usercontent.com",
    "wss://live.example.com",
    "http://localhost:8790",
    "http://*.localhost:8790",
    "http://127.0.0.1:5173",
  ])("accepts %s", (source) => {
    expect(isOriginSource(source)).toBe(true);
  });

  test.each([
    // A directive smuggled in an origin would widen the policy.
    "https://a.com; script-src *",
    "https://a.com 'unsafe-hashes'",
    "https://a.com/path",
    "https://a.com/",
    "*",
    "https:",
    "'self'",
    "data:",
    "https://*",
    "https://a.*.com",
    "HTTPS://A.COM",
    "javascript://a.com",
    // Insecure only for loopback names.
    "http://cdn.example.com",
    "ws://live.example.com",
    "https://a.com:99999",
    "",
  ])("refuses %j", (source) => {
    expect(isOriginSource(source)).toBe(false);
  });
});

describe("validateConfig", () => {
  test("accepts every preset", () => {
    expect(() => validateConfig(presets.inlineWidget())).not.toThrow();
    expect(() => validateConfig(presets.artifact())).not.toThrow();
    expect(() => validateConfig(presets.mcpApp())).not.toThrow();
    expect(() =>
      validateConfig(presets.url({ contentOrigins: ["https://*.preview.example.com"] })),
    ).not.toThrow();
  });

  test("refuses an origin that would inject a directive, wherever it is", () => {
    expect(refusal(withField({ egress: { connect: ["https://a.com; script-src *"] } }))).toContain(
      "config.egress.connect[0]",
    );
    expect(
      refusal(
        withField({ capabilities: { openLink: { connect: ["https://a.com 'unsafe-eval'"] } } }),
      ),
    ).toContain("config.capabilities.openLink.connect[0]");
    expect(refusal(withField({ embedder: { frameSrc: ["*"] } }))).toContain(
      "config.embedder.frameSrc[0]",
    );
  });

  test("refuses unknown fields, capabilities and gates instead of ignoring them", () => {
    expect(refusal(withField({ egres: {} }))).toContain("config.egres");
    expect(refusal(withField({ capabilities: { sendPromt: {} } }))).toContain("not a capability");
    expect(refusal(withField({ egress: { frame: ["https://a.com"] } }))).toContain(
      "config.egress.frame",
    );
    expect(refusal(withField({ capabilities: { sendPrompt: { gates: ["none"] } } }))).toContain(
      "gates[0]",
    );
    expect(
      refusal(
        withField({ capabilities: { sendPrompt: { gates: [{ rateLimit: { perMinute: 0 } }] } } }),
      ),
    ).toContain("perMinute");
  });

  test("refuses theme values and names that could break out of CSS", () => {
    expect(
      refusal(
        withField({ theme: { variables: { "--x": "red; } body { display: none" }, event: "a:b" } }),
      ),
    ).toContain("--x");
    expect(refusal(withField({ theme: { variables: { color: "red" }, event: "a:b" } }))).toContain(
      "color",
    );
    expect(refusal(withField({ theme: { variables: {}, event: "a b" } }))).toContain(
      "config.theme.event",
    );
  });

  test("ties isolation to where content is served from", () => {
    expect(refusal(withField({ isolation: "domain" }))).toContain("needs the origins");
    expect(refusal(withField({ contentOrigins: ["https://*.example.com"] }))).toContain(
      "opaque isolation serves nothing",
    );
    expect(refusal(withField({ isolation: "external" }))).toContain("url mode");
    expect(refusal(withField({ mode: "url" }))).toContain("url mode");
  });

  test("url mode declares no capabilities: it has no shell", () => {
    const url = presets.url({ contentOrigins: ["https://*.preview.example.com"] });
    expect(refusal({ ...url, capabilities: { sendPrompt: {} } })).toContain("no shell");
  });

  test("refuses limits and layouts that contradict themselves", () => {
    expect(refusal(withField({ limits: { ...base.limits, minHeightPx: 3000 } }))).toContain(
      "minHeightPx",
    );
    expect(refusal(withField({ limits: { ...base.limits, maxBytes: -1 } }))).toContain("maxBytes");
    expect(
      refusal(withField({ layout: { minWidthPx: 400, narrowWidthPx: 300, wideWidthPx: 750 } })),
    ).toContain("config.layout");
  });

  test("a host's guide topic may not replace a built-in one", () => {
    expect(refusal(withField({ guide: { topics: { widget: "mine" } } }))).toContain("built-in");
    expect(() =>
      validateConfig(withField({ guide: { topics: { file: "Files: …" } } })),
    ).not.toThrow();
  });
});

describe("presets", () => {
  test("start with egress closed and only the capabilities that report to the host", () => {
    for (const config of [presets.inlineWidget(), presets.artifact(), presets.mcpApp()]) {
      expect(config.egress).toEqual({});
      expect(Object.keys(config.capabilities).sort()).toEqual(["reportError", "resize"]);
      expect(config.isolation).toBe("opaque");
    }
  });

  test("declare what the host asks for, with the vocabulary's gates unless it names its own", () => {
    const config = presets.inlineWidget({
      capabilities: { sendPrompt: {}, openLink: { gates: ["confirm"] }, reportError: false },
    });
    expect(config.capabilities.sendPrompt).toEqual({});
    expect(config.capabilities.openLink).toEqual({ gates: ["confirm"] });
    expect(config.capabilities.reportError).toBeUndefined();
  });

  test("merge theme variables over the defaults", () => {
    const config = presets.inlineWidget({
      theme: { variables: { "--color-accent": "#ff0000", "--brand": "#00f" } },
    });
    expect(config.theme.variables["--color-accent"]).toBe("#ff0000");
    expect(config.theme.variables["--brand"]).toBe("#00f");
    expect(config.theme.variables["--color-text-primary"]).toBeDefined();
  });

  test("an artifact page scrolls inside past a shorter cap than a widget", () => {
    expect(presets.artifact().limits.maxHeightPx).toBeLessThan(
      presets.inlineWidget().limits.maxHeightPx,
    );
  });
});

describe("createHost", () => {
  test("refuses domain isolation without a locator", () => {
    const config = presets.artifact({
      isolation: "domain",
      contentOrigins: ["https://*.example-usercontent.com"],
    });
    expect(() => createHost(config)).toThrow(/locator/u);
  });

  test("a mount needs a handler for every declared capability served by one", () => {
    const config: PortholeConfig = presets.inlineWidget({ capabilities: { sendPrompt: {} } });
    const host = createHost(config);
    const container = {} as HTMLElement;
    expect(() => host.mount(container, { displayId: "d1", title: "T", scheme: "light" })).toThrow(
      /sendPrompt/u,
    );
  });
});

describe("0.1.1: what a host may change", () => {
  test("a host drops default theme variables with null, and adds its own", () => {
    const config = presets.inlineWidget({
      theme: { variables: { "--color-chart-1": null, "--color-accent": null, "--brand": "#00f" } },
    });
    expect(config.theme.variables).not.toHaveProperty("--color-chart-1");
    expect(config.theme.variables).not.toHaveProperty("--color-accent");
    expect(config.theme.variables["--brand"]).toBe("#00f");
    expect(config.theme.variables["--color-text-primary"]).toBeDefined();
  });

  test("http and ws are allowed on loopback only, and the error says so", () => {
    expect(() =>
      validateConfig(presets.url({ contentOrigins: ["http://*.localhost:8790"] })),
    ).not.toThrow();
    expect(refusal(withField({ egress: { connect: ["http://cdn.example.com"] } }))).toMatch(
      /http off loopback: http is allowed only for localhost, \*\.localhost, 127\.0\.0\.1 and \[::1\].*use https/u,
    );
    expect(() => presets.url({ contentOrigins: ["http://preview.example.com"] })).toThrow(
      /off loopback/u,
    );
  });

  test("url mode may add the documented sandbox tokens; nothing else, and never top navigation", () => {
    const config = presets.url({
      contentOrigins: ["https://*.preview.example.com"],
      sandbox: [
        "allow-popups",
        "allow-popups-to-escape-sandbox",
        "allow-modals",
        "allow-downloads",
      ],
    });
    expect(compile(config).sandbox).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
    );
    expect(
      compile(presets.url({ contentOrigins: ["https://*.preview.example.com"] })).sandbox,
    ).toBe("allow-scripts allow-same-origin allow-forms");
    const url = presets.url({ contentOrigins: ["https://*.preview.example.com"] });
    expect(refusal({ ...url, sandbox: ["allow-top-navigation"] })).toMatch(/never granted/u);
    expect(refusal({ ...url, sandbox: ["allow-top-navigation-by-user-activation"] })).toMatch(
      /never granted/u,
    );
    expect(refusal({ ...url, sandbox: ["allow-presentation"] })).toMatch(/must be one of/u);
    expect(refusal({ ...base, sandbox: ["allow-popups"] })).toMatch(/only url mode/u);
  });

  test("url mode may delegate clipboard-write and fullscreen, and nothing by default (P049)", () => {
    const url = presets.url({ contentOrigins: ["https://*.preview.example.com"] });
    expect(compile(url).allow).toBe("");
    expect(
      compile(
        presets.url({
          contentOrigins: ["https://*.preview.example.com"],
          permissions: ["clipboard-write", "fullscreen"],
        }),
      ).allow,
    ).toBe("clipboard-write; fullscreen");
    expect(refusal({ ...url, permissions: ["camera"] })).toMatch(
      /permissions\[0\].*clipboard-write, fullscreen/u,
    );
    expect(refusal({ ...url, permissions: ["clipboard-read"] })).toMatch(/must be one of/u);
    expect(refusal({ ...url, permissions: "fullscreen" })).toMatch(/array/u);
    expect(refusal({ ...base, permissions: ["fullscreen"] })).toMatch(/only url mode/u);
  });

  test("a host that shares storage across displays says so, and the manual tells authors to prefix keys", () => {
    const shared = presets.inlineWidget({
      isolation: "domain",
      contentOrigins: ["https://*.example-usercontent.com"],
      storage: { shared: "conversation" },
    });
    expect(compile(shared).guide(["interactive"])).toContain(
      'localStorage is shared by every widget in this conversation, in this browser (another device starts fresh): prefix your keys with a name of this widget\'s own ("budget:filters", not "filters")',
    );
    const own = presets.inlineWidget({
      isolation: "domain",
      contentOrigins: ["https://*.example-usercontent.com"],
    });
    expect(compile(own).guide(["interactive"])).toContain("localStorage is kept for this widget");
    expect(refusal({ ...base, storage: { shared: "conversation" } })).toMatch(/only domain/u);
    expect(refusal({ ...own, storage: { shared: "A Conversation!" } })).toMatch(/noun/u);
    expect(refusal({ ...own, storage: { scope: "x" } })).toMatch(/not a known field/u);
  });

  test("a whole document takes the person's scheme when it declares it, unless the host says always", () => {
    expect(compile(presets.artifact()).shell?.themeDocuments).toBe("declared");
    expect(
      compile(presets.artifact({ theme: { documents: "always" } })).shell?.themeDocuments,
    ).toBe("always");
    expect(refusal(withField({ theme: { ...base.theme, documents: "sometimes" } }))).toMatch(
      /declared/u,
    );
    expect(compile(presets.artifact()).guide(["widget"])).toContain(
      '<meta name="color-scheme" content="light dark">',
    );
  });

  test("a load timeout is a positive limit", () => {
    expect(() =>
      presets.url({
        contentOrigins: ["https://*.p.example.com"],
        limits: { loadTimeoutMs: 2_000 },
      }),
    ).not.toThrow();
    expect(refusal(withField({ limits: { ...base.limits, loadTimeoutMs: 0 } }))).toMatch(
      /loadTimeoutMs/u,
    );
  });
});
