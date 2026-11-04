/**
 * The document's text as annotations (P053) and find in page (P131) read it, spliced into each of
 * their runtimes (inside its own function, after it took `createTreeWalker` and `createRange` from
 * the DOM before content ran): the body's text nodes in order, without scripts, styles, noscript
 * and templates, as one string with each node's start (`textIndex()`); an offset into it as a
 * boundary point (`pointAt`), a boundary point as an offset (`offsetOf`), a span as a range
 * (`rangeAt`). One source, so a match find highlights and an anchor's `TextPositionSelector` count
 * the same text. Plain ES2020, no template literals (it sits in one).
 *
 * Every built-in it calls is taken before content runs and called through the shell's `callOf`
 * (P129): the walker's step, a node's type, name and text (the `nodeType`, `localName` and
 * `nodeValue` getters), the body getter, a range's boundaries, and the map of nodes. Its
 * lists are the shell's prototype-less ones (`listOf`, `pushTo`), and the names it skips a lookup
 * with no prototype, so nothing content puts on `Array.prototype`, `Object.prototype`, `Map` or a
 * DOM prototype takes part in what it reads.
 */
export const TEXT_INDEX = String.raw`// The document's text: the body's text nodes in order, without scripts, styles, templates.
      const textNextNode = TreeWalker.prototype.nextNode;
      const textTypeOf = getterOf(Node.prototype, "nodeType");
      const textNameOf = getterOf(Element.prototype, "localName");
      const textValueOf = getterOf(Node.prototype, "nodeValue");
      const textBodyOf = getterOf(Document.prototype, "body");
      const textSetStart = Range.prototype.setStart;
      const textSetEnd = Range.prototype.setEnd;
      const textCollapse = Range.prototype.collapse;
      const textComparePoint = Range.prototype.comparePoint;
      const TextMap = Map;
      const textMapSet = Map.prototype.set;
      const textMapGet = Map.prototype.get;
      const textMapHas = Map.prototype.has;
      const TEXT_SHOW = NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT;
      const TEXT_ACCEPT = NodeFilter.FILTER_ACCEPT;
      const TEXT_REJECT = NodeFilter.FILTER_REJECT;
      const TEXT_SKIP = NodeFilter.FILTER_SKIP;
      const SKIPPED = bare(null);
      SKIPPED.script = 1;
      SKIPPED.style = 1;
      SKIPPED.noscript = 1;
      SKIPPED.template = 1;
      // A text node's text, read once through the kept getter; anything but a string is none.
      const textOf = (node) => {
        const value = textValueOf === null ? node.nodeValue : callOf(textValueOf, node, []);
        return typeof value === "string" ? value : "";
      };
      const textKind = (node) => (textTypeOf === null ? node.nodeType : callOf(textTypeOf, node, []));
      const textLesser = (a, b) => (a < b ? a : b);
      const skippedElement = (node) => SKIPPED[textNameOf === null ? node.localName : callOf(textNameOf, node, [])] === 1;
      const textIndex = () => {
        const nodes = listOf();
        const starts = listOf();
        const at = new TextMap();
        let text = "";
        const body = textBodyOf === null ? document.body : callOf(textBodyOf, document, []);
        if (body) {
          const walker = callOf(createTreeWalker, document, [body, TEXT_SHOW, {
            acceptNode: (node) => (textKind(node) === 1 ? (skippedElement(node) ? TEXT_REJECT : TEXT_SKIP) : TEXT_ACCEPT),
          }]);
          for (let node = callOf(textNextNode, walker, []); node !== null; node = callOf(textNextNode, walker, [])) {
            callOf(textMapSet, at, [node, nodes.length]);
            pushTo(nodes, node);
            pushTo(starts, text.length);
            text += textOf(node);
          }
        }
        return { nodes, starts, at, text };
      };
      // A boundary point as an offset into the text: in a text node, where it is; elsewhere, the
      // first text at or after it.
      const offsetOf = (index, container, offset) => {
        if (textKind(container) === 3 && callOf(textMapHas, index.at, [container])) {
          return index.starts[callOf(textMapGet, index.at, [container])] + textLesser(offset, textOf(container).length);
        }
        const point = callOf(createRange, document, []);
        try {
          callOf(textSetStart, point, [container, offset]);
        } catch (_) {
          return index.text.length;
        }
        callOf(textCollapse, point, [true]);
        let low = 0;
        let high = index.nodes.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (callOf(textComparePoint, point, [index.nodes[middle], 0]) >= 0) {
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
            offset = textOf(node).length;
          }
        } else {
          while (offset >= textOf(node).length && found + 1 < index.nodes.length) {
            found += 1;
            node = index.nodes[found];
            offset = 0;
          }
        }
        return { node, offset: textLesser(offset, textOf(node).length) };
      };
      const rangeAt = (index, start, end) => {
        const from = pointAt(index, start, false);
        const to = pointAt(index, end, true);
        if (from === null || to === null) {
          return null;
        }
        const range = callOf(createRange, document, []);
        try {
          callOf(textSetStart, range, [from.node, from.offset]);
          callOf(textSetEnd, range, [to.node, to.offset]);
        } catch (_) {
          return null;
        }
        return range;
      };`;
