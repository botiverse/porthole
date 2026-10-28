import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { presets } from "../src/index.ts";
import type { InstanceRef } from "../src/isolation/types.ts";
import {
  createContentHost,
  nestedLabelOf,
  prefixedName,
  type ContentHostOptions,
  type EntryOptions,
} from "../src/server/index.ts";

/**
 * Redirect entry (P068): a clean address opens directly. Without a cookie, the content origin
 * sends the browser to the app's authorize route, which decides and sends it back with a one-time
 * code bound to the address and to the browser that asked.
 */

const APP = "https://app.example.com";
const AUTHORIZE = `${APP}/porthole/authorize`;
const SECRET = "a test secret that is at least thirty-two bytes long";
const origin = (scope: string) => `https://a-${scope}.usercontent.example.net`;

const page = (scope: string, version = "1"): InstanceRef => ({
  scope,
  document: { kind: "artifact", id: scope, version },
});

interface Viewer {
  readonly id: string;
}

function kit(
  extra: Partial<ContentHostOptions<Viewer>> = {},
  entry: Partial<EntryOptions<Viewer>> = {},
) {
  const signIns: string[] = [];
  const content = createContentHost<Viewer>({
    domain: "usercontent.example.net",
    appOrigins: [APP],
    secret: SECRET,
    configs: (source) => ({
      artifact: presets.artifact({ isolation: "domain", contentOrigins: [source] }),
    }),
    name: prefixedName("a-"),
    instance: () => null,
    access: (instance, viewer) =>
      instance.scope.startsWith("secret")
        ? null
        : viewer !== null
          ? { viewer: viewer.id, subject: viewer.id }
          : instance.scope.startsWith("public")
            ? { anonymous: true }
            : null,
    source: (id, version) =>
      Promise.resolve({
        html: `<!doctype html><title>${id}</title><h1 id="t">${id} v${version}</h1>`,
      }),
    entry: {
      authorizeUrl: AUTHORIZE,
      // The address's path names the version: / is the first, /v/2 the second.
      at: (scope, path) =>
        path === "/" ? page(scope) : /^\/v\/\d$/u.test(path) ? page(scope, path.slice(3)) : null,
      signIn: (returnTo) => {
        signIns.push(returnTo);
        return new Response(null, {
          status: 303,
          headers: { location: `${APP}/signin?next=${encodeURIComponent(returnTo)}` },
        });
      },
      ...entry,
    },
    ...extra,
  });
  const authorize = content.authorize((request) => {
    const who = request.headers.get("x-viewer");
    return who === null ? null : { id: who };
  });
  return { content, authorize, signIns };
}

/** A browser's cookie jar, per host; what each request sends and each answer sets. */
class Browser {
  readonly jar = new Map<string, Map<string, string>>();
  readonly dest: "document" | "iframe";

  constructor(dest: "document" | "iframe" = "document") {
    this.dest = dest;
  }

  headers(url: string, extra: Record<string, string> = {}): Headers {
    const host = new URL(url).host;
    const cookies = [...(this.jar.get(host) ?? new Map<string, string>())]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    return new Headers({
      "sec-fetch-dest": this.dest,
      ...(cookies === "" ? {} : { cookie: cookies }),
      ...extra,
    });
  }

  keep(url: string, response: Response): void {
    const host = new URL(url).host;
    const cookies = this.jar.get(host) ?? new Map<string, string>();
    for (const each of response.headers.getSetCookie()) {
      const [pair = ""] = each.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      if (/max-age=0(;|$)/iu.test(each)) {
        cookies.delete(name);
      } else {
        cookies.set(name, pair.slice(at + 1));
      }
    }
    this.jar.set(host, cookies);
  }
}

/** One request through the content host or the app's authorize route, as a browser sends it. */
async function visit(
  { content, authorize }: ReturnType<typeof kit>,
  browser: Browser,
  url: string,
  viewer?: string,
): Promise<Response> {
  const request = new Request(url, {
    headers: browser.headers(url, viewer === undefined ? {} : { "x-viewer": viewer }),
  });
  const answer = url.startsWith(APP) ? await authorize(request) : await content.fetch(request);
  if (answer === null) {
    throw new Error(`nothing answered ${url}`);
  }
  browser.keep(url, answer);
  return answer;
}

