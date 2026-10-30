/**
 * The served modes' conformance cases (P016, P020): domain mode and url mode, probed in a real
 * browser against a host's own serving. A host implements `ServedConformanceHost` (show an
 * instance the way it does: located through its backend, framed under the config's policy), then
 * registers the cases in its Playwright project:
 *
 *   import { test } from "@playwright/test";
 *   import { defineServedSuite } from "@botiverse/porthole/conformance";
 *   defineServedSuite(test, myServedHost);
 *
 * Each case attempts one escape or access channel and asserts, with an out-of-band oracle where
 * one exists (a canary URL the host counts requests to), that nothing got through.
 */
import { expect, type Frame, type Page, type TestInfo, type TestType } from "@playwright/test";
import type { ConformanceTest } from "./probes.ts";
import type { EgressConfig } from "../config/schema.ts";
import type { FrameLocation, InstanceRef } from "../isolation/types.ts";
import { MCP_APPS_METHODS } from "../protocol/mcp-apps.ts";
import { keepsFramedCookies } from "./cookies.ts";

/** One served display, as the host shows it. */
export interface ServedDisplay {
  /** The content origin the frame was located on. */
  readonly origin: string;
  /** The display's frame, once its document loaded. */
  frame(): Promise<Frame>;
  /** Removes the frame. */
  destroy(): Promise<void>;
  /** Posts `message` to the frame as the host does (to the frame's window, at its origin). */
  post(message: unknown): Promise<void>;
  /** The messages the host took from the frame so far (from its window and origin only). */
  received(): Promise<readonly unknown[]>;
}

/** What a host implements to run the served-mode cases against its integration. */
export interface ServedConformanceHost {
  readonly name: string;
  /**
   * Shows `instance` in `page` as the host does: a fresh ticket from its backend, framed under
   * the config's sandbox, in an embedding page that sends the config's `embedderCsp`. The same page
   * may show several, one after another.
   *
   * For a served shell the suite gives `options.content`, a line of HTML: a host that speaks to
   * the shell (`createHost`, the React binding) sends it as the display's content, since a shell
   * draws nothing (and reports no height) until it has content, and the cases click inside it. A
   * host whose frame has a height of its own may ignore it.
   */
  show(
    page: Page,
    instance: InstanceRef,
    options?: { readonly content?: string },
  ): Promise<ServedDisplay>;
  /** A fresh ticketed location for `instance`, as the host's backend issues it. */
  locate(instance: InstanceRef): Promise<FrameLocation>;
  /** Navigates `page` to a page on an origin that is not one of the host's, framing `url`. */
  frameFromForeignOrigin(page: Page, url: string): Promise<void>;
  /** A URL whose requests the host counts, on an origin that is neither the host's nor content's. */
  canary(name: string): Promise<string>;
  /** How many requests reached `canary(name)`. */
  canaryHits(name: string): Promise<number>;
  /** A served shell (domain isolation) for `scope`. */
  shell(scope: string): InstanceRef | Promise<InstanceRef>;
  /**
   * A url-mode app for `scope`: its page loads a script from its own origin that sets
   * `document.documentElement.dataset.app = "ready"`.
   */
  app(scope: string): InstanceRef | Promise<InstanceRef>;
  /**
   * A stored artifact page (domain isolation) for `scope`: version `"1"` and `"2"` of one page,
   * each with `<main id="artifact">version N</main>` and a script that records
   * `document.documentElement.dataset.rtc = typeof RTCPeerConnection`.
   */
  artifact(scope: string, version: "1" | "2"): InstanceRef | Promise<InstanceRef>;
  /** The MCP Apps sandbox proxy (domain isolation) for `scope`, opening the view's `egress`. */
  proxy(scope: string, egress?: EgressConfig): InstanceRef | Promise<InstanceRef>;
}

export interface ServedSuiteOptions {
  /** Case ids to skip, each with the reason (shown in the report). */
  readonly skip?: Readonly<Record<string, string>>;
}

type Fixtures = { page: Page; browserName: string };

/** The cases of a served page on a tab of its own (P099), one per wall. */
export const TAB_CASES: readonly string[] = [
  "served.domain.tab-window-open",
  "served.domain.tab-escapes",
  "served.domain.tab-opener",
  "served.domain.tab-navigation",
  "served.domain.tab-links",
  "served.domain.tab-devices",
  "served.domain.tab-prompts",
];

const SETTLE_MS = 800;

/** What a served shell is given to draw (`ServedConformanceHost.show`'s `content`). */
const SHELL_CONTENT = '<p id="porthole-probe-content">Porthole conformance probe</p>';

/** What the frame can see of its host: everything here must be closed to it. */
async function reachIntoHost(frame: Frame): Promise<Record<string, string>> {
  return frame.evaluate(() => {
    const attempt = (read: () => string | null | undefined): string => {
      try {
        const value = read();
        return value === undefined || value === null ? "empty" : `read: ${value}`;
      } catch {
        return "blocked";
      }
    };
    return {
      parentDocument: attempt(() => window.parent.document.title),
      topLocation: attempt(() => window.top?.location.href),
      parentStorage: attempt(() => window.parent.localStorage.getItem("porthole-probe")),
      ownStorage: attempt(() => window.localStorage.getItem("porthole-probe")),
      cookie: attempt(() => (document.cookie.includes("porthole-probe") ? document.cookie : null)),
      referrer: attempt(() => document.referrer || null),
    };
  });
}

const CLOSED = {
  parentDocument: "blocked",
  topLocation: "blocked",
  parentStorage: "blocked",
  ownStorage: "empty",
  cookie: "empty",
  referrer: "empty",
};

/**
 * A view as an MCP Apps server would send it, speaking the protocol by hand: it asks its parent to
 * initialize, and reports what its realm offers and whether a fetch got out.
 */
const PROBE_VIEW = (canary: string) => `<!doctype html><html><head><title>View</title></head><body>
<p id="view">A view.</p>
<script>
  document.documentElement.dataset.rtc = typeof RTCPeerConnection;
  window.parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "probe", version: "1" }, appCapabilities: {} } }, "*");
  fetch(${JSON.stringify(canary)}, { mode: "no-cors" }).then(
    () => { document.documentElement.dataset.fetch = "sent"; },
    () => { document.documentElement.dataset.fetch = "blocked"; },
  );
</script></body></html>`;

const methodsOf = (messages: readonly unknown[]): string[] =>
  messages.flatMap((message) =>
    message !== null &&
    typeof message === "object" &&
    typeof (message as { method?: unknown }).method === "string"
      ? [(message as { method: string }).method]
      : [],
  );

/** Marks the host page with secrets the content must not see. */
async function plantHostSecrets(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem("porthole-probe", "host-secret");
    document.cookie = "porthole-probe=host-secret; Path=/";
  });
}

/** Registers every served-mode case as a test. */
/**
 * Registers every served-mode case as a test. A host that wants to select them by its own spec
 * file registers `servedTests` itself (see `ConformanceTest`).
 */
