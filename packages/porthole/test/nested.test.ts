import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { compile, presets } from "../src/index.ts";
import {
  PAGE_SANDBOX_TOKENS,
  sandboxTokens,
  servedSandboxDirective,
} from "../src/compile/policy.ts";
import { ConfigError } from "../src/config/validate.ts";
import { personMoved, shellGesture, type FocusMove } from "../src/platform/focus-guard.ts";
import { FRAME_SHELL_RUNTIME, frameShellScript } from "../src/shell/frame.ts";
import { nestedShellCsp, nestedShellResponse } from "../src/server/nested.ts";
import { createServer } from "../src/server/index.ts";

/**
 * A nested page (P111): its config, its sandbox (never `allow-same-origin`, held statically over
 * every sandbox Porthole writes), the shell's document and CSP, and the host's rule on what the
 * shell says. The browsers hold the rest (`leak/served/nested.spec.ts`).
 */

const ORIGIN = "https://a-x.example-usercontent.com";
const HOST = "https://app.example.com";
const nested = () =>
  presets.artifact({
    isolation: "domain",
    contentOrigins: ["https://*.example-usercontent.com"],
    nested: true,
  });

describe("config", () => {
  test("only an artifact served on its own origin nests, and keeps nothing of that origin's", () => {
    expect(nested().nested).toBe(true);
    expect(() => presets.artifact({ nested: true })).toThrow(ConfigError);
    expect(() =>
      presets.inlineWidget({
        isolation: "domain",
        contentOrigins: ["https://*.example-usercontent.com"],
        nested: true,
      }),
    ).toThrow(ConfigError);
    expect(() =>
      presets.artifact({
        isolation: "domain",
        contentOrigins: ["https://*.example-usercontent.com"],
        nested: true,
        storage: { scope: "this artifact" },
      }),
    ).toThrow(/keeps no storage/u);
    expect(() =>
      presets.artifact({
        isolation: "domain",
        contentOrigins: ["https://*.example-usercontent.com"],
        nested: true,
        runtime: "1",
        capabilities: { assets: {} },
      }),
    ).toThrow(/asset library/u);
  });

  test("the page's storage is the in-memory stand-in, and the manual says so", () => {
    const compiled = compile(nested());
    expect(compiled.shell?.storage).toBe("memory");
    expect(compiled.guide()).toMatch(/State isn't saved/u);
  });
});

describe("the sandbox (P111): never allow-same-origin on a nested page", () => {
  test("the page's frame and its answer: scripts alone", () => {
    expect(PAGE_SANDBOX_TOKENS).toEqual(["allow-scripts"]);
    expect(servedSandboxDirective(nested())).toEqual(["sandbox", "allow-scripts"]);
    // The frame the host makes holds the shell, on the content origin: its own origin, as before.
    expect(sandboxTokens(nested())).toEqual(["allow-scripts", "allow-same-origin"]);
  });

  test("the shell frames its page with the plan's sandbox, which is the page's, and refuses one with allow-same-origin", () => {
    const script = frameShellScript({ origins: [HOST], page: `${ORIGIN}/__porthole/f/abc/` });
    expect(script).toContain('"sandbox":"allow-scripts"');
    expect(FRAME_SHELL_RUNTIME).toContain('frame.setAttribute("sandbox", plan.sandbox);');
    expect(FRAME_SHELL_RUNTIME).toContain("/allow-same-origin/i.test(plan.sandbox)");
  });

  test("statically: every sandbox Porthole writes or serves names allow-same-origin only where it is the content origin's own frame", () => {
    // Every place in the source that sets a sandbox, and every literal sandbox list: the opaque
    // frame's, the nested page's, the shell's child's. allow-same-origin is in exactly the two
    // lists for a frame on an origin of its own (domain, external), and in no other code.
    const root = path.resolve(import.meta.dirname, "../src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
          files.push(full);
        }
      }
    };
    walk(root);
    const found: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const line of lines) {
        // Code, not prose: comments say the name freely.
        const code = line
          .replace(/\/\*.*?\*\//gu, "")
          .replace(/\/\/.*$/u, "")
          .replace(/^\s*(\/\*\*|\*).*$/u, "");
        if (code.includes("allow-same-origin")) {
          found.push(`${path.relative(root, file)}: ${code.trim()}`);
        }
      }
    }
    expect(found, "allow-same-origin appears only where it is reviewed").toEqual([
      // sandboxTokens: a frame on an origin of its own, a separate site (domain: the content's, or
      // a nested page's shell; external: a running app), P016, P099, P111.
      'compile/policy.ts: return ["allow-scripts", "allow-same-origin"];',
      'compile/policy.ts: return ["allow-scripts", "allow-same-origin", "allow-forms", ...(config.sandbox ?? [])];',
      // The conformance runner's foreign page, which frames a content origin as an attacker would.
      expect.stringMatching(
        /^conformance\/host-kit\.ts: body: `<!doctype html><title>Foreign<\/title>/u,
      ),
      // The shell's refusal of a plan that names it.
      'shell/frame.ts: if (typeof plan.sandbox !== "string" || /allow-same-origin/i.test(plan.sandbox)) {',
    ]);
    // And every attribute write takes a value from these, never a literal of its own.
    const writes = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /setAttribute\(\s*"sandbox"/u.test(line))
        .map((line) => `${path.relative(root, file)}: ${line.trim()}`),
    );
    expect(writes).toEqual([
      'platform/web.ts: frame.setAttribute("sandbox", spec.sandbox);',
      'shell/frame.ts: frame.setAttribute("sandbox", plan.sandbox);',
    ]);
  });
});

describe("the shell's document (P111)", () => {
  test("its page is under its own origin's sealed prefix, and nothing else", () => {
    expect(() => frameShellScript({ origins: [HOST], page: `${ORIGIN}/v/1/` })).toThrow(
      /__porthole\/f/u,
    );
    expect(() =>
      frameShellScript({ origins: ["null"], page: `${ORIGIN}/__porthole/f/a/` }),
    ).toThrow(TypeError);
  });

  test("its CSP runs its own script alone, frames and fetches only the sealed prefix, and is framed by the hosts", async () => {
    const response = nestedShellResponse(compile(nested()), {
      origin: ORIGIN,
      origins: [HOST],
      page: `${ORIGIN}/__porthole/f/abc/`,
      renew: { url: `${ORIGIN}/__porthole/f/abc/__porthole/renew`, expires: 1 },
    });
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'; /u);
    expect(csp).toContain(`frame-src ${ORIGIN}/__porthole/f/`);
    expect(csp).toContain(`connect-src ${ORIGIN}/__porthole/f/`);
    expect(csp).toContain(`frame-ancestors ${HOST}`);
    expect(csp).not.toContain("unsafe-inline");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    const script = /<script>([\s\S]*)<\/script>/u.exec(body)?.[1] ?? "";
    expect(csp).toBe(nestedShellCsp(script, ORIGIN, [HOST]));
    expect(body).not.toContain("<style");
  });
});

describe("the host's rule on the shell's word (P111)", () => {
  const word = { supported: true, activatedAt: 9_800, focused: true, focusedAt: 9_850 };
  const move: FocusMove = {
    now: 10_000,
    seen: true,
    pressed: false,
    over: false,
    overSince: -Infinity,
    lastKey: { key: "a", at: 9_500 },
    typedAt: 9_500,
    focusedAt: 5_000,
    gestureAt: 9_500,
    activation: true,
    hostMoved: false,
    shell: { word, hostInputAt: 9_500 },
  };

  test("the shell's activation within the second, after the host's last press or key: the person's", () => {
    expect(personMoved(move)).toBe(true);
    expect(shellGesture(word, 9_500, 10_000)).toBe(true);
  });

  test("a press or key on the host's page since: the page's", () => {
    expect(personMoved({ ...move, shell: { word, hostInputAt: 9_900 } })).toBe(false);
  });

  test("more than a second on, or never on: the page's", () => {
    expect(personMoved({ ...move, now: 10_801 })).toBe(false);
    expect(
      personMoved({
        ...move,
        shell: { word: { ...word, activatedAt: -Infinity }, hostInputAt: 0 },
      }),
    ).toBe(false);
  });

  test("no host-wide cue counts for a nested page: not the pointer, not activation with a quiet host", () => {
    const quiet = {
      ...move,
      now: 20_000,
      lastKey: null,
      gestureAt: 0,
      focusedAt: 0,
      over: true,
      overSince: 19_999,
      seen: false,
      shell: { word: { ...word, activatedAt: -Infinity }, hostInputAt: 0 },
    };
    expect(personMoved(quiet)).toBe(false);
    // The same move into a frame without a shell: 0.13's rules, which these cues satisfy.
    const { shell: _shell, ...plain } = quiet;
    expect(personMoved(plain)).toBe(true);
  });

  test("a Tab, the host's own move, and (where the engine tells it) a press on the frame still count", () => {
    expect(personMoved({ ...move, now: 20_000, lastKey: { key: "Tab", at: 19_900 } })).toBe(true);
    expect(personMoved({ ...move, now: 20_000, hostMoved: true })).toBe(true);
    expect(personMoved({ ...move, now: 20_000, pressed: true })).toBe(true);
  });

  test("an engine without userActivation in the shell: 0.13's rules", () => {
    const unsupported = { ...move, shell: { word: { ...word, supported: false }, hostInputAt: 0 } };
    expect(personMoved({ ...unsupported, pressed: true })).toBe(true);
    expect(shellGesture({ ...word, supported: false }, 0, 10_000)).toBe(false);
  });
});

describe("/server for a nested page (P111)", () => {
  const SITE = "example-usercontent.com";
  const encode = (text: string) => new TextEncoder().encode(text);
  const files: Record<string, string> = {
    "index.html": `<!doctype html><html><head><script src="./app.js"></script></head><body>files</body></html>`,
    "app.js": "window.ran = true;",
  };
  const server = () =>
    createServer({
      content: { domain: SITE, scheme: "https" },
      secret: new Uint8Array(32).fill(7),
      hostOrigins: [HOST],
      configs: { artifact: nested() },
      artifacts: {
        get: (id: string) =>
          Promise.resolve(
            id === "single"
              ? { html: "<!doctype html><p>one page</p>" }
              : {
                  files: Object.fromEntries(
                    Object.entries(files).map(([name, body]) => [
                      name,
                      { size: encode(body).byteLength, sha256: "", type: "text/plain" },
                    ]),
                  ),
                  read: (name: string) =>
                    Promise.resolve(files[name] === undefined ? null : encode(files[name] ?? "")),
                },
          ),
      },
    });
  /** A browser's request: framed (`iframe`), a script, or a fetch, from `site`. */
  const ask = (url: string, dest: "iframe" | "script" | "empty", site: string) =>
    new Request(url, {
      headers: {
        "sec-fetch-dest": dest,
        "sec-fetch-mode": dest === "iframe" ? "navigate" : dest === "script" ? "no-cors" : "cors",
        "sec-fetch-site": site,
      },
    });

  for (const id of ["set", "single"]) {
    test(`a ${id === "set" ? "set of files" : "single page"}: the framed address is the shell; the page, at its sealed address with no cookie, is sandboxed to scripts and hears the shell alone`, async () => {
      const porthole = server();
      const location = await porthole.issue(
        { scope: id, document: { kind: "artifact", id, version: "1" } },
        { viewer: "ada" },
      );
      const shell = await porthole.handle(ask(location.url, "iframe", "cross-site"));
      expect(shell?.status).toBe(200);
      const html = (await shell?.text()) ?? "";
      expect(html).not.toContain("one page");
      expect(html).not.toContain("files</body>");
      const page = /"page":"([^"]+)"/u.exec(html)?.[1] ?? "";
      expect(page.startsWith(`${location.origin}/__porthole/f/`)).toBe(true);
      // The page, as the shell's child asks for it: framed, from an opaque origin, no cookie.
      const answer = await porthole.handle(ask(page, "iframe", "cross-site"));
      expect(answer?.status).toBe(200);
      const csp = answer?.headers.get("content-security-policy") ?? "";
      expect(csp).toMatch(/; sandbox allow-scripts;/u);
      expect(csp).not.toContain("allow-same-origin");
      expect(csp).toContain(`frame-ancestors ${location.origin} ${HOST}`);
      const body = (await answer?.text()) ?? "";
      expect(body).toContain(`"origins":["${location.origin}"]`);
      expect(body).toContain('"storage":"memory"');
      expect(body).not.toContain(HOST);
    });
  }

  test("its files load from the opaque page: any origin's resource policy and CORS, their access in the path", async () => {
    const porthole = server();
    const location = await porthole.issue(
      { scope: "set", document: { kind: "artifact", id: "set", version: "1" } },
      { viewer: "ada" },
    );
    const html =
      (await (await porthole.handle(ask(location.url, "iframe", "cross-site")))?.text()) ?? "";
    const page = /"page":"([^"]+)"/u.exec(html)?.[1] ?? "";
    const script = await porthole.handle(ask(new URL("app.js", page).href, "script", "cross-site"));
    expect(script?.status).toBe(200);
    expect(script?.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(script?.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("only the shell renews the page's sealed address: same-origin, not the opaque page", async () => {
    const porthole = server();
    const location = await porthole.issue(
      { scope: "set", document: { kind: "artifact", id: "set", version: "1" } },
      { viewer: "ada" },
    );
    const html =
      (await (await porthole.handle(ask(location.url, "iframe", "cross-site")))?.text()) ?? "";
    const renew = /"renew":\{"url":"([^"]+)"/u.exec(html)?.[1] ?? "";
    expect(renew).toMatch(/\/__porthole\/f\/[^/]+\/__porthole\/renew$/u);
    expect((await porthole.handle(ask(renew, "empty", "same-origin")))?.status).toBe(200);
    expect((await porthole.handle(ask(renew, "empty", "cross-site")))?.status).toBe(403);
  });

  test("a subresource asked at the framed address gets nothing: the page's files are at its own", async () => {
    const porthole = server();
    const location = await porthole.issue(
      { scope: "set", document: { kind: "artifact", id: "set", version: "1" } },
      { viewer: "ada" },
    );
    expect((await porthole.handle(ask(location.url, "script", "cross-site")))?.status).toBe(404);
  });
});
