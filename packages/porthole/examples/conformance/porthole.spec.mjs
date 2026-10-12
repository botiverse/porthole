// Porthole's conformance suite (leak probes, served cases, redirect entry) against the example
// app's real page, signed in, through its real issue endpoint. The app runs in TEST MODE
// (PORTHOLE_CONFORMANCE=1, examples/app.mjs): pages the suite names itself. Never ship it.
import { test } from "@playwright/test";
import { defineHostConformance } from "@botiverse/porthole/conformance";
import { displays } from "../displays.mjs";

const port = Number(process.env.PORTHOLE_EXAMPLE_PORT ?? 8796);
const app = `http://localhost:${port}`;
const clean = (label, path = "/") => `http://${label}.content.localhost:${port}${path}`;

defineHostConformance(test, {
  name: "example",
  // The app's real page, as a person sees it: signed in.
  open: async (page) => {
    await page.goto(`${app}/login?next=/`);
    await Promise.all([page.waitForURL(`${app}/`), page.click("#sign-in")]);
  },
  // The app's frame endpoint (content.routes), and its display kinds.
  issue: { url: "/porthole/frames" },
  displays,
  contentSource: `http://*.content.localhost:${port}`,
  // A stored-pages app: its test page's two versions (the domain cases run on version 1).
  instances: {
    artifact: (scope, version) => ({
      scope,
      document: { kind: "artifact", id: "conformance", version },
    }),
  },
  entry: {
    // The clean address of the test page's version 1 (`/` is its latest).
    url: (scope) => clean(`a-t-${scope}`, "/v/1"),
    denied: () => clean("a-private"),
    atSignIn: async (page) => (await page.locator("#sign-in-page").count()) > 0,
    completeSignIn: (page) => page.click("#sign-in"),
    unknown: "derive",
  },
});