/** Follows redirects as a browser does, returning each hop's URL and the last answer. */
async function open(
  app: ReturnType<typeof kit>,
  browser: Browser,
  url: string,
  viewer?: string,
): Promise<{ readonly hops: string[]; readonly answer: Response; readonly at: string }> {
  const hops = [url];
  let at = url;
  let answer = await visit(app, browser, at, viewer);
  while (answer.status === 302 || answer.status === 303) {
    const location = answer.headers.get("location") ?? "";
    at = new URL(location, at).href;
    hops.push(at);
    if (at.startsWith(`${APP}/signin`)) {
      break;
    }
    answer = await visit(app, browser, at, viewer);
  }
  return { hops, answer, at };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a clean address opened directly", () => {
  it("signed in: authorize, a one-time code, the session, then the clean address itself", async () => {
    const app = kit();
    const browser = new Browser();
    const clean = app.content.urlOf("abc", "/v/2?tab=notes");
    expect(clean).toBe(`${origin("abc")}/v/2?tab=notes`);
    const { hops, answer, at } = await open(app, browser, clean ?? "", "ada");
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("abc v2");
    // There and back: the app's route, the code's one hop, the clean address again.
    expect(hops.map((each) => new URL(each).origin + new URL(each).pathname)).toEqual([
      `${origin("abc")}/v/2`,
      AUTHORIZE,
      `${origin("abc")}/__porthole/entry`,
      `${origin("abc")}/v/2`,
    ]);
    expect(at).toBe(clean);
    expect(hops.filter((each) => each.includes("code=")).length).toBe(1);
    // A reload rides on the session: no redirect.
    const again = await visit(app, browser, clean ?? "");
    expect(again.status).toBe(200);
    // Another path names another instance: entered on its own.
    const first = await open(app, browser, `${origin("abc")}/`, "ada");
    expect(await first.answer.text()).toContain("abc v1");
    expect(first.hops.length).toBe(4);
  });

  it("each redirect strips the referrer and isn't cached; the code leaves the address in one hop", async () => {
    const app = kit();
    const browser = new Browser();
    const begin = await visit(app, browser, `${origin("abc")}/`);
    expect(begin.status).toBe(302);
    for (const answer of [begin]) {
      expect(answer.headers.get("referrer-policy")).toBe("no-referrer");
      expect(answer.headers.get("cache-control")).toBe("no-store");
    }
    const authorized = await visit(app, browser, begin.headers.get("location") ?? "", "ada");
    expect(authorized.status).toBe(302);
    expect(authorized.headers.get("referrer-policy")).toBe("no-referrer");
    const redeemed = await visit(app, browser, authorized.headers.get("location") ?? "");
    expect(redeemed.status).toBe(303);
    expect(redeemed.headers.get("referrer-policy")).toBe("no-referrer");
    expect(redeemed.headers.get("location")).toBe(`${origin("abc")}/`);
    // The session cookie is the content origin's alone, never readable by script.
    const session = redeemed.headers
      .getSetCookie()
      .find((each) => each.startsWith("__Host-porthole-") && !each.includes("-n-"));
    expect(session).toMatch(/HttpOnly/u);
    expect(session).toMatch(/SameSite=Lax/u);
  });

  it("a replayed code, and a code taken to another instance's origin, are refused", async () => {
    const app = kit();
    const browser = new Browser();
    const begin = await visit(app, browser, `${origin("abc")}/`);
    const authorized = await visit(app, browser, begin.headers.get("location") ?? "", "ada");
    const code = new URL(authorized.headers.get("location") ?? "").searchParams.get("code") ?? "";
    // Taken to another origin: refused there (and spent).
    const elsewhere = await visit(app, browser, `${origin("xyz")}/__porthole/entry?code=${code}`);
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.text()).not.toContain('id="t"');
    const spent = await visit(app, browser, `${origin("abc")}/__porthole/entry?code=${code}`);
    expect(spent.status).toBe(403);
    // A fresh one, used twice.
    const again = await visit(app, browser, `${origin("abc")}/`);
    const second = await visit(app, browser, again.headers.get("location") ?? "", "ada");
    const url = second.headers.get("location") ?? "";
    expect((await visit(app, browser, url)).status).toBe(303);
    expect((await visit(app, browser, url)).status).toBe(403);
  });

  it("a code redeemed by a browser that didn't ask is refused (the state's nonce cookie)", async () => {
    const app = kit();
    const asker = new Browser();
    const begin = await visit(app, asker, `${origin("abc")}/`);
    const authorized = await visit(app, asker, begin.headers.get("location") ?? "", "ada");
    // Another browser (a victim sent the attacker's code), or one that keeps no cookie here.
    const other = new Browser();
    const answer = await visit(app, other, authorized.headers.get("location") ?? "");
    expect(answer.status).toBe(401);
    expect(await answer.text()).toContain('data-porthole-reason="cookies"');
    expect(answer.headers.getSetCookie().some((each) => each.includes("porthole-a"))).toBe(false);
  });

  it("signed out on a tab: the app's own sign-in, coming back to the authorize route", async () => {
    const app = kit();
    const browser = new Browser();
    const { at } = await open(app, browser, `${origin("abc")}/v/2`);
    expect(at.startsWith(`${APP}/signin?next=`)).toBe(true);
    expect(app.signIns).toHaveLength(1);
    expect(app.signIns[0]?.startsWith(`${AUTHORIZE}?state=`)).toBe(true);
    // Signed in, back at the authorize route with the same state: on to the content.
    const back = await open(app, browser, app.signIns[0] ?? "", "ada");
    expect(back.answer.status).toBe(200);
    expect(back.at).toBe(`${origin("abc")}/v/2`);
  });

  it("signed out in a frame: never the app's sign-in, a page asking for a tab", async () => {
    const app = kit();
    const browser = new Browser("iframe");
    const { answer, at } = await open(app, browser, `${origin("abc")}/`);
    expect(at.startsWith(AUTHORIZE)).toBe(true);
    expect(answer.status).toBe(401);
    const text = await answer.text();
    expect(text).toContain('data-porthole-reason="sign-in"');
    expect(text).toContain("Open this in a new tab to sign in");
    expect(app.signIns).toHaveLength(0);
    expect(answer.headers.get("content-security-policy")).toContain(`frame-ancestors ${APP}`);
  });

  it("a public page opens signed out, anonymously", async () => {
    const app = kit();
    const { answer } = await open(app, new Browser(), `${origin("public1")}/`);
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("public1 v1");
  });

  it("no access: the app's refusal on a tab, a plain page in a frame, never content", async () => {
    const refusals: number[] = [];
    const app = kit(
      {},
      {
        refusal: (status) => {
          refusals.push(status);
          return new Response("<h1>The app's own refusal</h1>", { status });
        },
      },
    );
    const tab = await open(app, new Browser(), `${origin("secret1")}/`, "ada");
    expect(tab.answer.status).toBe(403);
    expect(await tab.answer.text()).toBe("<h1>The app's own refusal</h1>");
    expect(refusals).toEqual([403]);
    const framed = await open(app, new Browser("iframe"), `${origin("secret1")}/`, "ada");
    expect(framed.answer.status).toBe(403);
    expect(await framed.answer.text()).toContain('data-porthole-reason="denied"');
    // An address that names nothing is a 404 on the content origin: no trip to the app (P070).
    const missing = await open(app, new Browser(), `${origin("abc")}/nothing`, "ada");
    expect(missing.answer.status).toBe(404);
    expect(missing.hops).toHaveLength(1);
    expect(refusals).toEqual([403]);
  });

  it("a refusal hook that answers nothing falls back to Porthole's page, and gets the address decoded", async () => {
    const seen: unknown[] = [];
    const app = kit(
      {},
      {
        refusal: (_status, _request, entry) => {
          seen.push(entry);
          return null;
        },
      },
    );
    const { answer } = await open(app, new Browser(), `${origin("secret2")}/?x=1`, "ada");
    expect(answer.status).toBe(403);
    expect(await answer.text()).toContain('data-porthole-reason="denied"');
    expect(seen).toEqual([
      {
        label: "a-secret2",
        scope: "secret2",
        path: "/?x=1",
        url: `${origin("secret2")}/?x=1`,
        instance: page("secret2"),
        framed: false,
      },
    ]);
  });

  it("the sign-in hook gets the address being opened", async () => {
    const contexts: unknown[] = [];
    const app = kit(
      {},
      {
        signIn: (_returnTo, _request, entry) => {
          contexts.push(entry);
          return new Response(null, { status: 303, headers: { location: `${APP}/signin` } });
        },
      },
    );
    await open(app, new Browser(), `${origin("abc")}/v/2`);
    expect(contexts).toEqual([
      expect.objectContaining({
        scope: "abc",
        path: "/v/2",
        instance: page("abc", "2"),
        framed: false,
      }),
    ]);
  });

  it("a state that isn't the server's, or is too old, gets no code", async () => {
    vi.useFakeTimers();
    const app = kit();
    const browser = new Browser();
    const begin = await visit(app, browser, `${origin("abc")}/`);
    const location = new URL(begin.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    const forged = new URL(location);
    forged.searchParams.set("state", `${state.split(".")[0]}.${"A".repeat(43)}`);
    expect((await visit(app, browser, forged.href, "ada")).status).toBe(400);
    vi.advanceTimersByTime(6 * 60_000);
    const old = await visit(app, browser, location.href, "ada");
    expect(old.status).toBe(401);
    expect(await old.text()).toContain("This took too long");
  });

  it("a browser that keeps the code's answer but not its session doesn't loop", async () => {
    const app = kit();
    const browser = new Browser();
    const begin = await visit(app, browser, `${origin("abc")}/`);
    const authorized = await visit(app, browser, begin.headers.get("location") ?? "", "ada");
    await visit(app, browser, authorized.headers.get("location") ?? "");
    // The session cookie dropped; the entered mark kept.
    const jar = browser.jar.get(new URL(origin("abc")).host);
    for (const name of jar?.keys() ?? []) {
      if (!name.includes("-n-")) {
        jar?.delete(name);
      }
    }
    const answer = await visit(app, browser, `${origin("abc")}/`);
    expect(answer.status).toBe(401);
    expect(await answer.text()).toContain('data-porthole-reason="cookies"');
  });

  it("the return path is the instance's own: a path that reads as another host stays on its origin", async () => {
    const app = kit({}, { at: (scope) => page(scope) });
    const { hops } = await open(app, new Browser(), `${origin("abc")}//evil.example/x`, "ada");
    for (const hop of hops) {
      expect([new URL(AUTHORIZE).origin, origin("abc")]).toContain(new URL(hop).origin);
    }
  });

  it("an instance served on another origin than the address is refused at authorize", async () => {
    const app = kit({}, { at: () => page("other") });
    const { answer } = await open(app, new Browser(), `${origin("abc")}/`, "ada");
    expect(answer.status).toBe(409);
  });
});

