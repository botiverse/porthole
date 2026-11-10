import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { presets } from "../src/index.ts";
import type { InstanceRef } from "../src/isolation/types.ts";
import {
  createContentHost,
  createServer,
  doorStatusResponse,
  statusPage,
  type AuthorizeRequest,
  type Grant,
  type PortholeServer,
  type ServerOptions,
} from "../src/server/index.ts";
import { pageScript, STATUS_SCRIPT_PATH } from "../src/server/pages.ts";

/**
 * Embed grants (P143): a public artifact page that any site may frame, with no host. Only where
 * the server opted in (`embeds`), only anonymous with no level or user, only an artifact's page that
 * isn't nested. The flag is signed into the session and the sealed address; every answer of such a
 * session says `frame-ancestors *`, its documents' plans name no host, and no door is minted.
 * Every other session's answers are as before, byte for byte, on the same server, while an embed
 * session of the same artifact exists.
 */

const secret = new Uint8Array(32).fill(9);
const HOST = "https://app.example.com";
const DOMAIN = "example-usercontent.com";
const CONTENT = `https://*.${DOMAIN}`;

const encode = (text: string) => new TextEncoder().encode(text);
const files: Record<string, string> = {
  "index.html": `<!doctype html><html><head><script src="./app.js"></script></head><body>files</body></html>`,
  "app.js": "window.ran = true;",
  "notes.txt": "hi",
};
const fileSet = {
  files: Object.fromEntries(
    Object.entries(files).map(([name, body]) => [
      name,
      { size: encode(body).byteLength, sha256: "", type: "text/plain" },
    ]),
  ),
  read: (name: string) =>
    Promise.resolve(files[name] === undefined ? null : encode(files[name] ?? "")),
};
const ASSET = "0123456789abcdef0123456789abcdef";

const configs = {
  artifact: presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] }),
  artifactFrames: presets.artifact({
    isolation: "domain",
    contentOrigins: [CONTENT],
    nestedFrames: "own",
  }),
  artifactNested: presets.artifact({
    isolation: "domain",
    contentOrigins: [CONTENT],
    nested: true,
  }),
  inlineWidget: presets.inlineWidget({ isolation: "domain", contentOrigins: [CONTENT] }),
  mcpApp: presets.mcpApp({ isolation: "domain", contentOrigins: [CONTENT] }),
  url: presets.url({ contentOrigins: [CONTENT] }),
};

function server(extra: Partial<ServerOptions> & { readonly asked?: AuthorizeRequest[] } = {}) {
  const { asked, ...rest } = extra;
  return createServer({
    content: { domain: DOMAIN, scheme: "https" },
    secret,
    hostOrigins: [HOST],
    configs,
    artifacts: {
      get: (id) =>
        Promise.resolve(
          id === "gone"
            ? null
            : id === "set"
              ? fileSet
              : { html: "<!doctype html><html><body><p>one</p></body></html>" },
        ),
    },
    assets: {
      get: (id, access) =>
        Promise.resolve(
          id === ASSET && access !== null && access.instance.document.kind === "artifact"
            ? {
                scope: access.instance.scope,
                artifact: access.instance.document.id,
                name: "logo.png",
                size: 3,
                sha256: "a".repeat(64),
                read: () => Promise.resolve(encode("png")),
              }
            : null,
        ),
    },
    authorize: {
      check: (request) => {
        asked?.push(request);
        return request.subject === "deny" ? { allow: false, code: "revoked" } : { allow: true };
      },
    },
    ...rest,
  });
}

const EMBED: Grant = { anonymous: true, embed: true };
const PUBLIC: Grant = { anonymous: true };
const MEMBER: Grant = { viewer: "ada", level: "interact", user: { id: "u1", name: "Ada" } };

const page = (scope: string, id = "page", preset?: string): InstanceRef => ({
  scope,
  document: { kind: "artifact", id, version: "1", ...(preset === undefined ? {} : { preset }) },
});

const ask = (url: string, dest = "iframe", headers: Record<string, string> = {}) =>
  new Request(url, {
    headers: { "sec-fetch-dest": dest, "sec-fetch-site": "cross-site", ...headers },
  });
/** The page's own fetch on its origin (a renewal): same-origin, not a navigation. */
const own = (url: string) =>
  new Request(url, {
    headers: {
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    },
  });

