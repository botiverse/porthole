/**
 * The shell's annotation runtime (P053), spliced into the shell's runtime (`__ANNOTATE__`) when
 * the config declares `annotate`, so it runs before any content does, with the DOM's own
 * functions as they were. Plain ES2020 like the rest of the shell; no template literals (it sits
 * in one).
 *
 * The host drives it (`porthole/annotate.start|stop|show|focus|clear`) and it reports
 * (`porthole/annotate.selected|unselected|cancelled|anchored|activated`):
 * - picking an element: the element under the pointer (or finger) is outlined with its name; a
 *   click or tap picks it, and the content's own handlers never see that click (unless the content
 *   patched the DOM's built-ins, P105); Escape cancels (while selecting text too, P112);
 * - selecting text: each selection that settles is reported, with where it is, and its clearing;
 * - marks: each anchor is found in the content as it is now (its CSS selector, its text where it
 *   was, its text anywhere, its words with any spacing) and drawn over it, in a layer of the
 *   shell's own (a closed shadow root), again whenever the content changes; what can't be found
 *   is reported `orphaned`;
 * - markers (P104): a mark with a count gets a small bubble with the number beside its anchor's
 *   last line (P105: in the line's gutter); a click on it is reported (`activated`), and the
 *   content's own handlers never see it; a draft (P107) is drawn apart, a dashed line and a hollow
 *   bubble with no number, and has a marker with or without a count;
 * - following: while a mark has a marker, once a scroll, a resize or a change of the content
 *   settles, the marks that moved since the host was last told are reported, at most once a
 *   second, so the host's own UI beside a mark can follow.
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
      };
      // The DOM's own functions, taken before content runs.
      const elementFromPoint = Document.prototype.elementFromPoint;
      const querySelector = Document.prototype.querySelector;
      const createRange = Document.prototype.createRange;
      const createTreeWalker = Document.prototype.createTreeWalker;
      const createElement = Document.prototype.createElement;
      const createElementNS = Document.prototype.createElementNS;
      const selectionOf = Document.prototype.getSelection;
      const elementRect = Element.prototype.getBoundingClientRect;
      const rangeRect = Range.prototype.getBoundingClientRect;
      const rangeRects = Range.prototype.getClientRects;
      const setStart = Range.prototype.setStart;
      const setStartBefore = Range.prototype.setStartBefore;
      const compareBoundaryPoints = Range.prototype.compareBoundaryPoints;
      const attachShadow = Element.prototype.attachShadow;
      const getAttribute = Element.prototype.getAttribute;
      const listenOn = EventTarget.prototype.addEventListener;
      const post = window.parent.postMessage.bind(window.parent);
      // Read once: content can replace window.parent (it is [Replaceable]), never what was read.
      const framed = window.parent !== window;
      const tell = (method, params) => {
        if (framed) {
          post({ jsonrpc: "2.0", method, params }, "*");
        }
      };
      const squash = (text) => String(text).replace(/\s+/g, " ").trim();
      const box = (rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });

      // The document's text: the body's text nodes in order, without scripts, styles, templates.
      const SKIPPED = { script: 1, style: 1, noscript: 1, template: 1 };
      const textIndex = () => {
        const nodes = [];
        const starts = [];
        const at = new Map();
        let text = "";
        const body = document.body;
        if (body) {
          const walker = createTreeWalker.call(document, body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => (node.nodeType === 1 ? (SKIPPED[node.localName] ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT),
          });
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            at.set(node, nodes.length);
            nodes.push(node);
            starts.push(text.length);
            text += node.nodeValue;
          }
        }
        return { nodes, starts, at, text };
      };
      // A boundary point as an offset into the text: in a text node, where it is; elsewhere, the
      // first text at or after it.
      const offsetOf = (index, container, offset) => {
        if (container.nodeType === 3 && index.at.has(container)) {
          return index.starts[index.at.get(container)] + Math.min(offset, container.nodeValue.length);
        }
        const point = createRange.call(document);
        try {
          point.setStart(container, offset);
        } catch (_) {
          return index.text.length;
        }
        point.collapse(true);
        let low = 0;
        let high = index.nodes.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (point.comparePoint(index.nodes[middle], 0) >= 0) {
            high = middle;
          } else {
            low = middle + 1;
          }
        }
        return low < index.nodes.length ? index.starts[low] : index.text.length;
      };
      const pointAt = (index, at, end) => {
        let low = 0;
        let high = index.nodes.length - 1;
        let found = -1;
        while (low <= high) {
          const middle = (low + high) >> 1;
          if (index.starts[middle] <= at) {
            found = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        if (found === -1) {
          return null;
        }
        let node = index.nodes[found];
        let offset = at - index.starts[found];
        if (end) {
          // An end at a node's very start belongs to the text before it.
          while (offset === 0 && found > 0) {
            found -= 1;
            node = index.nodes[found];
            offset = node.nodeValue.length;
          }
        } else {
          while (offset >= node.nodeValue.length && found + 1 < index.nodes.length) {
            found += 1;
            node = index.nodes[found];
            offset = 0;
          }
        }
        return { node, offset: Math.min(offset, node.nodeValue.length) };
      };
      const rangeAt = (index, start, end) => {
        const from = pointAt(index, start, false);
        const to = pointAt(index, end, true);
        if (from === null || to === null) {
          return null;
        }
        const range = createRange.call(document);
        try {
          range.setStart(from.node, from.offset);
          range.setEnd(to.node, to.offset);
        } catch (_) {
          return null;
        }
        return range;
      };
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
      const STYLE = ".mark{position:absolute;border-radius:2px;background:rgba(250,204,21,.18);box-shadow:inset 0 -2px 0 rgba(234,179,8,.95)}.mark.element{background:rgba(250,204,21,.07);box-shadow:none;outline:2px solid rgba(234,179,8,.9);outline-offset:1px}.mark.active{background:rgba(250,204,21,.26);box-shadow:inset 0 -3px 0 rgb(234,179,8),0 0 0 2px rgba(234,179,8,.45)}.mark.element.active{background:rgba(250,204,21,.12);box-shadow:none;outline-width:3px}.mark.element.quiet{background:rgba(250,204,21,.05);outline:1px solid rgba(234,179,8,.6);outline-offset:2px}.mark.element.quiet.active{background:rgba(250,204,21,.1);outline:2px solid rgba(234,179,8,.9)}.mark.draft{box-sizing:border-box;background:rgba(250,204,21,.08);box-shadow:none;border-bottom:2px dashed rgba(202,138,4,.95)}.mark.draft.active{background:rgba(250,204,21,.16);box-shadow:0 0 0 2px rgba(234,179,8,.45);border-bottom-width:3px}.mark.element.draft{background:rgba(250,204,21,.04);border-bottom:0;outline-style:dashed}.mark.element.draft.active{background:rgba(250,204,21,.08);box-shadow:none;outline-style:dashed}.marker{position:absolute;box-sizing:border-box;height:18px;min-width:18px;display:flex;align-items:center;justify-content:center;gap:3px;margin:0;padding:0 5px;border:1px solid rgba(161,98,7,.6);border-radius:9px 9px 9px 2px;background:#fde68a;color:#422006;box-shadow:0 1px 2px rgba(0,0,0,.3);font:600 11px/16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-style:normal;letter-spacing:0;word-spacing:0;text-transform:none;text-indent:0;text-shadow:none;direction:ltr;writing-mode:horizontal-tb;white-space:nowrap;user-select:none;-webkit-user-select:none;cursor:pointer;pointer-events:auto}.marker:hover{background:#fcd34d}.marker.active{background:#facc15;box-shadow:0 0 0 2px rgba(234,179,8,.55),0 1px 2px rgba(0,0,0,.3)}.marker.compact{padding:0 4px}.marker.draft{border:1px dashed rgb(202,138,4);background:#fffdf5;color:#a16207;box-shadow:0 1px 2px rgba(0,0,0,.2)}.marker.draft:hover{background:#fef9e7}.marker.draft.active{background:#fef3c7;box-shadow:0 0 0 2px rgba(234,179,8,.55),0 1px 2px rgba(0,0,0,.2)}.marker.inert{pointer-events:none}.marker svg{display:block;width:11px;height:11px;flex:none}.mark.flash{animation:flash 1.8s ease-out}@keyframes flash{from{box-shadow:inset 0 -3px 0 rgb(234,179,8),0 0 0 6px rgba(250,204,21,.6)}}.hover{position:absolute;outline:2px solid #2563eb;outline-offset:1px;background:rgba(37,99,235,.12)}.tag{position:absolute;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 6px;border-radius:4px;background:#1e293b;color:#fff}";
      // Inline and important: the content's own style sheets can't hide, shrink or move it by
      // accident. Set again at each draw, since its scripts can rewrite it (narrowing only: the
      // content can still cover the layer, or move it with its ancestors, P104).
      const LAYER_STYLE = "position:fixed!important;inset:0!important;width:auto!important;height:auto!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:none!important;z-index:2147483647!important;overflow:hidden!important;margin:0!important;padding:0!important;border:0!important;background:none!important;transform:none!important;scale:none!important;translate:none!important;rotate:none!important;zoom:1!important;clip-path:none!important;mask:none!important;filter:none!important;content-visibility:visible!important;contain:none!important";
      const ensureLayer = () => {
        if (layer === null) {
          layer = createElement.call(document, "div");
          layer.setAttribute("aria-hidden", "true");
          layer.setAttribute("data-porthole-annotations", "");
          shadow = attachShadow.call(layer, { mode: "closed" });
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
      let marks = [];
      // The markers as last drawn, for a click to find: { id, element }. Each mark keeps its
      // marker's node across draws, so a press that spans a redraw ends on the node it began on.
      let markers = [];
      const markerNodes = new Map();
      const MARKER_HEIGHT = 18;
      const SVG = "http://www.w3.org/2000/svg";
      const labelOf = (count) => (count === 0 ? "" : count > 99 ? "99+" : String(count));
      // Its size, near enough to place it: the padding and the glyph, then the number.
      const markerWidth = (label) => Math.max(MARKER_HEIGHT, 23 + (label === "" ? 0 : 3 + label.length * 7));
      // Compact (P105): the number alone, or the glyph alone for none, with less padding.
      const compactWidth = (label) => (label === "" ? 21 : Math.max(MARKER_HEIGHT, 10 + label.length * 7));
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
      // narrow screen), it goes as far right as it can, over the line's end.
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
        let left = fits(gutter, false);
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
        wanted.sort((a, b) => a.at.top - b.at.top || a.at.right - b.at.right);
        for (const each of wanted) {
          const middle = each.at.top + each.at.height / 2;
          let line = null;
          for (const one of lines) {
            if (line === null && one.block === each.block && Math.abs(one.middle - middle) < Math.min(one.height, each.at.height) / 2) {
              line = one;
            }
          }
          if (line === null) {
            line = { block: each.block, middle, height: each.at.height, bottom: each.at.bottom, range: each.range, at: each.at, items: [] };
            lines.push(line);
          }
          line.items.push(each);
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
          marker = createElement.call(document, "div");
          // A listener of its own makes it a thing to tap: WebKit makes a tap a click only on such
          // an element (P105, measured: the window's listener isn't enough). It never runs (the
          // window's first listener stops every click on the layer); the click is told there.
          callOf(listenOn, marker, ["click", tapTarget]);
        }
        marker.className = "marker" + (mark.draft ? " draft" : "") + (each.compact ? " compact" : "") + (mark.id === active ? " active" : "") + (mode.elements ? " inert" : "");
        marker.style.cssText = "left:" + each.left + "px;top:" + each.top + "px";
        markers.push({ id: mark.id, element: marker });
        const form = (mark.draft ? "draft:" : "") + (each.compact ? "compact:" : "full:") + label;
        if (kept && kept.form === form) {
          return marker;
        }
        markerNodes.set(mark.id, { element: marker, form });
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
      const tapTarget = () => {};
      let active = null;
      // The mark whose marker the pointer is over: its words are lit as the active mark's are, so
      // a marker in the gutter shows which words it is for (P105).
      let hot = null;
      let flashing = null;
      let flashUntil = 0;
      // The layer's parts: its style, the marks, the markers, the outline while picking. A draw
      // replaces the marks and the outline, and leaves each marker that stays where it is (P105): a
      // marker taken out of the page and put back mid-press loses its click (WebKit, measured once
      // the pointer's arrival on a marker lit its mark and redrew).
      let boxes = null;
      const boxesOf = (root) => {
        if (boxes === null || boxes.style.parentNode !== root || boxes.marks.parentNode !== root || boxes.markers.parentNode !== root || boxes.hover.parentNode !== root) {
          const style = createElement.call(document, "style");
          if (nonce !== "") {
            style.nonce = nonce;
          }
          boxes = { style, marks: createElement.call(document, "div"), markers: createElement.call(document, "div"), hover: createElement.call(document, "div") };
          root.replaceChildren(boxes.style, boxes.marks, boxes.markers, boxes.hover);
        }
        if (boxes.style.textContent !== STYLE) {
          boxes.style.textContent = STYLE;
        }
        return boxes;
      };
      const draw = () => {
        if (marks.length === 0 && hover === null && layer === null) {
          return;
        }
        const root = ensureLayer();
        const into = boxesOf(root);
        const parts = [];
        const flashOn = Date.now() < flashUntil;
        // What is measured first, then drawn: no node of the layer changes while the page is read.
        const corners = [];
        const wanted = [];
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
            each.style.cssText = "left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px";
            parts.push(each);
          }
          if (mark.marker) {
            const at = lastBox(rects);
            if (at !== null) {
              // A draft's marker has no number (P107).
              const label = mark.draft ? "" : labelOf(mark.count);
              const each = { mark, order: corners.length + wanted.length, label, width: markerWidth(label), small: compactWidth(label), compact: false, at, left: 0, top: 0 };
              if (mark.found.range) {
                // Kept while it still holds the words (P105): a change elsewhere doesn't move them.
                if (mark.block === undefined || !mark.block.isConnected || !containsOf.call(mark.block, mark.found.range.endContainer)) {
                  mark.block = blockOf(mark.found.range);
                }
                each.range = mark.found.range;
                each.block = mark.block;
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
        if (wanted.length > 0) {
          into.marks.style.display = "none";
          into.markers.style.display = "none";
          try {
            placeLines(wanted, placed, room);
          } finally {
            into.marks.style.display = "";
            into.markers.style.display = "";
          }
        }
        const badges = [];
        for (const each of corners.concat(wanted).sort((a, b) => a.order - b.order)) {
          badges.push(markerOf(each));
        }
        for (const id of Array.from(markerNodes.keys())) {
          if (!markers.some((each) => each.id === id)) {
            markerNodes.delete(id);
          }
        }
        const outlines = [];
        if (hover !== null && hover.isConnected) {
          const rect = elementRect.call(hover);
          const outline = createElement.call(document, "div");
          outline.className = "hover";
          outline.style.cssText = "left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px";
          const tag = createElement.call(document, "div");
          tag.className = "tag";
          tag.textContent = describe(hover).slice(0, 80);
          tag.style.cssText = "left:" + Math.max(4, rect.left) + "px;top:" + (rect.top >= 24 ? rect.top - 22 : Math.max(4, rect.bottom + 4)) + "px";
          outlines.push(outline, tag);
        }
        into.marks.replaceChildren(...parts);
        for (const child of Array.from(into.markers.childNodes)) {
          if (badges.indexOf(child) === -1) {
            into.markers.removeChild(child);
          }
        }
        for (const badge of badges) {
          if (badge.parentNode !== into.markers) {
            into.markers.appendChild(badge);
          }
        }
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
      const trackTick = () => {
        trackFrame = 0;
        if (tracking === null) {
          return;
        }
        const mark = marks.find((each) => each.id === tracking);
        if (mark !== undefined && mark.found !== null) {
          const rect = box(rectOf(mark.found));
          const now = performance.now();
          if (apart(trackedBox, rect) && now - trackedAt >= 16) {
            trackedBox = rect;
            trackedAt = now;
            tell(M.tracked, { id: tracking, rect });
          }
        }
        trackFrame = nextFrame(trackTick);
      };
      const track = (id) => {
        tracking = typeof id === "string" ? id : null;
        trackedBox = null;
        if (tracking !== null && trackFrame === 0) {
          trackFrame = nextFrame(trackTick);
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
      const resultOf = (mark, orders) => {
        if (mark.found === null) {
          return { id: mark.id, state: "orphaned" };
        }
        const order = (orders || ordersOf()).get(mark);
        return Object.assign({ id: mark.id, state: "attached", rect: box(rectOf(mark.found)) }, order === undefined ? {} : { order });
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
      const report = (pairs) => {
        if (pairs.length > 0) {
          for (const pair of pairs) {
            pair.mark.told = pair.result;
          }
          tell(M.anchored, { results: pairs.map((pair) => pair.result) });
        }
      };
      const resultsOf = (only) => {
        const orders = ordersOf();
        return marks.map((mark) => ({ mark, result: resultOf(mark, orders) })).filter((pair) => !only || moved(pair.mark, pair.result));
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
          mark.state = state;
        }
        if (all || changed) {
          report(resultsOf(false));
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
          const pairs = resultsOf(true);
          if (pairs.length > 0) {
            report(pairs);
            sent += 1;
          }
        }
        if (selectionScrolled) {
          selectionScrolled = false;
          if (reportSelection(true)) {
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
        report([{ mark, result: resultOf(mark) }]);
      };

      // A marker's click (P104). The layer takes no pointer but on its markers, so a press whose
      // target is the layer is on a marker: the content's handlers never see it (this listener
      // runs before any of theirs), nor does what lies under it, and a click is reported. No tab
      // stop, by choice: it would join the page's focus order, which the content controls, and the
      // layer is hidden from assistive technology; the host's own list of marks is the keyboard way.
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
      const markerAt = (x, y) => {
        for (let i = markers.length - 1; i >= 0; i -= 1) {
          const rect = markerBox(markers[i].element);
          if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
            return markers[i];
          }
        }
        return null;
      };
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
          const hit = markerAt(callOf(clientXOf, event, []), callOf(clientYOf, event, []));
          if (hit !== null && isShown(hit.id)) {
            tell(M.activated, { id: hit.id, rect: markerBox(hit.element) });
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
            tell(M.selected, { anchor, rect: box(elementRect.call(element)) });
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
        draw();
        tell(M.selected, { anchor, rect: box(elementRect.call(element)) });
      }, true);
      window.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
          return;
        }
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
        tell(M.selected, { anchor, rect });
        return true;
      };
      document.addEventListener("selectionchange", () => {
        if (mode.text) {
          clearTimeout(selectionTimer);
          selectionTimer = setTimeout(() => reportSelection(false), 250);
        }
      });
      window.addEventListener("scroll", () => {
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
            hover = null;
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
            track(params.id);
            break;
          case M.clear:
            track(null);
            pendingFocus = null;
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
