/**
 * Which links are bare (P151), spliced into the link-label runtime: a link whose only child is a
 * text node whose words, without the ASCII white space around them (space, tab, LF, FF, CR), are
 * its `href` attribute as written (also trimmed so) or its address as the platform resolved it.
 * `data` is the text node's, `raw` the attribute's, `resolved` the address. Comparisons and
 * indexing only (no String.prototype method content could replace); `slice` is the platform's
 * own `String.prototype.slice`, taken before content ran, and `apply` its `Reflect.apply`.
 */
export const LINK_BARE = String.raw`(data, raw, resolved, slice, apply) => {
        const space = (c) => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
        const trim = (text) => {
          let start = 0;
          let end = text.length;
          while (start < end && space(text[start])) {
            start += 1;
          }
          while (end > start && space(text[end - 1])) {
            end -= 1;
          }
          return start === 0 && end === text.length ? text : apply(slice, text, [start, end]);
        };
        if (typeof data !== "string") {
          return false;
        }
        const words = trim(data);
        if (words === "") {
          return false;
        }
        return (typeof raw === "string" && words === trim(raw)) || (typeof resolved === "string" && words === resolved);
      }`;

/**
 * The labels the host sent (P151), read into `table` (an object with no prototype, filled by
 * address), spliced into the link-label runtime; it answers how many it kept. The host checked
 * them already; the shell holds them to the same bounds, since the message crosses the frame: at
 * most `most` entries read, each an own `href` (a string of 1 to `hrefMost` characters) and an
 * own `text` (at most `textMost`, its bidirectional controls taken out, not blank once they are);
 * an own `tag` kept only if it is 1 to 32 of a-z, 0-9 and `-`. The first label for an address
 * wins. `own(object, name)` reads an own property once; `isList` is the platform's own
 * `Array.isArray`. Comparisons, indexing and its own closures only.
 */
export const LINK_LABELS_OF = String.raw`(labels, own, isList, most, hrefMost, textMost, table) => {
        // U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069.
        const bidi = (c) => c === "‎" || c === "‏" || (c >= "‪" && c <= "‮") || (c >= "⁦" && c <= "⁩");
        const blank = (c) => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
        const tagOf = (value) => {
          if (typeof value !== "string" || value.length < 1 || value.length > 32) {
            return null;
          }
          for (let i = 0; i < value.length; i += 1) {
            const c = value[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-")) {
              return null;
            }
          }
          return value;
        };
        if (isList(labels) !== true) {
          return 0;
        }
        const count = own(labels, "length");
        if (typeof count !== "number") {
          return 0;
        }
        let kept = 0;
        for (let i = 0; i < count && i < most; i += 1) {
          const each = own(labels, i);
          const href = own(each, "href");
          const text = own(each, "text");
          if (typeof href !== "string" || href.length === 0 || href.length > hrefMost || typeof text !== "string" || text.length > textMost) {
            continue;
          }
          let shown = "";
          let words = false;
          for (let j = 0; j < text.length; j += 1) {
            const c = text[j];
            if (!bidi(c)) {
              shown += c;
              words = words || !blank(c);
            }
          }
          if (!words || table[href] !== undefined) {
            continue;
          }
          table[href] = { text: shown, tag: tagOf(own(each, "tag")) };
          kept += 1;
        }
        return kept;
      }`;

/**
 * The shell's link labels (P151), spliced into the shell's runtime in find's place (after it)
 * when the config declares `linkLabels`, so it runs before any content does, with the DOM's own
 * functions as they were. Plain ES2020 like the rest of the shell; no template literals.
 *
 * The host sends `porthole/links.label` `{ labels: [{ href, text, tag? }] }` (a notification;
 * nothing is answered, and nothing else is ever said). For every HTML `a` and `area` in the
 * document with an `href` whose address (the attribute resolved against the document's base by
 * the platform's own URL parser) is a label's exactly:
 * - a bare link (`LINK_BARE`) has its text node's words replaced by the label's text, as text
 *   (the node's own `nodeValue` setter), never as markup; the words it had are kept, and given back
 *   when a later label set (or an empty one) no longer labels it, or the link stops being one, if
 *   the node still holds the label's words (a page that wrote its own since keeps them);
 * - every link, bare or not, gets `data-porthole-label="<tag>"` where the label has a tag, taken
 *   off again as the words are.
 * Applied again once a run of the document's changes settles (150 ms quiet, at most a second
 * late, as find's search is), so links the page adds later are labelled; its own changes are no
 * change of the content (the observer's records of them are taken).
 *
 * Every built-in it calls once content may have run is one it took before (the DOM's getters and
 * setters, `querySelectorAll`, `URL`, the timers, `WeakMap`), called through the shell's `callOf`
 * (P129); its lists are the shell's prototype-less ones, and what it reads from the host's message
 * is read once, as own properties. It inserts no node. It shares the realm with the content, which
 * can read the labels, rewrite or hide them, or draw a lookalike: a label is never a trust signal.
 */
