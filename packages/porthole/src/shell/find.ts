import { TEXT_INDEX } from "./text.ts";

/**
 * The matches of a query in the document's text (P131), spliced into the find runtime: `text` is
 * the text index's (`textIndex().text`), `query` the person's words. Case-insensitive unless
 * `caseSensitive` (Unicode simple case folding, `u` and `i`, so a match keeps the text's own
 * offsets), and loose about spacing as annotations' `squash` is: the query is trimmed, and each
 * run of white space in it matches any run of white space in the text. Everything else is
 * literal (no pattern syntax reaches the expression). Matches don't overlap, in document order.
 *
 * `keep(start, end)` says whether a match counts (the runtime: whether it has a box on screen,
 * and its range), null if not; at most `most` are kept, and at most ten times that many are
 * looked at (`capped`: it stopped there, and there may be more). The platform's own `RegExp`,
 * its `exec` and `Reflect.apply` come in as taken before content ran, and so do the list the
 * spans go in and how one is added (`list`, `push`: the shell's prototype-less `listOf` and
 * `pushTo`); nothing else is called on a prototype content could replace (only indexing,
 * comparisons and `length`).
 */
export const FIND_MATCH = String.raw`(text, query, caseSensitive, most, keep, Pattern, exec, apply, list, push) => {
        const SPACE = new Pattern("^\\s$", "u");
        const SYNTAX = "\\^$.*+?()[]{}|/";
        let source = "";
        let space = false;
        for (let i = 0; i < query.length; i += 1) {
          const c = query[i];
          if (apply(exec, SPACE, [c]) !== null) {
            space = source !== "";
            continue;
          }
          if (space) {
            source += "\\s+";
            space = false;
          }
          let special = false;
          for (let j = 0; j < SYNTAX.length && !special; j += 1) {
            special = SYNTAX[j] === c;
          }
          source += special ? "\\" + c : c;
        }
        const spans = list();
        if (source === "") {
          return { spans, capped: false };
        }
        const pattern = new Pattern(source, caseSensitive === true ? "gu" : "giu");
        let looked = 0;
        for (let found = apply(exec, pattern, [text]); found !== null; found = apply(exec, pattern, [text])) {
          const start = found.index;
          const end = start + found[0].length;
          if (end === start) {
            pattern.lastIndex = start + 1;
            continue;
          }
          if (spans.length === most || looked === most * 10) {
            return { spans, capped: true };
          }
          looked += 1;
          const kept = keep(start, end);
          if (kept !== null) {
            push(spans, { start, end, kept });
          }
        }
        return { spans, capped: false };
      }`;

/**
 * Whether a key is the find shortcut (P131), spliced into the find runtime: Cmd+F on Apple's
 * platforms (`apple`), Ctrl+F elsewhere, with no Alt, no Shift and not the other of the two. The
 * letter is `key`'s; on a layout whose letters aren't Latin (Cyrillic, Greek), the key in F's
 * place (`code`), as browsers find there too. Comparisons only.
 */
export const FIND_SHORTCUT = String.raw`(apple, key, code, meta, ctrl, alt, shift) => {
        if (alt === true || shift === true || (apple ? !(meta === true && ctrl !== true) : !(ctrl === true && meta !== true))) {
          return false;
        }
        if (key === "f" || key === "F") {
          return true;
        }
        const latin = typeof key === "string" && key.length === 1 && ((key >= "a" && key <= "z") || (key >= "A" && key <= "Z"));
        return !latin && code === "KeyF";
      }`;

/**
 * Only the latest query (P131), spliced into the find runtime: what the shell does with each
 * query the host asks. A search is synchronous and, on a large page, long (hundreds of ms), so a
 * bar that asks at every key builds a queue of messages behind it. A query that comes while none
 * waits, and not within `quiet` ms of the end of the last one run, is run at once (answered
 * before any content's listener could answer it). Otherwise it waits for the next task, after the
 * messages already queued: a later query (or a clear, `drop`) supersedes it, and the one it
 * superseded is answered `superseded(id)` at once (an error; the host makes it `"unsupported"`).
 * So a burst is at most the query running and the latest, never each in turn.
 *
 * `later(run, wait)` and `time()` are the shell's kept timers and clock, `run(id, request)` runs
 * and answers a query; `request` is what the runtime read from the host's message when it came
 * (read once, never again). Comparisons and its own closures only.
 */