const cookieOf = (response: Response): string =>
  (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

/** The `frame-ancestors` sources of a response's policy (null: none). */
function ancestorsOf(response: Response): string[] | null {
  const policies = (response.headers.get("content-security-policy") ?? "")
    .split(/[;,]/u)
    .map((each) => each.trim())
    .filter((each) => each.startsWith("frame-ancestors "));
  return policies.length === 0 ? null : policies.flatMap((each) => each.split(/\s+/u).slice(1));
}

interface Answer {
  readonly name: string;
  readonly response: Response;
}

/**
 * Every kind of answer a session gets (P141's list, for an artifact): a page's ticket and its
 * cookie's reload, a file set's ticket, its page at its sealed base, a script, a file, a missing
 * file, a renewal and a renewal from elsewhere, a set with its own frames, an asset and a missing
 * one at the sealed address, a refusal of the host's check, a page whose version is gone, and the
 * sealed address once the session ended. `tag` keeps scopes apart per run.
 */
async function everyAnswer(
  porthole: PortholeServer,
  grant: Grant,
  tag: string,
  options: { readonly ended?: boolean } = {},
): Promise<Answer[]> {
  const answers: Answer[] = [];
  const keep = async (name: string, response: Response | null) => {
    expect(response, name).not.toBeNull();
    answers.push({ name, response: response! });
    return response!;
  };
  const single = await porthole.issue(page(`page-${tag}`), grant);
  const shown = await keep("page", await porthole.handle(ask(single.url)));
  expect(shown.status, "page").toBe(200);
  const cookie = cookieOf(shown);
  await keep(
    "page by its cookie",
    await porthole.handle(ask(single.url.replace(/\?ticket=.*$/u, ""), "iframe", { cookie })),
  );
  for (const preset of ["artifact", "artifactFrames"]) {
    const set = await porthole.issue(page(`set-${preset}-${tag}`, "set", preset), grant);
    const entry = await keep(`${preset}: set's ticket`, await porthole.handle(ask(set.url)));
    const base = /"base":"([^"]+)"/u.exec(await entry.clone().text())?.[1];
    expect(base, `${preset}: the set's sealed base`).toBeDefined();
    const at = new URL(base!, set.origin).href;
    await keep(`${preset}: page at its base`, await porthole.handle(ask(at)));
    await keep(`${preset}: script`, await porthole.handle(ask(`${at}app.js`, "script")));
    await keep(`${preset}: text file`, await porthole.handle(ask(`${at}notes.txt`, "empty")));
    await keep(`${preset}: missing file`, await porthole.handle(ask(`${at}nothing.js`, "script")));
    await keep(`${preset}: renewal`, await porthole.handle(own(`${at}__porthole/renew`)));
    await keep(
      `${preset}: renewal from elsewhere`,
      await porthole.handle(ask(`${at}__porthole/renew`, "empty")),
    );
    await keep(
      `${preset}: asset`,
      await porthole.handle(ask(`${at}__porthole/blob/${ASSET}`, "image")),
    );
    await keep(
      `${preset}: missing asset`,
      await porthole.handle(ask(`${at}__porthole/blob/${"f".repeat(32)}`, "image")),
    );
  }
  const denied = await porthole.issue(page(`denied-${tag}`), { ...grant, subject: "deny" });
  const refused = await keep("denied", await porthole.handle(ask(denied.url)));
  expect(refused.status, "denied").toBe(403);
  const gone = await porthole.issue(page(`gone-${tag}`, "gone"), grant);
  const missing = await keep("version gone", await porthole.handle(ask(gone.url)));
  expect(missing.status, "version gone").toBe(404);
  if (options.ended === true) {
    const short = await porthole.issue(page(`ended-${tag}`, "set"), {
      ...grant,
      sessionSeconds: 1,
    });
    const entry = await porthole.handle(ask(short.url));
    const base = /"base":"([^"]+)"/u.exec((await entry?.text()) ?? "")?.[1];
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5_000);
    try {
      const ended = await keep(
        "ended",
        await porthole.handle(ask(new URL(base!, short.origin).href)),
      );
      expect(ended.status, "ended").toBe(401);
    } finally {
      clock.mockRestore();
    }
  }
  return answers;
}