export const LINKS_RUNTIME = String.raw`if (declared("linkLabels")) {
    (() => {
      const LIMIT = { labels: 500, href: 2048, text: 300 };
      const M = { label: "porthole/links.label" };
      const TAG = "data-porthole-label";
      const SELECTOR = "a[href],area[href]";
      // The DOM's own functions, taken before content runs and called only through callOf (P129).
      const setterOf = (proto, name) => {
        const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined;
        return descriptor && typeof descriptor.set === "function" ? descriptor.set : null;
      };
      const nodeValueOf = getterOf(Node.prototype, "nodeValue");
      const nodeValueTo = setterOf(Node.prototype, "nodeValue");
      const setAttributeOn = Element.prototype.setAttribute;
      const removeAttributeOn = Element.prototype.removeAttribute;
      const takeRecordsIn = MutationObserver.prototype.takeRecords;
      const messageDataOf = getterOf(MessageEvent.prototype, "data");
      const messageOriginOf = getterOf(MessageEvent.prototype, "origin");
      const messageSourceOf = getterOf(MessageEvent.prototype, "source");
      const isList = Array.isArray;
      const Written = WeakMap;
      const timeoutIn = window.setTimeout;
      const clearTimeoutIn = window.clearTimeout;
      const later = (run, wait) => callOf(timeoutIn, window, [run, wait]);
      const cancelLater = (timer) => callOf(clearTimeoutIn, window, [timer]);
      const clock = Date.now;
      const time = () => callOf(clock, Date, []);
      const lesser = (a, b) => (a < b ? a : b);
      const greater = (a, b) => (a > b ? a : b);
      // Read once: content can replace window.parent (it is [Replaceable]), never what was read.
      const parentWindow = window.parent;
      // Through the platform's getter, taken now; where an engine has none there, as the object says.
      const get = (getter, target, name) => (getter === null ? target[name] : callOf(getter, target, []));
      // An own property of what the host sent, read once, never one from a prototype content filled.
      const own = (object, name) => (object !== null && typeof object === "object" && callOf(hasOwn, object, [name]) ? object[name] : undefined);
      const isBare = ${LINK_BARE};
      const labelsOf = ${LINK_LABELS_OF};

      // A text node's words, through the kept getter; anything but a string is none.
      const wordsOf = (node) => {
        const value = get(nodeValueOf, node, "nodeValue");
        return typeof value === "string" ? value : null;
      };
      const setText = (node, text) => {
        if (nodeValueTo === null) {
          node.nodeValue = text;
        } else {
          callOf(nodeValueTo, node, [text]);
        }
      };
      // A label's words go in as text: the link's own text node takes them, never markup.
      const writeLabel = (link, child, text) => {
        setText(child, text);
      };
      const attributeOf = (element, name) => callOf(getAttributeIn, element, [name]);

      // The labels shown, by address; whether there are any.
      let table = bare(null);
      let labelled = false;
      // What this runtime wrote: each text node's ({ node, was, wrote, live, seen }) and each tag
      // ({ element, tag, live, seen }), found again by node through the kept WeakMap's methods.
      let written = listOf();
      let tagged = listOf();
      const writtenOf = new Written();
      const taggedOf = new Written();
      let pass = 0;

      const apply = () => {
        pass += 1;
        const nextWritten = listOf();
        const nextTagged = listOf();
        const links = labelled ? callOf(queryAllDocument, document, [SELECTOR]) : null;
        const count = links === null ? 0 : countOf(links);
        for (let i = 0; i < count; i += 1) {
          const link = links[i];
          try {
            // HTML links only (an SVG one draws no text node of its own).
            if (namespaceOf !== null && callOf(namespaceOf, link, []) !== XHTML) {
              continue;
            }
            const raw = attributeOf(link, "href");
            if (typeof raw !== "string") {
              continue;
            }
            let resolved = null;
            try {
              resolved = resolveHere(raw);
            } catch (_) {
              continue;
            }
            const label = typeof resolved === "string" ? table[resolved] : undefined;
            if (label === undefined) {
              continue;
            }
            if (label.tag !== null) {
              if (attributeOf(link, TAG) !== label.tag) {
                callOf(setAttributeOn, link, [TAG, label.tag]);
              }
              const mark = callOf(weakMapGet, taggedOf, [link]);
              const entry = mark !== undefined && mark.live ? mark : { element: link, tag: label.tag, live: true, seen: 0 };
              entry.tag = label.tag;
              entry.seen = pass;
              callOf(weakMapSet, taggedOf, [link, entry]);
              pushTo(nextTagged, entry);
            }
            const children = get(childNodesOf, link, "childNodes");
            if (countOf(children) !== 1) {
              continue;
            }
            const child = children[0];
            if (typeOf(child) !== 3) {
              continue;
            }
            const now = wordsOf(child);
            if (now === null) {
              continue;
            }
            const known = callOf(weakMapGet, writtenOf, [child]);
            if (known !== undefined && known.live) {
              if (now === known.wrote) {
                // Still the label's words: kept, or the new label's.
                if (known.wrote !== label.text) {
                  writeLabel(link, child, label.text);
                  known.wrote = label.text;
                }
                known.seen = pass;
                pushTo(nextWritten, known);
                continue;
              }
              // The page wrote its own words since: they are its, not a label's.
              known.live = false;
            }
            if (isBare(now, raw, resolved, sliceOf, callOf)) {
              const entry = { node: child, was: now, wrote: label.text, live: true, seen: pass };
              callOf(weakMapSet, writtenOf, [child, entry]);
              writeLabel(link, child, label.text);
              pushTo(nextWritten, entry);
            }
          } catch (_) {}
        }
        // What was labelled and no longer is: its own words back, where the label's are still there.
        for (let i = 0; i < written.length; i += 1) {
          const entry = written[i];
          if (entry.live && entry.seen !== pass) {
            entry.live = false;
            try {
              if (wordsOf(entry.node) === entry.wrote) {
                setText(entry.node, entry.was);
              }
            } catch (_) {}
          }
        }
        for (let i = 0; i < tagged.length; i += 1) {
          const entry = tagged[i];
          if (entry.live && entry.seen !== pass) {
            entry.live = false;
            try {
              if (attributeOf(entry.element, TAG) === entry.tag) {
                callOf(removeAttributeOn, entry.element, [TAG]);
              }
            } catch (_) {}
          }
        }
        written = nextWritten;
        tagged = nextTagged;
        // Its own changes are none of the content's: their records go unread.
        callOf(takeRecordsIn, contentWatch, []);
      };

      // Applied again once a run of changes settles (150 ms quiet), at most a second late.
      let timer = 0;
      let deadline = 0;
      const again = () => {
        timer = 0;
        deadline = 0;
        apply();
      };
      const schedule = () => {
        const now = time();
        if (deadline === 0) {
          deadline = now + 1000;
        }
        cancelLater(timer);
        timer = later(again, greater(0, lesser(150, deadline - now)));
      };
      const contentWatch = new MutationObserver(() => {
        if (labelled || written.length > 0 || tagged.length > 0) {
          schedule();
        }
      });
      callOf(observeIn, contentWatch, [document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href"] }]);

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
        if (data === null || typeof data !== "object" || own(data, "jsonrpc") !== "2.0" || own(data, "method") !== M.label || own(data, "id") !== undefined) {
          return;
        }
        const next = bare(null);
        let kept = 0;
        try {
          kept = labelsOf(own(own(data, "params"), "labels"), own, isList, LIMIT.labels, LIMIT.href, LIMIT.text, next);
        } catch (_) {
          kept = 0;
        }
        // A new set replaces the last whole (none: every link its own words back).
        table = kept > 0 ? next : bare(null);
        labelled = kept > 0;
        cancelLater(timer);
        timer = 0;
        deadline = 0;
        apply();
      });
    })();
  }`;
