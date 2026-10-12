// A whole Porthole app, runtime-agnostic (a web `Request` in, a `Response` out): agents' HTML
// pages, each version on an origin of its own, framed in the app's viewer and openable at a
// clean address. examples/node/server.mjs and examples/workers/worker.mjs only adapt it.
//
// What is the app's own here (the policy): who is signed in (a cookie), which pages exist, who
// may see each. Everything else is Porthole's. Copy this file and replace the policy.
import { presets } from "@botiverse/porthole";
import { conformancePage, createContentHost, prefixedName } from "@botiverse/porthole/server";

/** The config a page is shown under: served on its own origin, or opaque while that's down. */
export const pageConfig = (contentSource) =>
  presets.artifact({
    // A whole-page viewer: the frame fills its box, and the agent's manual says so.
    layout: { kind: "fill" },
    ...(contentSource === null ? {} : { isolation: "domain", contentOrigins: [contentSource] }),
  });

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
  /** Who may see an instance: anyone signed in, but a page with an owner only its owner. */
  const accessOf = (instance, viewer) => {
    const owner = pages[page(instance.scope) ?? ""]?.owner ?? null;
    return viewer !== null && (owner === null || owner === viewer)
      ? { viewer, subject: viewer }
      : null;
  };
  const page = (scope) =>
    pages[scope]
      ? scope
      : settings.conformance === true && /^t-[a-z0-9-]{1,40}$/u.test(scope)
        ? "conformance"
        : null;

  const content = createContentHost({
    domain: settings.contentDomain,
    appOrigins: [appOrigin],
    secret: settings.secret,
    ...(settings.tickets === undefined ? {} : { tickets: settings.tickets }),
    // The key is the preset a stored page names: an artifact's defaults to "artifact".
    configs: (source) => ({ artifact: pageConfig(source) }),
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
    // Policy 4: what a clean address names: `/` the latest version, `/v/<n>` version n.
    entry: {
      authorizeUrl: `${appOrigin}/porthole/authorize`,
      at: (scope, path) => {
        const id = page(scope);
        if (id === null) return null;
        const version =
          path === "/" ? Object.keys(pages[id].versions).at(-1) : /^\/v\/(\d+)$/u.exec(path)?.[1];
        return pages[id].versions[version] === undefined
          ? null
          : { scope, document: { kind: "artifact", id, version } };
      },
      // The app's own sign-in, coming back to the authorize route. Absolute: Node's
      // Response.redirect needs one.
      signIn: (returnTo) =>
        Response.redirect(`${appOrigin}/login?next=${encodeURIComponent(returnTo)}`, 303),
    },
    ...(settings.health === undefined ? {} : { health: settings.health }),
    log: (event) => console.log(JSON.stringify(event)),
  });
  const issue = content.issue(viewerOf);
  const authorize = content.authorize(viewerOf);

  async function handle(request) {
    const url = new URL(request.url);
    const viewer = viewerOf(request);
    if (url.pathname === "/porthole/authorize") return authorize(request);
    if (url.pathname === "/api/frames") return issue(request);
    if (url.pathname.startsWith("/porthole-client/")) {
      return (
        (await settings.client(url.pathname.slice("/porthole-client".length))) ??
        new Response("not found", { status: 404 })
      );
    }
    if (url.pathname === "/api/meta") {
      // What the page needs: whether frames are served, and the config to show them under.
      const meta = content.meta();
      return Response.json({
        ...meta,
        config: pageConfig(meta.served ? meta.contentSource : null),
        viewer,
      });
    }
    if (url.pathname === "/login" && request.method === "GET") {
      const next = escape(ownPath(url.searchParams.get("next"), appOrigin));
      return html(
        `<!doctype html><title>Sign in</title><main id="sign-in-page"><form method="post"><input type="hidden" name="next" value="${next}"><button id="sign-in">Sign in as ada</button></form></main>`,
        {
          "content-security-policy":
            // No form-action: after the sign-in POST, redirect entry goes on through the
            // content origin, and form-action holds every redirect of a submission.
            "default-src 'none'; frame-ancestors 'none'",
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
    if (url.pathname === "/api/page") {
      // The opaque fallback's content: the latest version, for a viewer who may see it.
      const id = url.searchParams.get("id") ?? "";
      const latest = pages[id] === undefined ? undefined : Object.keys(pages[id].versions).at(-1);
      const instance =
        latest === undefined
          ? null
          : { scope: id, document: { kind: "artifact", id, version: latest } };
      const grant = instance === null ? null : accessOf(instance, viewer);
      return grant === null
        ? new Response("not found", { status: 404 })
        : new Response(pages[id].versions[latest], {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
    }
    if (url.pathname === "/") {
      if (viewer === null) return Response.redirect(`${appOrigin}/login?next=/`, 303);
      const id = url.searchParams.get("page") ?? "hello";
      if (pages[id] === undefined) return new Response("not found", { status: 404 });
      return html(viewerPage(id), {
        // The embedding page's CSP: its scripts by nonce, and frames only from content origins
        // (content.frameSources). An opaque display inherits this policy too, so it leaves
        // img/media/font/style/worker open to what inline content uses (docs/ADOPTING.md).
        "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${NONCE}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src data: blob:; font-src data:; worker-src blob:; frame-src ${content.frameSources.length === 0 ? "'none'" : content.frameSources.join(" ")}; base-uri 'none'; frame-ancestors 'none'`,
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
<body><main id="app"><p>Signed in. <a id="open-tab" href="${escape(content.urlOf(id) ?? "#")}" target="_blank" rel="noopener">Open in a new tab</a></p>
<div id="frame"></div><p id="problem" role="alert"></p></main>
<script type="importmap" nonce="${NONCE}">{"imports":{"@botiverse/porthole":"/porthole-client/index.js"}}</script>
<script type="module" nonce="${NONCE}">
const problem = (text) => { document.getElementById("problem").textContent = text; };
// The client module failing to load would otherwise show nothing at all.
import("@botiverse/porthole").then(async ({ createHost, httpLocator }) => {
  const meta = await (await fetch("/api/meta")).json();
  const host = createHost(meta.config, { locator: httpLocator("/api/frames"), nonce: ${JSON.stringify(NONCE)} });
  const display = host.mount(document.getElementById("frame"), {
    displayId: ${JSON.stringify(id)}, title: ${JSON.stringify(id)}, scheme: "light",
    // Served: located by the issue endpoint. Opaque (frames not served now): the same page, inline.
    ...(meta.served ? { instance: { scope: ${JSON.stringify(id)}, document: { kind: "artifact", id: ${JSON.stringify(id)}, version: "1" } } } : {}),
  });
  if (!meta.served) display.setContent(await (await fetch("/api/page?id=${encodeURIComponent(id)}")).text());
  display.on("outcome", (outcome) => { if (outcome.state !== "loaded") problem("The page couldn't be shown here (" + (outcome.reason ?? outcome.state) + "): open it in a new tab."); });
  display.on("hostError", (error) => problem(error.message));
}, (error) => problem("Porthole's client didn't load: " + error.message));
</script></body></html>`;

  return { content, handle };
}