export function defineServedSuite(
  test: TestType<object, object>,
  host: ServedConformanceHost,
  options: ServedSuiteOptions = {},
): void {
  const typed = test as unknown as TestType<Fixtures, object>;
  typed.describe(`served modes (${host.name})`, () => {
    for (const each of servedTests(host, options)) {
      // Playwright reads the fixtures a test uses from its parameter's destructuring.
      typed(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
    }
  });
}

/** Every served-mode case as a test entry (see `ConformanceTest`). */
export function servedTests(
  host: ServedConformanceHost,
  options: ServedSuiteOptions = {},
): ConformanceTest[] {
  const tests: ConformanceTest[] = [];
  let info: TestInfo | null = null;
  // The case being run's own TestInfo (for an expected failure measured on one engine).
  const typed = {
    fail: (condition: boolean, reason: string) => info?.fail(condition, reason),
  };
  const define = (id: string, title: string, body: (fixtures: Fixtures) => Promise<void>) => {
    tests.push({
      id,
      title: `${id}: ${title}`,
      async run({ page, browserName }, testInfo) {
        const reason = options.skip?.[id];
        testInfo.skip(reason !== undefined, reason);
        info = testInfo;
        await body({ page, browserName });
      },
    });
  };

  {
    const modes = [
      ["domain", (scope: string) => host.shell(scope)],
      ["url", (scope: string) => host.app(scope)],
    ] as const;
    // A served shell draws (and has a height to click in) once its host gives it content.
    const showMode = async (
      page: Page,
      mode: "domain" | "url",
      instance: InstanceRef | Promise<InstanceRef>,
    ) => host.show(page, await instance, mode === "domain" ? { content: SHELL_CONTENT } : {});

    for (const [mode, instance] of modes) {
      define(
        `served.${mode}.origin`,
        "content runs on its own origin, never the host's",
        async ({ page }) => {
          const display = await showMode(page, mode, instance(`${mode}-origin`));
          const frame = await display.frame();
          const origin = await frame.evaluate(() => window.origin);
          expect(origin, "probe: content runs on its own origin").toBe(display.origin);
          expect(origin, "probe: content runs on the host's origin").not.toBe(
            new URL(page.url()).origin,
          );
        },
      );

      define(
        `served.${mode}.no-reach`,
        "content can't reach the host's DOM, storage, cookies or URL",
        async ({ page }) => {
          const display = await showMode(page, mode, instance(`${mode}-reach`));
          await plantHostSecrets(page);
          expect(
            await reachIntoHost(await display.frame()),
            "probe: content reached into the host",
          ).toEqual(CLOSED);
        },
      );

      define(
        `served.${mode}.no-top-navigation`,
        "content can't navigate the host's page, even after a click",
        async ({ page }) => {
          const display = await showMode(page, mode, instance(`${mode}-top`));
          const frame = await display.frame();
          const before = page.url();
          const target = await host.canary(`${mode}-top`);
          await frame.evaluate((url) => {
            const button = document.createElement("button");
            button.id = "porthole-probe-top";
            button.textContent = "go";
            button.addEventListener("click", () => {
              try {
                window.top!.location.href = url;
              } catch {
                // Blocked: what we want.
              }
            });
            document.body.append(button);
            try {
              window.top!.location.href = url;
            } catch {
              // Blocked.
            }
          }, target);
          await frame.click("#porthole-probe-top");
          await page.waitForTimeout(SETTLE_MS);
          expect(page.url(), "probe: the host's page stays").toBe(before);
          expect(
            await host.canaryHits(`${mode}-top`),
            "probe: the navigation reached the canary",
          ).toBe(0);
        },
      );

      define(
        `served.${mode}.no-popups`,
        "content can't open a window, even after a click",
        async ({ page }) => {
          const display = await showMode(page, mode, instance(`${mode}-popup`));
          const frame = await display.frame();
          const target = await host.canary(`${mode}-popup`);
          const opened: Page[] = [];
          page.context().on("page", (each) => opened.push(each));
          const programmatic = await frame.evaluate((url) => {
            const button = document.createElement("button");
            button.id = "porthole-probe-popup";
            button.textContent = "open";
            // Without allow-popups, Chromium and WebKit return null; Firefox throws. Both refuse.
            const open = () => {
              try {
                return window.open(url) !== null;
              } catch {
                return false;
              }
            };
            button.addEventListener("click", () => {
              document.body.dataset.popup = String(open());
            });
            document.body.append(button);
            return open();
          }, target);
          await frame.click("#porthole-probe-popup");
          await page.waitForTimeout(SETTLE_MS);
          expect(programmatic, "probe: a window opened on load").toBe(false);
          expect(
            await frame.evaluate(() => document.body.dataset.popup),
            "probe: a window opened after a click",
          ).toBe("false");
          expect(opened, "probe: a window opened").toHaveLength(0);
          expect(
            await host.canaryHits(`${mode}-popup`),
            "probe: the popup reached the canary",
          ).toBe(0);
        },
      );
    }

    define(
      "served.domain.address",
      "a served frame's address is its own, carrying at most Porthole's ticket: never the app's",
      async ({ page }) => {
        const display = await host.show(page, await host.shell("address"), {
          content: SHELL_CONTENT,
        });
        const frame = await display.frame();
        const seen = await frame.evaluate(() => ({
          origin: location.origin,
          search: location.search,
          hash: location.hash,
        }));
        expect(seen.origin, "probe: the frame's address is on its own origin").toBe(display.origin);
        expect(seen.search, "probe: the frame's address carries more than the ticket").toMatch(
          /^(\?ticket=[^&]+)?$/u,
        );
        expect(seen.hash, "probe: the frame's address carries a fragment").toBe("");
        expect(seen.origin, "probe: the frame's address is the host's origin").not.toBe(
          new URL(page.url()).origin,
        );
      },
    );

    define(
      "served.domain.storage-scope",
      "storage persists within a scope and is never shared across scopes",
      async ({ page }) => {
        const first = await host.show(page, await host.shell("scope-a"), {
          content: SHELL_CONTENT,
        });
        await (await first.frame()).evaluate(() => localStorage.setItem("kept", "a"));
        await first.destroy();
        const again = await host.show(page, await host.shell("scope-a"), {
          content: SHELL_CONTENT,
        });
        expect(await (await again.frame()).evaluate(() => localStorage.getItem("kept"))).toBe("a");
        expect(again.origin).toBe(first.origin);
        const other = await host.show(page, await host.shell("scope-b"), {
          content: SHELL_CONTENT,
        });
        expect(other.origin, "probe: another scope shares the origin").not.toBe(first.origin);
        expect(
          await (await other.frame()).evaluate(() => localStorage.getItem("kept")),
          "probe: another scope read the storage",
        ).toBeNull();
      },
    );

    define(
      "served.artifact.versions",
      "each version of a page shows as stored, on its scope's origin, hardened before it runs",
      async ({ page }) => {
        const one = await host.show(page, await host.artifact("artifact-scope", "1"));
        const two = await host.show(page, await host.artifact("artifact-scope", "2"));
        expect(two.origin).toBe(one.origin);
        for (const [display, version] of [
          [one, "1"],
          [two, "2"],
        ] as const) {
          const frame = await display.frame();
          await expect(frame.locator("#artifact")).toHaveText(`version ${version}`);
          expect(
            await frame.evaluate(() => document.documentElement.dataset.rtc),
            "probe: the page ran before it was hardened",
          ).toBe("undefined");
        }
      },
    );

    define(
      "served.domain.ticket-once",
      "a ticket opens its content once; without it there is nothing",
      async ({ page, browserName }) => {
        const location = await host.locate(await host.shell("ticket-once"));
        const first = await page.goto(location.url);
        expect(first?.status()).toBe(200);
        // A fresh browser state: no cookie, only the used ticket.
        const fresh = await page.context().browser()!.newContext();
        try {
          const other = await fresh.newPage();
          const again = await other.goto(location.url);
          expect(again?.status(), `probe: ${browserName}`).toBe(401);
          expect(
            await other.locator("#porthole-root").count(),
            "probe: a used ticket showed content",
          ).toBe(0);
        } finally {
          await fresh.close();
        }
      },
    );

    define(
      "served.domain.self-navigation",
      "a served frame can't navigate itself away, to an outside site or another content origin, even after a click",
      async ({ page }) => {
        // Data in the address of a navigation the frame starts itself (P079). Another content
        // origin first: the embedding page's frame-src must let content origins in, so the shell's
        // guard is the only wall there, and the frame's document must stay. Then an outside site,
        // which frame-src stops too (where it does, an engine may show its error page in the
        // frame): no request may reach it.
        const display = await host.show(page, await host.shell("self-navigation"), {
          content: SHELL_CONTENT,
        });
        const frame = await display.frame();
        const sibling = `${(await host.locate(await host.shell("self-navigation-sibling"))).origin}/?d=secret`;
        const outside = `${await host.canary("self-navigation")}?d=secret`;
        const away = async (url: string): Promise<void> => {
          await frame.evaluate((target) => {
            (window as unknown as { portholeProbeStays?: boolean }).portholeProbeStays = true;
            document.getElementById("porthole-probe-self")?.remove();
            const button = document.createElement("button");
            button.id = "porthole-probe-self";
            button.textContent = "go";
            button.addEventListener("click", () => {
              location.href = target;
            });
            document.body.append(button);
          }, url);
          await frame.click("#porthole-probe-self");
          await page.waitForTimeout(SETTLE_MS);
        };
        await away(sibling);
        const stays = await frame
          .evaluate(
            () =>
              (window as unknown as { portholeProbeStays?: boolean }).portholeProbeStays === true,
          )
          .catch(() => false);
        expect(stays, "probe: another content origin: the frame's document stays").toBe(true);
        expect(new URL(frame.url()).origin, "probe: another content origin").toBe(display.origin);
        await away(outside);
        expect(await host.canaryHits("self-navigation"), "probe: the outside site").toBe(0);
      },
    );

    // A served page on a tab of its own (P099, the review's S4): a public link, "open in a new
    // tab", a bookmark. No frame's sandbox is there: the page's own (its CSP's `sandbox`) must
    // hold what the frame's holds, and a click (a visitor's, after typing into the page) must open
    // nothing either. One case per wall, so each negative control fails its own.
    const onTab = async (page: Page, scope: string): Promise<void> => {
      const location = await host.locate(await host.shell(scope));
      const answer = await page.goto(location.url);
      expect(answer?.status()).toBe(200);
      expect(new URL(page.url()).origin).toBe(location.origin);
    };
    /**
     * Clicks `selector` with raw input: a person's click (user activation), and an action that
     * doesn't wait on what the click starts (a navigation refused, a popup that never commits).
     */
    const press = async (page: Page, selector: string): Promise<void> => {
      const box = await page.locator(selector).boundingBox();
      expect(box, selector).not.toBeNull();
      await page.mouse.click(
        (box?.x ?? 0) + (box?.width ?? 0) / 2,
        (box?.y ?? 0) + (box?.height ?? 0) / 2,
      );
    };
    /** Windows, downloads and browser dialogs the page's context starts from now on. */
    const watchWindows = (page: Page) => {
      const opened: string[] = [];
      const downloads: string[] = [];
      const dialogs: string[] = [];
      page.context().on("page", (each) => opened.push(each.url()));
      page.on("download", (each) => downloads.push(each.url()));
      page.on("dialog", (each) => {
        dialogs.push(`${each.type()}: ${each.message()}`);
        void each.dismiss();
      });
      return { opened, downloads, dialogs };
    };

    define(
      "served.domain.tab-window-open",
      "a page on a tab of its own can't open a window (window.open, a picture-in-picture document), even after a click",
      async ({ page }) => {
        await onTab(page, "tab-window-open");
        const target = await host.canary("tab-window-open");
        const { opened } = watchWindows(page);
        const programmatic = await page.evaluate((url) => {
          // Chromium and WebKit answer null, Firefox throws: either way nothing opens.
          const open = () => {
            try {
              return window.open(`${url}?d=secret`) !== null;
            } catch {
              return false;
            }
          };
          // A picture-in-picture document (Chromium, Firefox) is a window of this origin, in a
          // fresh realm the shell never hardened: measured, on a tab it opened with WebRTC there.
          const pip = (
            window as unknown as {
              documentPictureInPicture?: { requestWindow(options?: object): Promise<Window> };
            }
          ).documentPictureInPicture;
          const button = document.createElement("button");
          button.id = "porthole-probe-open";
          button.textContent = "send";
          button.addEventListener("click", () => {
            document.body.dataset.popup = String(open());
            if (pip === undefined) {
              document.body.dataset.pip = "absent";
              return;
            }
            pip.requestWindow({ width: 120, height: 120 }).then(
              (shown) => {
                document.body.dataset.pip = "opened";
                shown.close();
              },
              () => {
                document.body.dataset.pip = "refused";
              },
            );
          });
          document.body.append(button);
          return open();
        }, target);
        await press(page, "#porthole-probe-open");
        await page.waitForTimeout(SETTLE_MS);
        expect(programmatic, "probe: on load").toBe(false);
        expect(await page.evaluate(() => document.body.dataset.popup), "probe: after a click").toBe(
          "false",
        );
        expect(["absent", "refused"], "probe: picture-in-picture").toContain(
          await page.evaluate(() => document.body.dataset.pip),
        );
        expect(opened, "probe: a window opened").toEqual([]);
        expect(
          await host.canaryHits("tab-window-open"),
          "probe: the window reached the canary",
        ).toBe(0);
      },
    );

    define(
      "served.domain.tab-escapes",
      "a page on a tab of its own can't open a link in a new window, submit a form, start a download or ask in a browser dialog, even after a click",
      async ({ page }) => {
        await onTab(page, "tab-escapes");
        const kinds = ["link", "form", "blank-form"] as const;
        const urls = Object.fromEntries(
          await Promise.all(kinds.map(async (kind) => [kind, await host.canary(`tab-${kind}`)])),
        ) as Record<(typeof kinds)[number], string>;
        const { opened, downloads, dialogs } = watchWindows(page);
        await page.evaluate((each) => {
          const box = document.createElement("div");
          box.innerHTML = `<a id="porthole-probe-blank" href="${each.link}?d=secret" target="_blank">blank</a>
<form id="porthole-probe-form" action="${each.form}" method="get"><input name="d" value="secret"></form>
<form id="porthole-probe-blank-form" action="${each["blank-form"]}" target="_blank"><input name="d" value="secret"></form>`;
          document.body.append(box);
          // Links clicked past the shell's own click handling, as content may click them.
          window.addEventListener(
            "click",
            (event) => {
              if (event.target instanceof Element && event.target.closest("a") !== null) {
                event.stopImmediatePropagation();
              }
            },
            true,
          );
          const button = document.createElement("button");
          button.id = "porthole-probe-escape";
          button.textContent = "send";
          button.addEventListener("click", () => {
            document.getElementById("porthole-probe-blank")?.click();
            for (const id of ["porthole-probe-form", "porthole-probe-blank-form"]) {
              try {
                (document.getElementById(id) as HTMLFormElement).submit();
              } catch {
                // Refused: what we want.
              }
            }
            const save = document.createElement("a");
            save.href = URL.createObjectURL(new Blob(["secret"]));
            save.download = "secret.txt";
            document.body.append(save);
            save.click();
            // The browser's own dialog, asking for what a phishing page wants (no allow-modals).
            window.prompt("Your password, to go on");
          });
          document.body.append(button);
        }, urls);
        await press(page, "#porthole-probe-escape");
        await page.waitForTimeout(SETTLE_MS);
        expect(opened, "probe: a window opened").toEqual([]);
        expect(downloads, "probe: a download started").toEqual([]);
        expect(dialogs, "probe: a browser dialog showed").toEqual([]);
        expect(new URL(page.url()).pathname, "probe: the page stays").not.toMatch(/canary/u);
        for (const kind of kinds) {
          expect(await host.canaryHits(`tab-${kind}`), `probe: ${kind}`).toBe(0);
        }
      },
    );

    /** A served shell on a tab opened by another page that keeps a reference to it. */
    const fromOpener = async (page: Page, scope: string): Promise<Page> => {
      const location = await host.locate(await host.shell(scope));
      await page.goto("about:blank");
      await page.setContent('<button id="porthole-probe-opener" type="button">open</button>');
      await page.evaluate((url) => {
        document
          .getElementById("porthole-probe-opener")
          ?.addEventListener("click", () => void window.open(url));
      }, location.url);
      const [tab] = await Promise.all([
        page.waitForEvent("popup"),
        press(page, "#porthole-probe-opener"),
      ]);
      await tab.waitForURL((url) => url.origin === location.origin);
      await tab.waitForLoadState("load");
      return tab;
    };
    /** Adds a button to `page` that sends itself or its opener to `url` when clicked; clicks it. */
    const clickAway = async (page: Page, url: string, which: "self" | "opener") => {
      await page.evaluate(
        ([target, whose]) => {
          const button = document.createElement("button");
          button.id = "porthole-probe-away";
          button.textContent = "go";
          button.addEventListener("click", () => {
            try {
              (whose === "opener" ? (window.opener as Window) : window).location.href = target;
            } catch {
              // Refused: what we want.
            }
          });
          document.body.append(button);
        },
        [url, which] as const,
      );
      await press(page, "#porthole-probe-away");
    };

    define(
      "served.domain.tab-opener",
      "a page on a tab of its own can't navigate the page that opened it, even after a click",
      async ({ page }) => {
        // `window.open` without noopener: the opener keeps a reference to the tab, and the tab to
        // it, which an unsandboxed page may send elsewhere (reverse tabnabbing).
        const tab = await fromOpener(page, "tab-opener");
        const away = await host.canary("tab-opener");
        await clickAway(tab, `${away}?d=secret`, "opener");
        await page.waitForTimeout(SETTLE_MS);
        expect(page.url(), "probe: the opener stays").toBe("about:blank");
        expect(
          await host.canaryHits("tab-opener"),
          "probe: the opener's navigation reached the canary",
        ).toBe(0);
      },
    );

    define(
      "served.domain.tab-navigation",
      'a page on a tab of its own can\'t navigate itself away, to a blob: document of its own or an outside site, by location, a link, navigation.navigate() or open(…, "_self"), however the address is given',
      async ({ page, browserName }) => {
        const located = await host.locate(await host.shell("tab-navigation"));
        // Location granted by the browser, so a document the shell never ran in would get it.
        await page
          .context()
          .grantPermissions(["geolocation"], { origin: located.origin })
          .catch(() => {});
        await page.context().setGeolocation({ latitude: 48.8566, longitude: 2.3522 });
        // A document it wrote itself (its own origin and CSP, sandbox included, no shell), then an
        // outside site; each by `location`, by `navigation.navigate()` (WebKit sent its request though
        // the navigate event cancelled it: measured) and by `open(…, "_self")`.
        // Every way a page starts its own navigation: `location` (set, assign, replace), a
        // target=_self link clicked past the shell, `navigation.navigate()`, `open(…, "_self")`,
        // and the last two given an object whose address is a page of its own the first time it
        // is read and the outside site after, and both again with String.prototype, URL, closest
        // and an event's target replaced by liars that say the address is the page's own. Each
        // outside one has a canary of its own: WebKit was measured sending the request of
        // navigation.navigate() and of a link though the navigate event cancelled them.
        info?.setTimeout(90_000);
        const ways = [
          "location",
          "assign",
          "replace",
          "link",
          "navigate",
          "open",
          "navigate-twice",
          "open-twice",
          "navigate-lying",
          "link-lying",
        ];
        const canaries = Object.fromEntries(
          await Promise.all(ways.map(async (how) => [how, await host.canary(`tab-nav-${how}`)])),
        ) as Record<string, string>;
        /** The tab, loaded again (its session cookie serves it), with one button armed. */
        const arm = (tab: Page, kind: string, way: string) =>
          tab.evaluate(
            ([outside, name, how]) => {
              const html = `<!doctype html><title>blob</title><script>
const said = { rtc: typeof RTCPeerConnection };
const done = () => { document.title = JSON.stringify(said); };
navigator.geolocation.getCurrentPosition(() => { said.location = "granted"; done(); }, (e) => { said.location = "denied " + e.code; done(); });
navigator.mediaDevices && navigator.mediaDevices.getUserMedia({ video: true }).then(() => { said.media = "granted"; done(); }, (e) => { said.media = "rejected " + e.name; done(); });
</script>`;
              const blob = URL.createObjectURL(new Blob([html], { type: "text/html" }));
              const navigation = (
                window as unknown as { navigation?: { navigate(url: unknown): unknown } }
              ).navigation;
              // Links clicked past the shell's own click handling, as content may click them.
              window.addEventListener(
                "click",
                (event) => {
                  if (event.target instanceof Element && event.target.closest("a") !== null) {
                    event.stopImmediatePropagation();
                  }
                },
                true,
              );
              const twoFaced = (url: string) => {
                let reads = 0;
                return {
                  toString: () => {
                    reads += 1;
                    return reads === 1 ? location.href : url;
                  },
                };
              };
              // Built-ins replaced for the length of one call, each lying in the page's favour.
              const lying = (run: () => void) => {
                const here = location.href;
                const liars: [object, string, unknown][] = [
                  [String.prototype, "indexOf", () => 0],
                  [String.prototype, "split", () => [here]],
                  [
                    window,
                    "URL",
                    function () {
                      return { href: here };
                    },
                  ],
                  [Element.prototype, "closest", () => null],
                ];
                const kept = liars.map(
                  ([owner, key]) =>
                    [owner, key, Object.getOwnPropertyDescriptor(owner, key)] as const,
                );
                const target = Object.getOwnPropertyDescriptor(Event.prototype, "target");
                for (const [owner, key, value] of liars) {
                  Object.defineProperty(owner, key, { configurable: true, writable: true, value });
                }
                Object.defineProperty(Event.prototype, "target", {
                  configurable: true,
                  get: () => document.body,
                });
                try {
                  run();
                } finally {
                  for (const [owner, key, descriptor] of kept) {
                    if (descriptor !== undefined) {
                      Object.defineProperty(owner, key, descriptor);
                    }
                  }
                  if (target !== undefined) {
                    Object.defineProperty(Event.prototype, "target", target);
                  }
                }
              };
              const quiet = (result: unknown) => {
                const started = result as {
                  committed?: Promise<unknown>;
                  finished?: Promise<unknown>;
                } | null;
                started?.committed?.catch(() => {});
                started?.finished?.catch(() => {});
              };
              {
                {
                  const url = name === "blob" ? blob : `${outside[how]}?d=secret`;
                  const button = document.createElement("button");
                  button.id = `porthole-probe-${name}-${how}`;
                  button.textContent = `${name} by ${how}`;
                  button.addEventListener("click", () => {
                    try {
                      if (how === "location") {
                        location.href = url;
                      } else if (how === "assign") {
                        location.assign(url);
                      } else if (how === "replace") {
                        location.replace(url);
                      } else if (how === "link" || how === "link-lying") {
                        const link = document.createElement("a");
                        link.href = url;
                        link.target = "_self";
                        document.body.append(link);
                        if (how === "link") {
                          link.click();
                        } else {
                          lying(() => link.click());
                        }
                      } else if (how === "navigate-lying") {
                        lying(() => quiet(navigation?.navigate(url)));
                      } else if (how === "open") {
                        window.open(url, "_self");
                      } else if (how === "open-twice") {
                        window.open(twoFaced(url) as unknown as string, "_self");
                      } else if (navigation !== undefined) {
                        quiet(navigation.navigate(how === "navigate" ? url : twoFaced(url)));
                      }
                    } catch {
                      // Refused: what we want.
                    }
                  });
                  document.body.append(button);
                }
              }
            },
            [canaries, kind, way] as const,
          );
        for (const name of ["blob", "outside"]) {
          for (const how of ways) {
            // A tab of its own each time, from a fresh ticket: WebKit was measured sending a
            // cancelled navigation's request from a tab's first, and not from one after another.
            const fresh = await host.locate(await host.shell("tab-navigation"));
            const tab = await page.context().newPage();
            expect((await tab.goto(fresh.url))?.status()).toBe(200);
            const here = tab.url();
            await arm(tab, name, how);
            const id = `porthole-probe-${name}-${how}`;
            // Clicked by the page itself, after the evaluation returns: none of these needs a
            // person's click, and a Playwright action may wait on a navigation the engine started
            // and dropped (measured: WebKit, a mouse click after these, never returned).
            await tab.evaluate((each) => {
              setTimeout(() => document.getElementById(each)?.click(), 0);
            }, id);
            await tab.waitForTimeout(SETTLE_MS);
            if (tab.url().startsWith("blob:")) {
              // What such a document gets, where nothing stopped it (P099's accepted limit).
              info?.annotations.push({
                type: "measured",
                description: `${browserName}: a blob: document of its own, by ${how}, got ${await tab.title()}`,
              });
            }
            expect(
              tab.url(),
              `probe: a ${name === "blob" ? "blob: document" : "outside site"} by ${how}: the tab stays`,
            ).toBe(here);
            await tab.close();
          }
        }
        await page.waitForTimeout(SETTLE_MS);
        const heard = (
          await Promise.all(
            ways.map(async (how) => [how, await host.canaryHits(`tab-nav-${how}`)] as const),
          )
        ).filter(([, hits]) => hits > 0);
        expect(heard, "probe: the outside site heard these").toEqual([]);
      },
    );

    define(
      "served.domain.tab-links",
      "a page on a tab of its own can't send a link elsewhere by changing it after the shell read it, or from a shadow root; its fragment links and its own cancels still work",
      async ({ page }) => {
        // The browser follows a link with what it is once every listener ran; the shell follows
        // what it read in the first. Each in a fresh tab (WebKit sent a cancelled navigation's
        // request from a tab's first attempt), each outside one with a canary of its own.
        info?.setTimeout(90_000);
        const ways = [
          "switch-href",
          "switch-target",
          "add-href",
          "drop-download",
          "open-shadow",
          "closed-shadow",
        ];
        const canaries = Object.fromEntries(
          await Promise.all(ways.map(async (how) => [how, await host.canary(`tab-links-${how}`)])),
        ) as Record<string, string>;
        const freshTab = async () => {
          const located = await host.locate(await host.shell("tab-links"));
          const tab = await page.context().newPage();
          expect((await tab.goto(located.url))?.status()).toBe(200);
          return tab;
        };
        for (const how of ways) {
          const tab = await freshTab();
          const here = tab.url();
          await tab.evaluate(
            ([way, outside]) => {
              const url = `${outside}?d=secret`;
              const link = document.createElement("a");
              link.textContent = "go";
              if (way === "switch-href") {
                link.href = location.href;
              } else if (way === "switch-target") {
                link.href = url;
                link.target = "_blank";
              } else if (way === "drop-download") {
                link.href = "data.bin";
                link.setAttribute("download", "data.bin");
              } else if (way !== "add-href") {
                link.href = url;
              }
              if (way === "open-shadow" || way === "closed-shadow") {
                const holder = document.createElement("div");
                document.body.append(holder);
                const root = holder.attachShadow({
                  mode: way === "open-shadow" ? "open" : "closed",
                });
                root.append(link);
                // Past every listener after the shell's, the shadow tree's own included.
                window.addEventListener("click", (event) => event.stopImmediatePropagation(), true);
              } else {
                document.body.append(link);
                // After the shell's first listener, and past every one after it: the link changed
                // before the browser reads it.
                window.addEventListener(
                  "click",
                  (event) => {
                    event.stopImmediatePropagation();
                    if (way === "switch-target") {
                      link.target = "_self";
                    } else {
                      link.href = url;
                    }
                    if (way === "drop-download") {
                      link.removeAttribute("download");
                    }
                  },
                  true,
                );
              }
              setTimeout(() => link.click(), 0);
            },
            [how, canaries[how] ?? ""] as const,
          );
          await tab.waitForTimeout(SETTLE_MS);
          expect(tab.url(), `probe: ${how}: the tab stays`).toBe(here);
          await tab.close();
        }
        await page.waitForTimeout(SETTLE_MS);
        const heard = (
          await Promise.all(
            ways.map(async (how) => [how, await host.canaryHits(`tab-links-${how}`)] as const),
          )
        ).filter(([, hits]) => hits > 0);
        expect(heard, "probe: the outside site heard these").toEqual([]);
        // Still as before: a fragment link jumps; a link content cancels goes nowhere.
        const tab = await freshTab();
        await tab.evaluate(() => {
          const below = document.createElement("p");
          below.id = "porthole-probe-below";
          const jump = document.createElement("a");
          jump.id = "porthole-probe-jump";
          jump.href = "#porthole-probe-below";
          jump.textContent = "jump";
          const kept = document.createElement("a");
          kept.id = "porthole-probe-kept";
          kept.href = "#porthole-probe-kept";
          kept.textContent = "kept";
          kept.addEventListener("click", (event) => event.preventDefault());
          document.body.append(jump, kept, below);
          setTimeout(() => jump.click(), 0);
        });
        await expect
          .poll(() => tab.evaluate(() => location.hash), { timeout: 3_000 })
          .toBe("#porthole-probe-below");
        await tab.evaluate(() => {
          setTimeout(() => document.getElementById("porthole-probe-kept")?.click(), 0);
        });
        await tab.waitForTimeout(SETTLE_MS);
        expect(await tab.evaluate(() => location.hash), "a click content cancelled").toBe(
          "#porthole-probe-below",
        );
        await tab.close();
      },
    );

    define(
      "served.domain.tab-devices",
      "a page on a tab of its own gets no camera, microphone, location or full screen, even with the browser's permission and a click",
      async ({ page, browserName }) => {
        const location = await host.locate(await host.shell("tab-devices"));
        // The browser's permission given (a person who said yes before): only the page's own
        // policy may refuse. An engine Playwright can't grant a name to asks, and is refused.
        const context = page.context();
        for (const name of ["geolocation", "camera", "microphone"]) {
          await context.grantPermissions([name], { origin: location.origin }).catch(() => {});
        }
        await context.setGeolocation({ latitude: 48.8566, longitude: 2.3522 });
        const warnings: string[] = [];
        page.on("console", (message) => {
          if (/permissions.policy/iu.test(message.text())) {
            warnings.push(message.text());
          }
        });
        const answer = await page.goto(location.url);
        expect(answer?.status()).toBe(200);
        await page.evaluate(() => {
          const button = document.createElement("button");
          button.id = "porthole-probe-devices";
          button.textContent = "share";
          button.addEventListener("click", () => {
            // Full screen first: it takes the click's activation.
            const element = document.documentElement;
            const fullscreen =
              typeof element.requestFullscreen === "function"
                ? element.requestFullscreen().then(
                    () => "entered",
                    () => "rejected",
                  )
                : Promise.resolve("absent");
            const media =
              navigator.mediaDevices === undefined
                ? Promise.resolve("absent")
                : navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(
                    (stream) => {
                      stream.getTracks().forEach((track) => track.stop());
                      return "granted";
                    },
                    (error: unknown) =>
                      `rejected ${error instanceof Error ? error.name : String(error)}`,
                  );
            const position = new Promise<string>((resolve) => {
              navigator.geolocation.getCurrentPosition(
                () => resolve("granted"),
                (error) => resolve(`denied ${error.code}`),
                { timeout: 3_000 },
              );
            });
            void Promise.all([fullscreen, media, position]).then(([screen, devices, place]) => {
              if (document.fullscreenElement !== null) {
                void document.exitFullscreen();
              }
              document.body.dataset.devices = JSON.stringify({
                fullscreen: screen,
                media: devices,
                location: place,
              });
            });
          });
          document.body.append(button);
        });
        await press(page, "#porthole-probe-devices");
        await expect
          .poll(() => page.evaluate(() => document.body.dataset.devices ?? ""), { timeout: 6_000 })
          .not.toBe("");
        const said = JSON.parse(
          await page.evaluate(() => document.body.dataset.devices ?? "{}"),
        ) as Record<string, string>;
        expect(said.location, "probe: location").toBe("denied 1");
        // No stream, however it is refused: a machine without a camera says NotFoundError even
        // where the policy would refuse (measured: Chromium, the header alone).
        expect(said.media, "probe: camera and microphone").not.toBe("granted");
        expect(["rejected", "absent"], "probe: full screen").toContain(said.fullscreen);
        if (warnings.length > 0) {
          info?.annotations.push({
            type: "measured",
            description: `${browserName}: ${warnings.slice(0, 3).join(" | ")}`,
          });
        }
      },
    );

    define(
      "served.domain.tab-prompts",
      "a page on a tab of its own can't ask for a passkey, a payment (Apple Pay too) or a share, or put a video in full screen, even after a click",
      async ({ page }) => {
        // Each where the engine has it, refused at once (a prompt would wait for the person, up
        // to the request's own timeout). A payment method's address is fetched by the browser,
        // outside the CSP: the canary must hear nothing.
        await onTab(page, "tab-prompts");
        const canary = await host.canary("tab-payment");
        await page.evaluate((payTo) => {
          const button = document.createElement("button");
          button.id = "porthole-probe-prompts";
          button.textContent = "pay";
          const timed = (start: () => Promise<unknown> | undefined): Promise<string> => {
            const begun = performance.now();
            let asked: Promise<unknown> | undefined;
            try {
              asked = start();
            } catch (error) {
              return Promise.resolve(
                `refused ${error instanceof Error ? error.name : "error"} at once`,
              );
            }
            if (asked === undefined) {
              return Promise.resolve("absent");
            }
            return asked.then(
              () => "granted",
              (error: unknown) =>
                `refused ${error instanceof Error ? error.name : "error"}${performance.now() - begun < 1_500 ? " at once" : " later"}`,
            );
          };
          const challenge = new Uint8Array(32);
          button.addEventListener("click", () => {
            const passkey = timed(() =>
              navigator.credentials?.create({
                publicKey: {
                  challenge,
                  rp: { name: "Probe" },
                  user: { id: challenge, name: "probe", displayName: "Probe" },
                  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                  timeout: 6_000,
                },
              }),
            );
            const payment = timed(() =>
              typeof PaymentRequest === "function"
                ? new PaymentRequest([{ supportedMethods: `${payTo}?d=secret` }], {
                    total: { label: "Probe", amount: { currency: "USD", value: "1.00" } },
                  }).show()
                : undefined,
            );
            const share = timed(() =>
              typeof navigator.share === "function"
                ? navigator.share({ title: "Probe", url: `${payTo}?via=share` })
                : undefined,
            );
            // WebKit's Apple Pay sheet, where it has one: a session begun from a click.
            const ApplePay = (
              window as unknown as {
                ApplePaySession?: new (
                  version: number,
                  request: object,
                ) => EventTarget & {
                  begin(): void;
                };
              }
            ).ApplePaySession;
            const applePay = timed(() => {
              if (ApplePay === undefined) {
                return undefined;
              }
              const session = new ApplePay(3, {
                countryCode: "US",
                currencyCode: "USD",
                supportedNetworks: ["visa"],
                merchantCapabilities: ["supports3DS"],
                total: { label: "Probe", amount: "1.00" },
              });
              return new Promise((resolve, reject) => {
                session.addEventListener("cancel", () =>
                  reject(new DOMException("cancelled", "AbortError")),
                );
                session.begin();
                setTimeout(() => resolve("begun"), 1_000);
              });
            });
            const video = document.createElement("video");
            document.body.append(video);
            const enter = (video as unknown as { webkitEnterFullscreen?: () => void })
              .webkitEnterFullscreen;
            let videoFullscreen = "absent";
            if (typeof enter === "function") {
              try {
                enter.call(video);
                videoFullscreen = "called";
              } catch (error) {
                videoFullscreen = `refused ${error instanceof Error ? error.name : "error"}`;
              }
            }
            void Promise.all([passkey, payment, share, applePay]).then(
              ([key, pay, sent, apple]) => {
                document.body.dataset.prompts = JSON.stringify({
                  passkey: key,
                  payment: pay,
                  share: sent,
                  applePay: apple,
                  video: videoFullscreen,
                  shown:
                    (video as unknown as { webkitDisplayingFullscreen?: boolean })
                      .webkitDisplayingFullscreen === true,
                });
              },
            );
          });
          document.body.append(button);
        }, canary);
        await press(page, "#porthole-probe-prompts");
        // A prompt the page may show waits for the person, and its report never comes: the
        // probe's verdict (P096), as much as one refused too late.
        await expect
          .poll(() => page.evaluate(() => document.body.dataset.prompts ?? ""), {
            timeout: 10_000,
            message: "probe: a prompt was shown and waited, instead of being refused at once",
          })
          .not.toBe("");
        const said = JSON.parse(
          await page.evaluate(() => document.body.dataset.prompts ?? "{}"),
        ) as Record<string, string | boolean>;
        const atOnce = (value: unknown) =>
          value === "absent" || (typeof value === "string" && /^refused \w+ at once$/u.test(value));
        expect(atOnce(said.passkey), `probe: a passkey: ${String(said.passkey)}`).toBe(true);
        expect(atOnce(said.payment), `probe: a payment: ${String(said.payment)}`).toBe(true);
        expect(atOnce(said.share), `probe: a share: ${String(said.share)}`).toBe(true);
        expect(atOnce(said.applePay), `probe: Apple Pay: ${String(said.applePay)}`).toBe(true);
        expect(
          said.video === "absent" || String(said.video).startsWith("refused"),
          `probe: a video's full screen: ${String(said.video)}`,
        ).toBe(true);
        expect(said.shown, "probe: a video in full screen").toBe(false);
        await page.waitForTimeout(SETTLE_MS);
        expect(await host.canaryHits("tab-payment"), "probe: the payment method's address").toBe(0);
      },
    );

    define(
      "served.domain.frame-ancestors",
      "only the host's origins may frame content",
      async ({ page }) => {
        const location = await host.locate(await host.shell("foreign"));
        await host.frameFromForeignOrigin(page, location.url);
        await page.waitForTimeout(SETTLE_MS);
        for (const frame of page.frames().slice(1)) {
          // A refused frame shows the engine's error page, which Firefox never lets a script
          // finish in: a frame that doesn't answer in time showed nothing of the content.
          const unreachable = { origin: "unreachable", root: false };
          const shown = await Promise.race([
            frame
              .evaluate(() => ({
                origin: window.origin,
                root: document.getElementById("porthole-root") !== null,
              }))
              .catch(() => unreachable),
            new Promise<typeof unreachable>((resolve) =>
              setTimeout(() => resolve(unreachable), 3_000),
            ),
          ]);
          expect(shown.root, "probe: a foreign origin framed the content").toBe(false);
          expect(shown.origin, "probe: a foreign origin framed the content's origin").not.toBe(
            location.origin,
          );
        }
      },
    );

    define(
      "served.domain.door",
      "a served display's door is on its own origin, opaque, says open from null, is taken once, refuses the wrong ticket, and says what the content route says (P125)",
      async ({ page }) => {
        const doorOf = (location: Awaited<ReturnType<typeof host.locate>>): string => {
          expect(
            location.door,
            "probe: the server gives a door for a served display",
          ).toBeDefined();
          return location.door!.url;
        };
        // Land on a host-origin page first, so the door (framed by it) is within frame-ancestors.
        await host.show(page, await host.shell("door-nav"), { content: SHELL_CONTENT });
        // (1) The door is on the display's own origin, at Porthole's door path.
        const first = await host.locate(await host.shell("door-shape"));
        const door = new URL(doorOf(first));
        expect(door.origin, "probe: the door is on the display's origin").toBe(first.origin);
        expect(door.pathname, "probe: the door is at /__porthole/door/<key>").toMatch(
          /^\/__porthole\/door\/[A-Za-z0-9_-]+$/u,
        );

        // (2) Framed opaque (sandbox allow-scripts), it says `open` from the opaque origin within
        // SETTLE_MS; (5) and a door on a tab of its own is an opaque origin too.
        const said = await page.evaluate(
          async ({ url, settle }) => {
            const frame = document.createElement("iframe");
            // Opaque: scripts only (the probe frames the door as the host does, P125).
            frame.sandbox.add("allow-scripts");
            const got = new Promise<{ origin: string; data: unknown } | null>((resolve) => {
              const onMessage = (event: MessageEvent) => {
                if (event.source === frame.contentWindow) {
                  window.removeEventListener("message", onMessage);
                  resolve({ origin: event.origin, data: event.data });
                }
              };
              window.addEventListener("message", onMessage);
              setTimeout(() => resolve(null), settle);
            });
            frame.src = url;
            document.body.append(frame);
            const message = await got;
            frame.remove();
            return message;
          },
          { url: door.href, settle: SETTLE_MS + 2_000 },
        );
        expect(said, "probe: the door said nothing when framed opaque").not.toBeNull();
        expect(said?.origin, "probe: the door spoke from an opaque origin").toBe("null");
        expect(
          (said?.data as { method?: unknown } | null)?.method,
          "probe: the door spoke a frame status",
        ).toBe("porthole/notifications/frame-status");
        expect(
          (said?.data as { params?: { state?: unknown } } | null)?.params?.state,
          "probe: the door said open",
        ).toBe("open");

        // (3) The same door ticket again opens nothing: a used ticket is `session`.
        const again = await page.request.get(door.href, { failOnStatusCode: false });
        expect(again.status(), "probe: a used door ticket is 401 session").toBe(401);

        // (4) The door ticket at the content route, and the content ticket at the door, open
        // nothing; (6) a fresh door framed from a foreign origin hears nothing (frame-ancestors).
        const fresh = await host.locate(await host.shell("door-cross"));
        const freshDoor = new URL(doorOf(fresh));
        const freshContent = new URL(fresh.url);
        const key = freshDoor.pathname.split("/").at(-1) ?? "";
        const doorTicket = freshDoor.searchParams.get("ticket") ?? "";
        const contentTicket = freshContent.searchParams.get("ticket") ?? "";
        const doorTicketAtContent = `${fresh.origin}/__porthole/d/${key}?ticket=${doorTicket}`;
        const contentTicketAtDoor = `${fresh.origin}/__porthole/door/${key}?ticket=${contentTicket}`;
        for (const [what, url] of [
          ["the door ticket at the content route", doorTicketAtContent],
          ["the content ticket at the door", contentTicketAtDoor],
        ] as const) {
          const response = await page.request.get(url, { failOnStatusCode: false });
          expect(response.status(), `probe: ${what} opens nothing`).toBe(401);
        }

        // (7) The door and the content route say the same block for the same grant (P125's
        // invariant): for one issue, its door ticket at the door and its content ticket at
        // `/__porthole/d/`, each from a browser with no cookie, answer the same status and reason.
        // `session`: each ticket already used once; `not-found`: a version that doesn't exist.
        const browser = page.context().browser();
        const wordOf = async (url: string) => {
          const isolated = await browser!.newContext();
          try {
            const answer = await isolated.request.get(url, {
              failOnStatusCode: false,
              maxRedirects: 0,
              headers: { "sec-fetch-dest": "iframe" },
            });
            const body = await answer.text();
            return {
              status: answer.status(),
              reason: /data-porthole-reason="([a-z-]+)"/u.exec(body)?.[1] ?? null,
            };
          } finally {
            await isolated.close();
          }
        };
        const used = await host.locate(await host.shell("door-same-session"));
        await wordOf(doorOf(used));
        await wordOf(used.url);
        const usedDoor = await wordOf(doorOf(used));
        const usedContent = await wordOf(used.url);
        expect(usedDoor, "probe: a used door ticket says session").toEqual({
          status: 401,
          reason: "session",
        });
        expect(usedContent, "probe: the content route says what the door says (used)").toEqual(
          usedDoor,
        );
        const page1 = await host.artifact("door-same-missing", "1");
        const missing: InstanceRef =
          page1.document.kind === "artifact"
            ? { ...page1, document: { ...page1.document, version: "porthole-no-such-version" } }
            : page1;
        let gone: FrameLocation | null = null;
        try {
          gone = await host.locate(missing);
        } catch {
          // A host that refuses to issue for a version it doesn't have answers before any frame.
          info?.annotations.push({
            type: "measured",
            description:
              "the host refuses to issue for a missing version: not-found is never framed",
          });
        }
        if (gone !== null) {
          const goneDoor = await wordOf(doorOf(gone));
          const goneContent = await wordOf(gone.url);
          expect(goneDoor, "probe: a missing document's door says not-found").toEqual({
            status: 404,
            reason: "not-found",
          });
          expect(goneContent, "probe: the content route says what the door says (missing)").toEqual(
            goneDoor,
          );
        }

        // (6) A fresh door from a foreign origin: frame-ancestors refuses it, so it says nothing.
        const foreignDoor = await host.locate(await host.shell("door-foreign"));
        await host.frameFromForeignOrigin(page, doorOf(foreignDoor));
        await page.waitForTimeout(SETTLE_MS);
        for (const frame of page.frames().slice(1)) {
          const reached = await Promise.race([
            frame
              .evaluate(() => document.querySelector("[data-porthole-door]") !== null)
              .catch(() => false),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
          ]);
          expect(reached, "probe: a foreign origin framed the door").toBe(false);
        }
      },
    );

    define(
      "served.domain.egress",
      "the CSP in the document's headers closes egress; only what the config opens to any https site (images, media) reaches it",
      async ({ page }) => {
        const display = await host.show(page, await host.shell("egress"), {
          content: SHELL_CONTENT,
        });
        const frame = await display.frame();
        const kinds = ["fetch", "img", "media", "script", "style", "frame"] as const;
        const urls = Object.fromEntries(
          await Promise.all(kinds.map(async (kind) => [kind, await host.canary(`egress-${kind}`)])),
        ) as Record<(typeof kinds)[number], string>;
        // Each kind tried once; the policy that applied is read from the violations it raises.
        const seen = await frame.evaluate(async (each) => {
          const policies: string[] = [];
          document.addEventListener("securitypolicyviolation", (event) =>
            policies.push(event.originalPolicy),
          );
          let fetched = "sent";
          try {
            await fetch(each.fetch, { mode: "no-cors" });
          } catch {
            fetched = "blocked";
          }
          const image = new Image();
          image.src = each.img;
          document.body.append(image);
          const audio = document.createElement("audio");
          audio.preload = "auto";
          audio.src = each.media;
          document.body.append(audio);
          const script = document.createElement("script");
          script.src = each.script;
          document.body.append(script);
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = each.style;
          document.head.append(link);
          const nested = document.createElement("iframe");
          nested.src = each.frame;
          document.body.append(nested);
          await new Promise((resolve) => setTimeout(resolve, 800));
          return { fetched, policy: policies.find((policy) => /connect-src/u.test(policy)) ?? "" };
        }, urls);
        await page.waitForTimeout(SETTLE_MS);
        expect(seen.fetched, "probe: the fetch got out").toBe("blocked");
        expect(seen.policy, "probe: a CSP applied to the document").not.toBe("");
        const sources = new Map(
          seen.policy
            .split(";")
            .map((directive) => directive.trim().split(/\s+/u))
            .map(([name = "", ...rest]) => [name, rest] as const),
        );
        // What runs or talks never opens to any site (P059), whatever the config.
        for (const name of ["script-src", "style-src", "connect-src", "frame-src", "default-src"]) {
          expect(sources.get(name) ?? [], `probe: ${name} opens no scheme`).not.toContain("https:");
        }
        for (const kind of ["fetch", "script", "style", "frame"] as const) {
          expect(await host.canaryHits(`egress-${kind}`), `probe: ${kind}`).toBe(0);
        }
        // Images and media: closed, unless the config opened them to any https site (P059);
        // then, the canary being an https site, an image reaches it, as the config means.
        const https = (kind: "img" | "media") =>
          (sources.get(`${kind}-src`) ?? []).includes("https:") &&
          new URL(urls[kind]).protocol === "https:";
        const opened = (["img", "media"] as const).filter(https);
        if (opened.length > 0) {
          info?.annotations.push({
            type: "expected",
            description: `${opened.join(" and ")} load from any https site under this config (anyHttps, P059): ${opened.includes("img") ? "the image is asserted to reach the outside site" : "measured, not asserted"}; script, style, connect and frames still can't`,
          });
        }
        if (https("img")) {
          expect(
            await host.canaryHits("egress-img"),
            "the image, as the config opens it",
          ).toBeGreaterThan(0);
        } else {
          expect(await host.canaryHits("egress-img"), "probe: img").toBe(0);
        }
        if (!https("media")) {
          expect(await host.canaryHits("egress-media"), "probe: media").toBe(0);
        }
      },
    );

    const resourceReady = (html: string) => ({
      jsonrpc: "2.0",
      method: MCP_APPS_METHODS.sandboxResourceReady,
      params: { html },
    });
    const proxyReady = async (display: ServedDisplay) =>
      expect
        .poll(async () => methodsOf(await display.received()))
        .toContain(MCP_APPS_METHODS.sandboxProxyReady);

    define(
      "served.proxy.view",
      "the sandbox proxy becomes the view, hardened, talking to its host directly",
      async ({ page }) => {
        const display = await host.show(page, await host.proxy("proxy-view"));
        await proxyReady(display);
        const canary = await host.canary("proxy-undeclared");
        await display.post(resourceReady(PROBE_VIEW(canary)));
        const frame = await display.frame();
        await expect(frame.locator("#view")).toHaveText("A view.");
        await expect
          .poll(async () => methodsOf(await display.received()))
          .toContain(MCP_APPS_METHODS.initialize);
        await expect(
          frame.locator("html"),
          "probe: the view's undeclared fetch got out",
        ).toHaveAttribute("data-fetch", "blocked");
        expect(
          await frame.evaluate(() => [window.origin, document.documentElement.dataset.rtc]),
          "probe: the view runs hardened on its own origin",
        ).toEqual([display.origin, "undefined"]);
        expect(
          await host.canaryHits("proxy-undeclared"),
          "probe: the undeclared fetch reached the canary",
        ).toBe(0);
      },
    );

    define(
      "served.proxy.parent-only",
      "the sandbox proxy takes a view only from its host",
      async ({ page }) => {
        const display = await host.show(page, await host.proxy("proxy-parent"));
        await proxyReady(display);
        const frame = await display.frame();
        await frame.evaluate(
          (message) => window.postMessage(message, "*"),
          resourceReady('<p id="view">Not from the host.</p>'),
        );
        await page.waitForTimeout(SETTLE_MS);
        expect(
          await frame.locator("#view").count(),
          "probe: the proxy took a view not from its host",
        ).toBe(0);
      },
    );

    define(
      "served.proxy.egress",
      "the sandbox proxy opens what the view declares, and nothing else",
      async ({ page }) => {
        const canary = await host.canary("proxy-declared");
        const display = await host.show(
          page,
          await host.proxy("proxy-egress", { connect: [new URL(canary).origin] }),
        );
        await proxyReady(display);
        await display.post(resourceReady(PROBE_VIEW(canary)));
        const frame = await display.frame();
        await expect(frame.locator("html")).toHaveAttribute("data-fetch", "sent");
        expect(await host.canaryHits("proxy-declared")).toBe(1);
      },
    );

    define(
      "served.url.ticket",
      "an app shows nothing to a browser without its ticket's cookie",
      async ({ page }) => {
        const location = await host.locate(await host.app("url-ticket"));
        // A fresh browser: no cookie of the content's, none of the app's. Porthole refuses it, or
        // (redirect entry, P068) hands it to the app's authorize route, which asks it to sign in.
        const fresh = await page.context().browser()!.newContext();
        try {
          const other = await fresh.newPage();
          const bare = await other.goto(`${location.origin}/`);
          const away = new URL(other.url()).origin !== location.origin;
          expect(bare?.status() === 401 || away, `probe: ended at ${other.url()}`).toBe(true);
          expect(
            await other.evaluate(() => document.documentElement.dataset.app ?? null),
            "probe: the app ran without its ticket's cookie",
          ).toBeNull();
        } finally {
          await fresh.close();
        }
      },
    );

    define(
      "served.url.tab",
      "an app opened on a tab of its own runs, its requests riding on its cookie",
      async ({ page }) => {
        const location = await host.locate(await host.app("url-tab"));
        await page.goto(location.url);
        await expect(page.locator("html")).toHaveAttribute("data-app", "ready");
      },
    );

    define(
      "served.url.framed",
      "a framed app's own requests ride on its partitioned cookie",
      async ({ page }) => {
        // Where the browser keeps no cookie in a cross-site frame (P025: Playwright's WebKit on
        // Linux), a framed app's own requests are refused and such hosts open it on a tab: the
        // case must fail there. Measured by a probe of the browser's own, not by its name (P098:
        // the same WebKit on macOS keeps them).
        const display = await host.show(page, await host.app("url-framed"));
        const scheme = new URL(display.origin).protocol === "https:" ? "https:" : "http:";
        typed.fail(
          !(await keepsFramedCookies(page, scheme)),
          "this browser keeps no cookie in a cross-site frame (measured)",
        );
        const frame = await display.frame();
        await expect
          .poll(() => frame.evaluate(() => document.documentElement.dataset.app ?? null), {
            timeout: 3_000,
          })
          .toBe("ready");
      },
    );

    define(
      "served.url.siblings",
      "another origin's page never rides an app's cookie: its load of the app's script is refused",
      async ({ page, browserName }) => {
        // P101: two apps framed on one host page share its cookie partition, and sibling labels
        // are same-site until the content domain is on the Public Suffix List (P047), so a tab's
        // Lax cookie goes with a sibling's requests too. The app's own load is the control.
        const load = (frame: Frame, src: string) =>
          frame.evaluate(
            (url) =>
              new Promise<string>((resolve) => {
                const script = document.createElement("script");
                script.addEventListener("load", () => resolve("load"));
                script.addEventListener("error", () => resolve("error"));
                script.src = url;
                document.head.append(script);
                setTimeout(() => resolve("timeout"), 3_000);
              }),
            src,
          );
        const ready = (frame: Frame) =>
          expect
            .poll(() => frame.evaluate(() => document.documentElement.dataset.app ?? null), {
              timeout: 3_000,
            })
            .toBe("ready");
        const scriptOf = async (frame: Frame, origin: string): Promise<string> => {
          const src = await frame.evaluate(
            () => document.querySelector<HTMLScriptElement>("script[src]")?.src ?? "",
          );
          expect(src, "the app's page loads a script").not.toBe("");
          expect(new URL(src).origin, "from its own origin").toBe(origin);
          return src;
        };
        // Framed side by side, where the engine keeps a framed cookie (WebKit doesn't, P025).
        if (browserName !== "webkit") {
          const a = await host.show(page, await host.app("url-siblings-a"));
          const frameA = await a.frame();
          await ready(frameA);
          const script = await scriptOf(frameA, a.origin);
          expect(await load(frameA, script), "the app's own load").toBe("load");
          const b = await host.show(page, await host.app("url-siblings-b"));
          const frameB = await b.frame();
          await ready(frameB);
          expect(await load(frameB, script), "probe: another app's frame loading it").toBe("error");
        }
        // Each on a tab of its own, in one browser.
        const c = await host.locate(await host.app("url-siblings-c"));
        const d = await host.locate(await host.app("url-siblings-d"));
        const tab = await page.context().newPage();
        try {
          await tab.goto(c.url);
          await ready(tab.mainFrame());
          const script = await scriptOf(tab.mainFrame(), c.origin);
          expect(await load(tab.mainFrame(), script), "the app's own load").toBe("load");
          await tab.goto(d.url);
          await ready(tab.mainFrame());
          expect(await load(tab.mainFrame(), script), "probe: another app's tab loading it").toBe(
            "error",
          );
        } finally {
          await tab.close();
        }
      },
    );
  }
  return tests;
}
