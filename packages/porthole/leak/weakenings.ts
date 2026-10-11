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
      find: '["script-src", "\'unsafe-inline\'", "\'unsafe-eval\'", "blob:", ...origins("script")],',
      replace:
        '["script-src", "\'self\'", "\'unsafe-inline\'", "\'unsafe-eval\'", "blob:", ...origins("script")],',
    },
    {
      file: POLICY,
      find: '["img-src", "data:", "blob:", ...origins("img")],',
      replace: '["img-src", "\'self\'", "data:", "blob:", ...origins("img")],',
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
      find: '    themed = plan.themeDocuments === "always" ||',
      replace: "    themed = true ||",
    },
  ],
  "embedder-csp": "embedder-csp",
  "embedder-self": "embedder-csp",
  "url-permissions": [
    {
      file: POLICY,
      find: '  return config.mode === "url" ? (config.permissions ?? []).join("; ") : "";',
      replace:
        '  return config.mode === "url" ? (config.permissions ?? ["clipboard-write", "fullscreen"]).join("; ") : "";',
    },
  ],
  // The served harness's server without the host's per-request check (P050).
  authorize: "harness",
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
