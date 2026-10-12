import { defineConfig, devices } from "@playwright/test";

/**
 * The leak/conformance suite (P008), run against Porthole's reference host. Every engine Porthole
 * supports is a project: Chromium, WebKit and Firefox (P017).
 * `PORTHOLE_LEAK_ENGINES=chromium` runs a subset (WebKit needs system libraries some machines lack).
 */

const port = Number(process.env.PORTHOLE_LEAK_PORT ?? 8797);
const kitPort = Number(process.env.PORTHOLE_KIT_PORT ?? 8798);
const engines = (process.env.PORTHOLE_LEAK_ENGINES ?? "chromium,webkit,firefox").split(",");

const all = [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "webkit", use: { ...devices["Desktop Safari"] } },
  {
    name: "firefox",
    use: {
      ...devices["Desktop Firefox"],
      // Lets an unsandboxed peer connection reach the loopback STUN oracle, so 3.webrtc has its
      // positive control on Firefox too (by default it sends no STUN to loopback: measured).
      launchOptions: {
        firefoxUserPrefs: {
          "media.peerconnection.ice.loopback": true,
          "media.peerconnection.ice.obfuscate_host_addresses": false,
        },
      },
    },
  },
];

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: "../../../.dev/leak-results",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node leak/server.ts",
      cwd: "..",
      url: `http://127.0.0.1:${port}/`,
      reuseExistingServer: false,
      env: {
        PORTHOLE_LEAK_PORT: String(port),
        PORTHOLE_LEAK_WEAKEN: process.env.PORTHOLE_LEAK_WEAKEN ?? "",
      },
    },
    // The host kit's reference app, for the conformance runner (leak/kit.spec.ts, P066).
    {
      command: "node leak/kit/server.ts",
      cwd: "..",
      url: `http://localhost:${kitPort}/api/meta`,
      reuseExistingServer: false,
      env: { PORTHOLE_KIT_PORT: String(kitPort) },
    },
  ],
  projects: all.filter((project) => engines.includes(project.name)),
});
