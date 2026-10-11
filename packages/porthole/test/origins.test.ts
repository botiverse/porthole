import { describe, expect, test } from "vitest";
import { compile, presets } from "../src/index.ts";
import { hostOriginProblem, isHostOrigin } from "../src/isolation/served.ts";
import { createServer } from "../src/server/index.ts";

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
