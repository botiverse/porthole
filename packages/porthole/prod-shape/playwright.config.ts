import { defineConfig, devices } from "@playwright/test";

/**
 * The prod-shape suite (P066), run inside the profile's Playwright container
 * (ops/prod-shape/run.sh): the kit app behind Caddy's TLS on https://app.test, content on
 * same-site siblings under https://*.content.test, real DNS and certificate checks.
 * PORTHOLE_PROD_ENGINES picks engines; PORTHOLE_PROD_WORKERS the parallelism.
 */
const engines = (process.env.PORTHOLE_PROD_ENGINES ?? "chromium,webkit,firefox").split(",");

const all = [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "webkit", use: { ...devices["Desktop Safari"] } },
  {
    name: "firefox",
    use: {
      ...devices["Desktop Firefox"],
      // As the leak suite's: an unsandboxed peer connection reaches the loopback STUN oracle.
      launchOptions: {
        firefoxUserPrefs: {
          "media.peerconnection.ice.loopback": true,
          "media.peerconnection.ice.obfuscate_host_addresses": false,
        },
      },
      // Playwright's Firefox reads neither the system's trust store nor an enterprise policy
      // (measured), so it can't be made to trust the edge's CA: it overrides certificate errors.
      // Pages are still https (secure contexts, Secure and __Host- cookies); only the chain isn't
      // checked by this one engine. Chromium and WebKit check it.
      ignoreHTTPSErrors: true,
    },
  },
];

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // The repository is mounted read-only: results go to the container's own disk.
  outputDir: "/tmp/prod-shape-results",
  // A gate: a stray `.only` would run part of the suite and still pass.
  forbidOnly: true,
  fullyParallel: true,
  workers: Number(process.env.PORTHOLE_PROD_WORKERS ?? 4),
  reporter: [["list"], ["json", { outputFile: "/tmp/prod-shape-results.json" }]],
  use: { trace: "retain-on-failure" },
  projects: all.filter((project) => engines.includes(project.name)),
});
