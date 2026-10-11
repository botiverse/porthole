/**
 * The shell's runtime: the code that runs first in the frame, before any content. Plain ES2020,
 * no imports and no build step, so every engine (a browser frame now, a native web view later)
 * runs it as it is. `__PLAN__` is replaced with the frame's plan (`ShellPlan` plus the origins it
 * takes messages from, and a document to render, if any).
 *
 * Before any content runs, it:
 * 1. stands in for storage an opaque origin lacks (a map for the frame's life);
 * 2. removes every WebRTC constructor, non-configurably: a peer connection reaches the network
 *    outside connect-src (ICE gathering), and not every engine honors the CSP's `webrtc 'block'`;
 * 3. removes every frame-like element content adds, wherever it adds it (the document, any shadow
 *    root), since a nested frame runs in a fresh realm where step 2 never happened (and not every
 *    engine enforces `frame-src 'none'` for `srcdoc`/`about:blank` children); and the resource
 *    hints and refreshes a CSP doesn't govern;
 * 4. closes the parser entry points that could build a shadow root step 3 can't see (declarative
 *    shadow DOM through `setHTMLUnsafe`, `parseHTMLUnsafe`, `document.write`);
 * 5. keeps content off the clipboard: the async Clipboard API refuses, `execCommand` won't copy or
 *    cut, and copy and cut events never reach content, so what a person copies is what they
 *    selected (P051). Copy buttons go through the host (`copyText`, P052).
 * A whole document (an artifact page, an MCP Apps view) is never written in: it is parsed inert,
 * imported, and its scripts run in order, as a fragment's are.
 *
 * Then, when it speaks for the content (`protocol: "shell"`), it asks its host `ui/initialize`,
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
  // Fixed in place: content can neither restore what is removed nor replace what is wrapped.
  const lock = (target, name, value) => {
    try {
      Object.defineProperty(target, name, { configurable: false, writable: false, value });
    } catch (_) {}
  };

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
      lock(window, name, undefined);
    }
  }

  // No nested frames (each would be a fresh realm with WebRTC intact), no resource hints and no
  // refreshes (they reach the network outside the CSP's fetch directives). Removed as they are
  // added: a mutation observer's microtask runs before a child frame's document loads.
  const FRAMES = "iframe,frame,frameset,object,embed,portal,fencedframe";
  const HINTS = 'link[rel~="dns-prefetch" i],link[rel~="preconnect" i],link[rel~="prefetch" i],link[rel~="prerender" i],script[type="speculationrules" i],meta[http-equiv="refresh" i],meta[http-equiv="x-dns-prefetch-control" i]';
  const GUARDED = FRAMES + "," + HINTS;
  const guardedRoots = new WeakSet();
  let guardRoot = null;
  const strip = (node) => {
    if (node === null || (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11)) {
      return;
    }
    if (node.nodeType === 1 && node.matches(GUARDED)) {
      node.remove();
      return;
    }
    for (const element of Array.from(node.querySelectorAll(GUARDED))) {
      element.remove();
    }
    // Open shadow roots made without attachShadow (declarative ones the parser built elsewhere).
    if (node.nodeType === 1 && node.shadowRoot) {
      guardRoot(node.shadowRoot);
    }
    for (const element of Array.from(node.querySelectorAll("*"))) {
      if (element.shadowRoot) {
        guardRoot(element.shadowRoot);
      }
    }
  };
  const frameGuard = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        strip(node);
      }
    }
  });
  guardRoot = (root) => {
    if (guardedRoots.has(root)) {
      return;
    }
    guardedRoots.add(root);
    strip(root);
    frameGuard.observe(root, { childList: true, subtree: true });
  };
  guardRoot(document);

  // Every shadow root content makes, open or closed, is guarded as it is made.
  const attachShadow = Element.prototype.attachShadow;
  lock(Element.prototype, "attachShadow", function (init) {
    const root = attachShadow.call(this, init);
    guardRoot(root);
    return root;
  });

  // The parser builds declarative shadow roots (template shadowrootmode) without attachShadow, and
  // a closed one is out of the guard's reach. Fragment parsing doesn't build them, so the entry
  // points that would are given fragment parsing's behavior, and a document can't be rewritten.
  const parseInert = (html) => {
    const template = document.createElement("template");
    template.innerHTML = String(html);
    return template.content;
  };
  for (const proto of [Element.prototype, typeof ShadowRoot === "function" ? ShadowRoot.prototype : null]) {
    if (proto !== null && "setHTMLUnsafe" in proto) {
      lock(proto, "setHTMLUnsafe", function (html) {
        this.innerHTML = String(html);
      });
    }
  }
  if (typeof Document.parseHTMLUnsafe === "function") {
    lock(Document, "parseHTMLUnsafe", (html) => new DOMParser().parseFromString(String(html), "text/html"));
  }
  const noRewrite = function () {
    throw new Error("document.open and document.write aren't available here: build the page with DOM methods");
  };
  for (const name of ["open", "write", "writeln"]) {
    lock(Document.prototype, name, noRewrite);
  }

  // Some engines act on a hint the moment its element is connected or changed (WebKit opens a
  // preconnect then, outside the CSP), before the observer's microtask. So every way to connect a
  // node drops guarded elements first, synchronously, and a connected link or meta can't be
  // changed into one. The observer stays as the backstop for anything these miss.
  const admit = (node) => {
    if (node === null || typeof node !== "object" || typeof node.nodeType !== "number") {
      return true;
    }
    if (node.nodeType === 1 && node.matches(GUARDED)) {
      return false;
    }
    strip(node);
    return true;
  };
  const admitted = (args) => args.map((arg) => (admit(arg) ? arg : document.createTextNode("")));
  const wrapInsert = (proto, name, positions) => {
    const original = proto && proto[name];
    if (typeof original !== "function") {
      return;
    }
    lock(proto, name, function (...args) {
      const checked = positions === "all" ? admitted(args) : args.map((arg, index) => (positions.indexOf(index) !== -1 && !admit(arg) ? document.createTextNode("") : arg));
      return original.apply(this, checked);
    });
  };
  for (const proto of [Node.prototype]) {
    wrapInsert(proto, "appendChild", [0]);
    wrapInsert(proto, "insertBefore", [0]);
    wrapInsert(proto, "replaceChild", [0]);
  }
  for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
    for (const name of ["append", "prepend", "replaceChildren"]) {
      wrapInsert(proto, name, "all");
    }
  }
  for (const proto of [Element.prototype, CharacterData.prototype, DocumentType.prototype]) {
    for (const name of ["before", "after", "replaceWith"]) {
      wrapInsert(proto, name, "all");
    }
  }
  wrapInsert(Element.prototype, "insertAdjacentElement", [1]);
  wrapInsert(Range.prototype, "insertNode", [0]);
  wrapInsert(Range.prototype, "surroundContents", [0]);

  // Markup parsed in place: parsed first in a detached element of the same kind (so it parses as it
  // would in place, and nothing in it is connected yet), guarded, then moved in.
  const accessor = (proto, name) => (proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined);
  const contextFor = (element) => {
    if (element === null || element.nodeType !== 1) {
      return document.createElement("div");
    }
    // A fresh element of the same kind; a custom element's own class is not run again.
    const name = element.localName.indexOf("-") === -1 ? element.localName : "div";
    return document.createElementNS(element.namespaceURI, name);
  };
  const innerHTMLs = [accessor(Element.prototype, "innerHTML"), accessor(typeof ShadowRoot === "function" ? ShadowRoot.prototype : null, "innerHTML")];
  const setInner = (innerHTMLs[0] || innerHTMLs[1]).set;
  const parseIn = (contextElement, html) => {
    const box = contextFor(contextElement);
    setInner.call(box, String(html));
    strip(box);
    return Array.from(box.childNodes);
  };
  [Element.prototype, typeof ShadowRoot === "function" ? ShadowRoot.prototype : null].forEach((proto, index) => {
    const descriptor = innerHTMLs[index];
    if (!proto || !descriptor || !descriptor.set) {
      return;
    }
    Object.defineProperty(proto, "innerHTML", {
      configurable: false,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(html) {
        if (this.nodeType === 1 && this.localName === "template") {
          descriptor.set.call(this, html);
          return;
        }
        this.replaceChildren(...parseIn(this.nodeType === 11 ? this.host || null : this, html));
      },
    });
  });
  const outer = accessor(Element.prototype, "outerHTML");
  if (outer && outer.set) {
    Object.defineProperty(Element.prototype, "outerHTML", {
      configurable: false,
      enumerable: outer.enumerable,
      get: outer.get,
      set(html) {
        const parent = this.parentNode;
        if (parent === null || parent.nodeType === 9) {
          outer.set.call(this, html);
          return;
        }
        this.replaceWith(...parseIn(parent.nodeType === 1 ? parent : null, html));
      },
    });
  }
  const insertAdjacentHTML = Element.prototype.insertAdjacentHTML;
  lock(Element.prototype, "insertAdjacentHTML", function (position, html) {
    insertAdjacentHTML.call(this, position, "");
    const where = String(position).toLowerCase();
    const outside = where === "beforebegin" || where === "afterend";
    const nodes = parseIn(outside ? this.parentElement : this, html);
    if (where === "beforebegin") {
      this.before(...nodes);
    } else if (where === "afterbegin") {
      this.prepend(...nodes);
    } else if (where === "beforeend") {
      this.append(...nodes);
    } else {
      this.after(...nodes);
    }
  });
  if (typeof Element.prototype.setHTML === "function") {
    lock(Element.prototype, "setHTML", function (html) {
      this.innerHTML = String(html);
    });
  }
  // insertHTML parses markup outside these guards; copy, cut and paste reach the clipboard (P051).
  const REFUSED_COMMANDS = ["inserthtml", "copy", "cut", "paste"];
  const execCommand = Document.prototype.execCommand;
  if (typeof execCommand === "function") {
    lock(Document.prototype, "execCommand", function (command, ...rest) {
      return REFUSED_COMMANDS.indexOf(String(command).toLowerCase()) !== -1 ? false : execCommand.call(this, command, ...rest);
    });
  }

  // The clipboard is the host's to write (P051): content can neither write nor read it. A copy
  // the person makes (their keys, their menu) copies their selection as the browser makes it: no
  // copy or cut listener of the content's runs, so none can swap what goes on the clipboard.
  const noClipboard = function () {
    return Promise.reject(new DOMException("Content can't use the clipboard here" + (declared("copyText") ? ": call copyText(text) from a click" : ""), "NotAllowedError"));
  };
  if (typeof Clipboard === "function") {
    for (const name of ["write", "writeText", "read", "readText"]) {
      if (typeof Clipboard.prototype[name] === "function") {
        lock(Clipboard.prototype, name, noClipboard);
      }
    }
  }
  for (const type of ["copy", "cut"]) {
    window.addEventListener(type, (event) => event.stopImmediatePropagation(), true);
  }

  // A connected link or meta can't become a guarded one: the change is tried on a detached copy
  // first, and if the copy would be guarded, the element leaves the document before it changes.
  const watched = (element) => element && element.nodeType === 1 && (element.localName === "link" || element.localName === "meta");
  const beforeChange = (element, change) => {
    if (!watched(element) || !element.isConnected) {
      return;
    }
    const copy = element.cloneNode(false);
    try {
      change(copy);
    } catch (_) {
      return;
    }
    if (copy.matches(GUARDED)) {
      element.remove();
    }
  };
  const guardMethod = (proto, name, change) => {
    const original = proto && proto[name];
    if (typeof original !== "function") {
      return;
    }
    lock(proto, name, function (...args) {
      beforeChange(this, (copy) => change(copy, args, original));
      return original.apply(this, args);
    });
  };
  for (const name of ["setAttribute", "setAttributeNS", "toggleAttribute", "removeAttribute", "removeAttributeNS"]) {
    guardMethod(Element.prototype, name, (copy, args, original) => original.apply(copy, args));
  }
  for (const name of ["setAttributeNode", "setAttributeNodeNS"]) {
    guardMethod(Element.prototype, name, (copy, args) => copy.setAttributeNS(args[0].namespaceURI, args[0].name, args[0].value));
  }
  for (const [proto, name] of [[Attr.prototype, "value"], [Node.prototype, "nodeValue"], [Node.prototype, "textContent"]]) {
    const descriptor = accessor(proto, name);
    if (!descriptor || !descriptor.set) {
      continue;
    }
    Object.defineProperty(proto, name, {
      configurable: false,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        if (this.nodeType === 2 && this.ownerElement) {
          const attribute = this;
          beforeChange(attribute.ownerElement, (copy) => copy.setAttributeNS(attribute.namespaceURI, attribute.name, String(value)));
        }
        descriptor.set.call(this, value);
      },
    });
  }
  // Attribute maps and token lists don't name their element: remember it when content gets one.
  const owners = new WeakMap();
  const remember = (proto, name) => {
    const descriptor = accessor(proto, name);
    if (!descriptor || !descriptor.get) {
      return;
    }
    Object.defineProperty(proto, name, {
      configurable: false,
      enumerable: descriptor.enumerable,
      get() {
        const value = descriptor.get.call(this);
        if (value !== null && typeof value === "object") {
          owners.set(value, this);
        }
        return value;
      },
      // relList = "…" forwards to the list's value, natively: guarded here instead.
      set: descriptor.set
        ? function (value) {
            beforeChange(this, (copy) => descriptor.set.call(copy, value));
            descriptor.set.call(this, value);
          }
        : undefined,
    });
  };
  remember(Element.prototype, "attributes");
  for (const proto of [
    typeof HTMLLinkElement === "function" ? HTMLLinkElement.prototype : null,
    typeof HTMLMetaElement === "function" ? HTMLMetaElement.prototype : null,
  ]) {
    remember(proto, "relList");
    for (const name of Object.getOwnPropertyNames(proto || {})) {
      const descriptor = accessor(proto, name);
      if (descriptor && descriptor.set && name !== "relList") {
        Object.defineProperty(proto, name, {
          configurable: false,
          enumerable: descriptor.enumerable,
          get: descriptor.get,
          set(value) {
            beforeChange(this, (copy) => descriptor.set.call(copy, value));
            descriptor.set.call(this, value);
          },
        });
      }
    }
  }
  for (const name of ["setNamedItem", "setNamedItemNS", "removeNamedItem", "removeNamedItemNS"]) {
    const original = NamedNodeMap.prototype[name];
    if (typeof original !== "function") {
      continue;
    }
    lock(NamedNodeMap.prototype, name, function (...args) {
      beforeChange(owners.get(this), (copy) => {
        if (name.indexOf("set") === 0) {
          copy.setAttributeNS(args[0].namespaceURI, args[0].name, args[0].value);
        } else {
          copy.removeAttribute(args[args.length - 1]);
        }
      });
      return original.apply(this, args);
    });
  }
  const tokens = typeof DOMTokenList === "function" ? DOMTokenList.prototype : null;
  for (const name of ["add", "remove", "replace", "toggle"]) {
    const original = tokens && tokens[name];
    if (typeof original === "function") {
      lock(tokens, name, function (...args) {
        const element = owners.get(this);
        beforeChange(element, (copy) => original.apply(copy.relList, args));
        return original.apply(this, args);
      });
    }
  }
  const tokenValue = accessor(tokens, "value");
  if (tokenValue && tokenValue.set) {
    Object.defineProperty(tokens, "value", {
      configurable: false,
      enumerable: tokenValue.enumerable,
      get: tokenValue.get,
      set(value) {
        beforeChange(owners.get(this), (copy) => tokenValue.set.call(copy.relList, value));
        tokenValue.set.call(this, value);
      },
    });
  }

  let root = document.getElementById("porthole-root");
  let reported = 0;
  const report = (message) => {
    if (!declared("reportError") || reported >= plan.maxErrorReports) {
      return;
    }
    reported += 1;
    send({ method: "notifications/message", params: { level: "error", logger: "porthole", data: String(message).slice(0, 2000) } });
  };
  const send = (message) => {
    if (plan.protocol === "shell" && window.parent !== window) {
      // Nothing secret is ever said from here, so any parent may hear it; what it hears is the
      // content's word, which the host gates before it acts on it.
      window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, message), "*");
    }
  };

  // A parsed tree's scripts are held (each replaced by a numbered marker) and run later, in order,
  // as the page's parser would run them: each made again, live, in its marker's place, and each
  // external one loaded before the next runs. Markers are found in the live document by number, so
  // this works the same for a fragment that was moved in and a document that was imported.
  let held = 0;
  const holdScripts = (tree, owner) => {
    const scripts = [];
    for (const script of Array.from(tree.querySelectorAll("script"))) {
      const marker = owner.createComment("porthole-script:" + held);
      held += 1;
      script.replaceWith(marker);
      scripts.push({ script, id: marker.data });
    }
    return scripts;
  };
  const markers = () => {
    const found = new Map();
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.data.indexOf("porthole-script:") === 0) {
        found.set(node.data, node);
      }
    }
    return found;
  };
  const runScripts = async (scripts) => {
    const placed = markers();
    for (const { script, id } of scripts) {
      const marker = placed.get(id);
      if (marker === undefined) {
        continue;
      }
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
  };
  // The page's own load events, for code that waits for them: its scripts ran after the shell's
  // document had loaded, so they fire again, once, after them.
  const announceLoaded = () => {
    document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true }));
    window.dispatchEvent(new Event("load"));
  };

  // A fragment takes the person's scheme; a whole document only if it declares that it supports
  // both (or the config says always), else it shows as its author styled it (P039).
  let lastContext = null;
  let themed = plan.content !== "document";
  const schemeFollows = () => {
    const root = document.documentElement;
    const theme = lastContext && lastContext.theme;
    if (themed && (theme === "light" || theme === "dark")) {
      root.style.colorScheme = theme;
      root.setAttribute("data-theme", theme);
    } else {
      root.style.removeProperty("color-scheme");
      root.removeAttribute("data-theme");
    }
  };
  // A whole document, parsed inert (no scripts run, no declarative shadow roots built), guarded,
  // imported in place of the shell's, then its scripts run in order. The theme on the root stays.
  const renderDocument = async (html) => {
    const parsed = new DOMParser().parseFromString(String(html), "text/html");
    strip(parsed);
    const scripts = holdScripts(parsed, parsed);
    const element = document.documentElement;
    for (const attribute of Array.from(parsed.documentElement.attributes)) {
      if (attribute.name !== "style") {
        element.setAttribute(attribute.name, attribute.value);
      }
    }
    document.head.replaceChildren(...Array.from(parsed.head.childNodes, (node) => document.importNode(node, true)));
    document.body.replaceWith(document.importNode(parsed.body, true));
    root = null;
    const declaredScheme = parsed.querySelector('meta[name="color-scheme" i]');
    themed = plan.themeDocuments === "always" || (declaredScheme !== null && /\bdark\b/i.test(declaredScheme.getAttribute("content") || ""));
    schemeFollows();
    await runScripts(scripts);
    announceLoaded();
  };

  // A document the plan carries (a served page, an MCP Apps view) is rendered once the shell's own
  // document has loaded, whichever protocol the frame speaks.
  const whenLoaded = (run) => {
    if (document.readyState === "complete") {
      run();
    } else {
      window.addEventListener("load", run, { once: true });
    }
  };

  __ANNOTATE__

  if (plan.protocol !== "shell") {
    // A view that speaks for itself.
    if (typeof plan.document === "string") {
      whenLoaded(() => void renderDocument(plan.document));
    }
    return;
  }

  // Content in this window may speak MCP Apps too (the official App SDK numbers its requests):
  // the shell's ids are its own strings, so neither takes the other's answers.
  let nextId = 1;
  const pending = new Map();
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = "porthole-shell-" + nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const notify = (method, params) => send({ method, params });

  const themeNames = new Set(plan.themeVariables);
  const applyTheme = (context) => {
    if (context === null || typeof context !== "object") {
      return;
    }
    // The spec's variables, and Porthole's own beside them (its own-prefixed field).
    const own = context["porthole/styles"];
    for (const variables of [context.styles && context.styles.variables, own && own.variables]) {
      if (variables === null || typeof variables !== "object") {
        continue;
      }
      for (const name of Object.keys(variables)) {
        const value = variables[name];
        if (themeNames.has(name) && typeof value === "string") {
          document.documentElement.style.setProperty(name, value);
        }
      }
    }
    lastContext = context;
    schemeFollows();
    window.dispatchEvent(new CustomEvent(plan.themeEvent, { detail: { theme: context.theme } }));
  };

  // No size before there is something to size: an empty shell's height would make the host
  // forget the height it remembered for this display, and the frame would jump.
  let drawn = false;
  let lastHeight = -1;
  const measure = () => {
    if (!declared("resize") || !drawn) {
      return;
    }
    const box = root !== null && root.isConnected ? root : document.documentElement;
    const rect = box.getBoundingClientRect();
    const height = Math.ceil(box === root ? Math.max(rect.height, root.scrollHeight) : rect.height);
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
    lock(window, "sendPrompt", (text) => {
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
    });
  }
  if (declared("copyText")) {
    lock(window, "copyText", (text) => {
      if (!gestured("copyText")) {
        return refuse("copyText needs a click: call it from a button's handler");
      }
      const words = String(text);
      if (words === "" || words.length > plan.maxCopyChars) {
        return refuse("copyText takes 1 to " + plan.maxCopyChars + " characters");
      }
      return request("porthole/copy-text", { text: words }).then((result) => !(result && result.isError));
    });
  }
  if (declared("openLink")) {
    lock(window, "openLink", (url) => {
      if (!gestured("openLink")) {
        return refuse("openLink needs a click: call it from a link's or button's handler");
      }
      return request("ui/open-link", { url: String(url) }).then((result) => !(result && result.isError));
    });
  }

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
  // A link never navigates this frame: an http(s) one opens outside, through the host, and an
  // in-page anchor still jumps. SVG links (href or xlink:href) and image-map areas too.
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      const link = target && target.closest ? target.closest("a, area") : null;
      if (link === null) {
        return;
      }
      const href = link.getAttribute("href") || link.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
      if (href === "" || href.charAt(0) === "#") {
        return;
      }
      event.preventDefault();
      let url = "";
      try {
        url = new URL(href, document.baseURI).href;
      } catch (_) {}
      if (/^https?:/i.test(url) && typeof window.openLink === "function") {
        window.openLink(url).catch(() => {});
      }
    },
    true,
  );
  if (typeof ResizeObserver === "function") {
    const sizes = new ResizeObserver(schedule);
    sizes.observe(document.documentElement);
    if (root !== null) {
      sizes.observe(root);
    }
  }
  window.addEventListener("load", schedule);

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
    morph(root, inert(parseInert(input.html || "")));
    drafted = true;
    drawn = true;
    schedule();
  };

  const SVG = /^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
  const render = async (input) => {
    if (rendered || input === null || typeof input !== "object") {
      return;
    }
    rendered = true;
    drawn = true;
    const html = String(input.html || "");
    if (plan.content === "document") {
      await renderDocument(html);
      schedule();
      return;
    }
    if (root === null) {
      return;
    }
    if (drafted) {
      // The whole content replaces its draft, and runs as if drawn first.
      root.textContent = "";
    }
    // SVG goes in as drawn: its scripts, if any, stay inert.
    const fragment = parseInert(html);
    strip(fragment);
    const scripts = SVG.test(html) ? [] : holdScripts(fragment, document);
    root.appendChild(fragment);
    schedule();
    await runScripts(scripts);
    announceLoaded();
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
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || plan.origins.indexOf(event.origin) === -1) {
      return;
    }
    receive(event.data);
  });
  if (typeof plan.document === "string") {
    whenLoaded(() => void render({ html: plan.document }));
  }

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