/** An answer with what differs from run to run (sealed addresses, their ends, ETags) evened out. */
async function normal(answer: Answer) {
  const headers = [...answer.response.clone().headers]
    .filter(([name]) => name !== "set-cookie" && name !== "etag")
    .map(([name, value]) => `${name}: ${value}`);
  const body = (await answer.response.clone().text())
    .replace(/\/__porthole\/f\/[A-Za-z0-9_-]{40,}\//gu, "/__porthole/f/<sealed>/")
    .replace(/"expires":\d+/gu, '"expires":0');
  return { name: answer.name, status: answer.response.status, headers, body };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an embed grant is taken only as narrow as P143 says", () => {
  it("is refused without the server's opt-in", async () => {
    await expect(server().issue(page("a"), EMBED)).rejects.toThrow(/embeds: true/u);
    await expect(server({ embeds: false }).issue(page("a"), EMBED)).rejects.toThrow(
      /embeds: true/u,
    );
    expect(() => server({ embeds: "yes" as unknown as boolean })).toThrow(
      /embeds is true or false/u,
    );
  });

  it("is refused with a viewer, a level or a user, and unless it is true", async () => {
    const porthole = server({ embeds: true });
    await expect(
      porthole.issue(page("a"), { viewer: "ada", embed: true } as unknown as Grant),
    ).rejects.toThrow(/anonymous/u);
    await expect(porthole.issue(page("a"), { ...EMBED, level: "view" })).rejects.toThrow(
      /anonymous/u,
    );
    await expect(porthole.issue(page("a"), { ...EMBED, user: { id: "u1" } })).rejects.toThrow(
      /anonymous|user comes with its level/u,
    );
    await expect(
      porthole.issue(page("a"), { anonymous: true, embed: false } as unknown as Grant),
    ).rejects.toThrow(/true or absent/u);
    await expect(
      porthole.issue(page("a"), { anonymous: true, embed: "yes" } as unknown as Grant),
    ).rejects.toThrow(/true or absent/u);
  });

  it("is refused for a url-mode app, a nested display, a served shell and the sandbox proxy", async () => {
    const porthole = server({ embeds: true, upstream: () => new Response("app") });
    await expect(
      porthole.issue(
        { scope: "u", document: { kind: "external", url: "https://app.test/" } },
        EMBED,
      ),
    ).rejects.toThrow(/url-mode/u);
    await expect(porthole.issue(page("n", "set", "artifactNested"), EMBED)).rejects.toThrow(
      /nested/u,
    );
    await expect(
      porthole.issue({ scope: "s", document: { kind: "shell", preset: "inlineWidget" } }, EMBED),
    ).rejects.toThrow(/served shell/u);
    await expect(
      porthole.issue({ scope: "p", document: { kind: "mcp-proxy" } }, EMBED),
    ).rejects.toThrow(/sandbox proxy/u);
  });

  it("mints no door, reports nothing, and has no door answer", async () => {
    const porthole = server({ embeds: true });
    const location = await porthole.issue(page("a"), EMBED);
    expect(location.door).toBeUndefined();
    expect(location.reports).toBe(false);
    expect(location.viewer).toBeUndefined();
    // The same instance's public (non-embed) grant still has its door.
    const normalLocation = await porthole.issue(page("a"), PUBLIC);
    expect(normalLocation.door).toBeDefined();
    expect(normalLocation.reports).toBe(true);
    await expect(porthole.doorAnswer(page("a"), EMBED)).rejects.toThrow(/no door/u);
  });

  it("never opens a clean address (redirect entry)", async () => {
    const porthole = server({ embeds: true, entry: { authorizeUrl: `${HOST}/authorize` } });
    const origin = porthole.originFor("a");
    const begun = await porthole.handle(
      new Request(`${origin}/page/`, {
        headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
      }),
    );
    expect(begun?.status).toBe(302);
    const state = porthole.entryState(
      new URL(begun!.headers.get("location")!).searchParams.get("state")!,
    );
    expect(state).not.toBeNull();
    await expect(porthole.enterBy(state!, page("a"), EMBED)).rejects.toThrow(/clean address/u);
  });

  it("goes through the host kit only where it opted in", async () => {
    const kit = (embeds?: boolean) =>
      createContentHost<null>({
        domain: DOMAIN,
        appOrigins: [HOST],
        secret,
        ...(embeds === undefined ? {} : { embeds }),
        configs: { artifact: configs.artifact },
        source: () => Promise.resolve({ html: "<p>one</p>" }),
        instance: (proposal) => proposal,
        access: () => EMBED,
      });
    const body = JSON.stringify({ instance: page("a") });
    const issue = (embeds?: boolean) =>
      kit(embeds).issue(() => null)(
        new Request(`${HOST}/porthole/frames`, { method: "POST", body }),
      );
    const refused = await issue();
    expect(refused.status).toBe(409);
    const issued = await issue(true);
    expect(issued.status).toBe(201);
    const location = (await issued.json()) as { url: string; door?: unknown; reports: boolean };
    expect(location.door).toBeUndefined();
    expect(location.reports).toBe(false);
  });
});

