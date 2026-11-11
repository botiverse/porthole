import { TEXT_INDEX } from "./text.ts";

/**
 * Which marker a press on the shell's layer is for (P119), spliced into the runtime: the index of
 * `count` boxes (`boxAt(i)`, the markers' own boxes in the viewport, the last drawn on top), or -1.
 * A point on a marker's own box is that marker's (the topmost, as before). With `touch` (the last
 * pointer a finger or a pen), a marker also takes the points of a 44 by 44 CSS px box centred on
 * its own (its own size where it is larger): where those overlap, the marker whose own box's
 * centre is nearest the point. No built-in is called (content may have patched them).
 */
export const MARKER_HIT = String.raw`(count, boxAt, x, y, touch) => {
        const TARGET = 44;
        let best = -1;
        let nearest = 0;
        for (let i = count - 1; i >= 0; i -= 1) {
          const rect = boxAt(i);
          if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
            return i;
          }
          if (touch) {
            const dx = x - (rect.x + rect.width / 2);
            const dy = y - (rect.y + rect.height / 2);
            const halfWidth = (rect.width > TARGET ? rect.width : TARGET) / 2;
            const halfHeight = (rect.height > TARGET ? rect.height : TARGET) / 2;
            if (dx >= -halfWidth && dx <= halfWidth && dy >= -halfHeight && dy <= halfHeight) {
              const distance = dx * dx + dy * dy;
              if (best === -1 || distance < nearest) {
                best = i;
                nearest = distance;
              }
            }
          }
        }
        return best;
      }`;

/**
 * What a marker is called (P133, P134), to whoever can't see it, spliced into the runtime: what it
 * is, and the words it is on, in quotes. In English, whatever the page's language: the shell has no
 * words of the host's. `anchor.label` stays as the host stores it (it is the host's to show): an
 * element's starts with its tag (`describe`, "p#intro.lead Words"), so an element's words are its
 * quote, cut where the label's are and marked so, or for one with no text of its own (an image's
 * `alt`) what follows the tag in the label. An element with neither has no words.
 */
export const MARKER_NAME = String.raw`(mark) => {
        const squash = (text) => String(text).replace(/\s+/g, " ").trim();
        const anchor = mark.anchor;
        const label = typeof anchor.label === "string" ? squash(anchor.label).slice(0, 120) : "";
        let words = label;
        if (anchor.kind === "element") {
          const quote = anchor.selectors.filter((each) => each && each.type === "TextQuoteSelector")[0];
          const said = quote && typeof quote.exact === "string" ? squash(quote.exact.slice(0, 300)) : "";
          const space = label.indexOf(" ");
          words = said.length > 40 ? said.slice(0, 40).trim() + "\u2026" : said !== "" ? said : space === -1 ? "" : label.slice(space + 1);
        }
        const what = mark.draft ? "Draft comment" : mark.count === 1 ? "1 comment" : mark.count > 1 ? mark.count + " comments" : "Comment";
        return words === "" ? what : what + ' on "' + words + '"';
      }`;

/**
 * Whether a host's `focusMark` is too old to land unasked (P137): `at` is the host's `Date.now()` as
 * it sent the word, `now` the shell's, kept before content runs. Both read the one wall clock of
 * this machine, the only clock two realms share (`performance.now()` counts from each one's own
 * start). No number is an older host's word, which can't be known fresh. A word from ahead of the
 * clock has the same bound behind it: two processes can read the clock a little apart, and past
 * that the clock was set back, and the age says nothing. Comparisons only, nothing a page can
 * patch, and a word that makes no number (`NaN`, `Infinity`) passes neither test.
 */
export const WORD_LATE = String.raw`(at, now) => {
  if (typeof at !== "number") {
    return true;
  }
  const age = now - at;
  return !(age > -100 && age < 100);
}`;

/**
 * The shell's annotation runtime (P053), spliced into the shell's runtime (`__ANNOTATE__`) when
 * the config declares `annotate`, so it runs before any content does, with the DOM's own
 * functions as they were. Plain ES2020 like the rest of the shell; no template literals (it sits
 * in one).
 *
 * The host drives it (`porthole/annotate.start|stop|show|focus|clear|track|clearSelection|focusMark`)
 * and it reports (`porthole/annotate.selected|unselected|cancelled|anchored|activated|tracked|selectionTracked`):
 * - picking an element: the element under the pointer (or finger) is outlined with its name; a
 *   click or tap picks it, and the content's own handlers never see that click (unless the content
 *   patched the DOM's built-ins, P105); Escape cancels (while selecting text too, P112);
 * - selecting text: each selection that settles is reported, with where it is, and its clearing;
 *   the host's `clearSelection` (P115) takes the page's selection away and tells nothing back;
 * - marks: each anchor is found in the content as it is now (its CSS selector, its text where it
 *   was, its text anywhere, its words with any spacing) and drawn over it, in a layer of the
 *   shell's own (a closed shadow root), again whenever the content changes; what can't be found
 *   is reported `orphaned`;
 * - markers (P104): a mark with a count gets a small button with the number, a bubble: a text
 *   anchor's at its paragraph's end (P133), a draft's (P107) beside its anchor's last line (P105:
 *   in the line's gutter), an element's on its corner; a click on it, or Enter or Space with the
 *   focus on it (P133), is reported (`activated`), and the content's own handlers never see it; a
 *   draft is drawn apart, a dashed line and a hollow bubble with no number, and has a marker with
 *   or without a count; the host's `focusMark` (P134) puts the focus on a marker that is there, and
 *   tells nothing back; one that had to wait for the marks (P135), or that this document took late
 *   (P137), lands only if the focus is in this document by then;
 * - following: while a mark has a marker, once a scroll, a resize or a change of the content
 *   settles, the marks that moved since the host was last told are reported, at most once a
 *   second, so the host's own UI beside a mark can follow;
 * - places in the document (P132): each result's box also in the document's coordinates
 *   (`documentRect`), with how far the document was scrolled as it was read (`scroll`), and the
 *   followed mark's (`tracked`) too, so a host places marks scrolled out of the frame, and keeps
 *   them placed as the document scrolls, from one report and the followed mark's scroll;
 * - the last line (P133): where a selection or a mark's words end, in the document's coordinates
 *   too (`lastLineDocumentRect`), so a host places its UI after them;
 * - the selection followed (P138): what the last `selected` reported (the element picked, or the
 *   words selected) is kept while the host follows the selection (`track` with `selection`) or said
 *   at `start` that it will (`keepSelection`, P140), and nothing is kept otherwise; while followed
 *   it is drawn in the layer and its boxes are reported as a followed mark's are
 *   (`selectionTracked`), with whether it is in view, or that it is gone; it takes no pointer, no
 *   focus and no key.
 *
 * It shares the realm with the content, which can interfere with all of it: the host takes its
 * reports as UI hints only.
 */
