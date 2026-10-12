// A whole Porthole app, runtime-agnostic (a web `Request` in, a `Response` out): agents' HTML
// pages, each version on an origin of its own, framed in the app's viewer and openable at a
// clean address. examples/node/server.mjs and examples/workers/worker.mjs only adapt it.
//
// What is the app's own here (the policy): who is signed in (a cookie), which pages exist, who
// may see each, and what a clean address names. Everything else is Porthole's: one mount
// (`content.routes`, under /porthole) answers frames, the authorize route and the page's meta.
import { conformancePage, createContentHost, prefixedName } from "@botiverse/porthole/server";
import { displays, kinds } from "./displays.mjs";

/** The stored pages: id → versions. An app keeps them in its database. */
const PAGES = {
  hello: {
    owner: null,
    versions: {
      1: `<!doctype html><html><head><title>Hello</title></head><body><h1>Hello from an agent</h1><p id="when"></p><script>document.getElementById("when").textContent = new Date().toDateString();</script></body></html>`,
    },
  },
};

const viewerOf = (request) => {
  const found = /(?:^|;\s*)example-viewer=([a-z]{1,20})(?:;|$)/u.exec(
    request.headers.get("cookie") ?? "",
  );
  return found === null ? null : found[1];
};

const html = (body, headers = {}) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

const escape = (text) => text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

/** Only a path of the app's own comes back from sign-in: never another site's address. */
const ownPath = (next, appOrigin) => {
  if (next?.startsWith(`${appOrigin}/`)) next = next.slice(appOrigin.length);
  return next?.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
};

/**
 * @param {{ appOrigin: string, contentDomain: string, secret: string, tickets?: import("@botiverse/porthole/server").TicketStore,
 *           health?: import("@botiverse/porthole/server").HealthOptions, conformance?: boolean, client: (path: string) => Promise<Response | null> }} settings
 */