describe("the embed flag is signed: never added to a session, never taken from one (P143)", () => {
  /** A signed value's payload, rewritten, with its old signature. */
  const forged = (value: string, change: (session: Record<string, unknown>) => void): string => {
    const [payload, signature] = value.split(".");
    const session = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    change(session);
    return `${Buffer.from(JSON.stringify(session)).toString("base64url")}.${signature}`;
  };

  it("an embed session with its flag stripped, or a public one with it added, opens nothing", async () => {
    const porthole = server({ embeds: true });
    const embedded = await porthole.issue(page("a"), EMBED);
    const embedCookie = cookieOf((await porthole.handle(ask(embedded.url)))!);
    const [embedName, embedValue] = embedCookie.split(/=(.*)/su);
    expect(embedName).toMatch(/^__Host-porthole-e-[a-z2-7]{16}$/u);
    const publicLocation = await porthole.issue(page("a"), PUBLIC);
    const publicCookie = cookieOf((await porthole.handle(ask(publicLocation.url)))!);
    const [publicName, publicValue] = publicCookie.split(/=(.*)/su);
    expect(publicName).toBe(embedName!.replace("porthole-e-", "porthole-"));
    const address = embedded.url.replace(/\?ticket=.*$/u, "");
    const reload = (cookie: string) => porthole.handle(ask(address, "iframe", { cookie }));
    // The controls: each as it was minted opens, the embed one framed by any page.
    expect(ancestorsOf((await reload(embedCookie))!)).toEqual(["*"]);
    expect(ancestorsOf((await reload(publicCookie))!)).toEqual([HOST]);
    // Stripped, added: the signature no longer holds.
    const stripped = forged(embedValue!, (session) => delete session.m);
    const added = forged(publicValue!, (session) => (session.m = 1));
    for (const cookie of [
      `${embedName}=${stripped}`,
      `${publicName}=${stripped}`,
      `${publicName}=${added}`,
      `${embedName}=${added}`,
    ]) {
      const answer = (await reload(cookie))!;
      expect(answer.status, cookie).toBe(401);
      expect(ancestorsOf(answer), cookie).toEqual([HOST]);
    }
    // A good session under the other name opens nothing either: the name and the flag agree.
    expect((await reload(`${publicName}=${embedValue}`))!.status).toBe(401);
    expect((await reload(`${embedName}=${publicValue}`))!.status).toBe(401);
  });

  it("a sealed address can't be changed, and an embed session's opens nothing where embeds are off", async () => {
    const porthole = server({ embeds: true });
    const set = await porthole.issue(page("s", "set"), EMBED);
    const base = /"base":"([^"]+)"/u.exec(await (await porthole.handle(ask(set.url)))!.text())?.[1];
    const at = new URL(base!, set.origin).href;
    expect(ancestorsOf((await porthole.handle(ask(at)))!)).toEqual(["*"]);
    const token = /\/f\/([^/]+)\//u.exec(at)![1]!;
    const flipped = `${token.slice(0, 30)}${token[30] === "A" ? "B" : "A"}${token.slice(31)}`;
    const tampered = (await porthole.handle(ask(at.replace(token, flipped))))!;
    expect(tampered.status).toBe(401);
    expect(ancestorsOf(tampered)).not.toContain("*");
    // The same secret without embeds (the host turned them off): the address opens nothing, and
    // its refusal is no embed's.
    const off = server({ embeds: false });
    const refused = (await off.handle(ask(at)))!;
    expect(refused.status).toBe(401);
    expect(ancestorsOf(refused)).not.toContain("*");
    // Its cookie too.
    const embedded = await porthole.issue(page("a"), EMBED);
    const cookie = cookieOf((await porthole.handle(ask(embedded.url)))!);
    const reload = (await off.handle(
      ask(embedded.url.replace(/\?ticket=.*$/u, ""), "iframe", { cookie }),
    ))!;
    expect(reload.status).toBe(401);
    expect(ancestorsOf(reload)).toEqual([HOST]);
  });
});

