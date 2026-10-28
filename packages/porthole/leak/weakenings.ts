/**
 * Negative controls: `PORTHOLE_LEAK_WEAKEN=<name>[,<name>]` serves the core with one defense
 * taken out, so the probes that prove it can be seen to fail (PRINCIPLE 6: a wall never seen to
 * fail proves nothing). Each names the text it removes; if that text is gone, the server refuses
 * to start rather than weaken nothing. The leak server and the served harness both apply them.
 */
export interface Edit {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}
const RUNTIME = "src/shell/runtime.ts";
const POLICY = "src/compile/policy.ts";
const BRIDGE = "src/bridge/bridge.ts";
const SHELL_ADAPTER = "src/protocol/shell-adapter.ts";
const MCP_ADAPTER = "src/mcp/adapter.ts";
const REQUESTS = "src/runtime/requests.ts";
/**
 * Each weakening: edits to the core's sources (served to the browser as they are stripped or
 * bundled), or a name the leak server (`embedder-csp`) or the served harness (`harness`) acts on.
 */
export const WEAKENINGS: Readonly<Record<string, readonly Edit[] | "embedder-csp" | "harness">> = {
  "frame-guard": [{ file: RUNTIME, find: "  guardRoot(document);\n", replace: "\n" }],
  webrtc: [{ file: RUNTIME, find: "      lock(window, name, undefined);", replace: "" }],
  // The shell's navigation guard (P079): the frame's own navigations to another document go on.
  "navigate-guard": [
    {
      file: RUNTIME,
      find: '  if (navigationApi && typeof navigationApi.addEventListener === "function"',
      replace: '  if (false && typeof navigationApi.addEventListener === "function"',
    },
    // The calls that ask the guard's rule first (P099): they start what they're asked.
    {
      file: RUNTIME,
      find: '    return { go: before(target, "#") === before(location.href, "#") || ownPage(target), target };',
      replace: "    return { go: true, target };",
    },
  ],
  // Only the guard's rule asked first (P099): navigation.navigate() and open(…, "_self") start
  // what they're asked, and the navigate event alone stops them (WebKit sends the request anyway).
  "navigate-ask": [
    {
      file: RUNTIME,
      find: '    return { go: before(target, "#") === before(location.href, "#") || ownPage(target), target };',
      replace: "    return { go: true, target };",
    },
  ],
  // The shell's following of a tab's links (P099): the browser follows them, after content's
  // listeners, and WebKit sends a cancelled one's request.
  "link-rule": [
    {
      file: RUNTIME,
      find: "  if (window.top === window) {\n    linksTaken = true;",
      replace: "  if (false) {\n    linksTaken = true;",
    },
  ],
  "attach-shadow": [
    {
      file: RUNTIME,
      find: "    const root = attachShadow.call(this, init);\n    guardRoot(root);",
      replace: "    const root = attachShadow.call(this, init);",
    },
  ],
  "parser-entry-points": [
    {
      file: RUNTIME,
      find: '  for (const name of ["open", "write", "writeln"]) {\n    lock(Document.prototype, name, noRewrite);\n  }',
      replace: "",
    },
  ],
  "declarative-shadow": [
    {
      file: RUNTIME,
      find: '      lock(proto, "setHTMLUnsafe", function (html) {\n        this.innerHTML = String(html);\n      });',
      replace: "",
    },
  ],
  "sync-guard": [
    {
      file: RUNTIME,
      find: "    if (node.nodeType === 1 && node.matches(GUARDED)) {\n      return false;\n    }\n    strip(node);\n    return true;",
      replace: "    return true;",
    },
    {
      file: RUNTIME,
      find: "    setInner.call(box, String(html));\n    strip(box);",
      replace: "    setInner.call(box, String(html));",
    },
    {
      file: RUNTIME,
      find: "    if (copy.matches(GUARDED)) {\n      element.remove();\n    }",
      replace: "",
    },
  ],
  "connect-src": [
    {
      file: POLICY,
      find: '["connect-src", ...list(origins("connect"))],',
      replace: '["connect-src", "*"],',
    },
  ],
  self: [
    {
      file: POLICY,
      find: '      "script-src",\n      "\'unsafe-inline\'",',
      replace: '      "script-src",\n      "\'self\'",\n      "\'unsafe-inline\'",',
    },
    {
      file: POLICY,
      find: '["img-src", "data:", "blob:", ...https("img"), ...origins("img")],',
      replace: '["img-src", "\'self\'", "data:", "blob:", ...https("img"), ...origins("img")],',
    },
    {
      file: POLICY,
      find: '["style-src", "\'unsafe-inline\'", ...origins("style")],',
      replace: '["style-src", "\'self\'", "\'unsafe-inline\'", ...origins("style")],',
    },
    {
      file: POLICY,
      find: '["connect-src", ...list(origins("connect"))],',
      replace: '["connect-src", "\'self\'", ...origins("connect")],',
    },
  ],
  sandbox: [
    {
      file: POLICY,
      find: '      return ["allow-scripts"];',
      replace:
        '      return ["allow-scripts", "allow-forms", "allow-popups", "allow-downloads", "allow-top-navigation", "allow-modals"];',
    },
  ],
  "base-uri": [{ file: POLICY, find: '    ["base-uri", "\'none\'"],\n', replace: "" }],
  "style-split": [
    {
      file: "src/host/create-host.ts",
      find: "(STANDARD.has(name) ? standard : own)[name] = value;",
      replace: "standard[name] = value;",
    },
  ],
  "confirm-gate": [
    {
      file: BRIDGE,
      find: '      const confirms = gates.includes("confirm");',
      replace: "      const confirms = false;",
    },
  ],
  // The show gate (P100): a model context update goes to the handler without the person shown it.
  "model-context-show": [
    {
      file: BRIDGE,
      find: '      const shows = gates.includes("show");',
      replace: "      const shows = false;",
    },
  ],
  "host-gesture": [
    {
      file: BRIDGE,
      find: "        if (activated === false) {",
      replace: "        if (activated === false && false) {",
    },
  ],
  "link-scheme": [
    {
      file: BRIDGE,
      find: '  if (\n    (url.protocol !== "https:" && url.protocol !== "http:") ||',
      replace: "  if (\n    false ||",
    },
  ],
  "shell-gesture": [
    {
      file: RUNTIME,
      find: "    return !(capability && capability.userActivation) || !activation || activation.isActive;",
      replace: "    return true;",
    },
  ],
  "draft-inert": [
    {
      file: RUNTIME,
      find: '  const INERT = "script,iframe,frame,frameset,object,embed,applet,portal,fencedframe,meta,base,noscript,link:not([rel~=stylesheet i])";',
      replace:
        '  const INERT = "iframe,frame,frameset,object,embed,applet,portal,fencedframe,meta,base,noscript,link:not([rel~=stylesheet i])";',
    },
    {
      file: RUNTIME,
      find: '        if (name.startsWith("on") || /^\\s*javascript:/i.test(attribute.value)) {',
      replace: "        if (false) {",
    },
  ],
  "document-theme": [
    {
      file: RUNTIME,
      find: '    themed = plan.themeDocuments !== "never" && (plan.themeDocuments === "always" ||',
      replace: "    themed = true || (",
    },
  ],
  "embedder-csp": "embedder-csp",
  "embedder-self": "embedder-csp",
  "url-permissions": [
    {
      file: POLICY,
      find: '    ? (config.permissions ?? []).join("; ")',
      replace: '    ? (config.permissions ?? ["clipboard-write", "fullscreen"]).join("; ")',
    },
  ],
  // The served harness's server without the host's per-request check (P050).
  authorize: "harness",
  // A file set's server without its refusal of service workers (P081): the harness passes a
  // worker's script request on as a plain script's.
  "service-worker": "harness",
  // A file set's page with 'self' where its CSP names its version's own path (P082): the harness
  // rewrites the header.
  "file-self": "harness",
  // A file set's files without their resource policy (P081): another origin may embed them.
  "file-corp": "harness",
  // A url-mode app's server without its origin check (P101): the harness drops `Origin` and
  // `Sec-Fetch-Site` from the app's requests, so another origin's ride on its cookie.
  "url-origin": "harness",
  // A served page without its CSP's sandbox (P099): on a tab of its own nothing else sandboxes it.
  "tab-sandbox": "harness",
  // A served page without its Permissions-Policy header (P099): on a tab nothing else denies it
  // devices, location or full screen, but the shell's locks (`device-locks`, the only wall on
  // WebKit and Firefox, which don't apply the header to them).
  "permissions-policy": "harness",
  "device-locks": [
    {
      file: RUNTIME,
      find: "  if (window.top === window) {\n    const deny",
      replace: "  if (false) {\n    const deny",
    },
  ],
  // The shell's window.open on a tab of its own (P099): the second wall behind the sandbox.
  "window-open": [
    {
      file: RUNTIME,
      find: "  if (window.top === window) {\n    const openWindow = window.open;",
      replace: "  if (false) {\n    const openWindow = window.open;",
    },
  ],
  // The host's checks on annotation reports (P053): taken only while asked for, within limits.
  "annotation-checks": [
    {
      file: "src/host/create-host.ts",
      find: '              annotating === null ||\n              !(kind === "element" ? annotating.elements : annotating.text)\n',
      replace: "              false\n",
    },
    {
      file: "src/annotate/validate.ts",
      find: "        !text(exact, LIMITS.exact, 1) ||",
      replace: '        typeof exact !== "string" ||',
    },
    {
      file: "src/annotate/validate.ts",
      find: "  if (value.selectors.length > 3 || !text(value.label, LIMITS.label)) {",
      replace: '  if (typeof value.label !== "string") {',
    },
  ],
  // A marker's click (P104): the host takes it only for a mark it shows with a marker.
  "annotation-activated": [
    {
      file: "src/host/create-host.ts",
      find: "            if (!marks.some((mark) => mark.id === id && hasMarker(mark))) {",
      replace: "            if (id === null) {",
    },
  ],
  // A reported box held to the frame's viewport (P104): the page places the host's UI nowhere
  // outside its frame.
  "annotation-rect-clamp": [
    {
      file: "src/host/create-host.ts",
      find: '        void through.call("annotate", withinFrame(report));',
      replace: '        void through.call("annotate", report);',
    },
  ],
  // A marker's click (P104): only for a mark shown with a marker (the id check stays).
  "annotation-activated-count": [
    {
      file: "src/host/create-host.ts",
      find: "            if (!marks.some((mark) => mark.id === id && hasMarker(mark))) {",
      replace: "            if (!marks.some((mark) => mark.id === id)) {",
    },
  ],
  // A draft's count never goes to the frame (P107): the page learns a mark is a draft, not how
  // many comments it holds.
  "draft-count": [
    {
      file: "src/annotate/validate.ts",
      find: "      return { id: mark.id, anchor, kind };",
      replace:
        "      return { id: mark.id, anchor, kind, ...(mark.count === undefined ? {} : { count: mark.count }) };",
    },
  ],
  // The shell's own checks on a show (P107): a draft draws no number, an unknown kind is no mark.
  "draft-shell-checks": [
    {
      file: "src/shell/annotate.ts",
      find: ' && (mark.kind === undefined || mark.kind === "posted" || mark.kind === "draft"))',
      replace: ")",
    },
    {
      file: "src/shell/annotate.ts",
      find: '                const count = !draft && typeof mark.count === "number"',
      replace: '                const count = typeof mark.count === "number"',
    },
    {
      file: "src/shell/annotate.ts",
      find: '              const label = mark.draft ? "" : labelOf(mark.count);',
      replace: '              const label = mark.count === null ? "" : labelOf(mark.count);',
    },
  ],
  // A marker's click (P104): the shell reports a trusted one only, never the content's own.
  "marker-trusted": [
    {
      file: "src/shell/annotate.ts",
      find: '        if (type === "click" && event.isTrusted && callOf(buttonOf, event, []) === 0) {',
      replace: '        if (type === "click" && callOf(buttonOf, event, []) === 0) {',
    },
  ],
  // A marker's click (P104): the shell's first listener keeps it from the content.
  "marker-click": [
    {
      file: "src/shell/annotate.ts",
      find: "        if (layer === null || callOf(targetOf, event, []) !== layer) {\n          return;\n        }\n        callOf(stopPress, event, []);\n",
      replace:
        "        if (layer === null || callOf(targetOf, event, []) !== layer) {\n          return;\n        }\n",
    },
  ],
  // A text marker's place (P105, #36): just past its words, as 0.9.0 had it (centred on the line).
  "marker-place": [
    {
      file: "src/shell/annotate.ts",
      find: "            found = placeLine(line, false, GAP, placed, room);",
      replace: "            found = { left: line.at.right + 2 };",
    },
  ],
  // A marker's tap (P105): without a listener of its own, WebKit makes no click of a tap on it.
  "marker-tap": [
    {
      file: "src/shell/annotate.ts",
      find: '          callOf(listenOn, marker, ["click", tapTarget]);\n',
      replace: "",
    },
  ],
  // A marker's press (P104, P105): what the browser would do with it (focus, selection) goes on.
  "marker-prevent": [
    {
      file: "src/shell/annotate.ts",
      find: "        if (CANCELLED[type] === 1) {\n          callOf(cancelPress, event, []);\n        }\n",
      replace: "",
    },
  ],
  // A marker's press read through the live prototypes (P105): content that patched them hears
  // it, or makes the shell misread it.
  "marker-originals": [
    {
      file: "src/shell/annotate.ts",
      find: "        if (layer === null || callOf(targetOf, event, []) !== layer) {\n          return;\n        }\n        callOf(stopPress, event, []);\n",
      replace:
        "        if (layer === null || event.target !== layer) {\n          return;\n        }\n        event.stopImmediatePropagation();\n",
    },
    {
      file: "src/shell/annotate.ts",
      find: "          const hit = markerAt(callOf(clientXOf, event, []), callOf(clientYOf, event, []));\n          if (hit !== null && isShown(hit.id)) {",
      replace:
        "          const hit = markerAt(event.clientX, event.clientY);\n          if (hit !== null && isShown(hit.id)) {",
    },
  ],
  // Follow-ups at most one a second (P104): every settle reports.
  "follow-throttle": [
    {
      file: "src/shell/annotate.ts",
      find: "      const FOLLOW_EVERY = 1000;",
      replace: "      const FOLLOW_EVERY = 0;",
    },
  ],
  // Follow-ups only while a mark has a marker (P104): a host without counts hears them too.
  "follow-count": [
    {
      file: "src/shell/annotate.ts",
      find: "      const counted = () => marks.some((mark) => mark.marker);",
      replace: "      const counted = () => marks.length > 0;",
    },
  ],
  // The selection's re-report after a scroll on the follow-ups' clock (P105): as 0.9, after every
  // settle, whether its box moved or not.
  "selection-follow": [
    {
      file: "src/shell/annotate.ts",
      find: "        if (reported !== null) {\n          selectionScrolled = true;\n          settle();\n        }",
      replace:
        '        if (reported !== null) {\n          clearTimeout(selectionTimer);\n          selectionTimer = setTimeout(() => {\n            reported = "";\n            reportSelection(false);\n          }, 150);\n        }',
    },
  ],
  // A marker's click only within a gesture (P105): the host takes one a page posts by itself.
  "annotation-activated-gesture": [
    {
      file: "src/host/create-host.ts",
      find: "            if (noGesture()) {\n              return;\n            }\n",
      replace: "",
    },
  ],
  // The host's nonce, not given to an opaque frame's shell (P054): on a strict host page the
  // inherited policy stops the shell, so nothing the suite asks of it happens.
  nonce: [
    {
      file: "src/shell/document.ts",
      find: '  const nonce = options.nonce === undefined ? "" : ` nonce="${options.nonce}"`;',
      replace: '  const nonce = "";',
    },
  ],
  // The capability runtime's walls (P085-P090), in the bridge the host page runs: a page held to
  // its declaration, a call to the viewer's level, a person to their own data, comments write-only.
  "runtime-declaration": [
    {
      file: BRIDGE,
      find: "        (declaration === undefined\n          ? RUNTIME_HOST_FUNCTIONS.includes(capability)\n          : !Object.hasOwn(declaration.capabilities, family.name))",
      replace: "        false",
    },
  ],
  // Both of the bridge's level checks: before the arguments are read, and the call's own.
  "runtime-level": [
    {
      file: BRIDGE,
      find: "    if (viewer === undefined || (needed !== null && !atLeast(viewer.level, needed))) {",
      replace: "    if (viewer === undefined) {",
    },
    {
      file: BRIDGE,
      find: "    if (needed !== null && !atLeast(viewer.level, needed)) {",
      replace: "    if (false) {",
    },
  ],
  // The names a page's `data` gives (P086), held without a viewer too (P094): exactly 264b12fa's
  // hole, the no-viewer branch's return, so the probe's case with a viewer still passes under it.
  "runtime-data-names": [
    {
      file: BRIDGE,
      find: '      return named ? args : "undeclared";',
      replace: "      return args;",
    },
  ],
  // A result the host pushed (`changed(result)`) answers a read past the read's gates (P094).
  "live-held-read": [
    {
      file: "src/protocol/live-data.ts",
      find: '        const outcome = await bridge.call(\n          "readData",\n          { uri },\n          { ...activation(), held: { uri, value } },\n        );',
      replace: "        const outcome = { ok: true, value };",
    },
  ],
  // The per-user data's owner check, in the helper the bridge and a host's own services share.
  "db-private": [
    {
      file: "src/runtime/db.ts",
      find: "  if (id === undefined || viewer?.id === undefined || id !== viewer.id) {\n    return null;\n  }",
      replace: "",
    },
  ],
  "comments-result": [
    {
      file: BRIDGE,
      find: "          return { ok: true, value: (value === true) as Result };",
      replace: "          return { ok: true, value: value as Result };",
    },
  ],
  // The focus guard (P109): every move of the keyboard into a frame taken as the person's, so a
  // page that calls focus() while the person types in the host's composer keeps their keys.
  "focus-guard": [
    {
      file: "src/platform/focus-guard.ts",
      find: "    const moved = personMoved({",
      replace: "    const moved = true || personMoved({",
    },
  ],
  // What the guard does after a take-back (P109, after GK-1): no watch that focus stays back, a
  // look only while a text field has focus, and focus left on nothing after a press on a field not
  // taken back, as before the review of the guard; so a page that takes focus back on its own
  // blur, where Firefox lands the take-back on nothing, keeps it.
  "focus-guard-watch": [
    {
      file: "src/platform/focus-guard.ts",
      find: "    const watched = contest;\n",
      replace: "    const watched = null as typeof contest;\n",
    },
    {
      file: "src/platform/focus-guard.ts",
      find: "    if (polling === 0 && (frames.size > 0 || contest !== null || waiting !== null)) {",
      replace: "    if (polling === 0 && frames.size > 0 && takesText(known)) {",
    },
    {
      file: "src/platform/focus-guard.ts",
      find: "      press !== null &&\n",
      replace: "      false &&\n      press !== null &&\n",
    },
  ],
  // A cancel (P112) taken with no mode on: a page that says it is heard whenever it likes.
  "cancel-any-mode": [
    {
      file: "src/host/create-host.ts",
      find: "            if (annotating === null) {\n              return;\n            }\n            if (annotating.elements) {",
      replace: "            if (annotating?.elements === true) {",
    },
  ],
  // A nested page's shell (P111) passes on what its page says in the shell's own namespace: a page
  // that says its shell's activation turned on is believed.
  "shell-namespace": [
    {
      file: "src/shell/frame.ts",
      find: 'typeof data.method === "string" && data.method.indexOf(PREFIX) === 0) {',
      replace: "false) {",
    },
  ],
  // A nested page's gesture (P111) needs no quiet host: the person's press in the page counts for
  // a second even after they pressed or typed on the host's page.
  "shell-host-input": [
    {
      file: "src/platform/focus-guard.ts",
      find: "    hostInputAt < word.activatedAt\n",
      replace: "    true\n",
    },
  ],
  // comments.open's gesture in the calling frame (P109): any gesture on the host's page will do,
  // the person typing in the host's own composer included.
  "comments-in-frame": [
    {
      file: BRIDGE,
      find: "        if (inFrame(capability) && options.focused?.() === false) {",
      replace: "        if (false) {",
    },
  ],
  // A comment's draft taken as the page gave it (P108): past the limit, unseen characters, not text.
  "comment-draft": [
    {
      file: REQUESTS,
      find: "(draft !== undefined && !draftText(draft))",
      replace: "false",
    },
  ],
  // The asset library's CSP (P089), taken out by the served harness: scripts from it run
  // whoever uploaded them; an asset opened on its own runs.
  "blob-script": "harness",
  "blob-inert": "harness",
  // An asset that wasn't trusted when it was uploaded, served as the script its name says.
  "blob-trusted": "harness",
  // An error log formatted as it came, before the bridge's gate, as before P095 (S05): a cycle
  // or a BigInt throws out of the adapter, a shared graph is written as a tree.
  "report-unbounded": [
    {
      file: SHELL_ADAPTER,
      find: '            void bridge.call("reportError", { message: params.data });',
      replace:
        '            void bridge.call("reportError", { message: JSON.stringify(params.data) });',
    },
    {
      file: MCP_ADAPTER,
      find: '          void bridge.call("reportError", { message: params.data });',
      replace:
        '          void bridge.call("reportError", { message: JSON.stringify(params.data) });',
    },
  ],
  // The shell's clipboard walls (P051): the async API, the copy and cut commands, copy events.
  clipboard: [
    {
      file: RUNTIME,
      find: '  const REFUSED_COMMANDS = ["inserthtml", "copy", "cut", "paste"];',
      replace: '  const REFUSED_COMMANDS = ["inserthtml"];',
    },
    { file: RUNTIME, find: "        lock(Clipboard.prototype, name, noClipboard);\n", replace: "" },
    {
      file: RUNTIME,
      find: "    window.addEventListener(type, (event) => event.stopImmediatePropagation(), true);\n",
      replace: "",
    },
  ],
};
export const weakened = (process.env.PORTHOLE_LEAK_WEAKEN ?? "")
  .split(",")
  .filter((name) => name !== "");
