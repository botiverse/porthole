import { describe, expect, it } from "vitest";
import { conformanceProjects, hostConformance } from "../src/conformance/host-kit.ts";
import { defineDisplays } from "../src/index.ts";

/** The runner's options an app's own setup needs (P074). */

const devices = {
  "Desktop Chrome": { browserName: "chromium", viewport: { width: 1280, height: 720 } },
  "Desktop Safari": { browserName: "webkit" },
  "Desktop Firefox": { browserName: "firefox" },
};

describe("conformanceProjects", () => {
  it("is Porthole's three engines by default, Firefox with the preferences its probes need", () => {
    const projects = conformanceProjects(devices);
    expect(projects.map((each) => each.name)).toEqual(["chromium", "webkit", "firefox"]);
    expect(projects[0]?.use).toEqual(devices["Desktop Chrome"]);
    expect(projects[2]?.use.launchOptions).toEqual({
      firefoxUserPrefs: {
        "media.peerconnection.ice.loopback": true,
        "media.peerconnection.ice.obfuscate_host_addresses": false,
      },
    });
  });

  it("passes a system browser's launch options through, and what every project uses", () => {
    const projects = conformanceProjects(devices, {
      engines: ["chromium", "firefox"],
      use: { ignoreHTTPSErrors: true },
      launchOptions: {
        chromium: { executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] },
        firefox: { firefoxUserPrefs: { "network.dns.disableIPv6": true } },
      },
    });
    expect(projects.map((each) => each.name)).toEqual(["chromium", "firefox"]);
    expect(projects[0]?.use).toMatchObject({
      browserName: "chromium",
      ignoreHTTPSErrors: true,
      launchOptions: { executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] },
    });
    expect(projects[1]?.use.launchOptions).toEqual({
      firefoxUserPrefs: {
        "media.peerconnection.ice.loopback": true,
        "media.peerconnection.ice.obfuscate_host_addresses": false,
        "network.dns.disableIPv6": true,
      },
    });
  });
});

describe("hostConformance", () => {
  it("asks a contentSource function when a case needs it, not when the spec file loads", () => {
    let asked = 0;
    let port = 0;
    hostConformance({
      name: "lazy",
      open: () => Promise.resolve(),
      displays: defineDisplays({ artifact: { preset: "artifact" } }),
      contentSource: () => {
        asked += 1;
        return `http://*.content.localhost:${port}`;
      },
      instances: {},
    });
    port = 8790;
    expect(asked).toBe(0);
  });
});