export const FIND_LATEST = String.raw`(later, time, quiet, run, superseded) => {
        let waiting = null;
        let scheduled = false;
        let ended = null;
        const runNow = (id, request) => {
          run(id, request);
          ended = time();
        };
        const runWaiting = () => {
          scheduled = false;
          const next = waiting;
          waiting = null;
          if (next !== null) {
            runNow(next.id, next.request);
          }
        };
        return {
          ask: (id, request) => {
            if (waiting === null && !scheduled && (ended === null || time() - ended >= quiet)) {
              runNow(id, request);
              return;
            }
            if (waiting !== null) {
              superseded(waiting.id);
            }
            waiting = { id, request };
            if (!scheduled) {
              scheduled = true;
              later(runWaiting, 0);
            }
          },
          drop: () => {
            if (waiting !== null) {
              const gone = waiting.id;
              waiting = null;
              superseded(gone);
            }
          },
        };
      }`;

/**
 * The style of the shell's layers over the content (annotations' and find's): inline and
 * important, so the content's own style sheets can't hide, shrink or move it by accident (its
 * scripts can, P104). The annotation runtime carries the same text (a test holds them equal).
 */
export const LAYER_STYLE =
  "position:fixed!important;inset:0!important;width:auto!important;height:auto!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:none!important;z-index:2147483647!important;overflow:hidden!important;margin:0!important;padding:0!important;border:0!important;background:none!important;transform:none!important;scale:none!important;translate:none!important;rotate:none!important;zoom:1!important;clip-path:none!important;mask:none!important;filter:none!important;content-visibility:visible!important;contain:none!important";

/**
 * The shell's find in page (P131), spliced into the shell's runtime (`__FIND__`) when the config
 * declares `find`, so it runs before any content does, with the DOM's own functions as they were.
 * Plain ES2020 like the rest of the shell; no template literals (it sits in one).
 *
 * The host drives it (`porthole/find.query`, a request; `porthole/find.clear|handled`) and it
 * says (`porthole/find.requested|updated`):
 * - a query: its matches in the document's text (annotations' text index: the body's text nodes,
 *   without scripts, styles, noscript, templates), case-insensitive and loose about spacing,
 *   those with a box on screen, at most 1,000; each is drawn in a layer of the shell's own (a
 *   closed shadow root, over the content, as annotations' marks are; never the CSS Custom
 *   Highlight API, which content can read and rewrite: P053, P104), the current one apart, again
 *   at each scroll, resize and change of the content; the answer is how many and which, and the
 *   current one's box once it was scrolled into view (its scrolling ancestors first, then the
 *   window, centred); only the latest of a burst is searched, the ones it superseded answered
 *   with an error (`FIND_LATEST`);
 * - a change of the content while a query is shown: found again once it settles (at most a
 *   second late), the current match kept by its place, and the host told when the count or the
 *   current one changed, at most once a second;
 * - the shortcut: while the host says it draws its own find bar (`handled`), Cmd+F (Apple) or
 *   Ctrl+F (elsewhere) in the frame that the page didn't take itself (it called preventDefault)
 *   stops the browser's own find and is told (`requested`); otherwise the key is left alone.
 *
 * Every built-in it calls once content may have run is one it took before (the DOM's methods and
 * getters, the timers, `postMessage`, `Map`, `RegExp`), called through the shell's `callOf`
 * (P129); its lists are the shell's prototype-less ones, and what it reads from the host's message
 * (the event's fields, the request's own properties) is read once and only as a string, a number
 * or a boolean. The nodes of its layer go in only through the shell's guarded insertion methods
 * (P130: `createElement`, `attachShadow`, `appendChild`, `replaceChildren`, the `textContent`
 * setter, taken after the shell wrapped them), and it inserts nothing into the content's own
 * trees.
 *
 * It shares the realm with the content, which can read the query, change what matches, hide the
 * layer, keep the key from it or say `requested` itself: the host takes what it says as a find
 * bar's numbers, never as facts.
 */
