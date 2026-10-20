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
 *    selected (P051). Copy buttons go through the host (`copyText`, P052);
 * 6. cancels every navigation the frame starts to another document (P079), before it sends a
 *    request: a navigation carries data out in its URL, and the embedding page's `frame-src`,
 *    the wall for that, must let served frames reach their own content origins. (Opaque frames
 *    get no navigate events: there `frame-src` is the wall.) A page that comes with files may
 *    open its set's other pages, under its version's own address, and nothing else (P084).
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
  // A page that came with files, answered at its ticket's address (P083): its own address first,
  // before anything loads, so its relative addresses are its files' (and the ticket leaves).
  if (plan.files && typeof plan.files.address === "string" && location.href !== plan.files.address) {
    try {
      history.replaceState(null, "", plan.files.address);
    } catch (_) {}
  }
  // The embedding page's nonce, where it gave one (a srcdoc frame inherits its policy): every
  // script the shell runs for the content carries it.
  const nonce = document.currentScript && document.currentScript.nonce ? document.currentScript.nonce : "";
  const declared = (name) => Object.prototype.hasOwnProperty.call(plan.capabilities, name);
  // Fixed in place: content can neither restore what is removed nor replace what is wrapped. A
  // property something fixed before the shell ran (an extension, an engine's own) can't be: each
  // such name goes on the shell's own script element (data-porthole-unfixed, for a test or a
  // person to see) and, once the shell can speak, to the host as an error report.
  const shellScript = document.currentScript;
  const unfixed = [];
  let tellUnfixed = (_name) => {};
  const lock = (target, name, value) => {
    try {
      Object.defineProperty(target, name, { configurable: false, writable: false, value });
    } catch (_) {
      unfixed.push(String(name));
      try {
        if (shellScript) {
          shellScript.setAttribute("data-porthole-unfixed", unfixed.join(" "));
        }
      } catch (_) {}
      tellUnfixed(String(name));
    }
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

  // No navigation to another document (P079): a frame that navigates itself carries data out in
  // the URL, and the embedding page's frame-src, the other wall, lets served frames reach every
  // content origin. (An opaque frame gets no navigate events, as the spec says for opaque
  // origins, measured: there frame-src is the wall, P033.) The navigate event comes before any request for every
  // navigation this document starts (location, a link, window.open(…, "_self"), a refresh), and
  // cancelling it stops it. Ours is the first listener, and reads the event through the platform's
  // own getters, kept now, so content can neither stop it nor lie to it. Same-document ones (an
  // anchor) go on, and so do reloads: the same address, on the frame's own origin (or none, in a
  // srcdoc frame), which history can change only within that origin. The host's own (a new
  // frame) are none of this document's. Each one stopped is told to the host (P080), as an error
  // report: below, once the shell can speak.
  let navigationBlocked = (_url) => {};
  // A page that comes with files (P084): another page of its own set, under the version's own
  // address, is a page of the same content and opens in the frame (the host is told first, so it
  // takes the next load for that page, not for content that left). Anything else stays stopped:
  // another path of the origin, a file that isn't a page, another origin.
  let navigating = (_url) => {};
  let filesBase = plan.files && typeof plan.files.base === "string" ? plan.files.base : null;
  // Every address the page's files had (P083: a sealed one is renewed): what reports say as "./".
  const filesBases = filesBase === null ? [] : [filesBase];
  // A frame's sealed files' address is its access: nothing the shell reports names it (P083).
  const SEALED = /(?:https?:\/\/[^\s"'<>\/]+)?\/__porthole\/f\/[A-Za-z0-9_-]{20,}\//g;
  const ownAddresses = (text) => {
    let out = String(text);
    for (const base of filesBases) {
      out = out.split(base).join("./");
    }
    return out.replace(SEALED, "./");
  };
  // The platform's own string and URL functions, kept now (P099): the rules that decide where this
  // document may go must read an address as the platform does, whatever content later puts on
  // String.prototype, URL or Reflect.
  const callOf = Reflect.apply;
  const NativeString = String;
  const NativeURL = URL;
  const urlHref = Object.getOwnPropertyDescriptor(URL.prototype, "href").get;
  const indexIn = String.prototype.indexOf;
  const lastIndexIn = String.prototype.lastIndexOf;
  const sliceOf = String.prototype.slice;
  const lowerOf = String.prototype.toLowerCase;
  const before = (text, mark) => {
    const at = callOf(indexIn, text, [mark]);
    return at < 0 ? text : callOf(sliceOf, text, [0, at]);
  };
  const ownPage = (url) => {
    if (filesBase === null || typeof url !== "string" || callOf(indexIn, url, [filesBase]) !== 0) {
      return false;
    }
    const path = before(before(callOf(sliceOf, url, [filesBase.length]), "#"), "?");
    const last = callOf(lowerOf, callOf(sliceOf, path, [callOf(lastIndexIn, path, ["/"]) + 1]), []);
    return last === "" || callOf(indexIn, last, ["."]) < 0 || callOf(sliceOf, last, [-5]) === ".html" || callOf(sliceOf, last, [-4]) === ".htm";
  };
  const navigationApi = window.navigation;
  const getterOf = (proto, name) => {
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined;
    return descriptor && typeof descriptor.get === "function" ? descriptor.get : null;
  };
  const navigateProto = typeof NavigateEvent === "function" ? NavigateEvent.prototype : null;
  const destinationOf = getterOf(navigateProto, "destination");
  const navigationTypeOf = getterOf(navigateProto, "navigationType");
  const destinationProto = typeof NavigationDestination === "function" ? NavigationDestination.prototype : null;
  const sameDocumentOf = getterOf(destinationProto, "sameDocument");
  const urlOf = getterOf(destinationProto, "url");
  const preventNavigation = Event.prototype.preventDefault;
  const applyOf = Reflect.apply;
  // A page of a set that a navigation opened (not its ticket's answer) says so as it arrives
  // (P098), below, once the shell can speak: the notice its last page sent as it left can reach
  // the host after this page's load, or never (Chromium forwards a cross-process message from a
  // task of the sending document's, which a navigation that commits first drops).
  let arrived = false;
  if (navigationApi && typeof navigationApi.addEventListener === "function" && destinationOf !== null && sameDocumentOf !== null && navigationTypeOf !== null) {
    arrived = filesBase !== null && typeof plan.files.address !== "string";
    navigationApi.addEventListener("navigate", (event) => {
      const destination = applyOf(destinationOf, event, []);
      if (!applyOf(sameDocumentOf, destination, []) && applyOf(navigationTypeOf, event, []) !== "reload") {
        const url = urlOf === null ? "" : String(applyOf(urlOf, destination, []));
        if (ownPage(url)) {
          navigating(url);
          return;
        }
        applyOf(preventNavigation, event, []);
        navigationBlocked(url);
      }
    }, true);
  }

  // The calls that start a navigation and can be asked first ask the guard's rule before they
  // start one (P099): WebKit sends navigation.navigate()'s request though the navigate event
  // cancels it (measured on a tab: an outside site heard it). Within the document (a fragment, the
  // same address) or another page of its own set (P084) goes on, as the guard lets it; anything
  // else is stopped here, before any request, and the host told, as the guard does.
  // The address is read once (String() and resolved here), and the call is given that address,
  // absolute: what was checked is what goes, whatever an object's toString says the next time.
  const mayNavigate = (url) => {
    const text = NativeString(url);
    let target = "";
    try {
      target = callOf(urlHref, new NativeURL(text, document.baseURI), []);
    } catch (_) {
      throw new DOMException("Not a URL", "SyntaxError");
    }
    return { go: before(target, "#") === before(location.href, "#") || ownPage(target), target };
  };
  const navigationProto = typeof Navigation === "function" ? Navigation.prototype : null;
  if (navigationProto !== null && typeof navigationProto.navigate === "function") {
    const navigateOriginal = navigationProto.navigate;
    lock(navigationProto, "navigate", function (url, options) {
      const asked = mayNavigate(url);
      if (asked.go) {
        return applyOf(navigateOriginal, this, [asked.target, options]);
      }
      navigationBlocked(asked.target);
      const aborted = Promise.reject(new DOMException("Navigation was aborted", "AbortError"));
      aborted.catch(() => {});
      return { committed: aborted, finished: aborted };
    });
  }

  // A page on a tab of its own opens no window (P099): a window would carry what a visitor typed
  // out in its address. Its document's CSP sandbox is the wall (no allow-popups); this is the
  // second, for an edge that drops the header. In a frame the frame's sandbox answers already
  // (null; a throw on Firefox). "_self" stays a navigation of this document, where the guard's
  // rule lets one (mayNavigate, above); every other target opens nothing. Nor a picture-in-picture document (Chromium,
  // Firefox): a window of this origin in a fresh realm, where nothing above ever ran (only a
  // top-level page may open one, so a frame can't).
  if (window.top === window) {
    const openWindow = window.open;
    lock(window, "open", function (url, target, features) {
      if (typeof target !== "string" || target.trim().toLowerCase() !== "_self") {
        return null;
      }
      const asked = mayNavigate(url);
      if (!asked.go) {
        navigationBlocked(asked.target);
        return null;
      }
      return applyOf(openWindow, window, [asked.target, "_self", features]);
    });
    if (typeof DocumentPictureInPicture === "function") {
      lock(DocumentPictureInPicture.prototype, "requestWindow", () => Promise.reject(new DOMException("A page here opens no other window", "NotAllowedError")));
    }
    // A link that would navigate this tab (no target, _self, _top, _parent) asks the same rule, from
    // the first click listener there is (window, capturing, the shell's own before any content's):
    // WebKit sends a link's request though the navigate event cancels it (measured), and content
    // can step past the shell's own link handling below. Read through the platform's own getters.
    const eventTarget = getterOf(Event.prototype, "target");
    const closestOf = Element.prototype.closest;
    const attributeOf = Element.prototype.getAttribute;
    const attributeNSOf = Element.prototype.getAttributeNS;
    window.addEventListener("click", (event) => {
      let link = null;
      try {
        const element = eventTarget === null ? null : callOf(eventTarget, event, []);
        link = element ? callOf(closestOf, element, ["a, area"]) : null;
      } catch (_) {}
      if (link === null) {
        return;
      }
      const target = callOf(lowerOf, NativeString(callOf(attributeOf, link, ["target"]) || ""), []);
      if (target !== "" && target !== "_self" && target !== "_top" && target !== "_parent") {
        return;
      }
      const href = callOf(attributeOf, link, ["href"]) || callOf(attributeNSOf, link, ["http://www.w3.org/1999/xlink", "href"]) || "";
      let asked = { go: false, target: "" };
      try {
        asked = mayNavigate(href);
      } catch (_) {}
      if (!asked.go) {
        callOf(preventNavigation, event, []);
      }
    }, true);
  }

  // Nor, on a tab, the camera, the microphone, the screen, location, full screen, passkeys, the
  // share sheet or payments (P099): a frame has none of them (its allow grants none), a tab has
  // no allow, and its Permissions-Policy header, the wall on Chromium, isn't applied to them by
  // WebKit and Firefox (measured). Each refuses as a denial does, at once, with no prompt.
  if (window.top === window) {
    const deny = () => Promise.reject(new DOMException("Not available here", "NotAllowedError"));
    if (typeof MediaDevices === "function") {
      for (const name of ["getUserMedia", "getDisplayMedia", "selectAudioOutput"]) {
        if (typeof MediaDevices.prototype[name] === "function") {
          lock(MediaDevices.prototype, name, deny);
        }
      }
    }
    for (const name of ["getUserMedia", "webkitGetUserMedia", "mozGetUserMedia"]) {
      if (typeof Navigator.prototype[name] === "function") {
        lock(Navigator.prototype, name, function (_constraints, _success, failure) {
          if (typeof failure === "function") {
            setTimeout(() => failure(new DOMException("Not available here", "NotAllowedError")), 0);
          }
        });
      }
    }
    if (typeof Geolocation === "function") {
      const deniedPosition = { code: 1, message: "Not available here", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
      const denyPosition = function (_success, failure) {
        if (typeof failure === "function") {
          setTimeout(() => failure(deniedPosition), 0);
        }
        return 0;
      };
      lock(Geolocation.prototype, "getCurrentPosition", denyPosition);
      lock(Geolocation.prototype, "watchPosition", denyPosition);
    }
    lock(Element.prototype, "requestFullscreen", () => Promise.reject(new TypeError("Full screen isn't available here")));
    for (const name of ["webkitRequestFullscreen", "webkitRequestFullScreen", "mozRequestFullScreen"]) {
      if (typeof Element.prototype[name] === "function") {
        lock(Element.prototype, name, () => undefined);
      }
    }
    // A video's own full screen (WebKit), passkeys and saved passwords, the share sheet, and
    // payments (whose method's address the browser fetches outside the CSP; WebKit's Apple Pay
    // sheet): each a prompt or a way out a frame never has.
    const notHere = () => {
      throw new DOMException("Not available here", "NotAllowedError");
    };
    if (typeof HTMLVideoElement === "function") {
      for (const name of ["webkitEnterFullscreen", "webkitEnterFullScreen"]) {
        if (typeof HTMLVideoElement.prototype[name] === "function") {
          lock(HTMLVideoElement.prototype, name, notHere);
        }
      }
    }
    if (typeof CredentialsContainer === "function") {
      for (const name of ["create", "get", "store"]) {
        if (typeof CredentialsContainer.prototype[name] === "function") {
          lock(CredentialsContainer.prototype, name, deny);
        }
      }
    }
    if (typeof Navigator.prototype.share === "function") {
      lock(Navigator.prototype, "share", deny);
      lock(Navigator.prototype, "canShare", () => false);
    }
    if (typeof PaymentRequest === "function") {
      lock(window, "PaymentRequest", function () {
        throw new DOMException("Payments aren't available here", "SecurityError");
      });
    }
    if (typeof ApplePaySession === "function") {
      lock(window, "ApplePaySession", function () {
        throw new DOMException("Payments aren't available here", "SecurityError");
      });
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
    return Promise.reject(new DOMException("Content can't use the clipboard here" + (declared("copyText") ? (plan.runtime ? ': call (await porthole.use("clipboard")).copy(text) from a click' : ": call copyText(text) from a click") : ""), "NotAllowedError"));
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
    send({ method: "notifications/message", params: { level: "error", logger: "porthole", data: ownAddresses(message).slice(0, 2000) } });
  };
  // Nothing secret is ever said from here, so any parent may hear it; what it hears is the
  // content's word, which the host gates before it acts on it.
  const post = (message) => {
    if (window.parent !== window) {
      window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, message), "*");
    }
  };
  const send = (message) => {
    if (plan.protocol === "shell") {
      post(message);
    }
  };
  // A navigation the guard above stopped (P080): one of the run's error reports, told even where
  // the content speaks for itself (an MCP Apps view), in Porthole's own notification.
  navigationBlocked = (url) => {
    if (!declared("reportError") || reported >= plan.maxErrorReports || url === "") {
      return;
    }
    reported += 1;
    post({ method: "porthole/navigation-blocked", params: { url: ownAddresses(url).slice(0, 4096) } });
  };
  // Another page of the set opening in the frame (P084): the host takes the next load for it. Each
  // notice names the version the files are (P098): the host takes one only for the version it
  // mounted.
  const filesSet = plan.files && plan.files.set && typeof plan.files.set === "object" ? { id: String(plan.files.set.id), version: String(plan.files.set.version) } : null;
  const notice = (url, more) => post({ method: "porthole/navigating", params: Object.assign({ url: ownAddresses(url).slice(0, 4096) }, filesSet === null ? {} : { set: filesSet }, more) });
  navigating = (url) => notice(url, {});
  if (arrived) {
    notice(location.href, { arrived: true });
  }
  // A sealed files' address opens the page's files on its own for a while (P083): renewed before
  // it ends, the page moved to the new one in place (the same page, the same history entry). Its
  // modules keep the address they loaded from; the server serves their own loads till the session
  // ends.
  if (filesBase !== null && typeof plan.files.expires === "number") {
    const nativeFetch = window.fetch.bind(window);
    const replace = History.prototype.replaceState;
    const renewIn = (expires) => Math.max(30000, expires - Date.now() - 300000);
    const renew = () => {
      nativeFetch(filesBase + "__porthole/renew", { credentials: "omit", cache: "no-store" })
        .then((answer) => (answer.ok ? answer.json() : null))
        .then((renewed) => {
          // Checked through the platform's own functions: content may have replaced a prototype's,
          // and the base decides where this page may go (ownPage).
          const prefix = location.origin + "/__porthole/f/";
          if (!renewed || typeof renewed.base !== "string" || typeof renewed.expires !== "number" || callOf(indexIn, renewed.base, [prefix]) !== 0 || callOf(indexIn, callOf(sliceOf, renewed.base, [prefix.length, -1]), ["/"]) !== -1 || callOf(sliceOf, renewed.base, [-1]) !== "/") {
            return;
          }
          const here = location.href;
          if (here.indexOf(filesBase) === 0) {
            try {
              applyOf(replace, history, [history.state, "", renewed.base + here.slice(filesBase.length)]);
            } catch (_) {}
          }
          filesBase = renewed.base;
          filesBases.push(renewed.base);
          setTimeout(renew, renewIn(renewed.expires));
        })
        .catch(() => setTimeout(renew, 60000));
    };
    setTimeout(renew, renewIn(plan.files.expires));
  }

  // What the shell couldn't fix in place (above), told to the host now that it can be, and after.
  tellUnfixed = (name) => report("Porthole couldn't fix " + name + " in place: a defense here may be missing");
  unfixed.forEach((name) => tellUnfixed(name));

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
      if (nonce !== "") {
        live.nonce = nonce;
      }
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

  // Whether the content is in place: a fragment or page the shell draws, once drawn whole; a
  // view the plan carries, once rendered; a view that is the document itself, from the start.
  const contentHooks = [];
  let contentIn = typeof plan.document !== "string" && plan.protocol !== "shell";
  const contentIsIn = () => contentIn;
  const whenContentIsIn = (run) => {
    if (contentIn) {
      run();
    } else {
      contentHooks.push(run);
    }
  };
  const contentArrived = () => {
    if (!contentIn) {
      contentIn = true;
      for (const run of contentHooks.splice(0)) {
        run();
      }
    }
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
    themed = plan.themeDocuments !== "never" && (plan.themeDocuments === "always" || (declaredScheme !== null && /\bdark\b/i.test(declaredScheme.getAttribute("content") || "")));
    schemeFollows();
    await runScripts(scripts);
    announceLoaded();
    contentArrived();
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
  // What the content was last told of (its scheme and values): the theme it starts with is no
  // change, and a host context that changes neither (a host re-sending it) is none either.
  let announced = null;
  const applyTheme = (context) => {
    if (context === null || typeof context !== "object") {
      return;
    }
    // The spec's variables, and Porthole's own beside them (its own-prefixed field).
    const own = context["porthole/styles"];
    const applied = [];
    for (const variables of [context.styles && context.styles.variables, own && own.variables]) {
      if (variables === null || typeof variables !== "object") {
        continue;
      }
      for (const name of Object.keys(variables)) {
        const value = variables[name];
        if (themeNames.has(name) && typeof value === "string") {
          document.documentElement.style.setProperty(name, value);
          applied.push(name + ":" + value);
        }
      }
    }
    lastContext = context;
    schemeFollows();
    const now = JSON.stringify([context.theme, applied.sort()]);
    if (announced === null) {
      announced = now;
      return;
    }
    if (now !== announced) {
      announced = now;
      window.dispatchEvent(new CustomEvent(plan.themeEvent, { detail: { theme: context.theme } }));
    }
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
  // Data (P079): readData reads a resource the host names, subscribeData follows one, through
  // MCP's resources/* requests, which the host gates (the viewer's consent, a rate). A value is the
  // first content's: JSON parsed when it says it is JSON, else its text.
  let resourceUpdated = (_uri) => {};
  const valueOf = (result) => {
    const first = result && Array.isArray(result.contents) ? result.contents[0] : undefined;
    if (first === null || typeof first !== "object") {
      return undefined;
    }
    if (typeof first.text === "string") {
      if (/(^|[/+])json(\s*;|$)/i.test(String(first.mimeType || ""))) {
        try {
          return JSON.parse(first.text);
        } catch (_) {}
      }
      return first.text;
    }
    return typeof first.blob === "string" ? first.blob : undefined;
  };
  const staleOf = (result) => Boolean(result && result._meta && result._meta["porthole/stale"] === true);
  const later = (error) => setTimeout(() => {
    throw error;
  });
  // Reads a resource (readData, the runtime's data.read).
  const readValue = (uri) => request("resources/read", { uri: String(uri) }).then(valueOf);
  // Follows one (subscribeData, the runtime's data.subscribe), where the config declares it.
  let follow = null;
  if (declared("subscribeData")) {
    // One subscription per URI, however many follow it; a read at a time, one more if it changed
    // meanwhile; a late follower gets the last value at once.
    const followed = new Map();
    const tell = (entry, result) => {
      entry.last = result;
      const value = valueOf(result);
      const info = { stale: staleOf(result), uri: entry.uri };
      for (const listener of Array.from(entry.listeners)) {
        try {
          listener.onData(value, info);
        } catch (error) {
          later(error);
        }
      }
    };
    const fail = (entry, error) => {
      for (const listener of Array.from(entry.listeners)) {
        if (typeof listener.onError === "function") {
          try {
            listener.onError(error);
          } catch (thrown) {
            later(thrown);
          }
        }
      }
    };
    const refresh = (entry) => {
      if (entry.reading) {
        entry.again = true;
        return;
      }
      entry.reading = true;
      request("resources/read", { uri: entry.uri })
        .then((result) => {
          if (followed.get(entry.uri) === entry) {
            tell(entry, result);
          }
        }, (error) => fail(entry, error))
        .then(() => {
          entry.reading = false;
          if (entry.again && followed.get(entry.uri) === entry) {
            entry.again = false;
            refresh(entry);
          }
        });
    };
    resourceUpdated = (uri) => {
      const entry = followed.get(uri);
      if (entry !== undefined) {
        refresh(entry);
      }
    };
    follow = (uri, onData, onError) => {
      if (typeof onData !== "function") {
        throw new TypeError("subscribeData(uri, onData, onError): onData must be a function");
      }
      const key = String(uri);
      const listener = { onData, onError };
      let entry = followed.get(key);
      if (entry === undefined) {
        const made = { uri: key, listeners: new Set(), reading: false, again: false, last: undefined };
        entry = made;
        followed.set(key, made);
        request("resources/subscribe", { uri: key }).then(() => {
          if (followed.get(key) === made) {
            refresh(made);
          }
        }, (error) => {
          if (followed.get(key) === made) {
            followed.delete(key);
          }
          fail(made, error);
        });
      } else if (entry.last !== undefined) {
        const known = entry;
        Promise.resolve().then(() => {
          if (known.listeners.has(listener)) {
            try {
              onData(valueOf(known.last), { stale: staleOf(known.last), uri: key });
            } catch (error) {
              later(error);
            }
          }
        });
      }
      entry.listeners.add(listener);
      const mine = entry;
      return () => {
        if (!mine.listeners.delete(listener) || mine.listeners.size > 0) {
          return;
        }
        if (followed.get(key) === mine) {
          followed.delete(key);
          request("resources/unsubscribe", { uri: key }).catch(() => {});
        }
      };
    };
  }


  // The capability runtime's hooks (P085): the host's offer from the handshake (null: no host
  // answered), and a watch's updates. The runtime, where the config has one, takes them.
  let runtimeOffer = (_offer) => {};
  let runtimeEvent = (_params) => {};

  __LEGACY__

  __RUNTIME__

  window.addEventListener("error", (event) => {
    const error = event.error;
    const where = event.lineno ? " (line " + event.lineno + ")" : "";
    // V8's stack starts with the message; WebKit's and Firefox's don't, so it goes first there.
    const stack = error && error.stack ? String(error.stack).split("\n").slice(0, 3).join(" ") : "";
    const said = error && error.message !== undefined ? String(error.name || "Error") + ": " + String(error.message) : event.message;
    report(stack === "" ? said + where : stack.indexOf(String(error.message)) === -1 ? said + " " + stack : stack);
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
      // A page of the set opens in the frame, whatever its target (P084); any other file of the
      // set never opens: its address carries the frame's access.
      if (ownPage(url)) {
        location.assign(url);
        return;
      }
      if (filesBase !== null && url.indexOf(filesBase) === 0) {
        navigationBlocked(url);
        return;
      }
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
    contentArrived();
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
          // A refusal says why (P080): its code, and a sentence to show the person.
          const why = data.error.data !== null && typeof data.error.data === "object" ? data.error.data : {};
          const error = new Error(String(typeof why.message === "string" && why.message !== "" ? why.message : data.error.message || "refused"));
          if (typeof why.code === "string") {
            error.code = why.code;
          }
          waiting.reject(error);
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
      case "notifications/resources/updated":
        if (typeof params.uri === "string") {
          resourceUpdated(params.uri);
        }
        break;
      case "porthole/event":
        runtimeEvent(params);
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
    if (initialized) {
      return;
    }
    if (tries >= 40) {
      // No host answered: the runtime has nothing to offer.
      runtimeOffer(null);
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
      const capabilities = result && result.hostCapabilities;
      const experimental = capabilities && capabilities.experimental;
      runtimeOffer(experimental && typeof experimental === "object" ? experimental["porthole/runtime"] : null);
      applyTheme(result && result.hostContext);
      notify("ui/notifications/initialized", {});
      schedule();
    }, () => {});
    setTimeout(initialize, 250);
  };
  initialize();
})();`;