for (const name of weakened) {
  if (WEAKENINGS[name] === undefined) {
    throw new Error(`No weakening named ${name}: ${Object.keys(WEAKENINGS).join(", ")}`);
  }
}

export function weaken(relative: string, text: string): string {
  let out = text;
  for (const name of weakened) {
    const weakening = WEAKENINGS[name];
    for (const edit of typeof weakening === "object" ? weakening : []) {
      if (edit.file !== relative) {
        continue;
      }
      if (!out.includes(edit.find)) {
        throw new Error(`Weakening ${name} no longer matches ${relative}`);
      }
      out = out.replace(edit.find, edit.replace);
    }
  }
  return out;
}

/**
 * The weakenings the served harness also applies to the documents its content origins serve
 * (their shell is made in the harness's own process, not loaded from the stripped sources): the
 * navigation guard (P079), whose wall in a served frame is the shell alone for another content
 * origin, and the shell's window.open and device locks on a tab (P099).
 */
const SERVED = [
  "navigate-guard",
  "navigate-ask",
  "link-rule",
  "window-open",
  "device-locks",
  // A nested page's shell (P111), made in the harness's process like the documents' shells.
  "shell-namespace",
];

/** Whether a control asked for edits the served documents' shell (`weakenServed`). */
export const servedShellWeakened = (): boolean => weakened.some((each) => SERVED.includes(each));

export function weakenServed(html: string): string {
  let out = html;
  for (const name of weakened.filter((each) => SERVED.includes(each))) {
    const weakening = WEAKENINGS[name];
    for (const edit of typeof weakening === "object" ? weakening : []) {
      // A served document without the text (a status page) has nothing to weaken; the files' own
      // text is checked once, before anything is served (`checkWeakenings`).
      out = out.replace(edit.find, edit.replace);
    }
  }
  return out;
}

/**
 * Every requested control's edits, checked against the files before anything is served (after the
 * review): a control whose text is gone stops the run, rather than weakening nothing.
 */
export function checkWeakenings(read: (relative: string) => string): void {
  for (const name of weakened) {
    const weakening = WEAKENINGS[name];
    for (const edit of typeof weakening === "object" ? weakening : []) {
      if (!read(edit.file).includes(edit.find)) {
        throw new Error(`Weakening ${name} no longer matches ${edit.file}: update its text`);
      }
    }
  }
}