export function makeApp(settings) {
  const { appOrigin } = settings;
  const pages = { ...PAGES };
  // TEST MODE, for Porthole's conformance runner only (examples/conformance): pages the suite
  // names itself, and one page no one may see. NEVER enable it in production: anyone signed in
  // could then make content origins of their own choosing.
  if (settings.conformance === true) {
    pages.conformance = {
      owner: null,
      versions: { 1: conformancePage("1"), 2: conformancePage("2") },
    };
    pages.private = { owner: "nobody", versions: { 1: "<!doctype html><p>private</p>" } };
  }
  const page = (scope) =>
    pages[scope]
      ? scope
      : settings.conformance === true && /^t-[a-z0-9-]{1,40}$/u.test(scope)
        ? "conformance"
        : null;
  const latest = (id) => Object.keys(pages[id].versions).at(-1);
  /** Who may see an instance: anyone signed in, but a page with an owner only its owner. */
  const accessOf = (instance, viewer) => {
    const owner = pages[page(instance.scope) ?? ""]?.owner ?? null;
    return viewer !== null && (owner === null || owner === viewer)
      ? { viewer, subject: viewer }
      : null;
  };

  const content = createContentHost({
    domain: settings.contentDomain,
    appOrigins: [appOrigin],
    secret: settings.secret,
    ...(settings.tickets === undefined ? {} : { tickets: settings.tickets }),
    displays,
    name: prefixedName("a-"),
    // Policy 1: the instance a frame request proposes. The server picks the scope, never the client.
    instance: (proposal) => {
      const { document } = proposal;
      if (document.kind !== "artifact") return null;
      if (
        settings.conformance === true &&
        document.id === "conformance" &&
        /^[a-z0-9-]{1,38}$/u.test(proposal.scope)
      ) {
        return {
          scope: `t-${proposal.scope}`,
          document: { kind: "artifact", id: "conformance", version: document.version },
        };
      }
      return pages[document.id]?.versions[document.version] === undefined
        ? null
        : {
            scope: document.id,
            document: { kind: "artifact", id: document.id, version: document.version },
          };
    },
    // Policy 2: who may see it.
    access: (instance, viewer) => accessOf(instance, viewer),
    // Policy 3: a stored page, by id and version.
    source: async (id, version) => {
      const stored = pages[id]?.versions[version];
      return stored === undefined ? null : { html: stored };
    },
    // Policy 4: what a clean address names: `/` the latest version, `/v/<n>` version n. And the
    // reverse (pathOf), so frames come with their clean address for "open in a new tab".
    entry: {
      at: (scope, path) => {
        const id = page(scope);
        if (id === null) return null;
        const version = path === "/" ? latest(id) : /^\/v\/(\d+)$/u.exec(path)?.[1];
        return pages[id].versions[version] === undefined
          ? null
          : { scope, document: { kind: "artifact", id, version } };
      },
      pathOf: (instance) =>
        instance.document.version === latest(page(instance.scope) ?? "hello")
          ? "/"
          : `/v/${instance.document.version}`,
      // The app's own sign-in, coming back to the authorize route. Absolute: Node's
      // Response.redirect needs one.
      signIn: (returnTo) =>
        Response.redirect(`${appOrigin}/login?next=${encodeURIComponent(returnTo)}`, 303),
    },
    ...(settings.health === undefined ? {} : { health: settings.health }),
    log: (event) => console.log(JSON.stringify(event)),
  });
  // Frames, the authorize route and the page's meta, under /porthole.
  const routes = content.routes(viewerOf);

  async function handle(request) {
    const url = new URL(request.url);
    const viewer = viewerOf(request);
    const porthole = await routes(request);
    if (porthole !== null) return porthole;
    if (url.pathname === "/porthole-client/displays.mjs") {
      // The page's display kinds: the same as the server's, as a module.
      return new Response(
        `import { defineDisplays } from "@botiverse/porthole";\nexport const displays = defineDisplays(${JSON.stringify(kinds)});\n`,
        { headers: { "content-type": "text/javascript; charset=utf-8" } },
      );
    }
    if (url.pathname.startsWith("/porthole-client/")) {
      return (
        (await settings.client(url.pathname.slice("/porthole-client".length))) ??
        new Response("not found", { status: 404 })
      );
    }
    if (url.pathname === "/api/page") {
      // The opaque fallback's content: the latest version, for a viewer who may see it.
      const id = url.searchParams.get("id") ?? "";
      const version = pages[id] === undefined ? undefined : latest(id);
      const instance =
        version === undefined ? null : { scope: id, document: { kind: "artifact", id, version } };
      return instance === null || accessOf(instance, viewer) === null
        ? new Response("not found", { status: 404 })
        : new Response(pages[id].versions[version], {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
    }
    if (url.pathname === "/login" && request.method === "GET") {
      const next = escape(ownPath(url.searchParams.get("next"), appOrigin));
      return html(
        `<!doctype html><title>Sign in</title><main id="sign-in-page"><form method="post"><input type="hidden" name="next" value="${next}"><button id="sign-in">Sign in as ada</button></form></main>`,
        {
          // No form-action: after the sign-in POST, redirect entry goes on through the content
          // origin, and form-action holds every redirect of a submission (docs/ADOPTING.md).
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        },
      );
    }
    if (url.pathname === "/login" && request.method === "POST") {
      const next = ownPath(new URLSearchParams(await request.text()).get("next"), appOrigin);
      return new Response(null, {
        status: 303,
        headers: {
          location: next,
          "set-cookie": `example-viewer=ada; Path=/; HttpOnly; SameSite=Lax${appOrigin.startsWith("https:") ? "; Secure" : ""}`,
        },
      });
    }
    if (url.pathname === "/") {
      if (viewer === null) return Response.redirect(`${appOrigin}/login?next=/`, 303);
      const id = url.searchParams.get("page") ?? "hello";
      if (pages[id] === undefined) return new Response("not found", { status: 404 });
      const frames = content.frameSources;
      return html(viewerPage(id), {
        // The embedding page's CSP: its scripts by nonce, and frames only from content origins
        // and the authorize route (content.frameSources). An opaque display inherits this policy
        // too, so it leaves img/media/font/style/worker open to what inline content uses.
        "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${NONCE}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src data: blob:; font-src data:; worker-src blob:; frame-src ${frames.length === 0 ? "'none'" : frames.join(" ")}; base-uri 'none'; frame-ancestors 'none'`,
      });
    }
    return new Response("not found", { status: 404 });
  }

  // A fixed nonce keeps the example short; an app makes one per response.
  const NONCE = "example-nonce";
  const viewerPage = (
    id,
  ) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pages</title>
<style>body{font-family:system-ui;margin:24px} #frame{height:480px;border:1px solid #8884} #problem{color:#b00}</style></head>
<body><main id="app"><p>Signed in. <button id="open-tab" type="button">Open in a new tab</button></p>
<div id="frame"></div><p id="problem" role="alert"></p></main>
<script type="importmap" nonce="${NONCE}">{"imports":{"@botiverse/porthole":"/porthole-client/index.js"}}</script>
<script type="module" nonce="${NONCE}">
const problem = (text) => { document.getElementById("problem").textContent = text; };
// The client module failing to load would otherwise show nothing at all.
Promise.all([import("@botiverse/porthole"), import("/porthole-client/displays.mjs")]).then(async ([{ createHost, frameFallback, portholeClient }, { displays }]) => {
  const porthole = portholeClient({ displays });            // the server's /porthole routes
  const meta = await porthole.refresh();
  const instance = { scope: ${JSON.stringify(id)}, document: { kind: "artifact", id: ${JSON.stringify(id)}, version: ${JSON.stringify(latest(id))} } };
  // "Open in a new tab": the clean address, opened inside the click.
  document.getElementById("open-tab").addEventListener("click", () => porthole.openInTab(instance));
  // Served while frames are served (located through /porthole/frames); opaque, inline, while not.
  const host = createHost(porthole.config("artifact"), { locator: porthole, nonce: ${JSON.stringify(NONCE)} });
  const display = host.mount(document.getElementById("frame"), {
    displayId: ${JSON.stringify(id)}, title: ${JSON.stringify(id)}, scheme: "light",
    ...(meta?.served ? { instance } : {}),
  });
  if (!meta?.served) display.setContent(await (await fetch("/api/page?id=${encodeURIComponent(id)}")).text());
  display.on("outcome", (outcome) => {
    const fallback = frameFallback(outcome);
    if (fallback !== null) problem(fallback.title + ": " + fallback.message);
  });
  display.on("hostError", (error) => problem(error.message));
}, (error) => problem("Porthole's client didn't load: " + error.message));
</script></body></html>`;

  return { content, handle };
}
