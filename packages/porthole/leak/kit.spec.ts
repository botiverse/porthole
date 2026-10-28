import { expect, test, type Page } from "@playwright/test";
import {
  defineHostConformance,
  hostConformance,
  type HostConformanceOptions,
} from "../src/conformance/host-kit.ts";
import { kitConfigOf } from "./kit/app.ts";

/**
 * The conformance runner (P066) against the host kit's reference app (`leak/kit/app.ts`) on
 * loopback, as an app runs it against its own page: the app's real page with its strict nonce
 * CSP, a viewer signed in, frames located by the app's issue endpoint.
 */
const port = Number(process.env.PORTHOLE_KIT_PORT ?? 8798);
const app = `http://localhost:${port}`;
const source = `http://*.kitcontent.localhost:${port}`;

const options: HostConformanceOptions = {
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
    // A label the app never assigns, the bare domain, a path no page has (P070).
    unknown: () => [
      `http://www.kitcontent.localhost:${port}/`,
      `http://f.kitcontent.localhost:${port}/`,
      `http://kitcontent.localhost:${port}/`,
      `http://zz-x.kitcontent.localhost:${port}/`,
      `http://k-abc.kitcontent.localhost:${port}/nothing`,
    ],
  },
};

defineHostConformance(test, options);

const kit = hostConformance(options);

/** How a WebSocket from `page` to `url` went: open, error, or nothing in time. */
const socketFrom = (page: Page, url: string) =>
  page.evaluate(
    (target) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(target);
        socket.addEventListener("open", () => {
          resolve("open");
          socket.close();
        });
        socket.addEventListener("error", () => resolve("error"));
        setTimeout(() => resolve("timeout"), 3_000);
      }),
    url,
  );

test("P0.3 / S6: a url-mode app's WebSocket opens from its own page, never a sibling's (P101)", async ({
  page,
}) => {
  // Through nodeHost's socket path (appSocket, the kit's relay to the running app). Sibling labels
  // of kitcontent.localhost are same-site: the app's Lax cookie goes with the sibling's socket.
  await kit.begin(page);
  await page.goto(`${app}/login?as=probe`);
  const a = await kit.served.locate(await kit.served.app("socket-a"));
  const b = await kit.served.locate(await kit.served.app("socket-b"));
  const socket = `${a.origin.replace(/^http/u, "ws")}/ws`;
  await page.goto(a.url);
  await expect(page.locator("html")).toHaveAttribute("data-app", "ready");
  expect(await socketFrom(page, socket), "the app's own socket").toBe("open");
  await page.goto(b.url);
  await expect(page.locator("html")).toHaveAttribute("data-app", "ready");
  expect(await socketFrom(page, socket), "a sibling app's socket to it").toBe("error");
});

test("a nested page's shell is on a label of its own through nodeHost: framed, and from its clean address (P114)", async ({
  page,
}) => {
  const shellLabel = new RegExp(
    `^http://porthole-[a-z2-7]{24}\\.kitcontent\\.localhost:${port}$`,
    "u",
  );
  await page.goto(`${app}/login?as=probe`);
  const asked = await page.context().request.post(`${app}/api/frames`, {
    data: {
      instance: {
        scope: "nest-a",
        document: { kind: "artifact", id: "page", version: "1", preset: "artifactNested" },
      },
    },
    headers: { origin: app },
  });
  expect(asked.status()).toBe(201);
  const location = (await asked.json()) as { url: string; origin: string };
  expect(location.origin).toMatch(shellLabel);
  await page.evaluate((url) => {
    const frame = document.createElement("iframe");
    frame.src = url;
    document.body.append(frame);
  }, location.url);
  await expect
    .poll(() => page.frames().some((frame) => frame.url().startsWith(`${location.origin}/`)))
    .toBe(true);
  await expect(page.frameLocator("iframe").frameLocator("iframe").locator("#artifact")).toHaveText(
    "version 1",
  );
  // The clean address is on the scope's label, which sends a tab on to the shell's.
  await page.goto(`http://k-nest-b.kitcontent.localhost:${port}/n`);
  await expect.poll(() => new URL(page.url()).origin, { timeout: 15_000 }).toMatch(shellLabel);
  await expect(page.frameLocator("iframe").locator("#artifact")).toHaveText("version 1");
});
