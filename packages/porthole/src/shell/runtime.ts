/**
 * The shell's runtime: the code that runs first in the frame, before any content. Plain ES2020,
 * no imports and no build step, so every engine (a browser frame now, a native web view later)
 * runs it as it is. `__PLAN__` is replaced with the frame's plan (`ShellPlan` plus the origins it
 * takes messages from).
 *
 * In order, it:
 * 1. stands in for storage an opaque origin lacks (a map for the frame's life);
 * 2. removes every WebRTC constructor, non-configurably: a peer connection reaches the network
 *    outside connect-src (ICE gathering), and not every engine honors the CSP's `webrtc 'block'`;
 * 3. removes every frame-like element content adds, since a nested frame runs in a fresh realm
 *    where step 2 never happened (and not every engine enforces `frame-src 'none'` for
 *    `srcdoc`/`about:blank` children);
 * then, when it speaks for the content (`protocol: "shell"`), it asks its host `ui/initialize`,
 * applies the theme the host answers, draws the content it is sent (inert while partial, run once
 * when whole), reports its size and errors, sends link clicks out through `openLink`, and defines
 * a global for each declared capability that has one.
 *
 * Nothing secret is ever in the frame: everything it says, the host treats as the content's own
 * words. It takes messages only from its parent, and only from the plan's origins.
 */
