import { defineConfig, devices } from "@playwright/test";

/**
 * The leak/conformance suite (P008), run against Porthole's reference host. Every engine Porthole
 * supports is a project: Chromium and WebKit gate phase 1, Firefox follows (P017).
 * `PORTHOLE_LEAK_ENGINES=chromium` runs a subset (WebKit needs system libraries some machines lack).
 */

const port = Number(process.env.PORTHOLE_LEAK_PORT ?? 8797);
const engines = (process.env.PORTHOLE_LEAK_ENGINES ?? "chromium,webkit").split(",");

const all = [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "webkit", use: { ...devices["Desktop Safari"] } },
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
  webServer: {
    command: "node leak/server.ts",
    cwd: "..",
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    env: {
      PORTHOLE_LEAK_PORT: String(port),
      PORTHOLE_LEAK_WEAKEN: process.env.PORTHOLE_LEAK_WEAKEN ?? "",
    },
  },
  projects: all.filter((project) => engines.includes(project.name)),
});
