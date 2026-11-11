/**
 * What a draft holds back (P117), spliced into the runtime: a tag start the content was cut in
 * (a trailing `<`, `</`, or `<` and a tag's name or attributes, with no `>` yet) is left out until
 * more comes. Parsed as it is, a cut right after `<` or `</` draws them as text.
 */
export const HELD_BACK = String.raw`(html) => {
    const at = html.lastIndexOf("<");
    return at !== -1 && /^\/?(?:[A-Za-z][^>]*)?$/.test(html.slice(at + 1)) ? html.slice(0, at) : html;
  }`;

/**
 * Which `<iframe>` the shell keeps under `nestedFrames: "own"` (P128), spliced into the runtime:
 * one with a `srcdoc` attribute (which wins over any `src`), or one whose `src`, resolved by the
 * platform's own URL parser (`resolve`, which normalizes `..`, `%2e` and backslashes), is under the
 * version's own files' address (`filesBase`, ending in `/`). Nothing else: no `src` or a blank one
 * (`about:blank`), another path of the origin, another origin, `data:`, `blob:`, `javascript:`.
 * Only comparisons and indexing, which content can't replace (no String.prototype method).
 */
export const OWN_FRAME = String.raw`(hasSrcdoc, src, filesBase, resolve) => {
    if (hasSrcdoc === true) {
      return true;
    }
    if (typeof src !== "string" || typeof filesBase !== "string" || filesBase.length === 0 || filesBase[filesBase.length - 1] !== "/") {
      return false;
    }
    let blank = true;
    for (let i = 0; i < src.length && blank; i += 1) {
      const c = src[i];
      blank = c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
    }
    if (blank) {
      return false;
    }
    let target = null;
    try {
      target = resolve(src);
    } catch (_) {
      return false;
    }
    if (typeof target !== "string" || target.length < filesBase.length) {
      return false;
    }
    for (let i = 0; i < filesBase.length; i += 1) {
      if (target[i] !== filesBase[i]) {
        return false;
      }
    }
    return true;
  }`;

/**
 * Which values a guard forwards as they are (P129, P130), spliced into the runtime: those that are
 * their own single reading. A string, a number, a boolean, a bigint, `null`, and a genuine
 * `undefined` (`value === undefined`: an object whose `typeof` is "undefined" isn't one). Nothing
 * here can throw or run content's code (`typeof` and `===` read no property).
 */
export const PASSES_AS_IS = String.raw`(value) => {
    if (value === null || value === undefined) {
      return true;
    }
    const kind = typeof value;
    return kind === "string" || kind === "number" || kind === "boolean" || kind === "bigint";
  }`;

/**
 * A name or value a guard inspects and then forwards, pinned to one reading (P129, P130), spliced
 * into the runtime as `ONCE(passesAsIs, toText)`: a value `passesAsIs` lets through goes on
 * unchanged; anything else is turned into its string once, by `toText` (the platform's own
 * `String`, kept before content runs), and that string is what is both checked and forwarded. A
 * symbol, a conversion that throws, or one that doesn't give a string is refused (the guard throws
 * and nothing is forwarded): fail closed.
 */
export const ONCE = String.raw`(passesAsIs, toText) => (value) => {
    let pass = false;
    try {
      pass = passesAsIs(value) === true;
    } catch (_) {
      pass = false;
    }
    if (pass) {
      return value;
    }
    let text = null;
    try {
      text = typeof value === "symbol" ? null : toText(value);
    } catch (_) {
      text = null;
    }
    if (typeof text !== "string") {
      throw new TypeError("This value can't be used here");
    }
    return text;
  }`;

/**
 * The shell's handshake with its host (P085, P139, P143), spliced into the runtime as
 * `HANDSHAKE(topLevel, ask, answered, none, later)`. On a tab of its own (`topLevel`: the window is
 * its own top, so its parent is itself and no host can hear it), and under a plan that names no
 * host (P143: the runtime passes `topLevel` true for it too), there is no host to ask: `none()`
 * at once, and nothing is asked. In a frame it asks (`ask()`, a promise of the host's answer) up to
 * 40 times, 250 ms apart (`later(run, ms)`), since the host may start listening after the shell
 * runs; the first answer is taken (`answered(result)`), once. After the 40th try with no answer,
 * `none()`; an answer that comes later still is taken.
 */