describe("the bound: frame-ancestors * for an embed session's answers alone (P143)", () => {
  it("every answer of an embed session says * and names no host; none mints a door", async () => {
    const asked: AuthorizeRequest[] = [];
    const porthole = server({ embeds: true, asked });
    const answers = await everyAnswer(porthole, EMBED, "e", { ended: true });
    expect(answers.length).toBe(23);
    for (const { name, response } of answers) {
      expect(ancestorsOf(response), name).toEqual(["*"]);
      const body = await response.clone().text();
      expect(body, name).not.toContain(HOST);
      if (body.includes("data-porthole-hosts")) {
        expect(body, name).toContain('data-porthole-hosts="[]"');
        expect(body, name).toContain("data-porthole-strict-parent");
      }
      if (body.includes("const plan = ")) {
        expect(body, name).toContain('"origins":[]');
      }
    }
    // The host's check is told it is an embed session, every time.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((each) => each.embed === true && each.anonymous)).toBe(true);
  });

  it("every other session's answers are as they were without embeds, byte for byte", async () => {
    for (const grant of [PUBLIC, MEMBER]) {
      const asked: AuthorizeRequest[] = [];
      const withEmbeds = await everyAnswer(server({ embeds: true, asked }), grant, "n", {
        ended: true,
      });
      const without = await everyAnswer(server(), grant, "n", { ended: true });
      expect(withEmbeds.length).toBe(without.length);
      for (const [at, answer] of withEmbeds.entries()) {
        expect(ancestorsOf(answer.response), answer.name).not.toContain("*");
        expect(await normal(answer), answer.name).toEqual(await normal(without[at]!));
      }
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.some((each) => "embed" in each)).toBe(false);
    }
  });

  it("a member's session of the same artifact is unchanged while an embed session of it exists", async () => {
    const porthole = server({ embeds: true });
    // The member's answers before any embed session.
    const before = await everyAnswer(porthole, MEMBER, "same");
    // Embed sessions of the very same instances, on the same server.
    const embedded = await everyAnswer(porthole, EMBED, "same");
    expect(embedded.every((each) => ancestorsOf(each.response)?.join(" ") === "*")).toBe(true);
    // The member again, interleaved with the embed session's own requests.
    const location = await porthole.issue(page("page-same"), MEMBER);
    const embedLocation = await porthole.issue(page("page-same"), EMBED);
    const memberShown = (await porthole.handle(ask(location.url)))!;
    const embedShown = (await porthole.handle(ask(embedLocation.url)))!;
    const memberCookie = cookieOf(memberShown);
    const embedCookie = cookieOf(embedShown);
    expect(ancestorsOf(memberShown)).toEqual([HOST]);
    expect(ancestorsOf(embedShown)).toEqual(["*"]);
    const after = await everyAnswer(porthole, MEMBER, "same");
    expect(after.length).toBe(before.length);
    for (const [at, answer] of after.entries()) {
      expect(ancestorsOf(answer.response), answer.name).not.toContain("*");
      expect(await normal(answer), answer.name).toEqual(await normal(before[at]!));
    }
    // A browser that partitions no cookies sends both: the member's session is the one served.
    const address = location.url.replace(/\?ticket=.*$/u, "");
    for (const cookie of [`${memberCookie}; ${embedCookie}`, `${embedCookie}; ${memberCookie}`]) {
      const both = (await porthole.handle(ask(address, "iframe", { cookie })))!;
      expect(both.status).toBe(200);
      expect(ancestorsOf(both)).toEqual([HOST]);
      expect(await both.text()).toContain(`"origins":["${HOST}"]`);
    }
    // The embed session alone still is one.
    const alone = (await porthole.handle(ask(address, "iframe", { cookie: embedCookie })))!;
    expect(ancestorsOf(alone)).toEqual(["*"]);
    expect(await alone.text()).toContain('"origins":[]');
  });

  it("the host's check answers an embed session apart from any other session", async () => {
    const asked: AuthorizeRequest[] = [];
    const porthole = server({
      embeds: true,
      asked,
      authorize: {
        ttlSeconds: 60,
        check: (request) => {
          asked.push(request);
          return request.embed === true ? { allow: false, code: "no-embeds" } : { allow: true };
        },
      },
    });
    const embedded = await porthole.issue(page("a"), EMBED);
    const refused = (await porthole.handle(ask(embedded.url)))!;
    expect(refused.status).toBe(403);
    expect(ancestorsOf(refused)).toEqual(["*"]);
    expect(await refused.text()).toContain('data-porthole-code="no-embeds"');
    const shown = (await porthole.handle(ask((await porthole.issue(page("a"), PUBLIC)).url)))!;
    expect(shown.status).toBe(200);
    expect(asked.map((each) => each.embed === true)).toEqual([true, false]);
  });
});

