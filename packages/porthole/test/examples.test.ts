import { readFileSync } from "node:fs";
import { get as get_ } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { d1TicketSchema } from "../src/server/index.ts";

/**
 * The package's runnable examples (P071): what an adopter copies has to work. The browser half
 * runs in examples/conformance (Playwright); here, the server half over HTTP.
 */

const at = (path: string) => new URL(`../examples/${path}`, import.meta.url);

describe("the examples", () => {
  it("ship the D1 migration the command prints", () => {
    expect(readFileSync(at("workers/migrations/0001_porthole_tickets.sql"), "utf8")).toBe(
      `${d1TicketSchema()}\n`,
    );
  });

  it("the Node example serves the app, its frames, clean addresses and 404s", async () => {
    const { start } = (await import(at("node/server.mjs").href)) as {
      start: (options: { port: number; secret: string }) => Promise<{
        appOrigin: string;
        close: () => void;
      }>;
    };
    const app = await start({ port: 8892, secret: "example-secret-for-tests-only-0123456789" });
    try {
      const get = (url: string, headers: Record<string, string> = {}) =>
        fetch(url, { headers, redirect: "manual" });
      expect((await get(`${app.appOrigin}/`)).status).toBe(303);
      const cookie = { cookie: "example-viewer=ada" };
      const page = await (await get(`${app.appOrigin}/`, cookie)).text();
      expect(page).toContain('href="http://a-hello.content.localhost:8892/"');
      // Served once the health gate has seen the content domain (opaque until then).
      await vi.waitFor(async () => {
        const meta = (await (await get(`${app.appOrigin}/api/meta`, cookie)).json()) as {
          served: boolean;
          config: { isolation: string };
        };
        expect(meta).toMatchObject({ served: true, config: { isolation: "domain" } });
      });
      const issued = await fetch(`${app.appOrigin}/api/frames`, {
        method: "POST",
        headers: { ...cookie, "content-type": "application/json" },
        body: JSON.stringify({
          instance: { scope: "x", document: { kind: "artifact", id: "hello", version: "1" } },
        }),
      });
      expect(issued.status).toBe(201);
      expect(((await issued.json()) as { origin: string }).origin).toBe(
        "http://a-hello.content.localhost:8892",
      );
      // A label the naming never makes: nothing there (asked of loopback, by Host).
      const status = await new Promise<number>((resolve, reject) => {
        get_(
          {
            host: "127.0.0.1",
            port: 8892,
            path: "/",
            headers: { host: "www.content.localhost:8892" },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        ).on("error", reject);
      });
      expect(status).toBe(404);
    } finally {
      app.close();
    }
  });
});
