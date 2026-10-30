import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, test } from "vitest";
import { compile, presets } from "../src/index.ts";
import {
  INERT_FILE_CSP,
  DOOR_SANDBOX_TOKENS,
  PAGE_SANDBOX_TOKENS,
  sandboxTokens,
  serializeCsp,
  servedSandboxDirective,
} from "../src/compile/policy.ts";
import { ConfigError } from "../src/config/validate.ts";
import {
  KEY_PRESS_MS,
  TYPING_MS,
  personMoved,
  pressPossible,
  shellGesture,
  type FocusMove,
} from "../src/platform/focus-guard.ts";
import { FRAME_SHELL_RUNTIME, frameShellScript } from "../src/shell/frame.ts";
import { nestedFileCsp, nestedShellCsp, nestedShellResponse } from "../src/server/nested.ts";
import { checkFrameLocation, onNestedLabel } from "../src/isolation/served.ts";
import { createServer, isNestedLabel, nestedLabelOf, prefixedName } from "../src/server/index.ts";
import { LIBRARY_FILES } from "../src/libraries/files.generated.ts";

/**
 * A nested page (P111): its config, its sandbox (never `allow-same-origin`, held statically over
 * every sandbox Porthole writes), the shell's document and CSP, and the host's rule on what the
 * shell says. The browsers hold the rest (`leak/served/nested.spec.ts`).
 */

/** A nested page's shell's own origin (P114): a `porthole-` label of the content domain. */
const ORIGIN = `https://porthole-${"a".repeat(24)}.example-usercontent.com`;
/** Its scope's origin, where the scope's other displays run (never the shell's, P121). */
const SCOPE_ORIGIN = "https://a-x.example-usercontent.com";
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
      // A served display's door (P125): scripts alone, from its own list.
      'platform/web.ts: frame.setAttribute("sandbox", DOOR_SANDBOX_TOKENS.join(" "));',
      'shell/frame.ts: frame.setAttribute("sandbox", plan.sandbox);',
    ]);
    expect(DOOR_SANDBOX_TOKENS).toEqual(["allow-scripts"]);
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

/** The shell's script run against a stand-in of its window: what it says, to whom. */
const shellAt = (at = ORIGIN) => {
  const said: { to: "host" | "page"; message: Record<string, unknown> }[] = [];
  const heard: ((event: unknown) => void)[] = [];
  const page = { postMessage: (message: never) => said.push({ to: "page", message }) };
  const parent = { postMessage: (message: never) => said.push({ to: "host", message }) };
  const style = {};
  const context: Record<string, unknown> = {
    parent,
    location: { origin: at, hostname: new URL(at).hostname, ancestorOrigins: [HOST] },
    document: {
      documentElement: { style },
      body: { style, append: () => said.push({ to: "page", message: { framed: true } }) },
      createElement: () => ({ style, setAttribute() {}, contentWindow: page, focus() {} }),
      hasFocus: () => true,
      activeElement: null,
      addEventListener() {},
    },
    navigator: { userActivation: { isActive: false } },
    performance: { now: () => 1_000 },
    requestAnimationFrame: () => 0,
    setInterval: () => 0,
    setTimeout: () => 0,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "message") {
        heard.push(listener);
      }
    },
    URL,
  };
  context.window = context;
  // The script as a host's own Worker might make it for `at` (P121: `frameShellScript` refuses
  // any origin but a shell's own label, so it is moved there by hand).
  vm.runInNewContext(
    frameShellScript({ origins: [HOST], page: `${ORIGIN}/__porthole/f/abc/` }).replaceAll(
      ORIGIN,
      at,
    ),
    context,
  );
  const fromHost = (data: unknown) => {
    for (const listener of heard) {
      listener({ source: parent, origin: HOST, data });
    }
  };
  return { said, fromHost };
};

