// Porthole's conformance suite against the example app, on Chromium, WebKit and Firefox:
//   npx playwright test -c node_modules/@botiverse/porthole/examples/conformance/playwright.config.mjs
// It starts the Node example in TEST MODE (PORTHOLE_CONFORMANCE=1): never ship that.
import { defineConfig, devices } from "@playwright/test";
import { conformanceProjects } from "@botiverse/porthole/conformance";

const port = Number(process.env.PORTHOLE_EXAMPLE_PORT ?? 8796);

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  outputDir: process.env.PORTHOLE_EXAMPLE_RESULTS ?? "test-results",
  fullyParallel: true,
  reporter: [["list"]],
  projects: conformanceProjects(devices, {
    engines: (process.env.PORTHOLE_ENGINES ?? "chromium,webkit,firefox").split(","),
  }),
  webServer: {
    command: "node ../node/server.mjs",
    cwd: import.meta.dirname,
    url: `http://localhost:${port}/porthole/meta`,
    env: {
      PORT: String(port),
      PORTHOLE_SECRET: "example-secret-for-tests-only-0123456789",
      PORTHOLE_CONFORMANCE: "1",
    },
  },
});