export const HANDSHAKE = String.raw`(topLevel, ask, answered, none, later) => {
    if (topLevel === true) {
      none();
      return;
    }
    let initialized = false;
    let tries = 0;
    const initialize = () => {
      if (initialized) {
        return;
      }
      if (tries >= 40) {
        none();
        return;
      }
      tries += 1;
      ask().then((result) => {
        if (initialized) {
          return;
        }
        initialized = true;
        answered(result);
      }, () => {});
      later(initialize, 250);
    };
    initialize();
  }`;

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
 *    hints and refreshes a CSP doesn't govern. Where the config opts in (`nestedFrames: "own"`,
 *    P128), an `<iframe>` of the page's own files or with `srcdoc` is kept (`OWN_FRAME`), and
 *    one that is kept leaves the document before a change would make it any other; in such a
 *    child realm steps 1, 2, 5 and 6 never ran (a page of the set has its own shell there), which
 *    the host accepted by opting in;
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
  // A plan that names no host (P143: an embedded document, framed below a page that is no host):
  // the shell asks no host and ends its handshake at once, as on a tab (P139), and says nothing to
  // any parent, not even its own notices to "*" (P053). No origin is a host's, so it hears no one.
  const hostless = Array.isArray(plan.origins) && plan.origins.length === 0;
  // Every built-in a guard calls is called through callOf, which is Reflect.apply itself, kept
  // now, before any content runs: a direct call of it never reads Function.prototype's call,
  // apply or bind, so nothing content later puts there sees what the shell calls or with what.
  const callOf = Reflect.apply;
  const hasOwn = Object.prototype.hasOwnProperty;
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
  const declared = (name) => callOf(hasOwn, plan.capabilities, [name]);
  // Fixed in place: content can neither restore what is removed nor replace what is wrapped. A
  // property something fixed before the shell ran (an extension, an engine's own) can't be: each
  // such name goes on the shell's own script element (data-porthole-unfixed, for a test or a
  // person to see) and, once the shell can speak, to the host as an error report.
  const shellScript = document.currentScript;
  // The platform's own, kept before the shell's guards wrap it: the shell marks the document's root
  // with it (data-porthole-host, P139).
  const setAttributeOfShell = Element.prototype.setAttribute;
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

  // Whether the page touched storage, told to the host once (P111): yes, never what it keeps.
  let storageTouched = false;
  let tellStorage = () => {};
  // A nested page's kept storage (P149): what its localStorage's map is filled with and writes
  // to, set below once the store's port is held; and whether this load's is kept at all (null
  // until that is known: content doesn't run before).
  let storageKept = null;
  let storeSay = null;
  let storeFill = null;
  if (plan.storage === "memory" || plan.storage === "kept") {
    // An opaque origin has no storage: a map stands in, for as long as the frame lives. A nested
    // page whose config keeps storage (P149) has its scope's own localStorage in that map: the
    // store's keys before content runs, each write sent on to the store. Keys are the content's
    // names (__proto__ among them): a Map's keys, never an object's properties. It counts as the
    // store does, so the page hears QuotaExceededError as it writes: the sum of every key's and
    // value's length, and the number of keys, never grown past the caps (what the origin already
    // holds past them stays, and can shrink).
    const MAX_UNITS = 1048576;
    const MAX_KEYS = 1024;
    const store = (kept) => {
      const items = new Map();
      let units = 0;
      const put = (key, value) => {
        const before = items.get(key);
        units += before === undefined ? key.length + value.length : value.length - before.length;
        items.set(key, value);
      };
      const drop = (key) => {
        const before = items.get(key);
        if (before !== undefined) {
          units -= key.length + before.length;
          items.delete(key);
        }
      };
      const empty = () => {
        items.clear();
        units = 0;
      };
      if (kept) {
        // What the store says is the content's word: strings alone, into the map, nothing else.
        storeFill = (data) => {
          if (data === null || typeof data !== "object") {
            return;
          }
          if (Array.isArray(data.keys)) {
            empty();
            for (let i = 0; i < data.keys.length; i += 1) {
              const pair = data.keys[i];
              if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") {
                put(pair[0], pair[1]);
              }
            }
          } else if (Array.isArray(data.changed) && typeof data.changed[0] === "string") {
            if (typeof data.changed[1] === "string") {
              put(data.changed[0], data.changed[1]);
            } else {
              drop(data.changed[0]);
            }
          } else if (data.cleared === 1) {
            empty();
          }
        };
      }
      const say = (message) => {
        if (kept && storeSay !== null) {
          storeSay(message);
        }
      };
      return {
        getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
        setItem: (key, value) => {
          const name = String(key);
          const text = String(value);
          if (kept) {
            const before = items.get(name);
            const grown = before === undefined ? name.length + text.length : text.length - before.length;
            const more = before === undefined ? 1 : 0;
            if (!((units + grown <= MAX_UNITS || grown <= 0) && (items.size + more <= MAX_KEYS || more === 0))) {
              throw new DOMException("The page's storage is full", "QuotaExceededError");
            }
          }
          put(name, text);
          say({ set: [name, text] });
        },
        removeItem: (key) => {
          drop(String(key));
          say({ remove: String(key) });
        },
        clear: () => {
          empty();
          say({ clear: 1 });
        },
        key: (index) => Array.from(items.keys())[index] ?? null,
        get length() {
          return items.size;
        },
      };
    };
    for (const name of ["localStorage", "sessionStorage"]) {
      const kept = store(plan.storage === "kept" && name === "localStorage");
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          get() {
            if (!storageTouched) {
              storageTouched = true;
              tellStorage();
            }
            return kept;
          },
        });
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
  // A nested page's files' address renewed by its shell (P111), which the shell's message gives.
  let adoptFiles = (_base) => false;
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
  // task of the sending document's, which a navigation that commits first drops). With or without
  // the Navigation API (P142): where there is none, the leaving page sends nothing, and this is the
  // page's only word.
  const arrived = filesBase !== null && typeof plan.files.address !== "string";
  if (navigationApi && typeof navigationApi.addEventListener === "function" && destinationOf !== null && sameDocumentOf !== null && navigationTypeOf !== null) {
    navigationApi.addEventListener("navigate", (event) => {
      const destination = applyOf(destinationOf, event, []);
      if (!applyOf(sameDocumentOf, destination, []) && applyOf(navigationTypeOf, event, []) !== "reload") {
        const url = urlOf === null ? "" : NativeString(applyOf(urlOf, destination, []));
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
  }
  // A link on a tab (P099) is followed by the shell, never by the browser: WebKit sends a link's
  // request though the navigate event cancels it (measured), and the browser follows a link with
  // the href and target it has once every listener ran, which content may change after any check.
  // So the first click listener there is (the shell's, on window, capturing) takes each plain click
  // on a link (found through the composed path, shadow roots included) from the browser: it
  // cancels it, reads the link once, and, after every listener ran and unless content cancelled
  // the click itself, follows what it read with a link of its own, detached (no listener of
  // content's sees its click), where the guard's rule lets it go: within the document (a
  // fragment), another page of the set (P084), a download of the page's own (which the sandbox
  // decides). A link to a new window does nothing (the sandbox refuses it anyway); a modified or
  // middle click is left to the browser (a window or a download: the sandbox refuses both).
  let linksTaken = false;
  if (window.top === window) {
    linksTaken = true;
    const pathOf = Event.prototype.composedPath;
    const matchesOf = Element.prototype.matches;
    const attributeOf = Element.prototype.getAttribute;
    const attributeNSOf = Element.prototype.getAttributeNS;
    const hasAttributeOf = Element.prototype.hasAttribute;
    const setAttributeOf = Element.prototype.setAttribute;
    const makeElement = Document.prototype.createElement;
    const clickOf = HTMLElement.prototype.click;
    const later = window.setTimeout;
    const addTo = WeakSet.prototype.add;
    const hasIn = WeakSet.prototype.has;
    const modifierGetters = [getterOf(MouseEvent.prototype, "ctrlKey"), getterOf(MouseEvent.prototype, "metaKey"), getterOf(MouseEvent.prototype, "shiftKey"), getterOf(MouseEvent.prototype, "altKey")];
    const buttonOf = getterOf(MouseEvent.prototype, "button");
    // A click content cancelled itself, through preventDefault or returnValue (the shell's own
    // cancels call the platform's function, kept above, and aren't counted).
    const cancelledByContent = new WeakSet();
    lock(Event.prototype, "preventDefault", function () {
      callOf(addTo, cancelledByContent, [this]);
      return callOf(preventNavigation, this, []);
    });
    const returnValue = Object.getOwnPropertyDescriptor(Event.prototype, "returnValue");
    if (returnValue && returnValue.get && returnValue.set) {
      try {
        Object.defineProperty(Event.prototype, "returnValue", {
          configurable: false,
          enumerable: returnValue.enumerable,
          get() {
            return callOf(returnValue.get, this, []);
          },
          set(value) {
            if (!value) {
              callOf(addTo, cancelledByContent, [this]);
            }
            callOf(returnValue.set, this, [value]);
          },
        });
      } catch (_) {
        unfixed.push("returnValue");
      }
    }
    const follow = (address, download) => {
      const anchor = callOf(makeElement, document, ["a"]);
      callOf(setAttributeOf, anchor, ["href", address]);
      if (download !== null) {
        callOf(setAttributeOf, anchor, ["download", download]);
      }
      callOf(clickOf, anchor, []);
    };
    window.addEventListener("click", (event) => {
      let link = null;
      try {
        const path = callOf(pathOf, event, []);
        for (let i = 0; i < path.length && link === null; i += 1) {
          try {
            if (callOf(matchesOf, path[i], ["a, area"])) {
              link = path[i];
            }
          } catch (_) {}
        }
      } catch (_) {}
      if (link === null) {
        return;
      }
      let plain = true;
      try {
        plain = callOf(buttonOf, event, []) === 0;
        for (let i = 0; i < modifierGetters.length; i += 1) {
          if (callOf(modifierGetters[i], event, [])) {
            plain = false;
          }
        }
      } catch (_) {}
      if (!plain) {
        return;
      }
      callOf(preventNavigation, event, []);
      // Read once, now: what is followed is what was read.
      const named = callOf(lowerOf, NativeString(callOf(attributeOf, link, ["target"]) || ""), []);
      const self = named === "" || named === "_self" || named === "_top" || named === "_parent";
      const href = callOf(attributeOf, link, ["href"]) ?? callOf(attributeNSOf, link, ["http://www.w3.org/1999/xlink", "href"]);
      const download = callOf(hasAttributeOf, link, ["download"]) ? NativeString(callOf(attributeOf, link, ["download"]) || "") : null;
      callOf(later, window, [
        () => {
          if (callOf(hasIn, cancelledByContent, [event]) || href === null) {
            return;
          }
          let asked = null;
          try {
            asked = mayNavigate(href);
          } catch (_) {
            return;
          }
          const own = callOf(indexIn, asked.target, [location.origin + "/"]) === 0 || callOf(indexIn, asked.target, ["blob:" + location.origin + "/"]) === 0 || callOf(indexIn, asked.target, ["data:"]) === 0;
          if (download !== null && own) {
            follow(asked.target, download);
          } else if (self && asked.go) {
            follow(asked.target, null);
          } else if (self) {
            navigationBlocked(asked.target);
          }
        },
        0,
      ]);
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
  // added: a mutation observer's microtask runs before a child frame's document loads. Under
  // nestedFrames "own" (P128), a page's own iframes stay (keptFrame, below).
  const FRAMES = "iframe,frame,frameset,object,embed,portal,fencedframe";
  const HINTS = 'link[rel~="dns-prefetch" i],link[rel~="preconnect" i],link[rel~="prefetch" i],link[rel~="prerender" i],script[type="speculationrules" i],meta[http-equiv="refresh" i],meta[http-equiv="x-dns-prefetch-control" i]';
  const GUARDED = FRAMES + "," + HINTS;
  // A page's own frames (P128), where the config opts in: an iframe of its version's files, or a
  // srcdoc one, read through the platform's own getters (kept now) and OWN_FRAME's rule. Every
  // other frame-like element is removed as before; the CSP's frame-src is the wall behind this.
  const ownFrames = plan.nestedFrames === "own";
  const ownFrame = ${OWN_FRAME};
  const localNameOf = getterOf(Element.prototype, "localName");
  const namespaceOf = getterOf(Element.prototype, "namespaceURI");
  const baseOf = getterOf(Node.prototype, "baseURI");
  const hasAttributeIn = Element.prototype.hasAttribute;
  const getAttributeIn = Element.prototype.getAttribute;
  const resolveHere = (text) => callOf(urlHref, new NativeURL(NativeString(text), callOf(baseOf, document, [])), []);
  const keptFrame = (element) => {
    if (!ownFrames || localNameOf === null || namespaceOf === null || baseOf === null) {
      return false;
    }
    try {
      if (callOf(localNameOf, element, []) !== "iframe" || callOf(namespaceOf, element, []) !== "http://www.w3.org/1999/xhtml") {
        return false;
      }
      return ownFrame(callOf(hasAttributeIn, element, ["srcdoc"]) === true, callOf(getAttributeIn, element, ["src"]), filesBase, resolveHere);
    } catch (_) {
      return false;
    }
  };
  const matchesIn = Element.prototype.matches;
  const guarded = (element) => callOf(matchesIn, element, [GUARDED]) && !keptFrame(element);
  // The built-ins step 3's guard and its observer use, captured before content runs and called
  // only through these references (as the rule above reads matches, localName, namespaceURI,
  // baseURI, src and srcdoc): a page that replaces a prototype method, a getter, or the global
  // Array.from can't make the guard or its observer walk past a frame they must remove.
  const nodeTypeOf = getterOf(Node.prototype, "nodeType");
  const isConnectedOf = getterOf(Node.prototype, "isConnected");
  const parentNodeOf = getterOf(Node.prototype, "parentNode");
  const shadowRootOfNode = getterOf(Element.prototype, "shadowRoot");
  const childNodesOf = getterOf(Node.prototype, "childNodes");
  const removeIn = Element.prototype.remove;
  const cloneNodeIn = Node.prototype.cloneNode;
  const queryAllElement = Element.prototype.querySelectorAll;
  const queryAllDocument = Document.prototype.querySelectorAll;
  const queryAllFragment = DocumentFragment.prototype.querySelectorAll;
  const nodeListLengthOf = getterOf(NodeList.prototype, "length");
  const weakSetHas = WeakSet.prototype.has;
  const weakSetAdd = WeakSet.prototype.add;
  const observeIn = MutationObserver.prototype.observe;
  const makeText = Document.prototype.createTextNode;
  const recordProto = typeof MutationRecord === "function" ? MutationRecord.prototype : null;
  const addedNodesOf = getterOf(recordProto, "addedNodes");
  const recordTypeOf = getterOf(recordProto, "type");
  const recordTargetOf = getterOf(recordProto, "target");
  const attrProto = typeof Attr === "function" ? Attr.prototype : null;
  const ownerElementOf = getterOf(attrProto, "ownerElement");
  const attrNameOf = getterOf(attrProto, "name");
  const attrNamespaceOf = getterOf(attrProto, "namespaceURI");
  const attrValueOf = getterOf(attrProto, "value");
  const setAttributeNSIn = Element.prototype.setAttributeNS;
  const removeAttributeIn = Element.prototype.removeAttribute;
  const createIn = Document.prototype.createElement;
  const createNSIn = Document.prototype.createElementNS;
  const weakMapGet = WeakMap.prototype.get;
  const weakMapSet = WeakMap.prototype.set;
  // A template's content, read natively: the walk below goes into it (P130), and content's own
  // reads of it are stripped first (the content getter, below).
  const templateContentOf = typeof HTMLTemplateElement === "function" ? getterOf(HTMLTemplateElement.prototype, "content") : null;
  const NativeDOMException = DOMException;
  const XHTML = "http://www.w3.org/1999/xhtml";
  // A list the shell builds (arguments to pass on, nodes to move): an object with no prototype,
  // so neither writing nor reading an index or its length reaches anything on Array.prototype or
  // Object.prototype. callOf takes it as its arguments.
  const bare = Object.create;
  const listOf = () => {
    const list = bare(null);
    list.length = 0;
    return list;
  };
  const pushTo = (list, value) => {
    list[list.length] = value;
    list.length += 1;
  };
  // FRAMES's names as a lookup with no prototype, decided now: an element of one of these names,
  // in any namespace and any case, is one content can't create under the default config (P130).
  const frameTags = bare(null);
  for (const tag of FRAMES.split(",")) {
    frameTags[tag] = true;
  }
  const frameCapableName = (name) => {
    const text = callOf(lowerOf, name, []);
    const first = callOf(indexIn, text, [":"]);
    const last = callOf(lastIndexIn, text, [":"]);
    return frameTags[text] === true || (first !== -1 && frameTags[callOf(sliceOf, text, [first + 1])] === true) || (last !== -1 && frameTags[callOf(sliceOf, text, [last + 1])] === true);
  };
  // An attribute's name, namespace and value, read through the kept getters.
  const attrParts = (attribute) => ({
    namespace: callOf(attrNamespaceOf, attribute, []),
    name: callOf(attrNameOf, attribute, []),
    value: callOf(attrValueOf, attribute, []),
  });
  // A name or value a guard inspects and then passes on, pinned to one reading (PASSES_AS_IS,
  // ONCE): anything but a primitive that is its own single reading (a string, number, boolean,
  // bigint, null, or undefined itself) is turned into its string once, here, so the guard checks
  // and the platform acts on the same text (a value whose toString answers differently the second
  // time can't slip past). null and booleans are kept as they are, for the setters that treat them
  // specially. A value that can't be read once (a symbol, a conversion that throws) is refused.
  const passesAsIs = ${PASSES_AS_IS};
  const once = (${ONCE})(passesAsIs, NativeString);
  // An object (a dictionary to read once), by the same rule: anything once wouldn't pass as it is.
  const objectLike = (value) => !passesAsIs(value) && typeof value !== "symbol";
  // A node's type (and whether it is connected), read through the kept getters; anything that
  // isn't a node reads as -1 / false, never throws, so the insertion guards can ask of any value.
  const typeOf = (node) => {
    if (node === null || typeof node !== "object" || nodeTypeOf === null) {
      return -1;
    }
    try {
      return callOf(nodeTypeOf, node, []);
    } catch (_) {
      return -1;
    }
  };
  const connected = (node) => {
    if (isConnectedOf === null) {
      return false;
    }
    try {
      return callOf(isConnectedOf, node, []) === true;
    } catch (_) {
      return false;
    }
  };
  const countOf = (list) => (nodeListLengthOf === null ? 0 : callOf(nodeListLengthOf, list, []));
  const shadowOf = (element) => (shadowRootOfNode === null ? null : callOf(shadowRootOfNode, element, []));
  const queryAllOf = (node, type, selector) => callOf(type === 1 ? queryAllElement : type === 9 ? queryAllDocument : queryAllFragment, node, [selector]);
  // An HTML template (its content is what the walk enters), by the kept getters: the selector
  // "template" also matches an HTML-namespace element named "TEMPLATE" in any case, which isn't one.
  const isTemplate =
    templateContentOf === null || localNameOf === null || namespaceOf === null
      ? null
      : (element) => callOf(localNameOf, element, []) === "template" && callOf(namespaceOf, element, []) === XHTML;
  const guardedRoots = new WeakSet();
  let watchRoot = null;
  // Every subtree the walk reaches is stripped: the node's own tree (querySelectorAll's reach), and
  // what that never enters, each template's content and each open shadow root's tree (P130),
  // however deep they nest. A list of what is left to walk, not recursion: no depth runs it out of
  // stack. A shadow root found is watched by the observer too (declarative ones the parser built
  // elsewhere, made without attachShadow).
  const strip = (start) => {
    const pending = listOf();
    pushTo(pending, start);
    for (let at = 0; at < pending.length; at += 1) {
      const node = pending[at];
      const type = typeOf(node);
      if (type !== 1 && type !== 9 && type !== 11) {
        continue;
      }
      if (type === 1 && guarded(node)) {
        callOf(removeIn, node, []);
        continue;
      }
      const framed = queryAllOf(node, type, GUARDED);
      for (let i = 0, n = countOf(framed); i < n; i += 1) {
        const element = framed[i];
        if (!keptFrame(element)) {
          callOf(removeIn, element, []);
        }
      }
      if (isTemplate !== null) {
        const templates = queryAllOf(node, type, "template");
        for (let i = 0, n = countOf(templates); i < n; i += 1) {
          if (isTemplate(templates[i])) {
            pushTo(pending, callOf(templateContentOf, templates[i], []));
          }
        }
        if (type === 1 && isTemplate(node)) {
          pushTo(pending, callOf(templateContentOf, node, []));
        }
      }
      if (type === 1) {
        const root = shadowOf(node);
        if (root) {
          watchRoot(root);
          pushTo(pending, root);
        }
      }
      const all = queryAllOf(node, type, "*");
      for (let i = 0, n = countOf(all); i < n; i += 1) {
        const root = shadowOf(all[i]);
        if (root) {
          watchRoot(root);
          pushTo(pending, root);
        }
      }
    }
  };
  const frameGuard = new MutationObserver((records) => {
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      // A kept frame whose src or srcdoc changed another way (P128): the backstop of the
      // synchronous guard below (beforeChange), as the rest of this observer is.
      if ((recordTypeOf === null ? record.type : callOf(recordTypeOf, record, [])) === "attributes") {
        const target = recordTargetOf === null ? record.target : callOf(recordTargetOf, record, []);
        if (connected(target) && guarded(target)) {
          callOf(removeIn, target, []);
        }
        continue;
      }
      const added = addedNodesOf === null ? record.addedNodes : callOf(addedNodesOf, record, []);
      for (let j = 0, n = countOf(added); j < n; j += 1) {
        strip(added[j]);
      }
    }
  });
  const observed = ownFrames ? { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcdoc"] } : { childList: true, subtree: true };
  watchRoot = (root) => {
    if (callOf(weakSetHas, guardedRoots, [root])) {
      return;
    }
    callOf(weakSetAdd, guardedRoots, [root]);
    callOf(observeIn, frameGuard, [root, observed]);
  };
  const guardRoot = (root) => {
    strip(root);
    watchRoot(root);
  };
  guardRoot(document);

  // Every shadow root content makes, open or closed, is guarded as it is made. On a tab (P099) a
  // closed one is made open, to the platform, and closed to content (its host's shadowRoot is
  // null, its mode "closed"): a click on a link inside it must show the link to the shell's first
  // listener through the event's composed path, which a closed tree hides.
  const attachShadow = Element.prototype.attachShadow;
  const shownOpen = new WeakSet();
  const addShown = WeakSet.prototype.add;
  // The init dictionary is read once (P130): each field, once, into a fresh object with no
  // prototype, which is all the platform is given; the mode that decides the closed-to-open turn
  // is the same pinned text the platform reads. A field this list doesn't name isn't passed on.
  const SHADOW_FIELDS = ["mode", "delegatesFocus", "slotAssignment", "clonable", "serializable", "customElementRegistry", "referenceTarget"];
  const SHADOW_TEXT = bare(null);
  SHADOW_TEXT.mode = true;
  SHADOW_TEXT.slotAssignment = true;
  SHADOW_TEXT.referenceTarget = true;
  const shadowInit = (init) => {
    const copy = bare(null);
    if (objectLike(init)) {
      for (let i = 0; i < SHADOW_FIELDS.length; i += 1) {
        const field = SHADOW_FIELDS[i];
        const value = init[field];
        if (value !== undefined) {
          copy[field] = SHADOW_TEXT[field] === true ? once(value) : value;
        }
      }
    }
    const asked = bare(null);
    asked.closed = window.top === window && copy.mode === "closed";
    if (asked.closed) {
      copy.mode = "open";
    }
    asked.init = copy;
    return asked;
  };
  lock(Element.prototype, "attachShadow", function (init) {
    const asked = shadowInit(init);
    init = asked.init;
    const root = callOf(attachShadow, this, [init]);
    guardRoot(root);
    if (asked.closed) {
      callOf(addShown, shownOpen, [root]);
    }
    return root;
  });
  if (window.top === window) {
    const shadowRootOf = getterOf(Element.prototype, "shadowRoot");
    const modeOf = typeof ShadowRoot === "function" ? getterOf(ShadowRoot.prototype, "mode") : null;
    const shown = WeakSet.prototype.has;
    try {
      if (shadowRootOf !== null) {
        Object.defineProperty(Element.prototype, "shadowRoot", {
          configurable: false,
          get() {
            const root = callOf(shadowRootOf, this, []);
            return root !== null && callOf(shown, shownOpen, [root]) ? null : root;
          },
        });
      }
      if (modeOf !== null) {
        Object.defineProperty(ShadowRoot.prototype, "mode", {
          configurable: false,
          get() {
            return callOf(shown, shownOpen, [this]) ? "closed" : callOf(modeOf, this, []);
          },
        });
      }
    } catch (_) {
      unfixed.push("shadowRoot");
    }
  }

  // The parser builds declarative shadow roots (template shadowrootmode) without attachShadow, and
  // a closed one is out of the guard's reach. Fragment parsing doesn't build them, so the entry
  // points that would are given fragment parsing's behavior, and a document can't be rewritten.
  const parseInert = (html) => {
    const template = callOf(createIn, document, ["template"]);
    template.innerHTML = NativeString(html);
    return template.content;
  };
  for (const proto of [Element.prototype, typeof ShadowRoot === "function" ? ShadowRoot.prototype : null]) {
    if (proto !== null && "setHTMLUnsafe" in proto) {
      lock(proto, "setHTMLUnsafe", function (html) {
        this.innerHTML = NativeString(html);
      });
    }
  }
  // Document.parseHTMLUnsafe and the Sanitizer API's Document.parseHTML: DOMParser's parse (no
  // declarative shadow DOM), through the platform's own parser, stripped before it is returned.
  const NativeDOMParser = DOMParser;
  const parseFromStringIn = DOMParser.prototype.parseFromString;
  for (const name of ["parseHTMLUnsafe", "parseHTML"]) {
    if (typeof Document[name] === "function") {
      lock(Document, name, (html) => {
        const parsed = callOf(parseFromStringIn, new NativeDOMParser(), [NativeString(html), "text/html"]);
        strip(parsed);
        return parsed;
      });
    }
  }
  const noRewrite = function () {
    throw new Error("document.open and document.write aren't available here: build the page with DOM methods");
  };
  const unfixedBeforeRewrite = unfixed.length;
  for (const name of ["open", "write", "writeln"]) {
    lock(Document.prototype, name, noRewrite);
  }
  // Whether all three are fixed in place. The press port rests on it (P148): document.open() takes
  // every listener off the window, the runtime's among them, and a document opened and closed
  // again loads again, so content that could call it would hear a port before the runtime did.
  const rewriteFixed = unfixed.length === unfixedBeforeRewrite;

  // Some engines act on a hint the moment its element is connected or changed (WebKit opens a
  // preconnect then, outside the CSP), before the observer's microtask. So every way to connect a
  // node drops guarded elements first, synchronously, and a connected link or meta can't be
  // changed into one. The observer stays as the backstop for anything these miss.
  const admit = (node) => {
    const type = typeOf(node);
    if (type === -1) {
      return true;
    }
    if (type === 1 && guarded(node)) {
      return false;
    }
    strip(node);
    return true;
  };
  const wrapInsert = (proto, name, positions) => {
    const original = proto && proto[name];
    if (typeof original !== "function") {
      return;
    }
    // Which arguments are nodes to check, decided now (before content runs), as a lookup that has
    // no prototype: nothing content later puts on Array.prototype takes part in the decision.
    const all = positions === "all";
    const checks = bare(null);
    if (!all) {
      for (let i = 0; i < positions.length; i += 1) {
        checks[positions[i]] = true;
      }
    }
    lock(proto, name, function (...args) {
      const checked = listOf();
      for (let i = 0; i < args.length; i += 1) {
        pushTo(checked, (all || checks[i] === true) && !admit(args[i]) ? callOf(makeText, document, [""]) : args[i]);
      }
      return callOf(original, this, checked);
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
  // A select's add and its options' add (P130), and moveBefore wherever the engine defines it.
  wrapInsert(typeof HTMLSelectElement === "function" ? HTMLSelectElement.prototype : null, "add", [0]);
  wrapInsert(typeof HTMLOptionsCollection === "function" ? HTMLOptionsCollection.prototype : null, "add", [0]);
  for (const proto of [Node.prototype, Element.prototype, Document.prototype, DocumentFragment.prototype]) {
    if (callOf(hasOwn, proto, ["moveBefore"])) {
      wrapInsert(proto, "moveBefore", [0]);
    }
  }
  // The setters that put a node in place (P130): document.body, a table's tHead, tFoot and
  // caption. The value is admitted as the insertion methods' arguments are, and a refused one
  // refuses the set (the setter has no harmless stand-in: null would remove the table's own).
  const refuseInsert = () => {
    throw new NativeDOMException("This element can't be inserted here", "HierarchyRequestError");
  };
  const wrapNodeSetter = (proto, name) => {
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined;
    if (!descriptor || typeof descriptor.set !== "function") {
      return;
    }
    try {
      Object.defineProperty(proto, name, {
        configurable: false,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set(value) {
          if (!admit(value)) {
            refuseInsert();
          }
          callOf(descriptor.set, this, [value]);
        },
      });
    } catch (_) {
      unfixed.push(name);
    }
  };
  for (const proto of [Document.prototype, typeof HTMLDocument === "function" ? HTMLDocument.prototype : null]) {
    if (proto !== null && callOf(hasOwn, proto, ["body"])) {
      wrapNodeSetter(proto, "body");
    }
  }
  for (const name of ["tHead", "tFoot", "caption"]) {
    wrapNodeSetter(typeof HTMLTableElement === "function" ? HTMLTableElement.prototype : null, name);
  }
  // The insertion methods the HTML-parse wrappers below call: the locked wrappers just installed
  // (admit runs inside them), taken now so an element can't shadow them with an own property and
  // no spread reads a replaceable array iterator; each is given a prototype-less argument list.
  const replaceChildrenElIn = Element.prototype.replaceChildren;
  const replaceChildrenFragIn = DocumentFragment.prototype.replaceChildren;
  const replaceWithIn = Element.prototype.replaceWith;
  const beforeIn = Element.prototype.before;
  const afterIn = Element.prototype.after;
  const prependIn = Element.prototype.prepend;
  const appendIn = Element.prototype.append;

  // Markup parsed in place: parsed first in a detached element of the same kind (so it parses as it
  // would in place, and nothing in it is connected yet), guarded, then moved in.
  const accessor = (proto, name) => (proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined);
  const contextFor = (element) => {
    if (typeOf(element) !== 1 || localNameOf === null || namespaceOf === null) {
      return callOf(createIn, document, ["div"]);
    }
    // A fresh element of the same kind; a custom element's own class is not run again.
    const local = callOf(localNameOf, element, []);
    const name = callOf(indexIn, local, ["-"]) === -1 ? local : "div";
    return callOf(createNSIn, document, [callOf(namespaceOf, element, []), name]);
  };
  const innerHTMLs = [accessor(Element.prototype, "innerHTML"), accessor(typeof ShadowRoot === "function" ? ShadowRoot.prototype : null, "innerHTML")];
  const setInner = (innerHTMLs[0] || innerHTMLs[1]).set;
  const parseIn = (contextElement, html) => {
    const box = contextFor(contextElement);
    callOf(setInner, box, [NativeString(html)]);
    strip(box);
    const children = childNodesOf === null ? box.childNodes : callOf(childNodesOf, box, []);
    const nodes = listOf();
    for (let i = 0, n = countOf(children); i < n; i += 1) {
      pushTo(nodes, children[i]);
    }
    return nodes;
  };
  const innerHTMLProtos = [Element.prototype, typeof ShadowRoot === "function" ? ShadowRoot.prototype : null];
  for (let index = 0; index < innerHTMLProtos.length; index += 1) {
    const proto = innerHTMLProtos[index];
    const descriptor = innerHTMLs[index];
    if (!proto || !descriptor || !descriptor.set) {
      continue;
    }
    Object.defineProperty(proto, "innerHTML", {
      configurable: false,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(html) {
        // Which branch runs is read through the kept getters, so a replaced nodeType or localName
        // can't route a connected element past parseIn (and its strip) by posing as a template
        // whose markup goes in inert.
        if (typeOf(this) === 1 && isTemplate !== null && isTemplate(this)) {
          // An HTML template's markup goes into its inert content, stripped before the setter
          // returns (P130), as every read of the content is.
          callOf(descriptor.set, this, [html]);
          strip(callOf(templateContentOf, this, []));
          return;
        }
        const forFragment = typeOf(this) === 11;
        callOf(forFragment ? replaceChildrenFragIn : replaceChildrenElIn, this, parseIn(forFragment ? this.host || null : this, html));
      },
    });
  }
  const outer = accessor(Element.prototype, "outerHTML");
  if (outer && outer.set) {
    Object.defineProperty(Element.prototype, "outerHTML", {
      configurable: false,
      enumerable: outer.enumerable,
      get: outer.get,
      set(html) {
        const parent = parentNodeOf === null ? this.parentNode : callOf(parentNodeOf, this, []);
        if (parent === null || typeOf(parent) === 9) {
          callOf(outer.set, this, [html]);
          return;
        }
        callOf(replaceWithIn, this, parseIn(typeOf(parent) === 1 ? parent : null, html));
      },
    });
  }
  const insertAdjacentHTML = Element.prototype.insertAdjacentHTML;
  lock(Element.prototype, "insertAdjacentHTML", function (position, html) {
    // The position is read once: the empty insert that validates it and the branch that places the
    // parsed nodes use the same reading.
    const where = callOf(lowerOf, NativeString(position), []);
    callOf(insertAdjacentHTML, this, [where, ""]);
    const outside = where === "beforebegin" || where === "afterend";
    const nodes = parseIn(outside ? this.parentElement : this, html);
    if (where === "beforebegin") {
      callOf(beforeIn, this, nodes);
    } else if (where === "afterbegin") {
      callOf(prependIn, this, nodes);
    } else if (where === "beforeend") {
      callOf(appendIn, this, nodes);
    } else {
      callOf(afterIn, this, nodes);
    }
  });
  for (const proto of [Element.prototype, typeof ShadowRoot === "function" ? ShadowRoot.prototype : null]) {
    if (proto !== null && callOf(hasOwn, proto, ["setHTML"]) && typeof proto.setHTML === "function") {
      lock(proto, "setHTML", function (html) {
        this.innerHTML = NativeString(html);
      });
    }
  }
  // A parser method this shell doesn't know (a later engine's) is refused rather than left open:
  // every name with "HTML" in it on the interfaces that take markup, other than the ones above.
  const KNOWN_HTML = bare(null);
  for (const name of ["innerHTML", "outerHTML", "insertAdjacentHTML", "setHTML", "setHTMLUnsafe", "getHTML", "parseHTMLUnsafe", "parseHTML"]) {
    KNOWN_HTML[name] = true;
  }
  const unknownMarkup = function () {
    throw new NativeDOMException("This way to add markup isn't available here: use innerHTML or DOM methods", "NotSupportedError");
  };
  for (const target of [Element.prototype, typeof ShadowRoot === "function" ? ShadowRoot.prototype : null, Document.prototype, DocumentFragment.prototype, Document, Range.prototype]) {
    for (const name of target === null ? [] : Object.getOwnPropertyNames(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (KNOWN_HTML[name] !== true && /HTML/.test(name) && descriptor && typeof descriptor.value === "function") {
        lock(target, name, unknownMarkup);
      }
    }
  }

  // Every API that hands content a subtree it can insert later strips it before it returns it
  // (P130): a parsed document, a template's content, a contextual fragment, a transform's output,
  // an XHR's document, an imported or adopted node. A producer whose result is itself a frame-like
  // element (one importNode or adoptNode would return) refuses instead: there is nothing to strip
  // it from.
  const framedElement = (node) => typeOf(node) === 1 && callOf(matchesIn, node, [FRAMES]) && !keptFrame(node);
  const refuseFrame = () => {
    throw new NativeDOMException("Frame elements aren't available here", "NotSupportedError");
  };
  const argumentsOf = (args) => {
    const list = listOf();
    for (let i = 0; i < args.length; i += 1) {
      pushTo(list, args[i]);
    }
    return list;
  };
  const wrapProducer = (proto, name) => {
    const original = proto && callOf(hasOwn, proto, [name]) ? proto[name] : null;
    if (typeof original !== "function") {
      return;
    }
    lock(proto, name, function (...args) {
      const made = callOf(original, this, argumentsOf(args));
      strip(made);
      if (framedElement(made)) {
        refuseFrame();
      }
      return made;
    });
  };
  wrapProducer(DOMParser.prototype, "parseFromString");
  wrapProducer(typeof DOMImplementation === "function" ? DOMImplementation.prototype : null, "createHTMLDocument");
  wrapProducer(typeof DOMImplementation === "function" ? DOMImplementation.prototype : null, "createDocument");
  wrapProducer(Range.prototype, "createContextualFragment");
  wrapProducer(typeof XSLTProcessor === "function" ? XSLTProcessor.prototype : null, "transformToFragment");
  wrapProducer(typeof XSLTProcessor === "function" ? XSLTProcessor.prototype : null, "transformToDocument");
  // importNode's clone is stripped (where an engine has it on a shadow root too, there as well).
  wrapProducer(Document.prototype, "importNode");
  wrapProducer(typeof ShadowRoot === "function" ? ShadowRoot.prototype : null, "importNode");
  // adoptNode's node is stripped before it is adopted.
  const adoptNodeIn = Document.prototype.adoptNode;
  if (typeof adoptNodeIn === "function") {
    lock(Document.prototype, "adoptNode", function (...args) {
      if (framedElement(args[0])) {
        refuseFrame();
      }
      strip(args[0]);
      return callOf(adoptNodeIn, this, argumentsOf(args));
    });
  }
  const strippedGetter = (proto, name, documentsOnly) => {
    const descriptor = accessor(proto, name);
    if (!descriptor || typeof descriptor.get !== "function") {
      return;
    }
    try {
      Object.defineProperty(proto, name, {
        configurable: false,
        enumerable: descriptor.enumerable,
        get() {
          const value = callOf(descriptor.get, this, []);
          if (!documentsOnly || typeOf(value) === 9) {
            strip(value);
          }
          return value;
        },
        set: descriptor.set,
      });
    } catch (_) {
      unfixed.push(name);
    }
  };
  strippedGetter(typeof HTMLTemplateElement === "function" ? HTMLTemplateElement.prototype : null, "content", false);
  strippedGetter(typeof XMLHttpRequest === "function" ? XMLHttpRequest.prototype : null, "responseXML", true);
  strippedGetter(typeof XMLHttpRequest === "function" ? XMLHttpRequest.prototype : null, "response", true);

  // Under the default config (no nested frames) no frame-like element exists anywhere content
  // reaches (P130): the parser's are stripped (above), and none can be made. createElement and
  // createElementNS refuse a FRAMES name, in any case and any namespace (the local name after a
  // prefix included), as document.write is refused; so does a customized built-in that extends
  // one (its constructor would make one). The name is read once, and that reading is what the
  // platform is given. Under nestedFrames "own" (P128) these stay as they are: an iframe is made,
  // and the guards above decide when it is connected or changed.
  const refuseFrameCreation = (proto, name, nameAt) => {
    const original = proto && callOf(hasOwn, proto, [name]) ? proto[name] : null;
    if (typeof original !== "function") {
      return;
    }
    lock(proto, name, function (...args) {
      const fixed = listOf();
      for (let i = 0; i < args.length; i += 1) {
        pushTo(fixed, i === nameAt ? NativeString(once(args[i])) : i < nameAt ? once(args[i]) : args[i]);
      }
      if (fixed.length > nameAt && frameCapableName(fixed[nameAt])) {
        refuseFrame();
      }
      return callOf(original, this, fixed);
    });
  };
  if (!ownFrames) {
    for (const proto of [Document.prototype, typeof ShadowRoot === "function" ? ShadowRoot.prototype : null]) {
      refuseFrameCreation(proto, "createElement", 0);
      refuseFrameCreation(proto, "createElementNS", 1);
    }
    const registry = typeof CustomElementRegistry === "function" ? CustomElementRegistry.prototype : null;
    const defineIn = registry === null ? null : registry.define;
    if (typeof defineIn === "function") {
      lock(registry, "define", function (...args) {
        const fixed = argumentsOf(args);
        if (fixed.length > 2 && objectLike(fixed[2])) {
          // The options are read once, into a fresh object with no prototype (extends, its one
          // field), which is what the platform is given.
          const read = fixed[2].extends;
          const options = bare(null);
          if (read !== undefined) {
            options.extends = NativeString(once(read));
            if (frameCapableName(options.extends)) {
              refuseFrame();
            }
          }
          fixed[2] = options;
        }
        return callOf(defineIn, this, fixed);
      });
    }
  }
  // insertHTML parses markup outside these guards; copy, cut and paste reach the clipboard (P051).
  const REFUSED_COMMANDS = ["inserthtml", "copy", "cut", "paste"];
  const execCommand = Document.prototype.execCommand;
  if (typeof execCommand === "function") {
    const refused = bare(null);
    for (let i = 0; i < REFUSED_COMMANDS.length; i += 1) {
      refused[REFUSED_COMMANDS[i]] = true;
    }
    lock(Document.prototype, "execCommand", function (command, ...rest) {
      // The command is read once, here, and that same text is both the one checked and the one run:
      // a command whose name reads "bold" when checked and "insertHTML" when the platform reads it
      // can't get past the refusal.
      const cmd = NativeString(command);
      if (refused[callOf(lowerOf, cmd, [])] === true) {
        return false;
      }
      const args = listOf();
      pushTo(args, cmd);
      for (let i = 0; i < rest.length; i += 1) {
        pushTo(args, rest[i]);
      }
      return callOf(execCommand, this, args);
    });
  }
  // Editing that brings markup in (P130): a paste, a drop, a replacement or a yank whose data
  // carries any type but plain text (text/html above all) is cancelled before the editor acts on
  // it, and only its plain text goes in, through the editor's own insertText, which carries no
  // markup. The first listener there is (the shell's, on window, capturing), on the platform's
  // own getters, kept now; only the browser's own events (isTrusted) are acted on. Composition
  // (insertCompositionText) can't be cancelled, and is text alone.
  const RICH_INPUTS = bare(null);
  for (const name of ["insertFromPaste", "insertFromPasteAsQuotation", "insertFromDrop", "insertReplacementText", "insertFromYank"]) {
    RICH_INPUTS[name] = true;
  }
  const listenIn = EventTarget.prototype.addEventListener;
  const inputProto = typeof InputEvent === "function" ? InputEvent.prototype : null;
  const inputTypeOf = getterOf(inputProto, "inputType");
  const dataTransferOf = getterOf(inputProto, "dataTransfer");
  const targetRangesIn = inputProto !== null && typeof inputProto.getTargetRanges === "function" ? inputProto.getTargetRanges : null;
  const transferProto = typeof DataTransfer === "function" ? DataTransfer.prototype : null;
  const transferTypesOf = getterOf(transferProto, "types");
  const transferDataIn = transferProto !== null && typeof transferProto.getData === "function" ? transferProto.getData : null;
  const cancelableOf = getterOf(Event.prototype, "cancelable");
  const rangeProto = typeof AbstractRange === "function" ? AbstractRange.prototype : typeof StaticRange === "function" ? StaticRange.prototype : null;
  const rangeEnds = [getterOf(rangeProto, "startContainer"), getterOf(rangeProto, "startOffset"), getterOf(rangeProto, "endContainer"), getterOf(rangeProto, "endOffset")];
  const selectionProto = typeof Selection === "function" ? Selection.prototype : null;
  const removeAllRangesIn = selectionProto === null ? null : selectionProto.removeAllRanges;
  const addRangeIn = selectionProto === null ? null : selectionProto.addRange;
  const getSelectionIn = Document.prototype.getSelection;
  const createRangeIn = Document.prototype.createRange;
  const setStartIn = Range.prototype.setStart;
  const setEndIn = Range.prototype.setEnd;
  // Where the editor would have put it (a drop's point, a replaced word): the event's first target
  // range, made the selection, so insertText puts the text there.
  const placeAt = (event) => {
    if (targetRangesIn === null || typeof removeAllRangesIn !== "function" || typeof addRangeIn !== "function" || rangeEnds[0] === null || rangeEnds[1] === null || rangeEnds[2] === null || rangeEnds[3] === null) {
      return;
    }
    try {
      const ranges = callOf(targetRangesIn, event, []);
      if (ranges.length === 0) {
        return;
      }
      const target = ranges[0];
      const range = callOf(createRangeIn, document, []);
      callOf(setStartIn, range, [callOf(rangeEnds[0], target, []), callOf(rangeEnds[1], target, [])]);
      callOf(setEndIn, range, [callOf(rangeEnds[2], target, []), callOf(rangeEnds[3], target, [])]);
      const selection = callOf(getSelectionIn, document, []);
      callOf(removeAllRangesIn, selection, []);
      callOf(addRangeIn, selection, [range]);
    } catch (_) {}
  };
  if (inputTypeOf !== null && dataTransferOf !== null && transferTypesOf !== null && transferDataIn !== null) {
    callOf(listenIn, window, [
      "beforeinput",
      (event) => {
        if (event.isTrusted !== true) {
          return;
        }
        let rich = false;
        let text = "";
        try {
          if (RICH_INPUTS[callOf(inputTypeOf, event, [])] !== true) {
            return;
          }
          const data = callOf(dataTransferOf, event, []);
          if (data === null) {
            return;
          }
          const types = callOf(transferTypesOf, data, []);
          for (let i = 0; i < types.length; i += 1) {
            if (types[i] !== "text/plain") {
              rich = true;
            }
          }
          if (!rich) {
            return;
          }
          text = NativeString(callOf(transferDataIn, data, ["text/plain"]));
        } catch (_) {
          // Unreadable: it is cancelled, and nothing of it goes in.
          text = "";
        }
        if (cancelableOf !== null && callOf(cancelableOf, event, []) !== true) {
          return;
        }
        callOf(preventNavigation, event, []);
        if (text !== "" && typeof execCommand === "function") {
          placeAt(event);
          callOf(execCommand, document, ["insertText", false, text]);
        }
      },
      true,
    ]);
  }

  // A nested page's real presses, told to its shell (P148). The shell sees a press in the page only
  // as its own activation turning on, and a press within 5 s of the last gesture turns nothing on
  // (P111): to the host that reads as a button that does nothing. So the runtime, which runs before
  // any content and hears the browser's own events first, tells the shell each one, over a
  // MessagePort the shell sends at each load of the page's frame. What keeps that the runtime's
  // word and never the content's:
  // - the port: taken here, by the first listener there is (on window, capturing), from the first
  //   message that is the browser's own (isTrusted), from the parent read now, that names the
  //   method and carries exactly one port. The event goes no further. Every other event of that
  //   name is stopped too, so content never hears one, and one that fails a check doesn't use up
  //   the one port. The port is in this closure alone: no content holds it or can post on it. No
  //   second port is taken: the shell's next one (it sends one at every load of the frame, and
  //   WebKit fires a load for a navigation within the document) is answered on the first, that
  //   this document is still here;
  // - the press: only the browser's own events (isTrusted), read through the platform's getters
  //   kept now. A mouse on its way down; a finger or a pen on its way up (one that scrolls ends in
  //   pointercancel: HTML's own rule for what activates); Enter or Space, not held down, on a
  //   native control that isn't editable (a link takes Enter alone), by its tag and type, never
  //   its role, which is the content's word; a click on such a control (an assistive technology's
  //   activation is a click alone), but not the click a form gives its submit button when Enter is
  //   pressed in another of its fields, which is typing, nor any click while a key is down;
  // - what is told: nothing but that there was one. No place, no target, no time.
  // After a press is told, what the page's calls say to its host (send, below) waits for the
  // shell's word that it has the press (it tells the host before it answers), so a call made in
  // the press's own handler never arrives ahead of it; a shell that doesn't answer in 250 ms
  // holds nothing back.
  // None of it is installed unless all of it can be (a built-in missing, or document.open, write
  // or writeln not fixed in place above): the page then tells no press, and the host has the
  // shell's activation alone, as before.
  let pressHeld = null;
  const pressParent = window.parent;
  if (plan.press === true && !hostless && pressParent !== window && rewriteFixed) {
    const messageProto = typeof MessageEvent === "function" ? MessageEvent.prototype : null;
    const messageSourceOf = getterOf(messageProto, "source");
    const messageDataOf = getterOf(messageProto, "data");
    const messagePortsOf = getterOf(messageProto, "ports");
    const stopNow = Event.prototype.stopImmediatePropagation;
    const portProto = typeof MessagePort === "function" ? MessagePort.prototype : null;
    const portPost = portProto === null ? null : portProto.postMessage;
    const portStart = portProto === null ? null : portProto.start;
    const eventTargetOf = getterOf(Event.prototype, "target");
    const pointerTypeOf = getterOf(typeof PointerEvent === "function" ? PointerEvent.prototype : null, "pointerType");
    const keyProto = typeof KeyboardEvent === "function" ? KeyboardEvent.prototype : null;
    const keyOf = getterOf(keyProto, "key");
    const repeatOf = getterOf(keyProto, "repeat");
    const editableOf = getterOf(HTMLElement.prototype, "isContentEditable");
    const designModeOf = getterOf(Document.prototype, "designMode");
    const activeOf = getterOf(Document.prototype, "activeElement");
    const controlTypeOf = getterOf(HTMLInputElement.prototype, "type");
    // Each control's form through its own getter: a field tied to a form by its form attribute is
    // not inside that form's element.
    const formGetters = bare(null);
    formGetters.button = getterOf(HTMLButtonElement.prototype, "form");
    formGetters.input = getterOf(HTMLInputElement.prototype, "form");
    formGetters.select = getterOf(HTMLSelectElement.prototype, "form");
    formGetters.textarea = getterOf(HTMLTextAreaElement.prototype, "form");
    const pressLater = setTimeout;
    const pressNoLater = clearTimeout;
    const pressListen = EventTarget.prototype.addEventListener;
    const all =
      messageSourceOf !== null && messageDataOf !== null && messagePortsOf !== null &&
      typeof stopNow === "function" && typeof portPost === "function" && typeof portStart === "function" &&
      eventTargetOf !== null && pointerTypeOf !== null && keyOf !== null && repeatOf !== null &&
      editableOf !== null && designModeOf !== null && activeOf !== null && controlTypeOf !== null &&
      formGetters.button !== null && formGetters.input !== null && formGetters.select !== null && formGetters.textarea !== null &&
      localNameOf !== null && namespaceOf !== null && nodeTypeOf !== null;
    if (all) {
      let port = null;
      // How many presses the shell hasn't answered yet, and the timer that stops waiting for it.
      let unanswered = 0;
      let giveUp = 0;
      const release = () => {
        unanswered = 0;
        callOf(pressNoLater, window, [giveUp]);
        const held = pressHeld;
        pressHeld = null;
        if (held !== null) {
          for (let i = 0; i < held.length; i += 1) {
            post(held[i]);
          }
        }
      };
      const tellPress = () => {
        if (port === null) {
          return;
        }
        try {
          callOf(portPost, port, [0]);
        } catch (_) {
          return;
        }
        unanswered += 1;
        if (pressHeld === null) {
          pressHeld = [];
        }
        callOf(pressNoLater, window, [giveUp]);
        giveUp = callOf(pressLater, window, [release, 250]);
      };
      callOf(pressListen, window, [
        "message",
        (event) => {
          let named = false;
          try {
            const data = callOf(messageDataOf, event, []);
            named = data !== null && typeof data === "object" && data.method === "porthole/shell/press-port";
          } catch (_) {}
          if (!named) {
            return;
          }
          callOf(stopNow, event, []);
          if (event.isTrusted !== true) {
            return;
          }
          try {
            const ports = callOf(messagePortsOf, event, []);
            if (callOf(messageSourceOf, event, []) !== pressParent || ports === null || ports.length !== 1) {
              return;
            }
            // Only the first is ever taken. A later one is the shell's for a load that left this
            // document where it was (WebKit's, for a navigation within it, P142): told, on the
            // port held, that this document is still here, so the shell goes on hearing that one.
            if (port !== null) {
              callOf(portPost, port, [1]);
              return;
            }
            const taken = ports[0];
            // The shell's answer to a press: it has it, and has told the host.
            callOf(pressListen, taken, [
              "message",
              () => {
                unanswered -= 1;
                if (unanswered <= 0) {
                  release();
                }
              },
            ]);
            callOf(portStart, taken, []);
            port = taken;
          } catch (_) {}
        },
        true,
      ]);
      // A native control a key or a click presses: "both" (Enter and Space), "enter" (a link), or
      // "" for anything else, an editable one included. By the kept getters: the tag and the type,
      // never an attribute the content writes to say what it is.
      const controlOf = (node) => {
        if (typeOf(node) !== 1 || callOf(namespaceOf, node, []) !== XHTML) {
          return "";
        }
        const name = callOf(localNameOf, node, []);
        let kind = "";
        if (name === "button" || name === "summary") {
          kind = "both";
        } else if (name === "input") {
          const type = callOf(controlTypeOf, node, []);
          kind = type === "button" || type === "submit" || type === "reset" ? "both" : "";
        } else if (name === "a") {
          kind = callOf(hasAttributeIn, node, ["href"]) === true ? "enter" : "";
        }
        return kind !== "" && callOf(editableOf, node, []) !== true ? kind : "";
      };
      const formOf = (node) => {
        if (typeOf(node) !== 1 || callOf(namespaceOf, node, []) !== XHTML) {
          return null;
        }
        const getter = formGetters[callOf(localNameOf, node, [])];
        return typeof getter === "function" ? callOf(getter, node, []) : null;
      };
      // The browser's own event: nothing a page dispatches is a press.
      const real = (event) => event.isTrusted === true;
      // Whether a key is down: from the browser's own keydown to its keyup, or the next press of
      // a pointer. No click in that time is a press. The key's own press was judged as it went
      // down, where it went down: content that moves the focus to its button inside the keydown
      // of an Enter typed in a text field gets that button a click of the browser's own, and a
      // held key's repeats give a button one each. An assistive technology's click comes with no
      // key down.
      let keyDown = false;
      const pointed = (down) => (event) => {
        if (!real(event)) {
          return;
        }
        keyDown = false;
        try {
          if ((callOf(pointerTypeOf, event, []) === "mouse") === down) {
            tellPress();
          }
        } catch (_) {}
      };
      callOf(pressListen, window, ["pointerdown", pointed(true), true]);
      callOf(pressListen, window, ["pointerup", pointed(false), true]);
      callOf(pressListen, window, [
        "keyup",
        (event) => {
          if (real(event)) {
            keyDown = false;
          }
        },
        true,
      ]);
      callOf(pressListen, window, [
        "keydown",
        (event) => {
          if (!real(event)) {
            return;
          }
          keyDown = true;
          try {
            // A key held down goes on being the key it was when it went down, wherever the focus
            // has moved since: its repeats are no press.
            const key = callOf(keyOf, event, []);
            if ((key !== "Enter" && key !== " ") || callOf(repeatOf, event, []) === true || callOf(designModeOf, document, []) === "on") {
              return;
            }
            const kind = controlOf(callOf(eventTargetOf, event, []));
            if (kind === "both" || (kind === "enter" && key === "Enter")) {
              tellPress();
            }
          } catch (_) {}
        },
        true,
      ]);
      callOf(pressListen, window, [
        "click",
        (event) => {
          if (!real(event)) {
            return;
          }
          try {
            const target = callOf(eventTargetOf, event, []);
            if (keyDown || controlOf(target) === "") {
              return;
            }
            // A form's own click on its submit button, for Enter in another of its fields.
            const active = callOf(activeOf, document, []);
            if (active !== null && active !== target) {
              const form = formOf(target);
              if (form !== null && form === formOf(active)) {
                return;
              }
            }
            tellPress();
          } catch (_) {}
        },
        true,
      ]);
    }
  }

  // A nested page's kept storage (P149): the store's port, and the wait for its keys. The page's
  // shell hands this runtime one end of a channel whose other end is the page's store, a document
  // of Porthole's own on the page's scope's own origin (porthole/shell/storage-port, one port).
  // Taken as the press port is: by the first listener there is, from the browser's own message,
  // from the parent read at start, the event stopped there. A later one replaces it (the shell
  // makes a new channel at each load of the frame, and the store drops the one before): what
  // crosses is data alone, the content's own words by another road, so no port here is worth
  // keeping from the one that follows it. Asked for its keys, the store answers, and content runs
  // only then: or, 1.5 s after this document loaded with no answer, on a map of memory alone,
  // nothing of which is ever written back (a page that started empty must not overwrite what is
  // kept), and the host is told so.
  let storageWaiting = [];
  const whenStored = (run) => {
    if (storageWaiting === null) {
      run();
    } else {
      storageWaiting[storageWaiting.length] = run;
    }
  };
  const storageSettled = (kept) => {
    if (storageWaiting === null) {
      return;
    }
    storageKept = kept;
    const waiting = storageWaiting;
    storageWaiting = null;
    for (let i = 0; i < waiting.length; i += 1) {
      waiting[i]();
    }
  };
  if (plan.storage !== "kept" || storeFill === null) {
    storageSettled(false);
  } else {
    const storeParent = window.parent;
    const messageProto = typeof MessageEvent === "function" ? MessageEvent.prototype : null;
    const storeSourceOf = getterOf(messageProto, "source");
    const storeDataOf = getterOf(messageProto, "data");
    const storePortsOf = getterOf(messageProto, "ports");
    const storeStop = Event.prototype.stopImmediatePropagation;
    const portProto = typeof MessagePort === "function" ? MessagePort.prototype : null;
    const storePost = portProto === null ? null : portProto.postMessage;
    const storeStart = portProto === null ? null : portProto.start;
    const storeListen = EventTarget.prototype.addEventListener;
    const storeLater = setTimeout;
    const fill = storeFill;
    if (
      hostless || storeParent === window || !rewriteFixed ||
      storeSourceOf === null || storeDataOf === null || storePortsOf === null ||
      typeof storeStop !== "function" || typeof storePost !== "function" || typeof storeStart !== "function"
    ) {
      storageSettled(false);
    } else {
      callOf(storeListen, window, [
        "message",
        (event) => {
          let named = false;
          try {
            const data = callOf(storeDataOf, event, []);
            named = data !== null && typeof data === "object" && data.method === "porthole/shell/storage-port";
          } catch (_) {}
          if (!named) {
            return;
          }
          callOf(storeStop, event, []);
          // Once this load runs on memory alone, it stays so: no port is taken, nothing written.
          if (event.isTrusted !== true || storageKept === false) {
            return;
          }
          try {
            const ports = callOf(storePortsOf, event, []);
            if (callOf(storeSourceOf, event, []) !== storeParent || ports === null || ports.length !== 1) {
              return;
            }
            const taken = ports[0];
            callOf(storeListen, taken, [
              "message",
              (message) => {
                let data = null;
                try {
                  data = callOf(storeDataOf, message, []);
                } catch (_) {}
                if (storageKept === false || data === null || typeof data !== "object") {
                  return;
                }
                // Its keys, with whether the origin gives it any storage at all: the answer the
                // wait is for. Then, from another tab of the origin, a change or a clearing.
                fill(data);
                if (storageKept === null && Array.isArray(data.keys)) {
                  storageSettled(data.kept === true);
                  if (storageKept !== true) {
                    storeSay = null;
                  }
                }
              },
            ]);
            callOf(storeStart, taken, []);
            storeSay = (message) => {
              try {
                callOf(storePost, taken, [message]);
              } catch (_) {}
            };
            if (storageKept === null) {
              storeSay({ ask: 1 });
            }
          } catch (_) {}
        },
        true,
      ]);
      const giveUp = () => {
        callOf(storeLater, window, [
          () => {
            if (storageKept === null) {
              storeSay = null;
              storageSettled(false);
            }
          },
          1500,
        ]);
      };
      if (document.readyState === "complete") {
        giveUp();
      } else {
        callOf(storeListen, window, ["load", giveUp, { once: true }]);
      }
    }
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
  // Nor can a kept iframe (P128) become one that isn't the page's own (a src elsewhere, its
  // srcdoc dropped).
  const watched = (element) => {
    if (typeOf(element) !== 1 || localNameOf === null) {
      return false;
    }
    const name = callOf(localNameOf, element, []);
    return name === "link" || name === "meta" || (ownFrames && name === "iframe");
  };
  const beforeChange = (element, change) => {
    if (!watched(element) || !connected(element)) {
      return;
    }
    const copy = callOf(cloneNodeIn, element, [false]);
    try {
      change(copy);
    } catch (_) {
      return;
    }
    if (guarded(copy)) {
      callOf(removeIn, element, []);
    }
  };
  // The names and values the check tests are pinned (once) before the check, and the same pinned
  // list is what the platform's own method is then given: the copy the guard inspects and the real
  // element can't be set from two different readings of the same argument. The strings parameter
  // names the DOMString positions to pin (an element or a boolean goes on as it is).
  const guardMethod = (proto, name, strings, change) => {
    const original = proto && proto[name];
    if (typeof original !== "function") {
      return;
    }
    const pin = bare(null);
    for (let i = 0; i < strings.length; i += 1) {
      pin[strings[i]] = true;
    }
    lock(proto, name, function (...args) {
      const fixed = listOf();
      for (let i = 0; i < args.length; i += 1) {
        pushTo(fixed, pin[i] === true ? once(args[i]) : args[i]);
      }
      beforeChange(this, (copy) => change(copy, fixed, original));
      return callOf(original, this, fixed);
    });
  };
  for (const [name, strings] of [["setAttribute", [0, 1]], ["setAttributeNS", [0, 1, 2]], ["toggleAttribute", [0]], ["removeAttribute", [0]], ["removeAttributeNS", [0, 1]]]) {
    guardMethod(Element.prototype, name, strings, (copy, args, original) => callOf(original, copy, args));
  }
  for (const name of ["setAttributeNode", "setAttributeNodeNS"]) {
    // The attribute node's own name, namespace and value are read through the kept getters (one
    // stored string each), both to check the copy and to set it; the real call takes the node.
    guardMethod(Element.prototype, name, [], (copy, args) => {
      const part = attrParts(args[0]);
      callOf(setAttributeNSIn, copy, [part.namespace, part.name, part.value]);
    });
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
        const v = once(value);
        const owner = typeOf(this) === 2 && ownerElementOf !== null ? callOf(ownerElementOf, this, []) : null;
        if (owner !== null) {
          const part = attrParts(this);
          beforeChange(owner, (copy) => callOf(setAttributeNSIn, copy, [part.namespace, part.name, NativeString(v)]));
        }
        callOf(descriptor.set, this, [v]);
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
        const value = callOf(descriptor.get, this, []);
        if (value !== null && typeof value === "object") {
          callOf(weakMapSet, owners, [value, this]);
        }
        return value;
      },
      // relList = "…" forwards to the list's value, natively: guarded here instead.
      set: descriptor.set
        ? function (value) {
            const v = once(value);
            beforeChange(this, (copy) => callOf(descriptor.set, copy, [v]));
            callOf(descriptor.set, this, [v]);
          }
        : undefined,
    });
  };
  remember(Element.prototype, "attributes");
  for (const proto of [
    typeof HTMLLinkElement === "function" ? HTMLLinkElement.prototype : null,
    typeof HTMLMetaElement === "function" ? HTMLMetaElement.prototype : null,
    // A kept iframe's src and srcdoc, set through their properties (P128).
    ownFrames && typeof HTMLIFrameElement === "function" ? HTMLIFrameElement.prototype : null,
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
            const v = once(value);
            beforeChange(this, (copy) => callOf(descriptor.set, copy, [v]));
            callOf(descriptor.set, this, [v]);
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
    const isSet = callOf(indexIn, name, ["set"]) === 0;
    lock(NamedNodeMap.prototype, name, function (...args) {
      // A removal names an attribute by a string pinned once; a set takes a node, whose own name,
      // namespace and value are read once through the kept getters. The copy and the real map act
      // on the same readings.
      const fixed = listOf();
      for (let i = 0; i < args.length; i += 1) {
        pushTo(fixed, isSet ? args[i] : once(args[i]));
      }
      beforeChange(callOf(weakMapGet, owners, [this]), (copy) => {
        if (isSet) {
          const part = attrParts(fixed[0]);
          callOf(setAttributeNSIn, copy, [part.namespace, part.name, part.value]);
        } else {
          callOf(removeAttributeIn, copy, [fixed[fixed.length - 1]]);
        }
      });
      return callOf(original, this, fixed);
    });
  }
  const tokens = typeof DOMTokenList === "function" ? DOMTokenList.prototype : null;
  for (const name of ["add", "remove", "replace", "toggle"]) {
    const original = tokens && tokens[name];
    if (typeof original === "function") {
      lock(tokens, name, function (...args) {
        // Each token is pinned once; the copy's list and the real list are changed by the same
        // tokens (a token that reads one way when checked and another when applied can't slip in).
        const fixed = listOf();
        for (let i = 0; i < args.length; i += 1) {
          pushTo(fixed, once(args[i]));
        }
        const element = callOf(weakMapGet, owners, [this]);
        beforeChange(element, (copy) => callOf(original, copy.relList, fixed));
        return callOf(original, this, fixed);
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
        const v = once(value);
        beforeChange(callOf(weakMapGet, owners, [this]), (copy) => callOf(tokenValue.set, copy.relList, [v]));
        callOf(tokenValue.set, this, [v]);
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
  // content's word, which the host gates before it acts on it. A hostless plan says nothing (P143).
  const post = (message) => {
    if (window.parent !== window && !hostless) {
      window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, message), "*");
    }
  };
  // After a press was told to the shell (P148), what the shell's protocol says next (a call, an
  // answer) waits for the shell to have the press: posted by the release above, through post.
  const send = (message) => {
    if (plan.protocol === "shell") {
      if (pressHeld !== null) {
        pressHeld[pressHeld.length] = message;
        return;
      }
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
  // The page used storage (P111): said once, as soon as the shell can speak; never keys or values.
  tellStorage = () => post({ method: "porthole/storage-used", params: plan.storage === "kept" ? { kept: storageKept === true } : {} });
  if (storageTouched) {
    tellStorage();
  }
  if (arrived) {
    notice(location.href, { arrived: true });
  }
  // A navigation within the document (a fragment, history between its entries) says the page
  // stayed (P142): WebKit fires the frame's load for one (measured, 18.2 and 26.6: a link to
  // #bottom, the first in a document), which the host would otherwise take for content that left.
  // Listened for now, before any content runs; each is the content's word, as every notice is.
  if (filesSet !== null && filesBase !== null) {
    const stayed = () => notice(location.href, { same: true });
    window.addEventListener("popstate", stayed, true);
    window.addEventListener("hashchange", stayed, true);
  }
  // A sealed files' address opens the page's files on its own for a while (P083): renewed before
  // it ends, the page moved to the new one in place (the same page, the same history entry). Its
  // modules keep the address they loaded from; the server serves their own loads till the session
  // ends.
  const replace = History.prototype.replaceState;
  // The files' origin, read from the address itself: a nested page's own origin is opaque (P111).
  const filesOrigin = filesBase === null ? null : new NativeURL(filesBase).origin;
  // A renewed sealed address (P083): one segment under the same origin's sealed prefix, checked
  // through the platform's own functions (content may have replaced a prototype's, and the base
  // decides where this page may go, ownPage); the page moves there in place.
  const adopt = (base) => {
    const prefix = filesOrigin + "/__porthole/f/";
    if (filesBase === null || typeof base !== "string" || callOf(indexIn, base, [prefix]) !== 0 || callOf(indexIn, callOf(sliceOf, base, [prefix.length, -1]), ["/"]) !== -1 || callOf(sliceOf, base, [-1]) !== "/") {
      return false;
    }
    const here = location.href;
    if (here.indexOf(filesBase) === 0) {
      try {
        applyOf(replace, history, [history.state, "", base + here.slice(filesBase.length)]);
      } catch (_) {}
    }
    filesBase = base;
    filesBases.push(base);
    return true;
  };
  adoptFiles = adopt;
  if (filesBase !== null && typeof plan.files.expires === "number") {
    const nativeFetch = window.fetch.bind(window);
    const renewIn = (expires) => Math.max(30000, expires - Date.now() - 300000);
    const renew = () => {
      nativeFetch(filesBase + "__porthole/renew", { credentials: "omit", cache: "no-store" })
        .then((answer) => (answer.ok ? answer.json() : null))
        .then((renewed) => {
          if (!renewed || typeof renewed.expires !== "number" || !adopt(renewed.base)) {
            return;
          }
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

  __FIND__

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
      // On a tab the shell's first listener took it (above).
      if (linksTaken || href === "" || href.charAt(0) === "#") {
        return;
      }
      callOf(preventNavigation, event, []);
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
  const heldBack = ${HELD_BACK};
  const draft = (input) => {
    if (rendered || root === null || input === null || typeof input !== "object" || plan.content === "document") {
      return;
    }
    morph(root, inert(parseInert(heldBack(String(input.html || "")))));
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
      case "porthole/files-renewed":
        // From the page's parent only (the listener's check): a nested page's shell renewed its
        // files' sealed address, which this page can't (its loads aren't its origin's own, P111).
        adoptFiles(params.base);
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
        // Find's own request is answered by the find runtime (P131), where the config declares it.
        if (data.id !== undefined && !(data.method === "porthole/find.query" && declared("find"))) {
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
    // A nested page's kept storage first (P149): its keys, or the word that there are none.
    whenStored(() => whenLoaded(() => void render({ html: plan.document })));
  }

  // The handshake (HANDSHAKE, P085): asked until answered, since the host may start listening
  // after this runs; on a tab of its own, not asked at all (P139): its parent is itself, so no host
  // hears it, and the runtime has nothing to offer from the start. Nor under a plan that names no
  // host (P143): no parent is one. How it ended goes on the
  // document's root element (data-porthole-host: "answered", or "none" where no host answered), for
  // a test, a person or a tool that shoots the page to see (P139): not on the shell's own script,
  // which a whole document's render takes out with the body it replaces, while the root stays (the
  // render adds the page's own attributes to it and removes none). The page's own word, never a
  // gate, set through the platform's setAttribute kept before the guards (setAttributeOfShell).
  const shellRoot = document.documentElement;
  const settled = (how) => {
    try {
      callOf(setAttributeOfShell, shellRoot, ["data-porthole-host", how]);
    } catch (_) {}
  };
  const handshake = ${HANDSHAKE};
  handshake(
    window.top === window || hostless,
    () =>
      request("ui/initialize", {
        protocolVersion: plan.protocolVersion,
        appInfo: { name: "porthole-shell", version: "1" },
        appCapabilities: {},
      }),
    (result) => {
      settled("answered");
      const capabilities = result && result.hostCapabilities;
      const experimental = capabilities && capabilities.experimental;
      runtimeOffer(experimental && typeof experimental === "object" ? experimental["porthole/runtime"] : null);
      applyTheme(result && result.hostContext);
      notify("ui/notifications/initialized", {});
      schedule();
    },
    () => {
      // No host answered (or none can): the runtime has nothing to offer.
      settled("none");
      runtimeOffer(null);
    },
    (run, ms) => setTimeout(run, ms),
  );
})();`;