describe("a nested page's shell on its own label alone (P121)", () => {
  test("frameShellScript and nestedShellResponse refuse any origin but a shell's own label", () => {
    expect(() =>
      frameShellScript({ origins: [HOST], page: `${SCOPE_ORIGIN}/__porthole/f/abc/` }),
    ).toThrow(/nested page's own label/u);
    const options = {
      origin: SCOPE_ORIGIN,
      origins: [HOST],
      page: `${SCOPE_ORIGIN}/__porthole/f/abc/`,
    };
    expect(() => nestedShellResponse(compile(nested()), options)).toThrow(/own label/u);
    // Its page on another origin than its own, even another shell's.
    const other = `https://porthole-${"b".repeat(24)}.example-usercontent.com`;
    expect(() =>
      nestedShellResponse(compile(nested()), {
        origin: ORIGIN,
        origins: [HOST],
        page: `${other}/__porthole/f/abc/`,
      }),
    ).toThrow(TypeError);
    // A label that only starts like one.
    expect(onNestedLabel(`https://porthole-${"a".repeat(23)}.example-usercontent.com`)).toBe(false);
    expect(onNestedLabel(`https://x.porthole-${"a".repeat(24)}.example-usercontent.com`)).toBe(
      false,
    );
    expect(onNestedLabel(ORIGIN)).toBe(true);
  });

  test("the host refuses a nested page's frame located anywhere but a shell's own label", () => {
    const locate = (origin: string, nestedConfig: boolean) => () =>
      checkFrameLocation(
        { url: `${origin}/__porthole/d/${"k".repeat(16)}?t=x`, origin },
        ["https://*.example-usercontent.com"],
        HOST,
        nestedConfig,
      );
    expect(locate(SCOPE_ORIGIN, true)).toThrow(/isn't a nested page's own/u);
    expect(locate(ORIGIN, true)).not.toThrow();
    // A config that doesn't nest: as before.
    expect(locate(SCOPE_ORIGIN, false)).not.toThrow();
  });

  test("a nested page's files' CSP, one source for /server and a Worker of a host's own (nestedFileCsp)", () => {
    const directives = compile(nested()).cspDirectives;
    const page = nestedFileCsp("page", directives);
    expect(page).toMatch(/; sandbox allow-scripts$/u);
    expect(page.startsWith(serializeCsp(directives))).toBe(true);
    expect(nestedFileCsp("script", directives)).toBe(`${serializeCsp(directives)}; sandbox`);
    expect(nestedFileCsp("file", directives)).toBe(INERT_FILE_CSP);
    for (const role of ["page", "script", "file"] as const) {
      expect(nestedFileCsp(role, directives)).not.toContain("allow-same-origin");
    }
  });

  test("the shell made for another origin frames nothing and says nothing there", () => {
    expect(shellAt(SCOPE_ORIGIN).said).toEqual([]);
  });
});

describe("the host's ask to the shell (P120)", () => {
  test("asked to look, the shell says its state at once, naming the ask; the page hears none of it", () => {
    const { said, fromHost } = shellAt();
    expect(
      said.filter((each) => each.to === "page"),
      "it framed its page",
    ).toEqual([{ to: "page", message: { framed: true } }]);
    said.length = 0;
    fromHost({ jsonrpc: "2.0", method: "porthole/shell/look", params: { n: 3 } });
    expect(said).toEqual([
      {
        to: "host",
        message: {
          jsonrpc: "2.0",
          method: "porthole/shell/state",
          params: { supported: true, active: false, ago: null, focused: true, gap: 0, asked: 3 },
        },
      },
    ]);
  });

  test("the host's words in the shell's namespace never reach the page; an ask without a number is none", () => {
    const { said, fromHost } = shellAt();
    said.length = 0;
    fromHost({ jsonrpc: "2.0", method: "porthole/shell/look", params: { n: -1 } });
    fromHost({ jsonrpc: "2.0", method: "porthole/shell/look", params: { n: "1" } });
    fromHost({ jsonrpc: "2.0", method: "porthole/shell/look" });
    fromHost({ jsonrpc: "2.0", method: "porthole/shell/state", params: {} });
    expect(said).toEqual([]);
    fromHost({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {} });
    expect(said.map((each) => each.to)).toEqual(["page"]);
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

  test("a move within KEY_PRESS_MS of the person's last key on the host's page: the page's (P122)", () => {
    expect(personMoved({ ...move, typedAt: 10_000 - KEY_PRESS_MS + 1 })).toBe(false);
    expect(personMoved({ ...move, typedAt: 10_000 - KEY_PRESS_MS })).toBe(true);
    // A press the engine shows still counts.
    expect(personMoved({ ...move, typedAt: 9_990, pressed: true })).toBe(true);
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

  test("where the host's page sees the pointer, an activation while it is off the frame and the person typing is their keys, not a press (P120)", () => {
    // Typing at 9,500, the move at 10,000: within a second of it, the pointer must have come over
    // the frame since.
    expect(pressPossible(true, false, -Infinity, 9_500, 10_000)).toBe(false);
    expect(pressPossible(true, true, 9_400, 9_500, 10_000)).toBe(false);
    expect(pressPossible(true, true, 9_600, 9_500, 10_000)).toBe(true);
    // Not typing within the second; or an engine that never shows the pointer over a frame.
    expect(pressPossible(true, false, -Infinity, 10_000 - TYPING_MS - 1, 10_000)).toBe(true);
    expect(pressPossible(false, false, -Infinity, 9_500, 10_000)).toBe(true);
    // The rule, as the activation turned on (`keyed`, P120 after its review), where the pointer is
    // seen: a key of the person's, not a press; where it isn't, or not keyed, as before.
    const keyed = { ...word, keyed: true };
    const shown = { ...move, shell: { word: keyed, hostInputAt: 9_500, pointerShown: true } };
    expect(personMoved(shown)).toBe(false);
    expect(personMoved({ ...shown, shell: { ...shown.shell, pointerShown: false } })).toBe(true);
    expect(personMoved({ ...shown, shell: { ...shown.shell, word } })).toBe(true);
    // A press the engine shows still counts.
    expect(personMoved({ ...shown, pressed: true })).toBe(true);
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

  test("every file below the sealed prefix carries a sandbox, never allow-same-origin: none opened on its own runs on the shell's origin", async () => {
    const kinds: Record<string, string> = {
      "index.html": "<!doctype html><p>page</p>",
      "about.htm": "<!doctype html><p>about</p>",
      "app.js": "1;",
      "mod.mjs": "export {};",
      "style.css": "p{}",
      "pic.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "data.xml": '<x xmlns:h="http://www.w3.org/1999/xhtml"><h:script>alert(1)</h:script></x>',
      "data.json": "{}",
      "notes.txt": "hi",
      "doc.pdf": "%PDF-1.4",
      "blob.bin": "?",
    };
    const porthole = createServer({
      content: { domain: SITE, scheme: "https" },
      secret: new Uint8Array(32).fill(7),
      hostOrigins: [HOST],
      configs: { artifact: nested() },
      artifacts: {
        get: () =>
          Promise.resolve({
            files: Object.fromEntries(
              Object.entries(kinds).map(([name, body]) => [
                name,
                { size: encode(body).byteLength, sha256: "", type: "text/plain" },
              ]),
            ),
            read: (name: string) =>
              Promise.resolve(kinds[name] === undefined ? null : encode(kinds[name] ?? "")),
          }),
      },
    });
    const location = await porthole.issue(
      { scope: "all", document: { kind: "artifact", id: "all", version: "1" } },
      { viewer: "ada" },
    );
    const html =
      (await (await porthole.handle(ask(location.url, "iframe", "cross-site")))?.text()) ?? "";
    const page = /"page":"([^"]+)"/u.exec(html)?.[1] ?? "";
    for (const name of Object.keys(kinds)) {
      // As a tab opens it: a navigation, top-level.
      const answer = await porthole.handle(
        new Request(new URL(name, page).href, {
          headers: {
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "none",
          },
        }),
      );
      expect(answer?.status, name).toBe(200);
      const csp = answer?.headers.get("content-security-policy") ?? "";
      expect(csp, `${name}: a sandbox`).toMatch(/(^|; )sandbox( allow-scripts)?(;|$)/u);
      expect(csp, `${name}: never allow-same-origin`).not.toContain("allow-same-origin");
    }
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

describe("a nested page's shell on a label of its own (P114, porthole#56)", () => {
  const SITE = "example-usercontent.com";
  const SOURCE = `https://*.${SITE}`;
  const encode = (text: string) => new TextEncoder().encode(text);
  const files: Record<string, string> = {
    "index.html": "<!doctype html><p>files</p>",
    "app.js": "window.ran = true;",
  };
  const server = (more: { name?: (scope: string) => string; reserved?: string[] } = {}) =>
    createServer({
      content: { domain: SITE, scheme: "https", ...more },
      secret: new Uint8Array(32).fill(7),
      hostOrigins: [HOST],
      configs: {
        artifact: nested(),
        plain: presets.artifact({ isolation: "domain", contentOrigins: [SOURCE] }),
        inlineWidget: presets.inlineWidget({ isolation: "domain", contentOrigins: [SOURCE] }),
      },
      artifacts: {
        get: () =>
          Promise.resolve({
            files: Object.fromEntries(
              Object.entries(files).map(([name, body]) => [
                name,
                { size: encode(body).byteLength, sha256: "", type: "text/plain" },
              ]),
            ),
            read: (name: string) =>
              Promise.resolve(files[name] === undefined ? null : encode(files[name] ?? "")),
          }),
      },
      assets: { get: () => Promise.resolve(null) },
    });
  const framed = (url: string) =>
    new Request(url, {
      headers: {
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
      },
    });
  const nestedPage = (scope: string) => ({
    scope,
    document: { kind: "artifact" as const, id: "set", version: "1" },
  });
  const plainPage = (scope: string) => ({
    scope,
    document: { kind: "artifact" as const, id: "set", version: "1", preset: "plain" },
  });

  test("the shell's label is its scope's own, one per scope, never a content label: its frame, its page and its files are there", async () => {
    const porthole = server({ name: prefixedName("a-") });
    const location = await porthole.issue(nestedPage("k3x9"), { viewer: "ada" });
    const label = nestedLabelOf("a-k3x9");
    expect(isNestedLabel(label)).toBe(true);
    expect(label).toMatch(/^porthole-[a-z2-7]{24}$/u);
    expect(location.origin).toBe(`https://${label}.${SITE}`);
    expect(location.origin).not.toBe(porthole.originFor("k3x9"));
    expect(new URL(location.url).origin).toBe(location.origin);
    // One per scope: another nested page of it shares it, another scope's is another.
    const again = await porthole.issue(
      { scope: "k3x9", document: { kind: "artifact", id: "other", version: "2" } },
      { viewer: "ada" },
    );
    expect(again.origin).toBe(location.origin);
    expect((await porthole.issue(nestedPage("k3x8"), { viewer: "ada" })).origin).not.toBe(
      location.origin,
    );
    // The scope's other displays stay on the scope's label.
    expect((await porthole.issue(plainPage("k3x9"), { viewer: "ada" })).origin).toBe(
      porthole.originFor("k3x9"),
    );
    const shell = await porthole.handle(framed(location.url));
    expect(shell?.status).toBe(200);
    const csp = shell?.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`frame-src ${location.origin}/__porthole/f/`);
    const html = (await shell?.text()) ?? "";
    const page = /"page":"([^"]+)"/u.exec(html)?.[1] ?? "";
    expect(page.startsWith(`${location.origin}/__porthole/f/`)).toBe(true);
    const answer = await porthole.handle(framed(page));
    expect(answer?.status).toBe(200);
    expect(answer?.headers.get("content-security-policy")).toContain(
      `frame-ancestors ${location.origin} ${HOST}`,
    );
    // The keyed default names its shells the same way.
    const keyed = server();
    const keyedAt = await keyed.issue(nestedPage("k3x9"), { viewer: "ada" });
    expect(keyedAt.origin).toBe(
      `https://${nestedLabelOf(new URL(keyed.originFor("k3x9")).hostname.split(".")[0] ?? "")}.${SITE}`,
    );
  });

  test("the scope's label never answers a nested page: not its frame's ticket, not its sealed address", async () => {
    const porthole = server({ name: prefixedName("a-") });
    const scope = porthole.originFor("k3x9");
    const location = await porthole.issue(nestedPage("k3x9"), { viewer: "ada" });
    const moved = `${scope}${new URL(location.url).pathname}${new URL(location.url).search}`;
    const there = await porthole.handle(framed(moved));
    expect(there?.status).toBe(401);
    expect(await there?.text()).not.toContain("<title>Porthole</title>");
    // Its sealed address, taken to the scope's label: nothing.
    const fresh = await porthole.issue(nestedPage("k3x9"), { viewer: "ada" });
    const html = (await (await porthole.handle(framed(fresh.url)))?.text()) ?? "";
    const page = new URL(/"page":"([^"]+)"/u.exec(html)?.[1] ?? "");
    for (const address of [page.pathname, `${page.pathname}app.js`]) {
      const answer = await porthole.handle(framed(`${scope}${address}`));
      expect(answer?.status, address).toBe(401);
    }
  });

  test("the shell's label answers nothing but nested pages: no other display, clean address, asset, library, entry or app", async () => {
    const porthole = server({ name: prefixedName("a-") });
    const shell = `https://${nestedLabelOf("a-k3x9")}.${SITE}`;
    // Another display of the scope, its ticket taken to the shell's label: refused (and spent).
    for (const instance of [
      plainPage("k3x9"),
      { scope: "k3x9", document: { kind: "shell" as const, preset: "inlineWidget" } },
    ]) {
      const location = await porthole.issue(instance, { viewer: "ada" });
      const url = new URL(location.url);
      const answer = await porthole.handle(framed(`${shell}${url.pathname}${url.search}`));
      expect(answer?.status, instance.document.kind).toBe(401);
    }
    // A plain page's sealed address, taken there: refused.
    const plain = await porthole.issue(plainPage("k3x9"), { viewer: "ada" });
    const html = (await (await porthole.handle(framed(plain.url)))?.text()) ?? "";
    const sealed = /\/__porthole\/f\/[A-Za-z0-9_-]{40,}\//u.exec(html)?.[0] ?? "";
    expect(sealed).not.toBe("");
    expect((await porthole.handle(framed(`${shell}${sealed}`)))?.status).toBe(401);
    const library = Object.keys(LIBRARY_FILES)[0] ?? "";
    expect(library).not.toBe("");
    expect((await porthole.handle(framed(`${porthole.originFor("k3x9")}${library}`)))?.status).toBe(
      200,
    );
    for (const address of [
      "/",
      "/v/1/",
      `/_blob/${"a".repeat(32)}`,
      library,
      "/__porthole/entry?code=x",
      "/__porthole/enter?ticket=x",
      "/__porthole/session",
    ]) {
      const answer = await porthole.handle(framed(`${shell}${address}`));
      expect(answer?.status, address).toBe(404);
    }
    // A label of Porthole's form that names no scope's shell is nothing either, and any other
    // porthole- label isn't served.
    expect((await porthole.handle(framed(`https://porthole-x.${SITE}/`)))?.status).toBe(404);
  });

  test("no host's naming makes a porthole- label, and a reserved one is never a shell's", async () => {
    expect(() => prefixedName("porthole-")).toThrow(/Porthole's own/u);
    const named = server({ name: (scope) => `porthole-${scope}` });
    await expect(named.issue(plainPage("x"), { viewer: "ada" })).rejects.toThrow(/porthole-/u);
    const reserved = server({ name: prefixedName("a-"), reserved: ["porthole-*"] });
    await expect(reserved.issue(nestedPage("x"), { viewer: "ada" })).rejects.toThrow(
      /reserve no porthole- label/u,
    );
    // A label reserved by the host is the host's, a shell's form or not.
    expect(await reserved.handle(framed(`https://${nestedLabelOf("a-x")}.${SITE}/`))).toBeNull();
  });
});