export const FIND_RUNTIME = String.raw`if (declared("find")) {
    (() => {
      // quiet: a query this soon (ms) after the last search ended may have others queued behind it.
      const LIMIT = { query: 256, matches: 1000, boxes: 50, drawn: 2000, quiet: 16 };
      const M = {
        query: "porthole/find.query",
        clear: "porthole/find.clear",
        handled: "porthole/find.handled",
        requested: "porthole/find.requested",
        updated: "porthole/find.updated",
      };
      // The DOM's own functions, taken before content runs and called only through callOf (P129).
      // The insertion methods and createElement are the shell's guarded ones (P130), wrapped by
      // step 3 before this runs: the layer's nodes go in the way any node does.
      const setterOf = (proto, name) => {
        const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined;
        return descriptor && typeof descriptor.set === "function" ? descriptor.set : null;
      };
      const createRange = Document.prototype.createRange;
      const createTreeWalker = Document.prototype.createTreeWalker;
      const createElement = Document.prototype.createElement;
      const attachShadow = Element.prototype.attachShadow;
      const setAttributeOn = Element.prototype.setAttribute;
      const appendTo = Node.prototype.appendChild;
      const parentElementOf = getterOf(Node.prototype, "parentElement");
      const documentElementOf = getterOf(Document.prototype, "documentElement");
      const bodyOf = getterOf(Document.prototype, "body");
      const replaceIn = Element.prototype.replaceChildren;
      const replaceInRoot = DocumentFragment.prototype.replaceChildren;
      const textContentTo = setterOf(Node.prototype, "textContent");
      const classNameTo = setterOf(Element.prototype, "className");
      const nonceTo = setterOf(HTMLElement.prototype, "nonce");
      const styleOf = getterOf(HTMLElement.prototype, "style");
      const cssTextOf = getterOf(CSSStyleDeclaration.prototype, "cssText");
      const cssTextTo = setterOf(CSSStyleDeclaration.prototype, "cssText");
      const propertyValueIn = CSSStyleDeclaration.prototype.getPropertyValue;
      const rangeRect = Range.prototype.getBoundingClientRect;
      const rangeRects = Range.prototype.getClientRects;
      // A range's boundary getters are AbstractRange's where an engine has it.
      const startContainerOf = getterOf(typeof AbstractRange === "function" ? AbstractRange.prototype : Range.prototype, "startContainer");
      const elementRect = Element.prototype.getBoundingClientRect;
      const listLength = getterOf(typeof DOMRectList === "function" ? DOMRectList.prototype : null, "length");
      const listItem = typeof DOMRectList === "function" ? DOMRectList.prototype.item : null;
      const itemOf = (list, i) => (listItem === null ? list[i] : callOf(listItem, list, [i]));
      const leftOf = getterOf(DOMRectReadOnly.prototype, "left");
      const topOf = getterOf(DOMRectReadOnly.prototype, "top");
      const widthOf = getterOf(DOMRectReadOnly.prototype, "width");
      const heightOf = getterOf(DOMRectReadOnly.prototype, "height");
      const clientWidthOf = getterOf(Element.prototype, "clientWidth");
      const clientHeightOf = getterOf(Element.prototype, "clientHeight");
      const clientTopOf = getterOf(Element.prototype, "clientTop");
      const clientLeftOf = getterOf(Element.prototype, "clientLeft");
      const scrollWidthOf = getterOf(Element.prototype, "scrollWidth");
      const scrollHeightOf = getterOf(Element.prototype, "scrollHeight");
      const computedOf = window.getComputedStyle;
      const scrollWindow = window.scrollBy;
      const scrollElement = Element.prototype.scrollBy;
      const Pattern = RegExp;
      const execOf = RegExp.prototype.exec;
      const BLANK = /^\s*$/u;
      const keyOf = getterOf(typeof KeyboardEvent === "function" ? KeyboardEvent.prototype : null, "key");
      const codeOf = getterOf(typeof KeyboardEvent === "function" ? KeyboardEvent.prototype : null, "code");
      const metaOf = getterOf(typeof KeyboardEvent === "function" ? KeyboardEvent.prototype : null, "metaKey");
      const ctrlOf = getterOf(typeof KeyboardEvent === "function" ? KeyboardEvent.prototype : null, "ctrlKey");
      const altOf = getterOf(typeof KeyboardEvent === "function" ? KeyboardEvent.prototype : null, "altKey");
      const shiftOf = getterOf(typeof KeyboardEvent === "function" ? KeyboardEvent.prototype : null, "shiftKey");
      const preventedOf = getterOf(Event.prototype, "defaultPrevented");
      const messageDataOf = getterOf(MessageEvent.prototype, "data");
      const messageOriginOf = getterOf(MessageEvent.prototype, "origin");
      const messageSourceOf = getterOf(MessageEvent.prototype, "source");
      const removedNodesOf = getterOf(recordProto, "removedNodes");
      // The platform's preventDefault, kept before a tab's shell locks its own over it (P099).
      const stopFind = preventNavigation;
      const timeoutIn = window.setTimeout;
      const clearTimeoutIn = window.clearTimeout;
      const animationFrameIn = window.requestAnimationFrame;
      const later = (run, wait) => callOf(timeoutIn, window, [run, wait]);
      const cancelLater = (timer) => callOf(clearTimeoutIn, window, [timer]);
      const nextFrame = (run) => callOf(animationFrameIn, window, [run]);
      const clock = Date.now;
      const time = () => callOf(clock, Date, []);
      // Read once: content can replace window.parent (it is [Replaceable]), never what was read.
      const parentWindow = window.parent;
      const framed = parentWindow !== window;
      const postIn = parentWindow.postMessage;
      const post = (message) => callOf(postIn, parentWindow, [message, "*"]);
      // Whose shortcut it is: Cmd on Apple's platforms, Ctrl elsewhere (read before content runs).
      const apple = callOf(execOf, /Mac|iPhone|iPad|iPod/, [NativeString(navigator.platform || "")]) !== null;
      const tell = (method, params) => {
        if (framed) {
          post({ jsonrpc: "2.0", method, params });
        }
      };
      // kind is "result" or "error": a literal's own property, never one set through a prototype.
      const answer = (id, kind, body) => {
        if (framed) {
          post({ jsonrpc: "2.0", id, [kind]: body });
        }
      };
      // Through the platform's getter, taken now; where an engine has none there, as the object says.
      const get = (getter, target, name) => (getter === null ? target[name] : callOf(getter, target, []));
      // A box's number, read once: only a number is used.
      const numberOf = (value) => (typeof value === "number" ? value : 0);
      const lesser = (a, b) => (a < b ? a : b);
      const greater = (a, b) => (a > b ? a : b);
      const boxOf = (rect) => ({ x: numberOf(get(leftOf, rect, "left")), y: numberOf(get(topOf, rect, "top")), width: numberOf(get(widthOf, rect, "width")), height: numberOf(get(heightOf, rect, "height")) });
      // A range's boxes (its lines), at most LIMIT.boxes; those of no size left out.
      const boxesOf = (range) => {
        const list = callOf(rangeRects, range, []);
        const count = lesser(numberOf(get(listLength, list, "length")), LIMIT.boxes);
        const out = listOf();
        for (let i = 0; i < count; i += 1) {
          const each = boxOf(itemOf(list, i));
          if (each.width > 0 || each.height > 0) {
            pushTo(out, each);
          }
        }
        return out;
      };
      const rootElement = () => (documentElementOf === null ? document.documentElement : callOf(documentElementOf, document, []));
      const bodyElement = () => (bodyOf === null ? document.body : callOf(bodyOf, document, []));
      const viewport = () => {
        const root = rootElement();
        return { width: numberOf(get(clientWidthOf, root, "clientWidth")), height: numberOf(get(clientHeightOf, root, "clientHeight")) };
      };
      // An own property of what the host sent, read once (a structured clone's own data property),
      // never one from a prototype content could fill.
      const own = (object, name) => (object !== null && typeof object === "object" && callOf(hasOwn, object, [name]) ? object[name] : undefined);

      ${TEXT_INDEX}
      const findMatches = ${FIND_MATCH};
      const isShortcut = ${FIND_SHORTCUT};
      const keepLatest = ${FIND_LATEST};

      // The shell's own layer, over the content, apart from annotations' (P053): a match is a
      // light warm fill with a thin edge, the current one stronger with a ring, so both read on a
      // light page and a dark one and neither looks like a comment's mark (yellow, underlined).
      const STYLE = ".hit{position:absolute;border-radius:2px;background:rgba(255,159,10,.28);box-shadow:inset 0 0 0 1px rgba(217,119,6,.5)}.hit.current{background:rgba(255,120,0,.5);box-shadow:0 0 0 2px rgb(234,88,12)}";
      const LAYER_STYLE = "${LAYER_STYLE}";
      // An element's inline style, through the kept getter and setter (CSSOM, which a CSP's
      // style-src doesn't govern, unlike a style attribute).
      const styleText = (element) => get(cssTextOf, get(styleOf, element, "style"), "cssText");
      const setStyle = (element, text) => {
        const style = get(styleOf, element, "style");
        if (cssTextTo === null) {
          style.cssText = text;
        } else {
          callOf(cssTextTo, style, [text]);
        }
      };
      let layer = null;
      let shadow = null;
      let parts = null;
      const ensureLayer = () => {
        if (layer === null) {
          layer = callOf(createElement, document, ["div"]);
          callOf(setAttributeOn, layer, ["aria-hidden", "true"]);
          callOf(setAttributeOn, layer, ["data-porthole-find", ""]);
          shadow = callOf(attachShadow, layer, [{ mode: "closed" }]);
          const style = callOf(createElement, document, ["style"]);
          if (nonce !== "") {
            if (nonceTo === null) {
              callOf(setAttributeOn, style, ["nonce", nonce]);
            } else {
              callOf(nonceTo, style, [nonce]);
            }
          }
          if (textContentTo === null) {
            style.textContent = STYLE;
          } else {
            callOf(textContentTo, style, [STYLE]);
          }
          parts = callOf(createElement, document, ["div"]);
          callOf(replaceInRoot, shadow, [style, parts]);
        }
        if (styleText(layer) !== LAYER_STYLE) {
          setStyle(layer, LAYER_STYLE);
        }
        if (!connected(layer)) {
          callOf(appendTo, rootElement(), [layer]);
        }
      };

      // What is shown: the query, its matches ({ start, end, range }), the current one (from 1).
      let shown = null;
      let matches = listOf();
      let capped = false;
      let active = 0;
      // Whether the host draws its own find bar: then the shortcut is the host's.
      let handled = false;

      const draw = () => {
        if (matches.length === 0) {
          if (parts !== null) {
            callOf(replaceIn, parts, []);
          }
          return;
        }
        ensureLayer();
        const seen = viewport();
        // The others first, then the current match, so it is drawn over them.
        const drawn = listOf();
        const current = listOf();
        for (let i = 0; i < matches.length && drawn.length < LIMIT.drawn; i += 1) {
          const outer = boxOf(callOf(rangeRect, matches[i].range, []));
          // Only what is in view is drawn; the rest again as it comes into view.
          if (outer.y + outer.height < 0 || outer.y > seen.height || outer.x + outer.width < 0 || outer.x > seen.width) {
            continue;
          }
          const mine = i + 1 === active;
          const rects = boxesOf(matches[i].range);
          for (let j = 0; j < rects.length; j += 1) {
            const rect = rects[j];
            const each = callOf(createElement, document, ["div"]);
            if (classNameTo === null) {
              callOf(setAttributeOn, each, ["class", mine ? "hit current" : "hit"]);
            } else {
              callOf(classNameTo, each, [mine ? "hit current" : "hit"]);
            }
            setStyle(each, "left:" + rect.x + "px;top:" + rect.y + "px;width:" + rect.width + "px;height:" + rect.height + "px");
            pushTo(mine ? current : drawn, each);
          }
        }
        for (let i = 0; i < current.length; i += 1) {
          pushTo(drawn, current[i]);
        }
        callOf(replaceIn, parts, drawn);
      };
      let drawing = false;
      const redraw = () => {
        if (!drawing && matches.length > 0) {
          drawing = true;
          nextFrame(() => {
            drawing = false;
            draw();
          });
        }
      };
      window.addEventListener("resize", redraw);
      window.addEventListener("scroll", redraw, true);

      // Every match of the query shown, found again: those with a box (text that is drawn).
      const search = () => {
        const index = textIndex();
        const found = findMatches(index.text, shown.query, shown.caseSensitive, LIMIT.matches, (start, end) => {
          const range = rangeAt(index, start, end);
          return range !== null && boxesOf(range).length > 0 ? range : null;
        }, Pattern, execOf, callOf, listOf, pushTo);
        const next = listOf();
        for (let i = 0; i < found.spans.length; i += 1) {
          const each = found.spans[i];
          pushTo(next, { start: each.start, end: each.end, range: each.kept });
        }
        matches = next;
        capped = found.capped;
      };
      // The first match at or after where the person is reading (the viewport's top), 0-based.
      const firstInView = () => {
        for (let i = 0; i < matches.length; i += 1) {
          const outer = boxOf(callOf(rangeRect, matches[i].range, []));
          if (outer.y + outer.height > 0) {
            return i;
          }
        }
        return 0;
      };
      // The current match after the matches were found again: by its place, moved as asked.
      const choose = (before, direction) => {
        const count = matches.length;
        if (count === 0) {
          return 0;
        }
        if (before < 0) {
          const first = firstInView();
          return direction === "prev" ? ((first - 1 + count) % count) + 1 : first + 1;
        }
        let at = 0;
        while (at < count && matches[at].start < before) {
          at += 1;
        }
        if (direction === "next") {
          return ((at < count && matches[at].start === before ? at + 1 : at) % count) + 1;
        }
        if (direction === "prev") {
          return ((at - 1 + count) % count) + 1;
        }
        return (at < count ? at : count - 1) + 1;
      };
      // Into view, centred where it is out of it: each scrolling ancestor, innermost first, then
      // the window. Instantly (a page's smooth scrolling would leave it where it was measured).
      const scrollBy = (scroll, target, dx, dy) => {
        try {
          callOf(scroll, target, [{ left: dx, top: dy, behavior: "instant" }]);
        } catch (_) {
          try {
            callOf(scroll, target, [dx, dy]);
          } catch (_) {}
        }
      };
      const SCROLLS = bare(null);
      SCROLLS.auto = 1;
      SCROLLS.scroll = 1;
      SCROLLS.overlay = 1;
      const centre = (from, size, start, length) => (from < start || from + size > start + length ? from - start - (length - lesser(size, length)) / 2 : 0);
      const reveal = (range) => {
        let node = get(startContainerOf, range, "startContainer");
        if (node !== null && typeOf(node) !== 1) {
          node = get(parentElementOf, node, "parentElement");
        }
        const body = bodyElement();
        const root = rootElement();
        for (let hops = 0; node !== null && node !== body && node !== root && hops < 64; hops += 1) {
          const style = callOf(computedOf, window, [node]);
          const down = SCROLLS[callOf(propertyValueIn, style, ["overflow-y"])] === 1 && numberOf(get(scrollHeightOf, node, "scrollHeight")) > numberOf(get(clientHeightOf, node, "clientHeight"));
          const across = SCROLLS[callOf(propertyValueIn, style, ["overflow-x"])] === 1 && numberOf(get(scrollWidthOf, node, "scrollWidth")) > numberOf(get(clientWidthOf, node, "clientWidth"));
          if (down || across) {
            const outer = boxOf(callOf(elementRect, node, []));
            const at = boxOf(callOf(rangeRect, range, []));
            const dy = down ? centre(at.y, at.height, outer.y + numberOf(get(clientTopOf, node, "clientTop")), numberOf(get(clientHeightOf, node, "clientHeight"))) : 0;
            const dx = across ? centre(at.x, at.width, outer.x + numberOf(get(clientLeftOf, node, "clientLeft")), numberOf(get(clientWidthOf, node, "clientWidth"))) : 0;
            if (dx !== 0 || dy !== 0) {
              scrollBy(scrollElement, node, dx, dy);
            }
          }
          node = get(parentElementOf, node, "parentElement");
        }
        const seen = viewport();
        const at = boxOf(callOf(rangeRect, range, []));
        const dy = centre(at.y, at.height, 0, seen.height);
        const dx = centre(at.x, at.width, 0, seen.width);
        if (dx !== 0 || dy !== 0) {
          scrollBy(scrollWindow, window, dx, dy);
        }
      };
      // An object with no prototype, so no property set on it reaches a setter content put on
      // Object.prototype; the host gets it as a plain object.
      const resultOf = (withBox) => {
        const result = bare(null);
        result.total = matches.length;
        result.active = active;
        if (capped) {
          result.capped = true;
        }
        if (withBox && active > 0) {
          result.rect = boxOf(callOf(rangeRect, matches[active - 1].range, []));
        }
        return result;
      };

      // Told: the numbers the host last had (an answer or an update), so a change of the content
      // that moves nothing tells nothing; at most one update a second, the latest.
      let told = "";
      let toldAt = 0;
      let tellTimer = 0;
      const keyOfResult = () => matches.length + ":" + active + ":" + capped;
      const tellUpdated = () => {
        if (shown === null || keyOfResult() === told) {
          return;
        }
        const wait = toldAt + 1000 - time();
        if (wait > 0) {
          if (tellTimer === 0) {
            tellTimer = later(() => {
              tellTimer = 0;
              tellUpdated();
            }, wait);
          }
          return;
        }
        told = keyOfResult();
        toldAt = time();
        tell(M.updated, resultOf(false));
      };

      // Found again once a run of changes settles (150 ms quiet), at most a second late.
      let searchTimer = 0;
      let deadline = 0;
      const again = () => {
        searchTimer = 0;
        deadline = 0;
        if (shown === null) {
          return;
        }
        const before = active > 0 ? matches[active - 1].start : -1;
        search();
        active = choose(before, "none");
        draw();
        tellUpdated();
      };
      const scheduleSearch = () => {
        const now = time();
        if (deadline === 0) {
          deadline = now + 1000;
        }
        cancelLater(searchTimer);
        searchTimer = later(again, greater(0, lesser(150, deadline - now)));
      };
      // The layer's own changes are none of the content's: a record of the layer, or one that only
      // adds or removes it, is passed over. Read through the kept getters.
      const ownChange = (record) => {
        if (get(recordTargetOf, record, "target") === layer) {
          return true;
        }
        const added = get(addedNodesOf, record, "addedNodes");
        const removed = get(removedNodesOf, record, "removedNodes");
        const addedCount = countOf(added);
        const removedCount = countOf(removed);
        return addedCount + removedCount === 1 && (addedCount === 1 ? added[0] === layer : removed[0] === layer);
      };
      const contentWatch = new MutationObserver((records) => {
        if (shown === null) {
          return;
        }
        for (let i = 0; i < records.length; i += 1) {
          if (ownChange(records[i])) {
            continue;
          }
          scheduleSearch();
          return;
        }
      });
      callOf(observeIn, contentWatch, [document, { childList: true, subtree: true, characterData: true }]);

      const clear = () => {
        shown = null;
        matches = listOf();
        capped = false;
        active = 0;
        told = "";
        cancelLater(searchTimer);
        searchTimer = 0;
        deadline = 0;
        cancelLater(tellTimer);
        tellTimer = 0;
        draw();
      };
      // What the host asked, read when its message comes: each of the request's fields once, as
      // its own property; only a string is a query. Kept as these values (a query that waits is
      // never read from the message again).
      const requestOf = (params) => {
        const asked = own(params, "query");
        const askedCase = own(params, "caseSensitive");
        const askedDirection = own(params, "direction");
        return {
          words: typeof asked === "string" ? callOf(sliceOf, asked, [0, LIMIT.query]) : "",
          caseSensitive: askedCase === true,
          direction: askedDirection === "next" || askedDirection === "prev" ? askedDirection : "none",
        };
      };
      // A query: its matches found (again, for the same words), the current one chosen, brought
      // into view when it moved or isn't in view, and drawn; answered with where they stand.
      const query = (request) => {
        const words = request.words;
        const caseSensitive = request.caseSensitive;
        const direction = request.direction;
        // No words at all clears: nothing drawn, nothing followed.
        if (callOf(execOf, BLANK, [words]) !== null) {
          clear();
          return { total: 0, active: 0 };
        }
        const same = shown !== null && shown.query === words && shown.caseSensitive === caseSensitive;
        const before = same && active > 0 ? matches[active - 1].start : -1;
        shown = { query: words, caseSensitive };
        search();
        active = choose(before, direction);
        // Brought into view after a move or for a new query (one already in view stays where it is).
        if (active > 0 && (direction !== "none" || !same)) {
          reveal(matches[active - 1].range);
        }
        draw();
        told = keyOfResult();
        return resultOf(true);
      };
      // Only the latest query: one the person moved past before it ran is answered as superseded
      // (an error the host makes "unsupported"), never searched (FIND_LATEST).
      const latest = keepLatest(
        later,
        time,
        LIMIT.quiet,
        (id, request) => {
          try {
            answer(id, "result", query(request));
          } catch (_) {
            answer(id, "error", { code: -32603, message: "find failed" });
          }
        },
        (id) => answer(id, "error", { code: -32800, message: "superseded by a later query" }),
      );

      // The shortcut, after the page's own listeners (on the window, as the event bubbles): one
      // the page took (preventDefault) is the page's own find. Read through the platform's
      // getters, kept now; a key the page makes up (isTrusted is false) is none.
      window.addEventListener("keydown", (event) => {
        if (!handled || !event.isTrusted || get(preventedOf, event, "defaultPrevented") === true) {
          return;
        }
        if (!isShortcut(apple, get(keyOf, event, "key"), get(codeOf, event, "code"), get(metaOf, event, "metaKey"), get(ctrlOf, event, "ctrlKey"), get(altOf, event, "altKey"), get(shiftOf, event, "shiftKey"))) {
          return;
        }
        callOf(stopFind, event, []);
        tell(M.requested, {});
      });

      // Only the plan's origins: an indexed loop over the plan's own list.
      const fromHost = (origin) => {
        for (let i = 0; i < plan.origins.length; i += 1) {
          if (plan.origins[i] === origin) {
            return true;
          }
        }
        return false;
      };
      window.addEventListener("message", (event) => {
        // The event's fields, each read once through the kept getters.
        if (get(messageSourceOf, event, "source") !== parentWindow || !fromHost(get(messageOriginOf, event, "origin"))) {
          return;
        }
        const data = get(messageDataOf, event, "data");
        if (data === null || typeof data !== "object" || own(data, "jsonrpc") !== "2.0") {
          return;
        }
        const method = own(data, "method");
        if (typeof method !== "string") {
          return;
        }
        const sent = own(data, "params");
        const params = sent !== null && typeof sent === "object" ? sent : bare(null);
        switch (method) {
          case M.query: {
            // A request: read now; answered at once, before any content's listener could answer
            // it, unless a burst of queries is queued behind a long search (then the latest only).
            const id = own(data, "id");
            if (typeof id !== "string" && typeof id !== "number") {
              return;
            }
            latest.ask(id, requestOf(params));
            break;
          }
          case M.clear:
            latest.drop();
            clear();
            break;
          case M.handled:
            handled = own(params, "handled") === true;
            break;
          default:
            break;
        }
      });
    })();
  }`;