describe("cookies stay on their own label (P143, P101)", () => {
  it("embed and other sessions set host-only cookies, never Domain=, over https __Host-", async () => {
    const porthole = server({ embeds: true });
    const cookies: string[] = [];
    for (const grant of [EMBED, PUBLIC, MEMBER]) {
      for (const dest of ["iframe", "document"]) {
        const location = await porthole.issue(page(`c-${dest}`), grant);
        const answer = (await porthole.handle(ask(location.url, dest)))!;
        cookies.push(...answer.headers.getSetCookie());
      }
    }
    expect(cookies).toHaveLength(6);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Host-porthole-/u);
      expect(cookie).not.toMatch(/;\s*domain=/iu);
      expect(cookie).toMatch(/;\s*Path=\/(;|$)/u);
      expect(cookie).toMatch(/;\s*HttpOnly(;|$)/u);
      expect(cookie).toMatch(/;\s*Secure(;|$)/u);
    }
    // In a frame, partitioned (CHIPS): an embed's session is the embedding site's alone.
    expect(cookies.filter((each) => each.includes("Partitioned"))).toHaveLength(3);
  });

  it("on loopback http, no prefix and still no Domain=", async () => {
    const porthole = createServer({
      content: { domain: "content.localhost", scheme: "http", port: 8790 },
      secret,
      hostOrigins: ["http://127.0.0.1:5173"],
      embeds: true,
      configs: {
        artifact: presets.artifact({
          isolation: "domain",
          contentOrigins: ["http://*.content.localhost:8790"],
        }),
      },
      artifacts: { get: () => Promise.resolve({ html: "<p>one</p>" }) },
    });
    for (const grant of [EMBED, PUBLIC]) {
      const location = await porthole.issue(page("l"), grant);
      const answer = (await porthole.handle(ask(location.url)))!;
      const cookie = answer.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/^porthole-/u);
      expect(cookie).not.toMatch(/;\s*domain=/iu);
    }
  });
});

describe("statusPage and doorStatusResponse for an embed (P143)", () => {
  it("are framed by any page and name no host", async () => {
    for (const response of [
      statusPage({
        embed: true,
        status: 404,
        title: "Gone",
        detail: "Not here.",
        reason: "not-found",
      }),
      doorStatusResponse({ embed: true, status: 403, reason: "denied", code: "private" }),
    ]) {
      expect(ancestorsOf(response)).toEqual(["*"]);
      const body = await response.text();
      expect(body).toContain('data-porthole-hosts="[]"');
      expect(body).toContain("data-porthole-strict-parent");
    }
    // Without embed, as before: the host origins.
    const hosted = statusPage({ status: 404, title: "Gone", detail: "x", hostOrigins: [HOST] });
    expect(ancestorsOf(hosted)).toEqual([HOST]);
    expect(await hosted.text()).not.toContain("data-porthole-strict-parent");
  });

  it("their script tells no parent anything", async () => {
    const posted: string[] = [];
    runInNewContext((await pageScript(STATUS_SCRIPT_PATH)?.text()) ?? "", {
      window: {
        parent: { postMessage: (_message: unknown, origin: string) => posted.push(origin) },
      },
      document: {
        querySelector: () => ({
          dataset: {
            portholeHosts: "[]",
            portholeReason: "not-found",
            portholeStatus: "404",
            portholeStrictParent: "",
          },
        }),
      },
      location: { ancestorOrigins: ["https://any.example"] },
    });
    expect(posted).toEqual([]);
  });
});
