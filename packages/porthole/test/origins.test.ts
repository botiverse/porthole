import { describe, expect, test } from "vitest";
import { compile, presets } from "../src/index.ts";
import { hostOriginProblem, isHostOrigin } from "../src/isolation/served.ts";
import {
  createServer,
  doorResponse,
  doorStatusResponse,
  nestedShellCsp,
  statusPage,
} from "../src/server/index.ts";

/**
 * Host origins of any scheme (item 0 of 0.1.1): a desktop app serves its UI from its own
 * registered scheme (`ferry://app`), and its widgets must mount there, with the origin checks
 * still exact.
 */

describe("host origins", () => {
  test.each([
    "https://app.example.com",
    "http://127.0.0.1:8797",
    "ferry://app",
    "app://local",
    "tauri://localhost",
    "chrome-extension://abcdefghijklmnop",
    "my-app+x.y://host.name:8443",
    "https://[::1]:3000",
  ])("accepts %s", (origin) => {
    expect(isHostOrigin(origin)).toBe(true);
    expect(hostOriginProblem(origin)).toBeNull();
  });

  test.each([
    ["null", /opaque/u],
    ["*", /not an exact origin/u],
    ["ferry://app/", /not an exact origin/u],
    ["ferry://app/index.html", /not an exact origin/u],
    ["FERRY://APP", /not an exact origin/u],
    ["ferry:app", /not an exact origin/u],
    ["file://", /not an exact origin/u],
    ["ferry://*.app", /not an exact origin/u],
    ["javascript://x%0aalert(1)", /not an exact origin/u],
    ["", /not an exact origin/u],
  ])("refuses %j", (origin, message) => {
    expect(isHostOrigin(origin)).toBe(false);
    expect(hostOriginProblem(origin)).toMatch(message);
  });

  test.each([
    "https://app.example.com:0",
    "https://app.example.com:65536",
    "https://app.example.com:99999",
    "https://app.example.com:0443",
    "https://0x7f.0.0.1",
    "http://127.1:8797",
    "ferry://app:0",
    "my-app+x.y://host.name:08443",
  ])(
    "refuses %j: a port 1 to 65535 without a leading zero, a host as the URL parser gives it (P145)",
    (origin) => {
      expect(hostOriginProblem(origin)).toMatch(/serializes/u);
      // And the exported test says no, as the problem does (after the audit of 0.15.1, N1).
      expect(isHostOrigin(origin)).toBe(false);
    },
  );

  test.each(["https://app.example.com:443", "https://app.example.com:65535", "ferry://app:1"])(
    "still accepts %s",
    (origin) => {
      expect(hostOriginProblem(origin)).toBeNull();
      expect(isHostOrigin(origin)).toBe(true);
    },
  );

  // After the audit of 0.15.1 (N1): P145 said every helper that takes host origins throws on a
  // bad one, and four didn't check them at all. They go into a header (`frame-ancestors`) and
  // into the page's own list of whom it tells.
  const HOST = "https://app.example.com";
  const NESTED = `https://porthole-${"a".repeat(24)}.example-usercontent.com`;
  const helpers: Record<string, (hostOrigins: readonly string[]) => unknown> = {
    statusPage: (hostOrigins) => statusPage({ status: 404, title: "t", detail: "d", hostOrigins }),
    "statusPage, its frame-ancestors given": (hostOrigins) =>
      statusPage({ status: 404, title: "t", detail: "d", hostOrigins, frameAncestors: HOST }),
    doorResponse: (hostOrigins) => doorResponse({ hostOrigins }),
    "doorResponse, its frame-ancestors given": (hostOrigins) =>
      doorResponse({ hostOrigins, frameAncestors: HOST }),
    doorStatusResponse: (hostOrigins) =>
      doorStatusResponse({ hostOrigins, status: 401, reason: "session" }),
    nestedShellCsp: (hostOrigins) => nestedShellCsp("0", NESTED, hostOrigins),
  };
  describe.each(Object.entries(helpers))("%s", (name, helper) => {
    test.each([
      "https://app.example.com:0",
      "https://a.example; script-src *",
      "https://app.example.com:0443",
      "*",
      "null",
    ])("throws on the host origin %j", (origin) => {
      expect(() => helper([HOST, origin])).toThrow(/hostOrigins: /u);
      expect(() => helper([HOST, origin])).toThrow(TypeError);
    });

    test("takes good ones, a default port and a desktop scheme among them", () => {
      expect(() => helper([HOST, "https://app.example.com:443", "ferry://app"])).not.toThrow();
      expect(name).not.toBe("");
    });
  });

  test("an embed's status pages name no host, and check none", () => {
    expect(() => statusPage({ status: 404, title: "t", detail: "d", embed: true })).not.toThrow();
    expect(() => doorStatusResponse({ embed: true, status: 401, reason: "session" })).not.toThrow();
  });

  test("the shell takes messages from a custom-scheme host, and from it only, exactly", () => {
    const html = compile(presets.inlineWidget()).shellDocument({ origins: ["ferry://app"] });
    const plan = JSON.parse(/const plan = (\{.*?\});\n/su.exec(html)?.[1] ?? "{}") as {
      origins: string[];
    };
    expect(plan.origins).toEqual(["ferry://app"]);
    expect(() => compile(presets.inlineWidget()).shellDocument({ origins: ["null"] })).toThrow(
      /opaque/u,
    );
  });

  test("/server lets a custom-scheme host frame its content", async () => {
    const server = createServer({
      content: { domain: "example-usercontent.com", scheme: "https" },
      secret: new Uint8Array(32).fill(3),
      hostOrigins: ["ferry://app", "https://app.example.com"],
      configs: {
        inlineWidget: presets.inlineWidget({
          isolation: "domain",
          contentOrigins: ["https://*.example-usercontent.com"],
        }),
      },
    });
    const location = await server.issue(
      { scope: "s", document: { kind: "shell", preset: "inlineWidget" } },
      { viewer: "v" },
    );
    const answer = await server.handle(
      new Request(location.url, { headers: { "sec-fetch-dest": "iframe" } }),
    );
    expect(answer?.headers.get("content-security-policy")).toContain(
      "frame-ancestors ferry://app https://app.example.com",
    );
    const html = await answer?.text();
    expect(html).toContain('"origins":["ferry://app","https://app.example.com"]');
  });
});

describe("same-site content is refused, with a message to act on", () => {
  test("checkFrameLocation says why and what to do", async () => {
    const { checkFrameLocation } = await import("../src/isolation/served.ts");
    expect(() =>
      checkFrameLocation(
        { url: "https://preview.app.example.com/x", origin: "https://preview.app.example.com" },
        ["https://*.app.example.com"],
        "https://app.example.com",
      ),
    ).toThrow(
      /may be the same site as the host \(https:\/\/app\.example\.com\): content must be served from a registrable domain the host uses for nothing else/u,
    );
  });
});
