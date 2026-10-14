/**
 * The shell's annotation runtime (P053), spliced into the shell's runtime (`__ANNOTATE__`) when
 * the config declares `annotate`, so it runs before any content does, with the DOM's own
 * functions as they were. Plain ES2020 like the rest of the shell; no template literals (it sits
 * in one).
 *
 * The host drives it (`porthole/annotate.start|stop|show|focus|clear`) and it reports
 * (`porthole/annotate.selected|unselected|cancelled|anchored`):
 * - picking an element: the element under the pointer (or finger) is outlined with its name; a
 *   click or tap picks it, and the content's own handlers never see that click; Escape cancels;
 * - selecting text: each selection that settles is reported, with where it is, and its clearing;
 * - marks: each anchor is found in the content as it is now (its CSS selector, its text where it
 *   was, its text anywhere, its words with any spacing) and drawn over it, in a layer of the
 *   shell's own (a closed shadow root), again whenever the content changes; what can't be found
 *   is reported `orphaned`.
 *
 * It shares the realm with the content, which can interfere with all of it: the host takes its
 * reports as UI hints only.
 */
export const ANNOTATE_RUNTIME = String.raw`if (declared("annotate")) {
    (() => {
      const LIMIT = { exact: 4000, quote: 300, context: 32, label: 120, css: 1000, marks: 500, boxes: 200 };
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
      };
      // The DOM's own functions, taken before content runs.
      const elementFromPoint = Document.prototype.elementFromPoint;
      const querySelector = Document.prototype.querySelector;
      const createRange = Document.prototype.createRange;
      const createTreeWalker = Document.prototype.createTreeWalker;
      const createElement = Document.prototype.createElement;
      const selectionOf = Document.prototype.getSelection;
      const elementRect = Element.prototype.getBoundingClientRect;
      const rangeRect = Range.prototype.getBoundingClientRect;
      const rangeRects = Range.prototype.getClientRects;
      const attachShadow = Element.prototype.attachShadow;
      const post = window.parent.postMessage.bind(window.parent);
      const tell = (method, params) => {
        if (window.parent !== window) {
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
        const words = squash(element.textContent || "").slice(0, 40);
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
      const STYLE = ".mark{position:absolute;border-radius:2px;background:rgba(250,204,21,.18);box-shadow:inset 0 -2px 0 rgba(234,179,8,.95)}.mark.element{background:rgba(250,204,21,.07);box-shadow:none;outline:2px solid rgba(234,179,8,.9);outline-offset:1px}.mark.active{background:rgba(250,204,21,.26);box-shadow:inset 0 -3px 0 rgb(234,179,8),0 0 0 2px rgba(234,179,8,.45)}.mark.element.active{background:rgba(250,204,21,.12);box-shadow:none;outline-width:3px}.mark.flash{animation:flash 1.8s ease-out}@keyframes flash{from{box-shadow:inset 0 -3px 0 rgb(234,179,8),0 0 0 6px rgba(250,204,21,.6)}}.hover{position:absolute;outline:2px solid #2563eb;outline-offset:1px;background:rgba(37,99,235,.12)}.tag{position:absolute;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 6px;border-radius:4px;background:#1e293b;color:#fff}";
      const ensureLayer = () => {
        if (layer === null) {
          layer = createElement.call(document, "div");
          layer.setAttribute("aria-hidden", "true");
          layer.setAttribute("data-porthole-annotations", "");
          // Inline and important: the content's own styles can't hide or move it by accident.
          layer.style.cssText = "position:fixed!important;inset:0!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:none!important;z-index:2147483647!important;overflow:hidden!important;margin:0!important;padding:0!important;border:0!important;background:none!important;transform:none!important";
          shadow = attachShadow.call(layer, { mode: "closed" });
        }
        if (!layer.isConnected) {
          document.documentElement.appendChild(layer);
        }
        return shadow;
      };

      let mode = { elements: false, text: false };
      let hover = null;
      let marks = [];
      let active = null;
      let flashing = null;
      let flashUntil = 0;
      const draw = () => {
        if (marks.length === 0 && hover === null && layer === null) {
          return;
        }
        const root = ensureLayer();
        const parts = [];
        const style = createElement.call(document, "style");
        if (nonce !== "") {
          style.nonce = nonce;
        }
        style.textContent = STYLE;
        parts.push(style);
        const flashOn = Date.now() < flashUntil;
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
            each.className = "mark " + (mark.found.range ? "text" : "element") + (mark.id === active ? " active" : "") + (flashOn && mark.id === flashing ? " flash" : "");
            each.style.cssText = "left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px";
            parts.push(each);
          }
        }
        if (hover !== null && hover.isConnected) {
          const rect = elementRect.call(hover);
          const outline = createElement.call(document, "div");
          outline.className = "hover";
          outline.style.cssText = "left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px";
          const tag = createElement.call(document, "div");
          tag.className = "tag";
          tag.textContent = describe(hover).slice(0, 80);
          tag.style.cssText = "left:" + Math.max(4, rect.left) + "px;top:" + (rect.top >= 24 ? rect.top - 22 : Math.max(4, rect.bottom + 4)) + "px";
          parts.push(outline, tag);
        }
        root.replaceChildren(...parts);
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

      const resultOf = (mark) => (mark.found === null ? { id: mark.id, state: "orphaned" } : { id: mark.id, state: "attached", rect: box(rectOf(mark.found)) });
      // Finds every mark again; tells the host every result (after show) or only when one changed.
      const anchorAll = (all) => {
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
          tell(M.anchored, { results: marks.map(resultOf) });
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
        anchorTimer = setTimeout(() => {
          anchorTimer = 0;
          deadline = 0;
          const every = reportAll;
          reportAll = false;
          anchorAll(every);
          if (pendingFocus !== null) {
            const id = pendingFocus;
            pendingFocus = null;
            focus(id);
          }
        }, Math.max(0, Math.min(150, deadline - now)));
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
        tell(M.anchored, { results: [resultOf(mark)] });
      };

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
        setCursor(false);
        draw();
      };
      // The content's own handlers never see the pointer while an element is being picked; a
      // finger outlines what it is on as it goes down.
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
        if (mode.elements && event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          mode = { elements: false, text: mode.text };
          hover = null;
          setCursor(false);
          draw();
          tell(M.cancelled, {});
        }
      }, true);

      // Selecting text: each selection that settles, and its clearing; again after a scroll.
      let reported = null;
      let selectionTimer = 0;
      const reportSelection = (again) => {
        if (!mode.text) {
          return;
        }
        const selection = selectionOf.call(document);
        if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
          if (reported !== null) {
            reported = null;
            tell(M.unselected, {});
          }
          return;
        }
        const range = selection.getRangeAt(0);
        if (!document.body || !document.body.contains(range.commonAncestorContainer)) {
          return;
        }
        const anchor = textAnchor(range, textIndex());
        if (anchor === null) {
          return;
        }
        const key = anchor.selectors[1].start + ":" + anchor.selectors[1].end;
        if (key === reported && !again) {
          return;
        }
        reported = key;
        tell(M.selected, { anchor, rect: box(rangeRect.call(range)) });
      };
      document.addEventListener("selectionchange", () => {
        if (mode.text) {
          clearTimeout(selectionTimer);
          selectionTimer = setTimeout(() => reportSelection(false), 250);
        }
      });
      let scrollTimer = 0;
      window.addEventListener("scroll", () => {
        if (reported !== null) {
          clearTimeout(scrollTimer);
          scrollTimer = setTimeout(() => reportSelection(true), 150);
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
            mode = { elements: params.elements === true, text: params.text === true };
            hover = null;
            reported = null;
            setCursor(mode.elements);
            draw();
            reportSelection(false);
            break;
          case M.stop:
            stop();
            break;
          case M.show:
            marks = (Array.isArray(params.marks) ? params.marks : [])
              .slice(0, LIMIT.marks)
              .filter((mark) => mark && typeof mark.id === "string" && mark.anchor && Array.isArray(mark.anchor.selectors))
              .map((mark) => ({ id: mark.id, anchor: mark.anchor, found: null, state: null }));
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
          case M.clear:
            pendingFocus = null;
            marks = [];
            active = null;
            draw();
            break;
          default:
            break;
        }
      });
    })();
  }`;
