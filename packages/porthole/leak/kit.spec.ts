import { test } from "@playwright/test";
import { defineHostConformance } from "../src/conformance/host-kit.ts";
import { kitConfigOf } from "./kit/app.ts";

/**
 * The conformance runner (P066) against the host kit's reference app (`leak/kit/app.ts`) on
 * loopback, as an app runs it against its own page: the app's real page with its strict nonce
 * CSP, a viewer signed in, frames located by the app's issue endpoint.
 */
const port = Number(process.env.PORTHOLE_KIT_PORT ?? 8798);
const app = `http://localhost:${port}`;
const source = `http://*.kitcontent.localhost:${port}`;

defineHostConformance(test, {
  name: "kit",
  open: async (page) => {
    await page.goto(`${app}/login?as=probe`);
  },
  issue: { url: "/api/frames" },
  config: (instance) => kitConfigOf(source, instance),
  instances: {
    shell: (scope) => ({ scope, document: { kind: "shell", preset: "inlineWidget" } }),
    artifact: (scope, version) => ({ scope, document: { kind: "artifact", id: "page", version } }),
    app: (scope) => ({ scope, document: { kind: "external", url: "http://any.invalid/" } }),
  },
  entry: {
    url: (scope) => `http://k-${scope}.kitcontent.localhost:${port}/`,
    denied: (scope) => `http://k-secret-${scope}.kitcontent.localhost:${port}/`,
    atSignIn: async (page) => (await page.locator("#sign-in-page").count()) > 0,
    completeSignIn: (page) => page.locator("#sign-in").click(),
  },
});
