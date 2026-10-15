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
  // The host's nonce, not given to an opaque frame's shell (P054): on a strict host page the
  // inherited policy stops the shell, so nothing the suite asks of it happens.
  nonce: [
    {
      file: "src/shell/document.ts",
      find: '  const nonce = options.nonce === undefined ? "" : ` nonce="${options.nonce}"`;',
      replace: '  const nonce = "";',
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
 * origin.
 */
const SERVED = ["navigate-guard"];

export function weakenServed(html: string): string {
  let out = html;
  for (const name of weakened.filter((each) => SERVED.includes(each))) {
    const weakening = WEAKENINGS[name];
    for (const edit of typeof weakening === "object" ? weakening : []) {
      out = out.replace(edit.find, edit.replace);
    }
  }
  return out;
}