export const SHELL_RUNTIME = String.raw`(() => {
  "use strict";
  const plan = __PLAN__;
  const declared = (name) => Object.prototype.hasOwnProperty.call(plan.capabilities, name);

  if (plan.storage === "memory") {
    // An opaque origin has no storage: a map stands in, for as long as the frame lives.
    const store = () => {
      const items = new Map();
      return {
        getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
        setItem: (key, value) => void items.set(String(key), String(value)),
        removeItem: (key) => void items.delete(String(key)),
        clear: () => items.clear(),
        key: (index) => Array.from(items.keys())[index] ?? null,
        get length() {
          return items.size;
        },
      };
    };
    for (const name of ["localStorage", "sessionStorage"]) {
      try {
        Object.defineProperty(window, name, { configurable: true, value: store() });
      } catch (_) {}
    }
  }

  // WebRTC leaves the frame outside connect-src. Only RTCPeerConnection (and its prefixed alias)
  // opens a connection; the rest are value types, removed too so nothing is assembled from them.
  for (const name of Object.getOwnPropertyNames(window)) {
    if (/^(RTC|webkitRTC)/.test(name)) {
      try {
        Object.defineProperty(window, name, { configurable: false, writable: false, value: undefined });
      } catch (_) {}
    }
  }

  // No nested frames: each would be a fresh realm with WebRTC intact. Removed as they are added
  // (a mutation observer's microtask runs before the child's document loads).
  const FRAME_TAGS = "iframe,frame,frameset,object,embed,portal,fencedframe";
  const stripFrames = (node) => {
    if (node === null || node.nodeType !== 1) {
      return;
    }
    if (typeof node.matches === "function" && node.matches(FRAME_TAGS)) {
      node.remove();
      return;
    }
    if (typeof node.querySelectorAll === "function") {
      for (const element of Array.from(node.querySelectorAll(FRAME_TAGS))) {
        element.remove();
      }
    }
  };
  const frameGuard = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        stripFrames(node);
      }
    }
  });
  const armFrameGuard = () => {
    try {
      for (const element of Array.from(document.querySelectorAll(FRAME_TAGS))) {
        element.remove();
      }
      frameGuard.observe(document, { childList: true, subtree: true });
    } catch (_) {}
  };
  armFrameGuard();

  if (plan.protocol !== "shell") {
    return;
  }

  let root = document.getElementById("porthole-root");
  let nextId = 1;
  const pending = new Map();
  const send = (message) => {
    if (window.parent !== window) {
      // Nothing secret is ever said from here, so any parent may hear it; what it hears is the
      // content's word, which the host gates before it acts on it.
      window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, message), "*");
    }
  };
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const notify = (method, params) => send({ method, params });

  const themeNames = new Set(plan.themeVariables);
  let lastContext = null;
  const applyTheme = (context) => {
    if (context === null || typeof context !== "object") {
      return;
    }
    lastContext = context;
    const variables = context.styles && context.styles.variables;
    if (variables !== null && typeof variables === "object") {
      for (const name of Object.keys(variables)) {
        const value = variables[name];
        if (themeNames.has(name) && typeof value === "string") {
          document.documentElement.style.setProperty(name, value);
        }
      }
    }
    if (context.theme === "light" || context.theme === "dark") {
      document.documentElement.style.colorScheme = context.theme;
      document.documentElement.setAttribute("data-theme", context.theme);
    }
    window.dispatchEvent(new CustomEvent(plan.themeEvent, { detail: { theme: context.theme } }));
  };

  let reported = 0;
  const report = (message) => {
    if (!declared("reportError") || reported >= plan.maxErrorReports) {
      return;
    }
    reported += 1;
    notify("notifications/message", { level: "error", logger: "porthole", data: String(message).slice(0, 2000) });
  };

  let lastHeight = -1;
  const measure = () => {
    if (!declared("resize")) {
      return;
    }
    const box = root !== null && root.isConnected ? root : document.documentElement;
    const rect = box.getBoundingClientRect();
    const height = Math.ceil(Math.max(rect.height, box === root ? root.scrollHeight : document.body ? document.body.scrollHeight : 0));
    if (height !== lastHeight) {
      lastHeight = height;
      notify("ui/notifications/size-changed", { width: Math.ceil(rect.width), height });
    }
  };
  let scheduled = false;
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        measure();
      });
    }
  };

  const gestured = (name) => {
    const capability = plan.capabilities[name];
    const activation = navigator.userActivation;
    return !(capability && capability.userActivation) || !activation || activation.isActive;
  };
  const refuse = (message) => Promise.reject(new Error(message));
  if (declared("sendPrompt")) {
    window.sendPrompt = (text) => {
      if (!gestured("sendPrompt")) {
        return refuse("sendPrompt needs a click: call it from a button's handler");
      }
      const words = String(text);
      if (words.trim() === "" || words.length > plan.maxPromptChars) {
        return refuse("sendPrompt takes 1 to " + plan.maxPromptChars + " characters");
      }
      return request("ui/message", { role: "user", content: [{ type: "text", text: words }] }).then(
        (result) => !(result && result.isError),
      );
    };
  }
  if (declared("openLink")) {
    window.openLink = (url) => {
      if (!gestured("openLink")) {
        return refuse("openLink needs a click: call it from a link's or button's handler");
      }
      return request("ui/open-link", { url: String(url) }).then((result) => !(result && result.isError));
    };
  }

  // Wired again after a document is written in (writing one erases the window's listeners).
  const wire = () => {
    window.addEventListener("error", (event) => {
      const error = event.error;
      const where = event.lineno ? " (line " + event.lineno + ")" : "";
      report(error && error.stack ? String(error.stack).split("\n").slice(0, 3).join(" ") : event.message + where);
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      report("Unhandled rejection: " + (reason && reason.message ? reason.message : String(reason)));
    });
    document.addEventListener("securitypolicyviolation", (event) => {
      report("Blocked by the sandbox: " + (event.blockedURI || "inline") + " (" + event.effectiveDirective + ")");
    });
    // A link opens outside, through the host, never in this frame; an in-page anchor still jumps.
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        const link = target && target.closest ? target.closest("a[href]") : null;
        if (link === null) {
          return;
        }
        const href = link.getAttribute("href") || "";
        if (href.charAt(0) === "#") {
          return;
        }
        event.preventDefault();
        if (/^https?:/i.test(link.href) && typeof window.openLink === "function") {
          window.openLink(link.href).catch(() => {});
        }
      },
      true,
    );
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(schedule).observe(root !== null && root.isConnected ? root : document.documentElement);
    }
    window.addEventListener("load", schedule);
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || plan.origins.indexOf(event.origin) === -1) {
        return;
      }
      receive(event.data);
    });
  };

  const SVG = /^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
  let rendered = false;

  // The content so far, drawn inert: what runs, loads a frame or navigates is left out, and every
  // attribute that runs code (on…) or names a javascript: URL. Parsed in a template, where nothing
  // runs; its scripts run only in the whole content, once (render).
  const INERT = "script,iframe,frame,frameset,object,embed,applet,portal,fencedframe,meta,base,noscript,link:not([rel~=stylesheet i])";
  const inert = (fragment) => {
    for (const element of Array.from(fragment.querySelectorAll(INERT))) {
      element.remove();
    }
    for (const element of Array.from(fragment.querySelectorAll("*"))) {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on") || /^\s*javascript:/i.test(attribute.value)) {
          element.removeAttributeNode(attribute);
        }
      }
    }
    return fragment;
  };
  // Change only what changed: what was drawn stays (an image doesn't load again, an animation
  // doesn't start over) as the content grows at its end.
  const morph = (into, from) => {
    const wanted = Array.from(from.childNodes);
    wanted.forEach((want, index) => {
      const have = into.childNodes[index];
      if (have === undefined) {
        into.appendChild(want);
      } else if (have.nodeType !== want.nodeType || have.nodeName !== want.nodeName || have.namespaceURI !== want.namespaceURI) {
        into.replaceChild(want, have);
      } else if (want.nodeType === 1) {
        for (const attribute of Array.from(have.attributes)) {
          if (!want.hasAttributeNS(attribute.namespaceURI, attribute.localName)) {
            have.removeAttributeNode(attribute);
          }
        }
        for (const attribute of Array.from(want.attributes)) {
          if (have.getAttributeNS(attribute.namespaceURI, attribute.localName) !== attribute.value) {
            have.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
          }
        }
        morph(have, want);
      } else if (have.nodeValue !== want.nodeValue) {
        have.nodeValue = want.nodeValue;
      }
    });
    while (into.childNodes.length > wanted.length) {
      into.removeChild(into.lastChild);
    }
  };
  let drafted = false;
  const draft = (input) => {
    if (rendered || root === null || input === null || typeof input !== "object" || plan.content === "document") {
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = String(input.html || "");
    morph(root, inert(template.content));
    drafted = true;
    schedule();
  };

  const render = async (input) => {
    if (rendered || root === null || input === null || typeof input !== "object") {
      return;
    }
    rendered = true;
    const html = String(input.html || "");
    if (plan.content === "document") {
      // A whole document, under the same policy, in place of the shell's.
      document.open();
      document.write(html);
      document.close();
      // The write replaced the tree and erased the window's listeners: guard the new tree, wire
      // the listeners again, and give the new root element the theme.
      root = null;
      armFrameGuard();
      wire();
      applyTheme(lastContext);
      schedule();
      return;
    }
    if (drafted) {
      // The whole content replaces its draft, and runs as if drawn first.
      root.textContent = "";
    }
    if (SVG.test(html)) {
      root.innerHTML = html;
      schedule();
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = html;
    const scripts = [];
    for (const script of Array.from(template.content.querySelectorAll("script"))) {
      const marker = document.createComment("script");
      script.replaceWith(marker);
      scripts.push({ script, marker });
    }
    root.appendChild(template.content);
    schedule();
    for (const { script, marker } of scripts) {
      const live = document.createElement("script");
      for (const attribute of Array.from(script.attributes)) {
        live.setAttribute(attribute.name, attribute.value);
      }
      // A script made by a script is async unless told otherwise: keep the page's order.
      live.async = script.hasAttribute("async");
      live.textContent = script.textContent;
      const external = live.hasAttribute("src") && !live.async && live.type !== "module";
      const loaded = external
        ? new Promise((resolve) => {
            live.addEventListener("load", resolve);
            live.addEventListener("error", () => {
              report("Couldn't load " + live.src);
              resolve();
            });
          })
        : null;
      marker.replaceWith(live);
      if (loaded !== null) {
        await loaded;
      }
    }
    schedule();
  };

  const receive = (data) => {
    if (data === null || typeof data !== "object" || data.jsonrpc !== "2.0") {
      return;
    }
    if (data.id !== undefined && data.method === undefined) {
      const waiting = pending.get(data.id);
      if (waiting !== undefined) {
        pending.delete(data.id);
        if (data.error) {
          waiting.reject(new Error(String(data.error.message || "refused")));
        } else {
          waiting.resolve(data.result);
        }
      }
      return;
    }
    const params = data.params !== null && typeof data.params === "object" ? data.params : {};
    switch (data.method) {
      case "ui/notifications/tool-input-partial":
        draft(params.arguments);
        break;
      case "ui/notifications/tool-input":
        void render(params.arguments);
        break;
      case "ui/notifications/host-context-changed":
        applyTheme(params);
        break;
      case "ui/resource-teardown":
      case "ping":
        if (data.id !== undefined) {
          send({ id: data.id, result: {} });
        }
        break;
      default:
        if (data.id !== undefined) {
          send({ id: data.id, error: { code: -32601, message: String(data.method) + " isn't offered here" } });
        }
        break;
    }
  };

  wire();

  // Ask until answered: the host may start listening after this runs.
  let initialized = false;
  let tries = 0;
  const initialize = () => {
    if (initialized || tries >= 40) {
      return;
    }
    tries += 1;
    request("ui/initialize", {
      protocolVersion: plan.protocolVersion,
      appInfo: { name: "porthole-shell", version: "1" },
      appCapabilities: {},
    }).then((result) => {
      if (initialized) {
        return;
      }
      initialized = true;
      applyTheme(result && result.hostContext);
      notify("ui/notifications/initialized", {});
      schedule();
    }, () => {});
    setTimeout(initialize, 250);
  };
  initialize();
})();`;