export const ANNOTATE_RUNTIME = String.raw`if (declared("annotate")) {
    (() => {
      const LIMIT = { exact: 4000, quote: 300, context: 32, label: 120, css: 1000, marks: 500, boxes: 200, count: 999 };
      const M = {
        start: "porthole/annotate.start",
        stop: "porthole/annotate.stop",
        show: "porthole/annotate.show",
        focus: "porthole/annotate.focus",
        clear: "porthole/annotate.clear",
        selected: "porthole/annotate.selected",
        unselected: "porthole/annotate.unselected",
        cancelled: "porthole/annotate.cancelled",
        anchored: "porthole/annotate.anchored",
        activated: "porthole/annotate.activated",
        track: "porthole/annotate.track",
        tracked: "porthole/annotate.tracked",
        selectionTracked: "porthole/annotate.selectionTracked",
        clearSelection: "porthole/annotate.clearSelection",
        focusMark: "porthole/annotate.focusMark",
      };
      // The DOM's own functions, taken before content runs.
      const elementFromPoint = Document.prototype.elementFromPoint;
      const querySelector = Document.prototype.querySelector;
      const createRange = Document.prototype.createRange;
      const createTreeWalker = Document.prototype.createTreeWalker;
      const createElement = Document.prototype.createElement;
      const createElementNS = Document.prototype.createElementNS;
      const selectionOf = Document.prototype.getSelection;
      const removeAllRanges = Selection.prototype.removeAllRanges;
      const focusElement = HTMLElement.prototype.focus;
      const hasFocus = Document.prototype.hasFocus;
      const wallClock = Date.now;
      const elementRect = Element.prototype.getBoundingClientRect;
      const rangeRect = Range.prototype.getBoundingClientRect;
      const rangeRects = Range.prototype.getClientRects;
      const cloneRange = Range.prototype.cloneRange;
      const setStart = Range.prototype.setStart;
      const setStartBefore = Range.prototype.setStartBefore;
      const compareBoundaryPoints = Range.prototype.compareBoundaryPoints;
      const attachShadow = Element.prototype.attachShadow;
      const getAttribute = Element.prototype.getAttribute;
      const listenOn = EventTarget.prototype.addEventListener;
      const post = window.parent.postMessage.bind(window.parent);
      // Read once: content can replace window.parent (it is [Replaceable]), never what was read. A
      // hostless plan (P143) tells no parent anything.
      const framed = window.parent !== window && !hostless;
      const tell = (method, params) => {
        if (framed) {
          post({ jsonrpc: "2.0", method, params }, "*");
        }
      };
      const squash = (text) => String(text).replace(/\s+/g, " ").trim();
      const box = (rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });

      ${TEXT_INDEX}
      const spanOf = (index, node) => {
        const range = createRange.call(document);
        range.selectNodeContents(node);
        return [offsetOf(index, range.startContainer, range.startOffset), offsetOf(index, range.endContainer, range.endOffset)];
      };

      // A CSS selector that matches this element and no other: from the nearest id, else the body.
      const escape = typeof CSS === "object" && CSS !== null && typeof CSS.escape === "function" ? CSS.escape : (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (each) => "\\" + each);
      const only = (selector, element) => {
        try {
          return querySelector.call(document, selector) === element;
        } catch (_) {
          return false;
        }
      };
      const cssPath = (element) => {
        const steps = [];
        for (let node = element; node !== null && node.nodeType === 1 && steps.length < 16; node = node.parentElement) {
          if (node.id && only("#" + escape(node.id), node)) {
            steps.unshift("#" + escape(node.id));
            break;
          }
          if (node.localName === "body" || node.localName === "html") {
            steps.unshift(node.localName);
            break;
          }
          let step = escape(node.localName);
          const parent = node.parentElement;
          if (parent !== null) {
            const same = Array.from(parent.children).filter((child) => child.localName === node.localName);
            if (same.length > 1) {
              step += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
            }
          }
          steps.unshift(step);
        }
        const selector = steps.join(" > ");
        return selector.length <= LIMIT.css && only(selector, element) ? selector : null;
      };
      const describe = (element) => {
        let name = element.localName + (element.id ? "#" + element.id : "");
        const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
        for (const each of classes) {
          name += "." + each;
        }
        // An element without words (an image, an icon button, a chart) is named by what it says it is.
        let words = squash(element.textContent || "");
        for (const attribute of ["alt", "aria-label", "title"]) {
          if (words) break;
          words = squash(getAttribute.call(element, attribute) || "");
        }
        words = words.slice(0, 40);
        return (words ? name + " " + words : name).slice(0, LIMIT.label);
      };
      const quoteOf = (index, start, end) => {
        const quote = { type: "TextQuoteSelector", exact: index.text.slice(start, end) };
        const prefix = index.text.slice(Math.max(0, start - LIMIT.context), start);
        const suffix = index.text.slice(end, end + LIMIT.context);
        if (prefix) {
          quote.prefix = prefix;
        }
        if (suffix) {
          quote.suffix = suffix;
        }
        return quote;
      };
      const elementAnchor = (element, index) => {
        const selectors = [];
        const css = cssPath(element);
        if (css !== null) {
          selectors.push({ type: "CssSelector", value: css });
        }
        const span = spanOf(index, element);
        const end = Math.min(span[1], span[0] + LIMIT.quote);
        if (index.text.slice(span[0], end).trim() !== "") {
          selectors.push(quoteOf(index, span[0], end), { type: "TextPositionSelector", start: span[0], end });
        }
        return selectors.length === 0 ? null : { kind: "element", selectors, label: describe(element) };
      };
      const textAnchor = (range, index) => {
        const start = offsetOf(index, range.startContainer, range.startOffset);
        const end = Math.min(offsetOf(index, range.endContainer, range.endOffset), start + LIMIT.exact);
        const exact = index.text.slice(start, end);
        if (exact.trim() === "") {
          return null;
        }
        const selectors = [quoteOf(index, start, end), { type: "TextPositionSelector", start, end }];
        let container = range.commonAncestorContainer;
        if (container.nodeType !== 1) {
          container = container.parentElement;
        }
        const css = container !== null && container !== document.body ? cssPath(container) : null;
        if (css !== null) {
          selectors.push({ type: "CssSelector", value: css });
        }
        return { kind: "text", selectors, label: squash(exact).slice(0, LIMIT.label) };
      };

      // Finding an anchor again, best-effort: where it was, its words anywhere (the occurrence
      // whose surroundings match best), then its words with any spacing.
      const shared = (a, b, fromEnd) => {
        let n = 0;
        while (n < a.length && n < b.length && (fromEnd ? a.charAt(a.length - 1 - n) === b.charAt(b.length - 1 - n) : a.charAt(n) === b.charAt(n))) {
          n += 1;
        }
        return n;
      };
      const locate = (index, quote, position) => {
        const text = index.text;
        const length = quote.exact.length;
        if (position && text.slice(position.start, position.start + length) === quote.exact) {
          return [position.start, position.start + length];
        }
        let best = null;
        let bestScore = -1;
        let seen = 0;
        for (let at = text.indexOf(quote.exact); at !== -1 && seen < 1000; at = text.indexOf(quote.exact, at + 1)) {
          seen += 1;
          const score =
            shared(text.slice(Math.max(0, at - LIMIT.context), at), quote.prefix || "", true) +
            shared(text.slice(at + length, at + length + LIMIT.context), quote.suffix || "", false) -
            (position ? Math.min(1, Math.abs(at - position.start) / 1e6) : 0);
          if (score > bestScore) {
            bestScore = score;
            best = [at, at + length];
          }
        }
        if (best !== null) {
          return best;
        }
        const wanted = squash(quote.exact);
        if (wanted === "") {
          return null;
        }
        const map = [];
        let loose = "";
        let space = false;
        for (let i = 0; i < text.length; i += 1) {
          const each = text.charAt(i);
          if (/\s/.test(each)) {
            if (!space && loose !== "") {
              loose += " ";
              map.push(i);
            }
            space = true;
          } else {
            loose += each;
            map.push(i);
            space = false;
          }
        }
        const at = loose.indexOf(wanted);
        return at === -1 ? null : [map[at], map[at + wanted.length - 1] + 1];
      };
      const find = (anchor, index) => {
        const of = (type) => anchor.selectors.filter((each) => each && each.type === type)[0];
        const css = of("CssSelector");
        const quote = of("TextQuoteSelector");
        const position = of("TextPositionSelector");
        if (anchor.kind === "text") {
          const span = quote ? locate(index, quote, position) : null;
          const range = span === null ? null : rangeAt(index, span[0], span[1]);
          return range === null ? null : { range };
        }
        let element = null;
        if (css && typeof css.value === "string") {
          try {
            element = querySelector.call(document, css.value);
          } catch (_) {
            element = null;
          }
        }
        if (element !== null && quote) {
          const span = spanOf(index, element);
          if (index.text.slice(span[0], span[1]).indexOf(quote.exact) === 0) {
            return { element };
          }
        }
        // Without words to check, or by an id, the selector is enough.
        if (element !== null && (!quote || css.value.charAt(0) === "#")) {
          return { element };
        }
        const span = quote ? locate(index, quote, position) : null;
        const range = span === null ? null : rangeAt(index, span[0], span[1]);
        if (range !== null) {
          let node = range.commonAncestorContainer;
          if (node.nodeType !== 1) {
            node = node.parentElement;
          }
          if (node !== null) {
            return { element: node };
          }
        }
        return null;
      };
      const rectOf = (found) => (found.range ? rangeRect.call(found.range) : elementRect.call(found.element));
      // How far the document is scrolled (P132): the top left of its root's box from the
      // viewport's, negated, read with the DOM's own getBoundingClientRect (taken before content
      // runs), never window.scrollY, which the content can replace. 0 - n: no -0 for a top at 0.
      const scrollOf = () => {
        const root = document.documentElement;
        if (!root) {
          return { x: 0, y: 0 };
        }
        const rect = elementRect.call(root);
        return { x: 0 - rect.left, y: 0 - rect.top };
      };
      // A box in the viewport, in the document (P132): where it is as the document scrolls.
      const inDocument = (rect, scroll) => ({ x: rect.x + scroll.x, y: rect.y + scroll.y, width: rect.width, height: rect.height });
      // Where what was found ends (P133), in the document as a documentRect is: its last line with
      // words on it, or an element's whole box (it has no lines of its own). Null with nothing drawn.
      const lastLineOf = (found, scroll) => {
        const rect = found.range ? lastBox(rangeRects.call(found.range)) : elementRect.call(found.element);
        return rect === null ? null : inDocument(box(rect), scroll);
      };
      // What a selection's report adds to its box (P133): its last line, with the scroll it was
      // read at; neither where nothing of it is drawn.
      const placeOf = (found) => {
        const scroll = scrollOf();
        const lastLineDocumentRect = lastLineOf(found, scroll);
        return lastLineDocumentRect === null ? {} : { lastLineDocumentRect, scroll };
      };

      // The shell's own layer, over the content: marks, the outline of what would be picked.
      let layer = null;
      let shadow = null;
      // Marks lie over the content's text, so their fill is light (the text under them keeps its
      // contrast, on a light page and a dark one alike) and an underline or outline says where
      // they are; the active one and a flash add a ring around it, not more fill over its words.
      // An element's mark with a marker is quieter (a thin line): the marker says what it is.
      // A marker is a small bubble with a number, drawn in its own colors and font (only what the
      // layer inherits from the page could reach it, so each of those is set here). A draft
      // (P107) is a comment not yet posted: its line is dashed (an element's outline too) and its
      // marker hollow, a light bubble with a dashed edge and the glyph's outline, no number.
      // While the last pointer was a finger or a pen (P119), each marker takes the pointer in a
      // box of at least 44 by 44 px centred on its own (an invisible ::before; 100% is its padding
      // box, its border 1 px), so a tap a few px off still lands on the shell's layer. A marker is
      // a real button (P133): what a browser gives one is taken off, a ring says it has the focus.
      // The selection the host follows (P138) is drawn as what is picked is: an element in the
      // picking outline, a little lighter and without its name; words with a light fill and a line
      // under them, in the same blue, apart from the marks' yellow (no comment is there yet).
      const STYLE = ".mark{position:absolute;border-radius:2px;background:rgba(250,204,21,.18);box-shadow:inset 0 -2px 0 rgba(234,179,8,.95)}.mark.element{background:rgba(250,204,21,.07);box-shadow:none;outline:2px solid rgba(234,179,8,.9);outline-offset:1px}.mark.active{background:rgba(250,204,21,.26);box-shadow:inset 0 -3px 0 rgb(234,179,8),0 0 0 2px rgba(234,179,8,.45)}.mark.element.active{background:rgba(250,204,21,.12);box-shadow:none;outline-width:3px}.mark.element.quiet{background:rgba(250,204,21,.05);outline:1px solid rgba(234,179,8,.6);outline-offset:2px}.mark.element.quiet.active{background:rgba(250,204,21,.1);outline:2px solid rgba(234,179,8,.9)}.mark.draft{box-sizing:border-box;background:rgba(250,204,21,.08);box-shadow:none;border-bottom:2px dashed rgba(202,138,4,.95)}.mark.draft.active{background:rgba(250,204,21,.16);box-shadow:0 0 0 2px rgba(234,179,8,.45);border-bottom-width:3px}.mark.element.draft{background:rgba(250,204,21,.04);border-bottom:0;outline-style:dashed}.mark.element.draft.active{background:rgba(250,204,21,.08);box-shadow:none;outline-style:dashed}.marker{position:absolute;box-sizing:border-box;height:18px;min-width:18px;display:flex;align-items:center;justify-content:center;gap:3px;margin:0;padding:0 5px;border:1px solid rgba(161,98,7,.6);border-radius:9px 9px 9px 2px;background:#fde68a;color:#422006;box-shadow:0 1px 2px rgba(0,0,0,.3);font:600 11px/16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-style:normal;letter-spacing:0;word-spacing:0;text-transform:none;text-indent:0;text-shadow:none;direction:ltr;writing-mode:horizontal-tb;white-space:nowrap;user-select:none;-webkit-user-select:none;cursor:pointer;pointer-events:auto;appearance:none;-webkit-appearance:none}.marker:focus-visible{outline:2px solid #2563eb;outline-offset:1px}.marker:hover{background:#fcd34d}.marker.active{background:#facc15;box-shadow:0 0 0 2px rgba(234,179,8,.55),0 1px 2px rgba(0,0,0,.3)}.marker.compact{padding:0 4px}.marker.draft{border:1px dashed rgb(202,138,4);background:#fffdf5;color:#a16207;box-shadow:0 1px 2px rgba(0,0,0,.2)}.marker.draft:hover{background:#fef9e7}.marker.draft.active{background:#fef3c7;box-shadow:0 0 0 2px rgba(234,179,8,.55),0 1px 2px rgba(0,0,0,.2)}.marker.inert,[data-placing]>.marker{pointer-events:none}.touch>.marker::before{content:'';position:absolute;left:50%;top:50%;width:max(100% + 2px,44px);height:max(100% + 2px,44px);transform:translate(-50%,-50%)}.marker svg{display:block;width:11px;height:11px;flex:none}.mark.flash{animation:flash 1.8s ease-out}@keyframes flash{from{box-shadow:inset 0 -3px 0 rgb(234,179,8),0 0 0 6px rgba(250,204,21,.6)}}.hover{position:absolute;outline:2px solid #2563eb;outline-offset:1px;background:rgba(37,99,235,.12)}.held{position:absolute;outline:2px solid #2563eb;outline-offset:1px;background:rgba(37,99,235,.06)}.held.text{outline:0;border-radius:2px;background:rgba(37,99,235,.12);box-shadow:inset 0 -2px 0 #2563eb}.tag{position:absolute;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 6px;border-radius:4px;background:#1e293b;color:#fff}.ride{position:absolute;left:0;top:0;width:0;height:0}@supports (animation-timeline:scroll()){.ride{animation:ride 1ms linear both;animation-timeline:scroll(root y)}@keyframes ride{to{transform:translateY(calc(-1px*var(--ride)))}}}";
      // The marks ride the document's own scroll (P147). The layer stays fixed and clipped to the
      // viewport, so it adds nothing to what the page can scroll; inside it one box holds every
      // mark, marker and outline at its place in the document (its top plus how far the document
      // is scrolled), and a scroll-driven animation moves that box up by the scroll. The engine
      // runs it with the scroll itself, so a mark is where its words are in every frame, not a
      // frame behind (a scroll event is heard after the frame it scrolled). Down the page only:
      // sideways, and where the engine has no scroll timeline (ridden: 0), a mark is placed in the
      // viewport and follows from the scroll event as before. Read with the DOM's own getters,
      // taken before content runs; the range is what the timeline runs over (0: it is inactive,
      // and nothing moves).
      const rides = typeof CSS === "object" && CSS !== null && typeof CSS.supports === "function" && CSS.supports("animation-timeline: scroll()");
      const scrollerOf = getterOf(Document.prototype, "scrollingElement");
      const scrollTopOf = getterOf(Element.prototype, "scrollTop");
      const scrollHeightOf = getterOf(Element.prototype, "scrollHeight");
      const clientHeightOf = getterOf(Element.prototype, "clientHeight");
      // How far down the document is scrolled as the marks are drawn, and how far it can be.
      let ridden = 0;
      const rideOf = () => {
        const none = { by: 0, range: 0 };
        if (!rides || scrollerOf === null || scrollTopOf === null || scrollHeightOf === null || clientHeightOf === null) {
          return none;
        }
        const scroller = callOf(scrollerOf, document, []);
        if (!scroller) {
          return none;
        }
        const range = callOf(scrollHeightOf, scroller, []) - callOf(clientHeightOf, scroller, []);
        const by = callOf(scrollTopOf, scroller, []);
        return range > 0 && by >= 0 && by <= range + 1 ? { by, range } : none;
      };
      // Inline and important: the content's own style sheets can't hide, shrink or move it by
      // accident. Set again at each draw, since its scripts can rewrite it (narrowing only: the
      // content can still cover the layer, or move it with its ancestors, P104). Clipped, where an
      // engine has it, not hidden: hidden is a box a focused marker out of view would scroll (P133).
      const LAYER_STYLE = "position:fixed!important;inset:0!important;width:auto!important;height:auto!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:none!important;z-index:2147483647!important;overflow:hidden!important;overflow:clip!important;margin:0!important;padding:0!important;border:0!important;background:none!important;transform:none!important;scale:none!important;translate:none!important;rotate:none!important;zoom:1!important;clip-path:none!important;mask:none!important;filter:none!important;content-visibility:visible!important;contain:none!important";
      const ensureLayer = () => {
        if (layer === null) {
          layer = createElement.call(document, "div");
          layer.setAttribute("data-porthole-annotations", "");
          shadow = attachShadow.call(layer, { mode: "closed" });
          // Within the shadow root: a focus moving from one marker to the next never leaves it.
          callOf(listenOn, shadow, ["focusin", onMarkerFocus]);
          callOf(listenOn, shadow, ["focusout", onMarkerFocus]);
        }
        if (layer.style.cssText !== LAYER_STYLE) {
          layer.style.cssText = LAYER_STYLE;
        }
        if (!layer.isConnected) {
          document.documentElement.appendChild(layer);
        }
        return shadow;
      };

      let mode = { elements: false, text: false, hold: false };
      let hover = null;
      // The selection last reported as selected (P138): its anchor, and what it is in the page (the
      // element picked, or a copy of the selection's range, which the page's changes keep up to
      // date and which stays when the page's own selection goes). Followed while the host asks
      // (track with selection), and drawn then. Each new selected replaces it. Kept only while the
      // host follows the selection, or said at its last start that it will (keepSelection, P140):
      // for any other host nothing is kept, as before P138.
      let held = null;
      let followingSelection = false;
      let keeping = false;
      const keeps = () => followingSelection || keeping;
      // What the host was last told of it: "attached", "orphaned", or null (nothing yet).
      let heldTold = null;
      const heldGone = (found) => (found.range ? found.range.collapsed || !found.range.startContainer.isConnected : !found.element.isConnected);
      const heldShown = () => followingSelection && held !== null && heldTold !== "orphaned" && !heldGone(held.found);
      // The element just picked (P138, Tenny's review): for a host that will follow it
      // (keepSelection, P140), it keeps its outline after selected, so there is no gap before the
      // host follows it, and the follow's highlight takes over where it does. For any other host
      // the outline goes with the pick, as before P138. Until the follow comes it ends as a
      // selection does: the next pick or selection, the host's clearSelection, a mode started or
      // stopped, clear, Escape, or the element leaving the page. Not unselected: a selection made
      // after the pick has already ended it as it was reported, so the one unselected can clear is
      // one from before, which the pick's own click takes away when text is selected too.
      let picked = null;
      const endPick = () => {
        if (picked !== null) {
          picked = null;
          redraw();
        }
      };
      const pickShown = () => picked !== null && !followingSelection && picked.isConnected;
      let marks = [];
      // The markers as last drawn, for a click to find: { id, element }. Each mark keeps its
      // marker's node across draws, so a press that spans a redraw ends on the node it began on.
      let markers = [];
      const markerNodes = new Map();
      // Whether the last pointer was a finger or a pen (P119): then each marker takes the pointer
      // in a 44 px box around it (the markers' box has the class "touch"). Until a pointer is
      // seen, whether the device has a coarse pointer at all (a phone, a tablet, a laptop with a
      // touch screen): a mouse moves before it presses, and its first move turns it off.
      const coarseQuery = typeof window.matchMedia === "function" ? window.matchMedia("(any-pointer: coarse)") : null;
      let touch = coarseQuery !== null && coarseQuery.matches === true;
      const markerHit = ${MARKER_HIT};
      const MARKER_HEIGHT = 18;
      const SVG = "http://www.w3.org/2000/svg";
      const labelOf = (count) => (count === 0 ? "" : count > 99 ? "99+" : String(count));
      // Its size, near enough to place it: the padding and the glyph, then the number.
      const markerWidth = (label) => Math.max(MARKER_HEIGHT, 23 + (label === "" ? 0 : 3 + label.length * 7));
      // Compact (P105): the number alone, or the glyph alone for none, with less padding.
      const compactWidth = (label) => (label === "" ? 21 : Math.max(MARKER_HEIGHT, 10 + label.length * 7));
      const nameOf = ${MARKER_NAME};
      // A rect's last line with words on it: its last box with a width, else any with a size.
      const lastBox = (rects) => {
        let any = null;
        for (let i = rects.length - 1; i >= 0; i -= 1) {
          if (rects[i].width > 0) {
            return rects[i];
          }
          if (any === null && rects[i].height > 0) {
            any = rects[i];
          }
        }
        return any;
      };
      // Where a text anchor's marker goes (P105, #36). At its words' end, raised (0.9), it lay over
      // the first letters of the next word, or between two lines. Now it sits beside the anchor's
      // last line, centred on it, clear of that line's words, and over nothing of the content's but
      // the background of a box holding the anchor, with nothing else between it and the words:
      // in the line's gutter, just past the right edge of the anchor's block (its content box);
      // where the frame is too narrow for that (text that runs to the frame's edges), at the
      // frame's right edge; where something else is beside the block (a table's next cell, a card
      // in a row of them), just past the line's last word. Markers on one line of one block go
      // together, in the order their words end. Where the bubble with its glyph fits in none of
      // these, the number alone does (compact); where that fits in none either (a full line on a
      // narrow screen), it goes as far right as it can, over the line's end. A posted comment's
      // marker (P133) is placed the same way on its paragraph's last line instead, where nothing
      // follows its words, and first tries just past that line's last word.
      const computedOf = window.getComputedStyle;
      const elementsAt = Document.prototype.elementsFromPoint;
      const containsOf = Node.prototype.contains;
      const INLINE = /^(inline|contents|none|ruby|table-(row|column|header|footer))/;
      const blockOf = (range) => {
        let node = range.endContainer;
        if (node.nodeType !== 1) {
          node = node.parentElement;
        }
        while (node !== null && node !== document.body && node !== document.documentElement && INLINE.test(computedOf.call(window, node).display)) {
          node = node.parentElement;
        }
        return node === null || node === document.documentElement ? document.body : node;
      };
      // The right edge of its content box: past it is the block's padding, then what is beside it.
      const contentRight = (block) => {
        const style = computedOf.call(window, block);
        return elementRect.call(block).right - (parseFloat(style.borderRightWidth) || 0) - (parseFloat(style.paddingRight) || 0);
      };
      // How far the words reach on the anchor's last line (at), in its block: at least its own.
      // Read forward from the anchor's end, 64 characters at a time, only until the text leaves
      // that line (P105: the whole rest of a long block, for each marker, cost 100 ms and more).
      const lineEnd = (range, block, at) => {
        let end = at.right;
        let node = range.endContainer;
        if (node.nodeType !== 3) {
          return end;
        }
        const middle = at.top + at.height / 2;
        const walker = createTreeWalker.call(document, block, NodeFilter.SHOW_TEXT);
        walker.currentNode = node;
        const piece = createRange.call(document);
        let from = range.endOffset;
        for (let pieces = 0; node !== null && pieces < 64; pieces += 1) {
          const length = node.nodeValue.length;
          if (from >= length) {
            node = walker.nextNode();
            from = 0;
            continue;
          }
          const to = Math.min(length, from + 64);
          try {
            piece.setStart(node, from);
            piece.setEnd(node, to);
          } catch (_) {
            return end;
          }
          for (const rect of Array.from(rangeRects.call(piece))) {
            if (rect.top > middle) {
              return end;
            }
            if (rect.width > 0 && rect.bottom >= middle && rect.right > end) {
              end = rect.right;
            }
          }
          from = to;
        }
        return end;
      };
      // The end of the paragraph an anchor ends in (P133): a range over the block's last words
      // that are drawn, from the anchor's end on, as far as a block inside it (a nested list, say:
      // its words are their own paragraph), 256 text nodes at most. Null if none follow the anchor.
      const inBlock = (node, block) => {
        for (let at = node.parentElement; at !== null && at !== block; at = at.parentElement) {
          if (!INLINE.test(computedOf.call(window, at).display)) {
            return false;
          }
        }
        return true;
      };
      const paragraphEnd = (range, block) => {
        const start = range.endContainer;
        if (start.nodeType !== 3) {
          return null;
        }
        const walker = createTreeWalker.call(document, block, NodeFilter.SHOW_TEXT);
        walker.currentNode = start;
        let end = null;
        let node = start;
        for (let pieces = 0; node !== null && pieces < 256; pieces += 1) {
          if (node !== start && !inBlock(node, block)) {
            break;
          }
          const words = node.nodeValue;
          const first = node === start ? range.endOffset : 0;
          let to = words.length;
          while (to > first && /\s/.test(words.charAt(to - 1))) {
            to -= 1;
          }
          if (to > first) {
            const piece = createRange.call(document);
            try {
              piece.setStart(node, Math.max(first, to - 2));
              piece.setEnd(node, to);
            } catch (_) {
              return end;
            }
            if (lastBox(rangeRects.call(piece)) !== null) {
              end = piece;
            }
          }
          node = walker.nextNode();
        }
        return end;
      };
      // Nothing of the content's at a point but a box that holds the block (its background); a
      // point out of view hides nothing.
      const clearAt = (x, y, block) => {
        if (x < 0 || y < 0 || x >= document.documentElement.clientWidth || y >= document.documentElement.clientHeight) {
          return true;
        }
        const hits = elementsAt.call(document, x, y);
        const first = hits[0] === layer ? hits[1] : hits[0];
        return first === undefined || containsOf.call(first, block);
      };
      // Its box: two opposite corners and its middle (the line's middle, up to it, is the path's).
      const clearOver = (left, top, width, block) =>
        clearAt(left + width / 2, top + MARKER_HEIGHT / 2, block) && clearAt(left + 1, top + 1, block) && clearAt(left + width - 1, top + MARKER_HEIGHT - 1, block);
      const GAP = 6;
      const NEAR = 3;
      const BETWEEN = 3;
      const EDGE = 2;
      const STEP = 8;
      const overlapping = (placed, left, top, width) => placed.filter((other) => Math.abs(other.top - top) < MARKER_HEIGHT && left < other.left + other.width + BETWEEN && other.left < left + width + BETWEEN)[0];
      // The first place, of those above, where a line's markers fit, or null.
      const placeLine = (line, compact, gap, placed, room) => {
        const block = line.block;
        let width = -BETWEEN;
        for (const each of line.items) {
          width += (compact ? each.small : each.width) + BETWEEN;
        }
        const most = room - EDGE - width;
        const right = Math.max(contentRight(block), line.words);
        // Along the line's middle, past the block, how far nothing stands in the way.
        const reach = (to) => {
          for (let x = right + 1; x < to; x += STEP) {
            if (!clearAt(x, line.middle, block)) {
              return x;
            }
          }
          return to;
        };
        // A place, moved past the markers already there (rightwards; at the frame's edge, leftwards).
        const fits = (left, leftwards) => {
          for (let tries = 0; tries < 20; tries += 1) {
            if (left < line.words + gap || left > most || reach(left + width) < left + width) {
              return null;
            }
            const hit = overlapping(placed, left, line.top, width);
            if (!hit) {
              return clearOver(left, line.top, width, block) ? left : null;
            }
            left = leftwards ? hit.left - BETWEEN - width : hit.left + hit.width + BETWEEN;
          }
          return null;
        };
        const gutter = right + gap;
        // A paragraph's end (P133): just past its last word, where the line leaves the room.
        let left = line.ending ? fits(line.words + gap, false) : null;
        if (left === null) {
          left = fits(gutter, false);
        }
        if (left === null && gutter > most) {
          left = fits(most, true);
        }
        if (left === null) {
          left = fits(line.words + gap, false);
        }
        return left === null ? null : { left, width };
      };
      const placeLines = (wanted, placed, room) => {
        // One line of one block: markers whose last lines share a middle.
        const lines = [];
        // In the order their words end, those at one paragraph's end too.
        wanted.sort((a, b) => a.at.top - b.at.top || a.at.right - b.at.right || a.words.top - b.words.top || a.words.right - b.words.right);
        for (const each of wanted) {
          const middle = each.at.top + each.at.height / 2;
          let line = null;
          for (const one of lines) {
            if (line === null && one.block === each.block && Math.abs(one.middle - middle) < Math.min(one.height, each.at.height) / 2) {
              line = one;
            }
          }
          if (line === null) {
            line = { block: each.block, middle, height: each.at.height, bottom: each.at.bottom, range: each.range, at: each.at, ending: false, items: [] };
            lines.push(line);
          }
          line.items.push(each);
          line.ending = line.ending || each.ending;
          if (each.at.right > line.at.right) {
            line.at = each.at;
            line.range = each.range;
          }
        }
        const seen = document.documentElement.clientHeight || window.innerHeight;
        for (const line of lines) {
          line.top = line.middle - MARKER_HEIGHT / 2;
          // Not cut off at the frame's top while its anchor is in view; with its anchor as it goes.
          if (line.top < 2) {
            line.top = Math.min(2, line.bottom - MARKER_HEIGHT);
          }
          let compact = false;
          let found = null;
          let left;
          if (line.top + MARKER_HEIGHT < 0 || line.top > seen) {
            // Out of view, nothing is measured: it is placed again as it comes into view.
            found = { left: Math.max(EDGE, Math.min(contentRight(line.block) + GAP, room - EDGE - line.items.length * MARKER_HEIGHT)) };
          } else {
            line.words = lineEnd(line.range, line.block, line.at);
            found = placeLine(line, false, GAP, placed, room);
            if (found === null) {
              compact = true;
              found = placeLine(line, true, NEAR, placed, room);
            }
          }
          if (found !== null) {
            left = found.left;
          } else {
            // Over the line's end, as far right as nothing else stands in the way.
            let width = -BETWEEN;
            for (const each of line.items) {
              width += each.small + BETWEEN;
            }
            let limit = room - EDGE;
            const right = Math.max(contentRight(line.block), line.words);
            for (let x = right + 1; x < limit; x += STEP) {
              if (!clearAt(x, line.middle, line.block)) {
                limit = x - NEAR;
              }
            }
            left = Math.max(EDGE, Math.min(room - EDGE, limit) - width);
          }
          for (const each of line.items) {
            each.compact = compact;
            each.left = left;
            each.top = line.top;
            const width = compact ? each.small : each.width;
            placed.push({ left, top: line.top, width });
            left += width + BETWEEN;
          }
        }
      };
      // An element's marker: on its top right corner, inside the frame's width, beside another.
      const placeCorner = (each, placed, room) => {
        let left = each.at.right - each.width / 2;
        let top = each.at.top - MARKER_HEIGHT / 2;
        if (top < 2) {
          top = Math.min(2, each.at.bottom - MARKER_HEIGHT);
        }
        for (let tries = 0; tries < 20; tries += 1) {
          const hit = overlapping(placed, left, top, each.width);
          if (!hit) {
            break;
          }
          left = hit.left + hit.width + BETWEEN;
        }
        each.left = Math.max(EDGE, Math.min(left, room - each.width - EDGE));
        each.top = top;
        placed.push({ left: each.left, top, width: each.width });
      };
      // The marker's node, kept across draws for its mark, where it was placed.
      const markerOf = (each) => {
        const mark = each.mark;
        const label = each.label;
        const kept = markerNodes.get(mark.id);
        let marker = kept ? kept.element : null;
        if (marker === null) {
          // A real button (P133): the keyboard reaches it, Enter and Space click it, assistive
          // technology names it, and WebKit makes a tap a click on it (P105).
          marker = createElement.call(document, "button");
          marker.setAttribute("type", "button");
        }
        // Stepped aside while elements are picked, from the keyboard too. Set, not left to the
        // button: Safari's Tab skips a button without one, unless the person asked otherwise.
        marker.tabIndex = mode.elements ? -1 : 0;
        marker.className = "marker" + (mark.draft ? " draft" : "") + (each.compact ? " compact" : "") + (mark.id === active ? " active" : "") + (mode.elements ? " inert" : "");
        marker.style.cssText = "left:" + each.left + "px;top:" + (each.top + ridden) + "px";
        markers.push({ id: mark.id, element: marker });
        const name = nameOf(mark);
        const form = (mark.draft ? "draft:" : "") + (each.compact ? "compact:" : "full:") + label + ":" + name;
        if (kept && kept.form === form) {
          return marker;
        }
        markerNodes.set(mark.id, { element: marker, form });
        marker.setAttribute("aria-label", name);
        marker.replaceChildren();
        if (!each.compact || label === "") {
          const glyph = createElementNS.call(document, SVG, "svg");
          glyph.setAttribute("viewBox", "0 0 16 16");
          glyph.setAttribute("aria-hidden", "true");
          const path = createElementNS.call(document, SVG, "path");
          // A draft's glyph is its outline (P107), a posted one's filled.
          if (mark.draft) {
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", "currentColor");
            path.setAttribute("stroke-width", "1.5");
            path.setAttribute("stroke-linejoin", "round");
          } else {
            path.setAttribute("fill", "currentColor");
          }
          path.setAttribute("d", "M3 2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8l-4 3v-3H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z");
          glyph.appendChild(path);
          marker.appendChild(glyph);
        }
        if (label !== "") {
          const number = createElement.call(document, "span");
          number.textContent = label;
          marker.appendChild(number);
        }
        return marker;
      };
      let active = null;
      // The mark whose marker the pointer is over, or the focus is on (P133): its words are lit as
      // the active mark's are, so a marker in the gutter shows which words it is for (P105).
      let hot = null;
      let flashing = null;
      let flashUntil = 0;
      // The layer's parts: its style, the marks, the markers, the outline while picking. A draw
      // replaces the marks and the outline, and leaves each marker that stays where it is (P105): a
      // marker taken out of the page and put back mid-press loses its click (WebKit, measured once
      // the pointer's arrival on a marker lit its mark and redrew).
      let boxes = null;
      const boxesOf = (root) => {
        if (boxes === null || boxes.style.parentNode !== root || boxes.ride.parentNode !== root || boxes.marks.parentNode !== boxes.ride || boxes.markers.parentNode !== boxes.ride || boxes.hover.parentNode !== boxes.ride) {
          const style = createElement.call(document, "style");
          if (nonce !== "") {
            style.nonce = nonce;
          }
          boxes = { style, ride: createElement.call(document, "div"), marks: createElement.call(document, "div"), markers: createElement.call(document, "div"), hover: createElement.call(document, "div") };
          boxes.ride.className = "ride";
          // Only the markers are for assistive technology (P133): the rest draws what the page
          // already says.
          boxes.marks.setAttribute("aria-hidden", "true");
          boxes.hover.setAttribute("aria-hidden", "true");
          boxes.ride.replaceChildren(boxes.marks, boxes.markers, boxes.hover);
          root.replaceChildren(boxes.style, boxes.ride);
        }
        if (boxes.style.textContent !== STYLE) {
          boxes.style.textContent = STYLE;
        }
        if (boxes.markers.className !== (touch ? "touch" : "")) {
          boxes.markers.className = touch ? "touch" : "";
        }
        return boxes;
      };
      const draw = () => {
        if (marks.length === 0 && hover === null && layer === null && !heldShown() && !pickShown()) {
          return;
        }
        const root = ensureLayer();
        const into = boxesOf(root);
        const parts = [];
        const flashOn = Date.now() < flashUntil;
        // Read with the boxes, in this one task: a place in the document is a box's top in the
        // viewport plus this.
        const ride = rideOf();
        ridden = ride.by;
        // What is measured first, then drawn: no node of the layer changes while the page is read.
        const corners = [];
        const wanted = [];
        const focused = focusedMarker() !== null;
        markers = [];
        for (const mark of marks) {
          if (mark.found === null) {
            continue;
          }
          const rects = mark.found.range ? Array.from(rangeRects.call(mark.found.range)) : [elementRect.call(mark.found.element)];
          for (const rect of rects.slice(0, LIMIT.boxes)) {
            if (rect.width === 0 && rect.height === 0) {
              continue;
            }
            const each = createElement.call(document, "div");
            each.className = "mark " + (mark.found.range ? "text" : "element") + (mark.marker ? " quiet" : "") + (mark.draft ? " draft" : "") + (mark.id === active || mark.id === hot ? " active" : "") + (flashOn && mark.id === flashing ? " flash" : "");
            each.style.cssText = "left:" + rect.left + "px;top:" + (rect.top + ridden) + "px;width:" + rect.width + "px;height:" + rect.height + "px";
            parts.push(each);
          }
          if (mark.marker) {
            const at = lastBox(rects);
            if (at !== null) {
              // A draft's marker has no number (P107).
              const label = mark.draft ? "" : labelOf(mark.count);
              const each = { mark, label, width: markerWidth(label), small: compactWidth(label), compact: false, at, words: at, left: 0, top: 0, ending: false };
              if (mark.found.range) {
                // Kept while it still holds the words (P105): a change elsewhere doesn't move them.
                if (mark.block === undefined || !mark.block.isConnected || !containsOf.call(mark.block, mark.found.range.endContainer)) {
                  mark.block = blockOf(mark.found.range);
                  mark.end = undefined;
                }
                each.range = mark.found.range;
                each.block = mark.block;
                // A posted comment's, at its paragraph's end (P133); read once for what was found,
                // since a block's words can be long. A draft's stays by the words being written on.
                if (!mark.draft) {
                  each.ending = true;
                  if (mark.end === undefined) {
                    mark.end = paragraphEnd(mark.found.range, mark.block);
                  }
                  const last = mark.end === null ? null : lastBox(rangeRects.call(mark.end));
                  if (last !== null) {
                    each.at = last;
                    each.range = mark.end;
                  }
                }
                wanted.push(each);
              } else {
                corners.push(each);
              }
            }
          }
        }
        // Markers go over every mark: elements' on their corners first, then the lines'.
        const room = document.documentElement.clientWidth || window.innerWidth;
        const placed = [];
        for (const each of corners) {
          placeCorner(each, placed, room);
        }
        // The layer's own boxes out of the way while places are hit-tested (P105): each test
        // otherwise walks every mark and marker the last draw left (0.13 ms each, 300 of them).
        // A marker with the focus would lose it out of the display (P133): while the person is on
        // one, the markers only stop taking the pointer, which the tests skip but still walk.
        if (wanted.length > 0) {
          into.marks.style.display = "none";
          if (focused) {
            into.markers.setAttribute("data-placing", "");
          } else {
            into.markers.style.display = "none";
          }
          try {
            placeLines(wanted, placed, room);
          } finally {
            into.marks.style.display = "";
            into.markers.style.display = "";
            into.markers.removeAttribute("data-placing");
          }
        }
        const badges = [];
        for (const each of corners.concat(wanted).sort((a, b) => a.mark.reading - b.mark.reading)) {
          badges.push(markerOf(each));
        }
        for (const id of Array.from(markerNodes.keys())) {
          if (!markers.some((each) => each.id === id)) {
            markerNodes.delete(id);
          }
        }
        const outlines = [];
        // The followed selection (P138), under the picking outline: no pointer, no focus, no name;
        // before the host follows it, the element just picked, drawn the same way.
        if (picked !== null && !picked.isConnected) {
          picked = null;
        }
        const lit = heldShown() ? held.found : pickShown() ? { element: picked } : null;
        if (lit !== null) {
          const rects = lit.range ? Array.from(rangeRects.call(lit.range)).slice(0, LIMIT.boxes) : [elementRect.call(lit.element)];
          for (const rect of rects) {
            if (rect.width === 0 && rect.height === 0) {
              continue;
            }
            const each = createElement.call(document, "div");
            each.className = lit.range ? "held text" : "held";
            each.style.cssText = "left:" + rect.left + "px;top:" + (rect.top + ridden) + "px;width:" + rect.width + "px;height:" + rect.height + "px";
            outlines.push(each);
          }
        }
        if (hover !== null && hover.isConnected) {
          const rect = elementRect.call(hover);
          const outline = createElement.call(document, "div");
          outline.className = "hover";
          outline.style.cssText = "left:" + rect.left + "px;top:" + (rect.top + ridden) + "px;width:" + rect.width + "px;height:" + rect.height + "px";
          const tag = createElement.call(document, "div");
          tag.className = "tag";
          tag.textContent = describe(hover).slice(0, 80);
          tag.style.cssText = "left:" + Math.max(4, rect.left) + "px;top:" + ((rect.top >= 24 ? rect.top - 22 : Math.max(4, rect.bottom + 4)) + ridden) + "px";
          outlines.push(outline, tag);
        }
        // How far the ride goes, for the animation; set only when it changed.
        const range = String(ride.range);
        if (into.ride.style.getPropertyValue("--ride") !== range) {
          into.ride.style.setProperty("--ride", range);
        }
        into.marks.replaceChildren(...parts);
        for (const child of Array.from(into.markers.childNodes)) {
          if (badges.indexOf(child) === -1) {
            into.markers.removeChild(child);
          }
        }
        // In reading order, the Tab key's (P133). A marker that stays in its place isn't touched
        // (a press spans a redraw, above), and none moves while one has the focus: it would lose it.
        badges.forEach((badge, at) => {
          const there = into.markers.childNodes[at] || null;
          if (badge.parentNode !== into.markers || (!focused && there !== badge)) {
            into.markers.insertBefore(badge, focused ? null : there);
          }
        });
        into.hover.replaceChildren(...outlines);
      };
      let drawing = false;
      const redraw = () => {
        if (!drawing) {
          drawing = true;
          requestAnimationFrame(() => {
            drawing = false;
            draw();
          });
        }
      };

      // The mark the host follows (P112): its box at each animation frame where it moved, at most
      // one every 16 ms, read through the platform's own frame clock (taken before content runs).
      const nextFrame = window.requestAnimationFrame.bind(window);
      let tracking = null;
      let trackedBox = null;
      let trackedAt = 0;
      let trackFrame = 0;
      // The followed selection's viewport as last told (P138): a frame made smaller can leave it
      // out of view without moving it.
      let trackedView = null;
      const trackTick = () => {
        trackFrame = 0;
        if (tracking === null && !followingSelection) {
          return;
        }
        if (followingSelection) {
          followHeld();
          trackFrame = nextFrame(trackTick);
          return;
        }
        const mark = marks.find((each) => each.id === tracking);
        if (mark !== undefined && mark.found !== null) {
          const rect = box(rectOf(mark.found));
          const now = performance.now();
          if (apart(trackedBox, rect) && now - trackedAt >= 16) {
            trackedBox = rect;
            trackedAt = now;
            // Its box moves as the document scrolls, inside the frame or not: each one tells the
            // host the scroll, for every mark it places by its place in the document (P132).
            const scroll = scrollOf();
            const lastLineDocumentRect = lastLineOf(mark.found, scroll);
            tell(M.tracked, Object.assign({ id: tracking, rect, documentRect: inDocument(rect, scroll), scroll }, lastLineDocumentRect === null ? {} : { lastLineDocumentRect }));
          }
        }
        trackFrame = nextFrame(trackTick);
      };
      // The followed selection (P138), as a followed mark is, and on its clock: where it is at each
      // animation frame where it moved, or the viewport changed size, with whether any of it is in
      // the viewport; orphaned once while it isn't in the page (a page that took the element out,
      // a re-render, the words gone), found again by its anchor at most twice a second meanwhile.
      // Geometry only: its anchor and words went with selected. Reads boxes, nothing else: no
      // focus, no selection, no listener.
      const followHeld = () => {
        const now = performance.now();
        if (held !== null && heldGone(held.found) && now - held.tried >= 500) {
          held.tried = now;
          let found = null;
          try {
            found = find(held.anchor, textIndex());
          } catch (_) {
            found = null;
          }
          if (found !== null && !heldGone(found)) {
            held.found = found;
          }
        }
        if (held === null || heldGone(held.found)) {
          if (heldTold !== "orphaned") {
            heldTold = "orphaned";
            trackedBox = null;
            tell(M.selectionTracked, { state: "orphaned" });
            redraw();
          }
          return;
        }
        const rect = box(rectOf(held.found));
        const root = document.documentElement;
        const view = { width: root ? root.clientWidth : 0, height: root ? root.clientHeight : 0 };
        const resized = trackedView === null || trackedView.width !== view.width || trackedView.height !== view.height;
        if ((heldTold !== "attached" || resized || apart(trackedBox, rect)) && now - trackedAt >= 16) {
          heldTold = "attached";
          trackedBox = rect;
          trackedView = view;
          trackedAt = now;
          const scroll = scrollOf();
          const lastLineDocumentRect = lastLineOf(held.found, scroll);
          const inView = rect.x < view.width && rect.x + rect.width > 0 && rect.y < view.height && rect.y + rect.height > 0;
          tell(M.selectionTracked, Object.assign({ state: "attached", rect, documentRect: inDocument(rect, scroll), scroll, inView }, lastLineDocumentRect === null ? {} : { lastLineDocumentRect }));
          // The highlight goes with it (a layout change moves it without a scroll).
          redraw();
        }
      };
      // A mark, the selection (P138), or nothing: one at a time, each replacing the last.
      const track = (id, selection) => {
        const was = heldShown() || pickShown();
        tracking = typeof id === "string" ? id : null;
        followingSelection = tracking === null && selection === true;
        // The follow's highlight takes the pick's outline over, in this draw (Tenny's review).
        if (followingSelection) {
          picked = null;
        }
        // Its end lets the selection go, unless the host said it follows it again (P140).
        if (!keeps()) {
          held = null;
        }
        trackedBox = null;
        trackedView = null;
        heldTold = null;
        if ((tracking !== null || followingSelection) && trackFrame === 0) {
          trackFrame = nextFrame(trackTick);
        }
        if (heldShown() || pickShown() || was) {
          draw();
        }
      };
      // A new selected (P138): what is followed, if the selection is, from the next frame on; kept
      // only for a host that follows it or will (P140).
      const holdSelected = (anchor, found) => {
        held = keeps() ? { anchor, found, tried: 0 } : null;
        if (followingSelection) {
          trackedBox = null;
          heldTold = null;
          redraw();
        }
      };

      // Where each found mark starts in the document, in order (P112): its place in a list the host
      // sorts, offscreen ones too. Read now, every time results are told.
      const startOf = (found) => {
        const range = createRange.call(document);
        if (found.range) {
          setStart.call(range, found.range.startContainer, found.range.startOffset);
        } else {
          setStartBefore.call(range, found.element);
        }
        return range;
      };
      const ordersOf = () => {
        const placed = [];
        for (const mark of marks) {
          if (mark.found !== null) {
            try {
              placed.push({ mark, start: startOf(mark.found) });
            } catch (_) {}
          }
        }
        placed.sort((a, b) => {
          try {
            return compareBoundaryPoints.call(a.start, Range.START_TO_START, b.start);
          } catch (_) {
            return 0;
          }
        });
        const orders = new Map();
        placed.forEach((each, at) => orders.set(each.mark, at));
        return orders;
      };
      // A mark's result: its box in the viewport, and in the document (P132), its last line too
      // (P133), by scroll, the report's one reading of it.
      const resultOf = (mark, orders, scroll) => {
        if (mark.found === null) {
          return { id: mark.id, state: "orphaned" };
        }
        const order = (orders || ordersOf()).get(mark);
        const rect = box(rectOf(mark.found));
        const lastLineDocumentRect = lastLineOf(mark.found, scroll);
        return Object.assign({ id: mark.id, state: "attached", rect, documentRect: inDocument(rect, scroll) }, lastLineDocumentRect === null ? {} : { lastLineDocumentRect }, order === undefined ? {} : { order });
      };
      // Two boxes more than 0.5 px apart on any side (or one of them unknown).
      const apart = (a, b) => !a || !b || Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5 || Math.abs(a.width - b.width) > 0.5 || Math.abs(a.height - b.height) > 0.5;
      // What the host was last told of each mark (mark.told), so a settle tells only what moved.
      const moved = (mark, result) => {
        const told = mark.told;
        if (!told || told.state !== result.state) {
          return true;
        }
        return result.state === "attached" && (apart(told.rect, result.rect) || told.order !== result.order);
      };
      // With the scroll the results' document boxes were read at (P132).
      const report = (pairs, scroll) => {
        if (pairs.length > 0) {
          for (const pair of pairs) {
            pair.mark.told = pair.result;
          }
          tell(M.anchored, { results: pairs.map((pair) => pair.result), scroll });
        }
      };
      const resultsOf = (only, scroll) => {
        const orders = ordersOf();
        return marks.map((mark) => ({ mark, result: resultOf(mark, orders, scroll) })).filter((pair) => !only || moved(pair.mark, pair.result));
      };
      // Finds every mark again; tells the host every result (after show, or when a state changed),
      // only the marks that moved (once the content is quiet), or nothing.
      const anchorAll = (all, quiet) => {
        const index = textIndex();
        let changed = false;
        for (const mark of marks) {
          let found = null;
          try {
            found = find(mark.anchor, index);
          } catch (_) {
            found = null;
          }
          const state = found === null ? "orphaned" : "attached";
          if (state !== mark.state) {
            changed = true;
          }
          mark.found = found;
          mark.end = undefined;
          mark.state = state;
        }
        // Where each starts, once for each finding: the markers' reading order (P133).
        const orders = ordersOf();
        for (const mark of marks) {
          const reading = orders.get(mark);
          mark.reading = reading === undefined ? marks.length : reading;
        }
        if (all || changed) {
          const scroll = scrollOf();
          report(resultsOf(false, scroll), scroll);
        } else if (quiet) {
          follow();
        }
        draw();
      };
      // Once the content has been quiet a moment (it may still be drawing), at most a second late.
      let anchorTimer = 0;
      let deadline = 0;
      let reportAll = false;
      // Nothing is reported before the content is in place (an empty shell would orphan every
      // mark), nor before a run of changes settles; a focus asked for meanwhile waits for it.
      let waitingForContent = false;
      let pendingFocus = null;
      let pendingMarker = null;
      // Asked through the kept function: a page that says it has the focus gets no landing the
      // platform would refuse (P135).
      const focusIsHere = () => callOf(hasFocus, document, []) === true;
      const wordLate = ${WORD_LATE};
      const settling = () => anchorTimer !== 0 || waitingForContent || marks.some((mark) => mark.state === null);
      const scheduleAnchor = (all) => {
        if (all) {
          reportAll = true;
        }
        if (!contentIsIn()) {
          if (!waitingForContent) {
            waitingForContent = true;
            whenContentIsIn(() => {
              waitingForContent = false;
              scheduleAnchor(false);
            });
          }
          return;
        }
        const now = Date.now();
        if (deadline === 0) {
          deadline = now + 1000;
        }
        clearTimeout(anchorTimer);
        // A run that waited its whole pause found the content quiet; one cut short by the deadline
        // didn't, and tells only states (what moved is told once it is quiet).
        const wait = Math.max(0, Math.min(150, deadline - now));
        anchorTimer = setTimeout(() => {
          anchorTimer = 0;
          deadline = 0;
          const every = reportAll;
          reportAll = false;
          anchorAll(every, wait === 150);
          if (wait !== 150) {
            // Cut short by the deadline: what moved is told once the content has been quiet.
            settle();
          }
          if (pendingFocus !== null) {
            const id = pendingFocus;
            pendingFocus = null;
            focus(id);
          }
          if (pendingMarker !== null) {
            const id = pendingMarker;
            pendingMarker = null;
            // Parked, the host's word is old: the person may have moved on, and a marker's focus
            // takes the keyboard with no gesture. So it lands only if the focus is still in this
            // document. Otherwise it is dropped (P135).
            if (focusIsHere()) {
              focusMark(id, false);
            }
          }
        }, wait);
      };
      new MutationObserver((records) => {
        if (marks.length === 0) {
          return;
        }
        for (const record of records) {
          if (record.target === layer || (record.addedNodes.length + record.removedNodes.length === 1 && (record.addedNodes[0] === layer || record.removedNodes[0] === layer))) {
            continue;
          }
          scheduleAnchor(false);
          return;
        }
      }).observe(document, { childList: true, subtree: true, characterData: true });
      window.addEventListener("resize", redraw);
      window.addEventListener("scroll", redraw, true);
      // Follow-ups. Once a scroll, a resize or a run of changes has settled: the marks that moved
      // since the host was last told, in one report (P104), while any mark has a marker (a host
      // without markers hears the reports it heard before); and once a scroll has settled, the
      // person's selection, if its box moved since it was told (P105). Each only what moved more
      // than 0.5 px, and all of them on one clock, at most one report a second (the latest): they
      // share the bridge's 120 a minute with the person's own selections and clicks. While marks
      // are being found again, that run tells them instead.
      const FOLLOW_EVERY = 1000;
      let settleTimer = 0;
      let followTimer = 0;
      let followed = 0;
      // A scroll moved the page since the selection was last told: it is followed only then.
      let selectionScrolled = false;
      const counted = () => marks.some((mark) => mark.marker);
      const sendFollow = () => {
        let sent = 0;
        if (marks.length > 0 && !settling() && counted()) {
          const scroll = scrollOf();
          const pairs = resultsOf(true, scroll);
          if (pairs.length > 0) {
            report(pairs, scroll);
            sent += 1;
          }
        }
        // Not while the host follows the selection (P138, Tenny's review): its reports carry where
        // it is; a scroll after the following ends is re-sent as before.
        if (selectionScrolled) {
          selectionScrolled = false;
          if (!followingSelection && reportSelection(true)) {
            sent += 1;
          }
        }
        if (sent > 0) {
          // Each report takes its own second of the clock: two at once leave the next one empty.
          followed = Date.now() + (sent - 1) * FOLLOW_EVERY;
        }
      };
      const follow = () => {
        if (followTimer !== 0 || !(selectionScrolled || counted())) {
          return;
        }
        const wait = followed + FOLLOW_EVERY - Date.now();
        if (wait <= 0) {
          sendFollow();
          return;
        }
        followTimer = setTimeout(() => {
          followTimer = 0;
          sendFollow();
        }, wait);
      };
      const settle = () => {
        if (marks.length === 0 && !selectionScrolled) {
          return;
        }
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = 0;
          follow();
        }, 150);
      };
      window.addEventListener("resize", settle);
      window.addEventListener("scroll", settle, true);

      const focus = (id) => {
        const mark = marks.filter((each) => each.id === id)[0];
        if (!mark) {
          return;
        }
        if (settling()) {
          // Where it is isn't known yet: focus it once anchoring has settled, then say where.
          pendingFocus = id;
          active = id;
          return;
        }
        active = id;
        if (mark.found !== null) {
          const rect = rectOf(mark.found);
          if (rect.top < 0 || rect.bottom > window.innerHeight) {
            window.scrollBy(0, rect.top - (window.innerHeight - Math.min(rect.height, window.innerHeight)) / 2);
          }
          flashing = id;
          flashUntil = Date.now() + 1800;
          setTimeout(redraw, 1850);
        }
        draw();
        const scroll = scrollOf();
        report([{ mark, result: resultOf(mark, null, scroll) }], scroll);
      };

      // The focus on a mark's marker, at the host's word (P134). Marks a show just replaced have no
      // markers yet, so it waits for them, as focus does; then a marker that isn't there, or has
      // stepped aside for picking, is nothing to do. The kept function, so a page that patched
      // focus isn't handed the marker from inside the closed root. The shell's focus listener
      // lights it and brings it into view; nothing is told. A fresh word reads no focus: after the
      // host's card closed the focus is on the host's body, so this document has none yet. One
      // parked is asked as it lands (P135), and one this document took late (P137: late, by when
      // the host sent it: a busy page doesn't park it) is asked here: its moment has passed.
      const focusMark = (id, late) => {
        if (settling()) {
          pendingMarker = id;
          return;
        }
        if (mode.elements || !isShown(id)) {
          return;
        }
        if (late && !focusIsHere()) {
          return;
        }
        for (let i = 0; i < markers.length; i += 1) {
          if (markers[i].id === id) {
            callOf(focusElement, markers[i].element, [{ preventScroll: true }]);
            return;
          }
        }
      };

      // A marker's click (P104). The layer takes no pointer but on its markers, so a press whose
      // target is the layer is on a marker: the content's handlers never see it (this listener
      // runs before any of theirs), nor does what lies under it, and a click is reported. A press
      // of the mouse or a finger moves no focus; the keyboard reaches a marker as any button
      // (P133, which reverses P104's no tab stop): it joins the page's focus order, which the
      // content controls, so the host's own list of marks stays the keyboard way it can rely on.
      //
      // A press is read and stopped through the platform's own functions and getters, kept now
      // (P105), as the navigation guard reads its events (P099): content that later patches
      // Event's, MouseEvent's or DOMRect's prototypes (or Function's call) neither hears a press
      // through this listener nor makes it misread one. Narrowing only: content can still cover
      // the layer, reach its nodes through other built-ins, and tell that a press happened.
      const stopPress = Event.prototype.stopImmediatePropagation;
      // The platform's preventDefault, kept before a tab's shell locks its own over it (P099).
      const cancelPress = preventNavigation;
      const targetOf = getterOf(Event.prototype, "target");
      const typeOf = getterOf(Event.prototype, "type");
      const buttonOf = getterOf(MouseEvent.prototype, "button");
      const detailOf = getterOf(UIEvent.prototype, "detail");
      const keyOf = getterOf(KeyboardEvent.prototype, "key");
      const repeatOf = getterOf(KeyboardEvent.prototype, "repeat");
      const activeOf = getterOf(ShadowRoot.prototype, "activeElement");
      const scrollWindow = window.scrollBy;
      const clientXOf = getterOf(MouseEvent.prototype, "clientX");
      const clientYOf = getterOf(MouseEvent.prototype, "clientY");
      const leftOf = getterOf(DOMRectReadOnly.prototype, "left");
      const topOf = getterOf(DOMRectReadOnly.prototype, "top");
      const widthOf = getterOf(DOMRectReadOnly.prototype, "width");
      const heightOf = getterOf(DOMRectReadOnly.prototype, "height");
      const markerBox = (element) => {
        const rect = callOf(elementRect, element, []);
        return { x: callOf(leftOf, rect, []), y: callOf(topOf, rect, []), width: callOf(widthOf, rect, []), height: callOf(heightOf, rect, []) };
      };
      // The marker a press at (x, y) is for: on a marker's own box, that one; after a finger or a
      // pen, also within the 44 px box around one, the nearest (P119).
      const markerAt = (x, y) => {
        const at = markerHit(markers.length, (i) => markerBox(markers[i].element), x, y, touch);
        return at < 0 ? null : markers[at];
      };
      const markerOfNode = (element) => {
        for (let i = 0; i < markers.length; i += 1) {
          if (markers[i].element === element) {
            return markers[i];
          }
        }
        return null;
      };
      // The marker with the focus (P133), or null.
      const focusedMarker = () => (shadow === null || activeOf === null ? null : markerOfNode(callOf(activeOf, shadow, [])));
      const isShown = (id) => {
        for (let i = 0; i < marks.length; i += 1) {
          if (marks[i].id === id) {
            return true;
          }
        }
        return false;
      };
      const onMarker = (event) => {
        if (layer === null || callOf(targetOf, event, []) !== layer) {
          return;
        }
        callOf(stopPress, event, []);
        const type = callOf(typeOf, event, []);
        // No focus moves, no selection changes, no menu; a touch still makes its click (on WebKit,
        // since the marker has a listener of its own, P105).
        if (CANCELLED[type] === 1) {
          callOf(cancelPress, event, []);
        }
        if (HOVERS[type] === 1 || HOVERS[type] === 0) {
          const hit = HOVERS[type] === 1 ? markerAt(callOf(clientXOf, event, []), callOf(clientYOf, event, [])) : null;
          const id = hit === null ? null : hit.id;
          if (id !== hot) {
            hot = id;
            redraw();
          }
        }
        // isTrusted is the event's own, unforgeable.
        if (type === "click" && event.isTrusted && callOf(buttonOf, event, []) === 0) {
          // From the keyboard or assistive technology (P133) a click has no count and no place:
          // it is the focused marker's. Not while elements are picked: the markers step aside.
          const keyed = callOf(detailOf, event, []) === 0 ? focusedMarker() : null;
          if (keyed !== null) {
            if (!mode.elements && isShown(keyed.id)) {
              tell(M.activated, { id: keyed.id, rect: markerBox(keyed.element) });
            }
            return;
          }
          const hit = markerAt(callOf(clientXOf, event, []), callOf(clientYOf, event, []));
          if (hit !== null && isShown(hit.id)) {
            tell(M.activated, { id: hit.id, rect: markerBox(hit.element) });
          }
        }
      };
      // The keys that click a focused marker (P133), each stopped as a press is, so the content
      // neither hears them nor cancels the click they make; it keeps every other key, Tab and
      // Escape too, as it would on a button of its own, and the host's find shortcut stays. A key
      // held down clicks once: each repeat would spend the bridge's rate on one press.
      const onMarkerKey = (event) => {
        if (layer === null || callOf(targetOf, event, []) !== layer) {
          return;
        }
        const key = callOf(keyOf, event, []);
        if (key === "Enter" || key === " ") {
          callOf(stopPress, event, []);
          if (callOf(repeatOf, event, [])) {
            callOf(cancelPress, event, []);
          }
        }
      };
      for (const type of ["keydown", "keypress", "keyup"]) {
        window.addEventListener(type, onMarkerKey, true);
      }
      // The focus on a marker (P133) lights its words, as the pointer does, and brings it into view:
      // a marker out of view is out of the layer's box, which never scrolls, so the document must.
      const onMarkerFocus = (event) => {
        const on = callOf(typeOf, event, []) === "focusin" ? markerOfNode(callOf(targetOf, event, [])) : null;
        const id = on === null ? null : on.id;
        if (id !== hot) {
          hot = id;
          redraw();
        }
        if (on !== null) {
          const rect = markerBox(on.element);
          const seen = document.documentElement.clientHeight || window.innerHeight;
          if (rect.y < 0 || rect.y + rect.height > seen) {
            callOf(scrollWindow, window, [0, rect.y - (seen - rect.height) / 2]);
          }
        }
      };
      // The pointer moving over a marker is stopped too. Narrowing only: the content still sees
      // the pointer leave its own element for the layer (relatedTarget), the layer's :hover and
      // :active, and the frame's user activation, so it can tell a marker was pressed, and
      // roughly where. Content that patches no built-in can't act on or cancel the click; one that
      // does can still cover the layer or reach its nodes (P105).
      const CANCELLED = { mousedown: 1, mouseup: 1, click: 1, dblclick: 1, auxclick: 1, contextmenu: 1 };
      // The pointer on a marker (1), or leaving the layer for the content (0).
      const HOVERS = { pointerover: 1, pointermove: 1, pointerout: 0, pointerleave: 0 };
      // Which pointer the person uses (P119), from each real one that goes down or moves, before
      // the marker's listener (which stops a press on the layer): a finger or a pen gives every
      // marker its 44 px box, a mouse takes it away. A mouse moves before it presses, so its press
      // is hit-tested on the markers' own boxes. Read through the platform's getter, kept now; an
      // event the page makes up (isTrusted is false) changes nothing.
      const pointerTypeOf = getterOf(typeof PointerEvent === "function" ? PointerEvent.prototype : null, "pointerType");
      const onPointer = (event) => {
        if (!event.isTrusted || pointerTypeOf === null) {
          return;
        }
        const kind = callOf(pointerTypeOf, event, []);
        const next = kind === "touch" || kind === "pen";
        if (next !== touch) {
          touch = next;
          if (boxes !== null) {
            boxes.markers.className = touch ? "touch" : "";
          }
        }
      };
      for (const type of ["pointerdown", "pointermove"]) {
        window.addEventListener(type, onPointer, true);
      }
      for (const type of ["pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend", "touchcancel", "pointerover", "pointerout", "pointerenter", "pointerleave", "pointermove", "mouseover", "mouseout", "mouseenter", "mouseleave", "mousemove"]) {
        window.addEventListener(type, onMarker, true);
      }

      // Picking an element: what is under the pointer, never the page itself or the shell's layer.
      let cursor = null;
      const setCursor = (on) => {
        if (typeof CSSStyleSheet !== "function" || !Array.isArray(document.adoptedStyleSheets)) {
          return;
        }
        if (cursor === null) {
          cursor = new CSSStyleSheet();
          cursor.replaceSync("*, *::before, *::after { cursor: crosshair !important; }");
        }
        const others = document.adoptedStyleSheets.filter((sheet) => sheet !== cursor);
        document.adoptedStyleSheets = on ? others.concat([cursor]) : others;
      };
      const pickable = (element) => (element && element.nodeType === 1 && element !== document.documentElement && element !== document.body && element !== layer ? element : null);
      const under = (x, y) => pickable(elementFromPoint.call(document, x, y));
      const stop = () => {
        mode = { elements: false, text: false };
        hover = null;
        picked = null;
        reported = null;
        reportedBox = null;
        setCursor(false);
        draw();
      };
      // The content's own handlers never see the pointer while an element is being picked (content
      // that patches Event.prototype can: P105); a finger outlines what it is on as it goes down.
      let pressed = null;
      const swallow = (event) => {
        if (mode.elements) {
          if (event.type === "pointerdown") {
            pressed = { x: event.clientX, y: event.clientY };
            hover = under(event.clientX, event.clientY);
            redraw();
          }
          event.stopImmediatePropagation();
          if (!mode.text && (event.type === "mousedown" || event.type === "mouseup")) {
            event.preventDefault();
          }
        }
      };
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "auxclick", "touchstart", "touchend"]) {
        window.addEventListener(type, swallow, true);
      }
      window.addEventListener("pointermove", (event) => {
        if (mode.elements) {
          hover = under(event.clientX, event.clientY);
          redraw();
        }
      }, true);

      // Holding a block (P112, hold mode): a finger held still for 500 ms selects the block under
      // it, and the click its release makes is the shell's; every other tap is the page's, as is
      // any mouse. On the platform's own timer (taken before content runs).
      const later = window.setTimeout.bind(window);
      const cancelLater = window.clearTimeout.bind(window);
      const HOLD_MS = 500;
      const HOLD_SLOP = 10;
      let holding = null;
      let swallowUntil = 0;
      const endHold = () => {
        if (holding !== null) {
          cancelLater(holding.timer);
          holding = null;
        }
      };
      window.addEventListener("pointerdown", (event) => {
        if (!mode.hold || mode.elements || event.pointerType !== "touch" || !event.isPrimary) {
          return;
        }
        endHold();
        const x = event.clientX;
        const y = event.clientY;
        holding = {
          x,
          y,
          timer: later(() => {
            holding = null;
            if (!mode.hold) {
              return;
            }
            const element = under(x, y);
            const anchor = element === null ? null : elementAnchor(element, textIndex());
            if (anchor === null) {
              return;
            }
            swallowUntil = performance.now() + 2000;
            holdSelected(anchor, { element });
            picked = keeping && !followingSelection ? element : null;
            redraw();
            tell(M.selected, Object.assign({ anchor, rect: box(elementRect.call(element)) }, placeOf({ element })));
          }, HOLD_MS),
        };
      }, true);
      window.addEventListener("pointermove", (event) => {
        if (holding !== null && event.pointerType === "touch" && Math.abs(event.clientX - holding.x) + Math.abs(event.clientY - holding.y) > HOLD_SLOP) {
          endHold();
        }
      }, true);
      for (const type of ["pointerup", "pointercancel"]) {
        window.addEventListener(type, endHold, true);
      }
      for (const type of ["click", "contextmenu"]) {
        window.addEventListener(type, (event) => {
          if (swallowUntil > performance.now()) {
            if (type === "click") {
              swallowUntil = 0;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        }, true);
      }
      window.addEventListener("click", (event) => {
        if (!mode.elements) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        // A drag that selected text: the selection is what was meant. A press and release in
        // one place is a pick.
        const selection = selectionOf.call(document);
        const dragged = pressed !== null && event.detail !== 0 && Math.abs(event.clientX - pressed.x) + Math.abs(event.clientY - pressed.y) > 4;
        if (mode.text && dragged && selection !== null && !selection.isCollapsed) {
          return;
        }
        const element = event.detail === 0 ? pickable(event.target) : under(event.clientX, event.clientY);
        if (element === null) {
          return;
        }
        const anchor = elementAnchor(element, textIndex());
        if (anchor === null) {
          return;
        }
        mode = { elements: false, text: mode.text };
        hover = null;
        setCursor(false);
        holdSelected(anchor, { element });
        // Its outline stays (P138), now without its name, until the host follows it or it ends;
        // only for a host that will follow it (P140): for any other it goes with the pick.
        picked = keeping && !followingSelection ? element : null;
        draw();
        tell(M.selected, Object.assign({ anchor, rect: box(elementRect.call(element)) }, placeOf({ element })));
      }, true);
      window.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
          return;
        }
        // The person wants out: a pick's outline goes (P138). The key is untouched by it.
        endPick();
        if (mode.elements) {
          event.preventDefault();
          event.stopImmediatePropagation();
          mode = { elements: false, text: mode.text };
          hover = null;
          setCursor(false);
          draw();
          tell(M.cancelled, {});
          return;
        }
        // Selecting text (P112): the person wants out too. The key stays the page's (a page that
        // closes its own dialog on Escape still does); the host decides what ends.
        if (mode.text) {
          tell(M.cancelled, {});
        }
      }, true);

      // Selecting text: each selection that settles, and its clearing; after a scroll, the same
      // selection again only if its box moved, on the follow-ups' clock (P105: re-sent after every
      // settle, an honest page's scrolling spent the budget its marker's click needed).
      let reported = null;
      let reportedBox = null;
      let selectionTimer = 0;
      // Whether it told the host anything.
      const reportSelection = (following) => {
        if (!mode.text) {
          return false;
        }
        const selection = selectionOf.call(document);
        if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
          if (reported !== null) {
            reported = null;
            reportedBox = null;
            tell(M.unselected, {});
            return true;
          }
          return false;
        }
        const range = selection.getRangeAt(0);
        if (!document.body || !document.body.contains(range.commonAncestorContainer)) {
          return false;
        }
        const anchor = textAnchor(range, textIndex());
        if (anchor === null) {
          return false;
        }
        const key = anchor.selectors[1].start + ":" + anchor.selectors[1].end;
        const rect = box(rangeRect.call(range));
        if (key === reported && !(following && apart(reportedBox, rect))) {
          return false;
        }
        reported = key;
        reportedBox = rect;
        holdSelected(anchor, { range: cloneRange.call(range) });
        endPick();
        tell(M.selected, Object.assign({ anchor, rect }, placeOf({ range })));
        return true;
      };
      document.addEventListener("selectionchange", () => {
        if (mode.text) {
          clearTimeout(selectionTimer);
          selectionTimer = setTimeout(() => reportSelection(false), 250);
        }
      });
      window.addEventListener("scroll", () => {
        // Not while the host follows the selection (P138, Tenny's review).
        if (followingSelection) {
          return;
        }
        if (reported !== null) {
          selectionScrolled = true;
          settle();
        }
      }, true);

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent || plan.origins.indexOf(event.origin) === -1) {
          return;
        }
        const data = event.data;
        if (data === null || typeof data !== "object" || data.jsonrpc !== "2.0" || typeof data.method !== "string") {
          return;
        }
        const params = data.params !== null && typeof data.params === "object" ? data.params : {};
        switch (data.method) {
          case M.start:
            mode = { elements: params.elements === true, text: params.text === true, hold: params.elements === "hold" };
            // Whether the host will follow what is selected (P140): only then is it kept before
            // the host follows it. A stop leaves it, so a stop sent as the composer opens doesn't
            // take the selection away before the follow comes.
            keeping = params.keepSelection === true;
            if (!keeps()) {
              held = null;
            }
            hover = null;
            picked = null;
            reported = null;
            reportedBox = null;
            setCursor(mode.elements);
            draw();
            reportSelection(false);
            break;
          case M.stop:
            stop();
            break;
          case M.show:
            // A draft (P107) has a marker and never a number; a kind the shell doesn't know is no mark.
            marks = (Array.isArray(params.marks) ? params.marks : [])
              .slice(0, LIMIT.marks)
              .filter((mark) => mark && typeof mark.id === "string" && mark.anchor && Array.isArray(mark.anchor.selectors) && (mark.kind === undefined || mark.kind === "posted" || mark.kind === "draft"))
              .map((mark) => {
                const draft = mark.kind === "draft";
                const count = !draft && typeof mark.count === "number" && mark.count >= 0 && mark.count <= LIMIT.count && Math.floor(mark.count) === mark.count ? mark.count : null;
                return { id: mark.id, anchor: mark.anchor, count, draft, marker: draft || count !== null, found: null, state: null, told: null };
              });
            if (typeof params.active === "string") {
              active = params.active;
            }
            if (!marks.some((mark) => mark.id === active)) {
              active = null;
            }
            scheduleAnchor(true);
            break;
          case M.focus:
            focus(String(params.id));
            break;
          case M.track:
            track(params.id, params.selection === true);
            break;
          case M.clearSelection: {
            // The host used the person's selection (P115): it goes, and with it what the shell
            // held of it (a report waiting to settle, the one last told, a scroll's follow-up), so
            // nothing is told back: the host knows, and the selectionchange this makes finds
            // nothing to report. Marks, a pick and the mode stay as they are, but a pick's outline
            // goes (P138). With nothing selected, nothing changes.
            cancelLater(selectionTimer);
            selectionTimer = 0;
            reported = null;
            reportedBox = null;
            endPick();
            selectionScrolled = false;
            const selection = selectionOf.call(document);
            if (selection !== null) {
              removeAllRanges.call(selection);
            }
            break;
          }
          case M.focusMark:
            focusMark(String(params.id), wordLate(params.at, callOf(wallClock, undefined, [])));
            break;
          case M.clear:
            track(null);
            picked = null;
            pendingFocus = null;
            pendingMarker = null;
            marks = [];
            active = null;
            hot = null;
            draw();
            break;
          default:
            break;
        }
      });
    })();
  }`;