describe("a nested page's clean address (P114)", () => {
  const SITE = "usercontent.example.net";
  const encode = (text: string) => new TextEncoder().encode(text);
  const files: Record<string, string> = {
    "index.html": '<!doctype html><title>set</title><h1 id="t">entry</h1>',
    "docs/a.html": '<!doctype html><title>a</title><h1 id="t">a</h1>',
  };
  const nestedKit = () =>
    kit(
      {
        configs: (source) => ({
          artifact: presets.artifact({
            isolation: "domain",
            contentOrigins: [source],
            nested: true,
          }),
        }),
        source: () =>
          Promise.resolve({
            files: Object.fromEntries(
              Object.entries(files).map(([name, body]) => [
                name,
                { size: encode(body).byteLength, sha256: "", type: "text/html" },
              ]),
            ),
            read: (name: string) =>
              Promise.resolve(files[name] === undefined ? null : encode(files[name] ?? "")),
          }),
      },
      {
        at: (scope, path) =>
          path.startsWith("/v/1/")
            ? { instance: page(scope), base: "/v/1/", file: path.slice(5), pinned: true }
            : null,
      },
    );

  it("goes on to the shell's own label with a ticket of its own, the page it was entered at below its base", async () => {
    const app = nestedKit();
    const browser = new Browser();
    const clean = `${origin("abc")}/v/1/docs/a.html`;
    const { hops, answer, at } = await open(app, browser, clean, "ada");
    const shell = `https://${nestedLabelOf("a-abc")}.${SITE}`;
    expect(shell).toMatch(/^https:\/\/porthole-[a-z2-7]{24}\.usercontent\.example\.net$/u);
    expect(hops.map((each) => new URL(each).origin + new URL(each).pathname).slice(0, 4)).toEqual([
      `${origin("abc")}/v/1/docs/a.html`,
      AUTHORIZE,
      `${origin("abc")}/__porthole/entry`,
      `${origin("abc")}/v/1/docs/a.html`,
    ]);
    // The scope's label never answers the shell: it sends the browser on, once.
    expect(new URL(at).origin).toBe(shell);
    expect(new URL(at).pathname).toMatch(/^\/__porthole\/d\/[a-z2-7]{16}$/u);
    expect(new URL(at).searchParams.get("ticket")).not.toBeNull();
    expect(answer.status).toBe(200);
    const html = await answer.text();
    expect(html).toContain("<title>Porthole</title>");
    expect(html).not.toContain('id="t"');
    const framed = /"page":"([^"]+)"/u.exec(html)?.[1] ?? "";
    expect(framed.startsWith(`${shell}/__porthole/f/`)).toBe(true);
    expect(framed.endsWith("/docs/a.html")).toBe(true);
    // The shell's label keeps a session of its own: a reload there opens without a ticket.
    const reload = await visit(app, browser, `${shell}${new URL(at).pathname}`);
    expect(reload.status).toBe(200);
    expect(await reload.text()).toContain("<title>Porthole</title>");
    // The ticket was one use.
    expect((await visit(app, new Browser(), at)).status).toBe(401);
    // Entered again, the scope's label sends it on again; it never serves the shell itself.
    const again = await visit(app, browser, clean);
    expect(again.status).toBe(303);
    expect(new URL(again.headers.get("location") ?? "").origin).toBe(shell);
  });

  it("an entry code is never a ticket at the shell's label: only its own browser redeems it, at its entry", async () => {
    const app = nestedKit();
    // The instance's document address on the shell's label, from one entry of the person's own.
    const { at } = await open(app, new Browser(), `${origin("abc")}/v/1/`, "ada");
    const document = `${new URL(at).origin}${new URL(at).pathname}`;
    // An attacker's code, taken to another browser at that address: no shell, no session.
    const attacker = new Browser();
    const begin = await visit(app, attacker, `${origin("abc")}/v/1/`);
    const authorized = await visit(app, attacker, begin.headers.get("location") ?? "", "eve");
    const code = new URL(authorized.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const victim = new Browser();
    const answer = await visit(app, victim, `${document}?ticket=${code}`);
    expect(answer.status).toBe(401);
    expect(await answer.text()).not.toContain("<title>Porthole</title>");
    expect(answer.headers.getSetCookie()).toEqual([]);
  });
});

describe("addresses that name nothing (P070)", () => {
  it("a label the naming never makes, the bare domain, and a path that names nothing: Porthole's 404, never the authorize route", async () => {
    const app = kit();
    for (const url of [
      "https://www.usercontent.example.net/",
      "https://f.usercontent.example.net/",
      "https://usercontent.example.net/",
      "https://zz-garbage.usercontent.example.net/x",
      "https://x.f.usercontent.example.net/",
      `${origin("abc")}/v/x`,
    ]) {
      const answer = await visit(app, new Browser(), url);
      expect(answer.status, url).toBe(404);
      expect(answer.headers.get("location"), url).toBeNull();
    }
  });

  it("an app's at that answers undefined means nothing too", async () => {
    const app = kit({}, { at: () => undefined });
    const answer = await visit(app, new Browser(), `${origin("abc")}/`);
    expect(answer.status).toBe(404);
  });

  it("a reserved label is still the app's: handed back, not answered", async () => {
    const app = kit({ reserved: ["p-*"] });
    const answer = await app.content.fetch(
      new Request("https://p-preview.usercontent.example.net/"),
    );
    expect(answer).toBeNull();
  });
});

describe("settings", () => {
  it("redirect entry needs a naming that says a label's scope", () => {
    expect(() => kit({ name: (scope: string) => `a-${scope}` })).toThrow(/prefixedName/u);
  });

  it("the authorize route must be on an app origin", () => {
    expect(() => kit({}, { authorizeUrl: "https://elsewhere.example/authorize" })).toThrow(
      /host origins/u,
    );
  });

  it("the page's frame sources add the authorize route, by its path only", () => {
    expect(kit().content.frameSources).toContain(AUTHORIZE);
  });

  it("clean addresses are never Porthole's own paths", () => {
    expect(() => kit().content.urlOf("abc", "/__porthole/d/x")).toThrow();
    expect(() => kit().content.urlOf("abc", "//evil.example")).toThrow();
  });

  it("the authorize route's pages carry their one script under its hash", async () => {
    const app = kit();
    const answer = await app.authorize(new Request(`${AUTHORIZE}?state=nope`));
    const text = await answer.text();
    const script = /<script>([\s\S]*)<\/script>/u.exec(text)?.[1] ?? "";
    const hash = createHash("sha256").update(script).digest("base64");
    expect(answer.headers.get("content-security-policy")).toContain(`script-src 'sha256-${hash}'`);
  });
});
