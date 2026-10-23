import { attributesOf } from "./markup.ts";

/**
 * Whether a page's own styles hold it to one screen (P106), read from its text: no layout, a
 * cascade of the few properties that matter over the three elements that hold a document (html,
 * body, and the body's one element of content, `#root` in an app's build). An app shell's styles
 * (`html, body { height: 100%; overflow: hidden }`, `#root { position: fixed; height: 100dvh }`)
 * stop a long page at its first screen in a frame: the person's wheel finds nothing to scroll.
 *
 * What counts, per element, by its cascaded values:
 * - html with overflow-y hidden or clip (the viewport's own: nothing scrolls);
 * - body with overflow-y hidden or clip, where html's overflow is visible (body's then becomes the
 *   viewport's) or body is one screen tall;
 * - the root with overflow-y hidden or clip and one screen tall;
 * - any of them position: fixed and one screen tall (a fixed box's content scrolls nothing);
 * and nothing inside body that scrolls itself: no rule, style="" or Tailwind utility the check
 * reads gives an element below body (the root, or anything in it) overflow-y auto or scroll. Then
 * the page may scroll in that box, and the check can't tell which box holds what. One screen tall:
 * height or max-height 100vh (dvh, svh, lvh), or 100% of an element that is (html's 100% is the
 * frame's), or position fixed or absolute with both top and bottom set (`inset: 0`).
 *
 * What it reads: the page's `<style>` elements, the stylesheets it links that the caller finds
 * (a version's own files) and what they `@import`, in document order; style="" on the three; the
 * class rules that match their classes; and, where the page loads Tailwind from its CDN, the few
 * Tailwind utilities that hold a page (h-screen, overflow-hidden, fixed, inset-0…). Specificity,
 * order, !important and cascade layers decide between rules, so a later override is seen.
 * What it doesn't: rules under @media (but `all` and `screen`), @supports or @container, selectors
 * beyond type, id, class, `*`, `:root`, `:only-child`, `:first-child` and the descendant and child
 * combinators (`:is()`, `:where()`, `:not()`, attributes and siblings match nothing), nested
 * rules, values through var() or calc(), a stylesheet linked or imported a second time (read
 * where it first comes), and what scripts do. Each of those misses a lock, or an override (then the
 * warning is wrong); it never refuses anything.
 *
 * Bounded: each stylesheet is read once per page, at most `SHEETS` of them and `READ` bytes in all;
 * past that, the rest isn't read. What it echoes to the agent is only values of a known shape, and
 * selectors of plain characters, each cut to `ECHOED` characters.
 */

/** A stylesheet the page links, as the caller finds it from `from` (a path), or null. */
export type LinkedSheet = (
  href: string,
  from: string,
) => { readonly path: string; readonly text: string } | null;

export interface ScrollLock {
  /** What to change, for the agent. */
  readonly message: string;
  /** The file the rule that holds it is in (the page's own `path`, or a stylesheet's). */
  readonly path?: string;
  /** Its line (1-based). */
  readonly line: number;
}

/** How much of one stylesheet is read: its first 2 MiB. */
const SCANNED = 2 * 1024 * 1024;
/** How deep `@import` and `@layer` are followed. */
const DEEPEST = 8;
/** The most stylesheets read for one page, each once. */
export const SHEETS = 32;
/** The most bytes of stylesheets read for one page, in all. */
export const READ = 4 * 1024 * 1024;
/** The longest declaration or selector told back to the agent. */
const ECHOED = 60;

interface Source {
  readonly path: string | undefined;
  readonly text: string;
}

/** One declaration's value for one property of one element, and what put it there. */
interface Value {
  readonly value: string;
  /** As the page wrote it, for the agent: `overflow: hidden`, or a utility class's name. */
  readonly written: string;
  /** Where it was said: a rule (with its selector), style="", or a utility class. */
  readonly kind: "rule" | "inline" | "utility";
  readonly selector: string;
  readonly important: boolean;
  readonly layer: string | null;
  readonly inline: boolean;
  readonly specificity: readonly number[];
  readonly order: number;
  readonly source: Source;
  readonly at: number;
}

/** An element of the document's top, as its tag says. */
interface Node {
  readonly label: string;
  readonly tag: string;
  readonly id: string;
  readonly classes: readonly string[];
  readonly onlyChild: boolean;
  readonly firstChild: boolean;
  readonly style: { readonly text: string; readonly at: number } | null;
  readonly classAt: number;
  /** Every declaration for each longhand: the cascade picks once all are read (layers' order). */
  readonly candidates: Map<string, Value[]>;
  readonly values: Map<string, Value>;
}

interface Tag {
  readonly name: string;
  readonly attributes: readonly { name: string; value: string; at: number }[];
  /** Where the tag's attributes start in the page. */
  readonly at: number;
}

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** Elements whose text isn't markup (or never shown): read past, to their end tag. */
const RAW = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "noscript",
  "template",
  "iframe",
  "xmp",
  "noembed",
  "noframes",
]);
/** A body's children that hold no content. */
const NOT_CONTENT = new Set(["script", "style", "link", "meta", "noscript", "template", "base"]);

const TAG_AT = /<(\/?)([a-z][a-z0-9-]{0,30})\b([^<>]{0,8192})>/iuy;
const closers = new Map<string, RegExp>();
const closer = (name: string): RegExp => {
  let found = closers.get(name);
  if (found === undefined) {
    found = new RegExp(`</${name}\\s*>`, "giu");
    closers.set(name, found);
  }
  return found;
};

const attribute = (tag: Tag | null, name: string) =>
  tag?.attributes.find((each) => each.name === name);

/** Where a stylesheet comes from, in document order. */
type SheetRef =
  | { readonly kind: "style"; readonly start: number; readonly end: number; readonly tag: Tag }
  | { readonly kind: "link"; readonly tag: Tag };

/** What a page's markup says of its top: html's and body's tags, body's children, its sheets. */
function scanPage(page: string): {
  html: Tag | null;
  body: Tag | null;
  children: Tag[];
  childCount: number;
  content: Tag[];
  contentCount: number;
  sheets: SheetRef[];
  tailwind: boolean;
  styleScrolls: boolean;
  classScrolls: boolean;
} {
  let html: Tag | null = null;
  let body: Tag | null = null;
  const children: Tag[] = [];
  let childCount = 0;
  const content: Tag[] = [];
  let contentCount = 0;
  const sheets: SheetRef[] = [];
  let tailwind = false;
  let styleScrolls = false;
  let classScrolls = false;
  let inBody = false;
  let depth = 0;
  let at = page.indexOf("<");
  while (at >= 0 && at < page.length) {
    if (page.startsWith("<!--", at)) {
      const end = page.indexOf("-->", at + 4);
      at = end < 0 ? page.length : page.indexOf("<", end + 3);
      continue;
    }
    TAG_AT.lastIndex = at;
    const match = TAG_AT.exec(page);
    if (match === null) {
      at = page.indexOf("<", at + 1);
      continue;
    }
    const closing = match[1] === "/";
    const name = (match[2] ?? "").toLowerCase();
    const attributesAt = at + 1 + (match[1] ?? "").length + name.length;
    let next = at + match[0].length;
    if (closing) {
      if (inBody) {
        if (depth === 0 && (name === "body" || name === "html")) {
          inBody = false;
        } else if (depth > 0) {
          depth -= 1;
        }
      }
      at = page.indexOf("<", next);
      continue;
    }
    const tag: Tag = { name, attributes: attributesOf(match[3] ?? ""), at: attributesAt };
    if (name === "html" && html === null) {
      html = tag;
    } else if (name === "body" && body === null) {
      body = tag;
      inBody = true;
      depth = 0;
    } else if (inBody) {
      // An element below body that scrolls itself, as its markup says.
      styleScrolls ||= declaresScroll(attribute(tag, "style")?.value ?? "");
      classScrolls ||= SCROLL_UTILITY.test(attribute(tag, "class")?.value ?? "");
    }
    if (inBody && depth === 0 && name !== "body") {
      childCount += 1;
      if (children.length < 2) {
        children.push(tag);
      }
      if (!NOT_CONTENT.has(name)) {
        contentCount += 1;
        if (content.length < 2) {
          content.push(tag);
        }
      }
    }
    if (name === "link") {
      const href = attribute(tag, "href")?.value ?? "";
      if (/tailwindcss/iu.test(href)) {
        tailwind = true;
      }
      sheets.push({ kind: "link", tag });
    } else if (name === "script" && /tailwindcss/iu.test(attribute(tag, "src")?.value ?? "")) {
      tailwind = true;
    }
    if (RAW.has(name)) {
      const end = closer(name);
      end.lastIndex = next;
      const found = end.exec(page);
      if (name === "style") {
        sheets.push({
          kind: "style",
          start: next,
          end: found === null ? page.length : found.index,
          tag,
        });
      }
      next = found === null ? page.length : found.index + found[0].length;
    } else if (inBody && name !== "body" && !VOID.has(name)) {
      depth += 1;
    }
    at = page.indexOf("<", next);
  }
  return {
    html,
    body,
    children,
    childCount,
    content,
    contentCount,
    sheets,
    tailwind,
    styleScrolls,
    classScrolls,
  };
}

/** Tailwind's utilities that make a box scroll itself. */
const SCROLL_UTILITY = /(?:^|\s)overflow-(?:y-)?(?:auto|scroll)(?:\s|$)/u;

/** Whether declarations (a block's, or style="") give overflow-y auto or scroll. */
function declaresScroll(text: string): boolean {
  for (const match of text.matchAll(
    /(?:^|[\s;{])overflow(-y)?\s{0,64}:\s{0,64}([^;{}!]{0,256})/giu,
  )) {
    const parts = (match[2] ?? "").trim().toLowerCase().split(/\s+/u);
    const y = match[1] === undefined ? (parts[1] ?? parts[0]) : parts[0];
    if (y !== undefined && SCROLLS.has(y)) {
      return true;
    }
  }
  return false;
}

/** A text with its comments blanked (same length, same lines), strings kept. */
function withoutComments(text: string): string {
  let out = "";
  let from = 0;
  let at = 0;
  while (at < text.length) {
    const code = text[at];
    if (code === '"' || code === "'") {
      at = stringEnd(text, at, text.length);
    } else if (code === "/" && text[at + 1] === "*") {
      const close = text.indexOf("*/", at + 2);
      const end = close < 0 ? text.length : close + 2;
      out += text.slice(from, at) + text.slice(at, end).replace(/[^\n]/gu, " ");
      from = end;
      at = end;
    } else {
      at += 1;
    }
  }
  return out + text.slice(from);
}

/** Past the string that starts at `at` (its quote): its end quote, a newline, or `to`. */
function stringEnd(text: string, at: number, to: number): number {
  const quote = text[at];
  let index = at + 1;
  while (index < to) {
    const code = text[index];
    if (code === "\\") {
      index += 2;
    } else if (code === quote || code === "\n") {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return to;
}

/** Past the block whose `{` is at `at`: after its `}`, or `to`. */
function blockEnd(text: string, at: number, to: number): number {
  let depth = 0;
  let index = at;
  while (index < to) {
    const code = text[index];
    if (code === '"' || code === "'") {
      index = stringEnd(text, index, to);
      continue;
    }
    if (code === "{") {
      depth += 1;
    } else if (code === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }
  return to;
}

/** The next rule or statement from `at`: its prelude, and its block's bounds if it has one. */
function nextItem(
  text: string,
  at: number,
  to: number,
): { prelude: string; block: readonly [number, number] | null; end: number } | null {
  let start = at;
  while (start < to && /\s/u.test(text[start] ?? "")) {
    start += 1;
  }
  if (start >= to) {
    return null;
  }
  let parens = 0;
  let index = start;
  while (index < to) {
    const code = text[index];
    if (code === '"' || code === "'") {
      index = stringEnd(text, index, to);
      continue;
    }
    if (code === "(") {
      parens += 1;
    } else if (code === ")") {
      parens = Math.max(0, parens - 1);
    } else if (parens === 0 && code === "{") {
      const end = blockEnd(text, index, to);
      return {
        prelude: text.slice(start, index).trim(),
        block: [index + 1, Math.max(index + 1, end - 1)],
        end,
      };
    } else if (parens === 0 && (code === ";" || code === "}")) {
      return { prelude: text.slice(start, index).trim(), block: null, end: index + 1 };
    }
    index += 1;
  }
  return { prelude: text.slice(start, to).trim(), block: null, end: to };
}

/** Splits at top-level commas (not inside parentheses or strings). */
function splitList(text: string): string[] {
  const out: string[] = [];
  let parens = 0;
  let from = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text[index];
    if (code === '"' || code === "'") {
      index = stringEnd(text, index, text.length) - 1;
    } else if (code === "(") {
      parens += 1;
    } else if (code === ")") {
      parens = Math.max(0, parens - 1);
    } else if (code === "," && parens === 0) {
      out.push(text.slice(from, index));
      from = index + 1;
    }
  }
  out.push(text.slice(from));
  return out.map((each) => each.trim()).filter((each) => each !== "");
}

interface Compound {
  readonly tag: string | null;
  readonly ids: readonly string[];
  readonly classes: readonly string[];
  readonly root: boolean;
  readonly onlyChild: boolean;
  readonly firstChild: boolean;
}

interface Selector {
  readonly compounds: readonly Compound[];
  /** Between compound k and k + 1. */
  readonly combinators: readonly (" " | ">")[];
  readonly specificity: readonly [number, number, number];
}

/** An identifier at `at`, its escapes read; null where there is none. */
function identAt(text: string, at: number): { value: string; end: number } | null {
  let value = "";
  let index = at;
  while (index < text.length) {
    const code = text[index] ?? "";
    if (code === "\\") {
      const hex = /^[0-9a-f]{1,6}\s?/iu.exec(text.slice(index + 1, index + 8));
      if (hex !== null) {
        value += String.fromCodePoint(Number.parseInt(hex[0].trim(), 16) || 0xfffd);
        index += 1 + hex[0].length;
      } else if (index + 1 < text.length) {
        value += text[index + 1];
        index += 2;
      } else {
        break;
      }
    } else if (/[\w-]/u.test(code) || code.charCodeAt(0) > 0x7f) {
      value += code;
      index += 1;
    } else {
      break;
    }
  }
  return value === "" ? null : { value, end: index };
}

/** A selector this check can match, or null (it then matches nothing here). */
function parseSelector(text: string): Selector | null {
  const compounds: Compound[] = [];
  const combinators: (" " | ">")[] = [];
  let ids = 0;
  let classLike = 0;
  let tags = 0;
  let index = 0;
  let pending: " " | ">" | null = null;
  while (index < text.length) {
    const code = text[index] ?? "";
    if (/\s/u.test(code)) {
      pending ??= " ";
      index += 1;
      continue;
    }
    if (code === ">") {
      pending = ">";
      index += 1;
      continue;
    }
    if (compounds.length > 0) {
      if (pending === null) {
        return null;
      }
      combinators.push(pending);
    } else if (pending === ">") {
      return null;
    }
    pending = null;
    let tag: string | null = null;
    const compoundIds: string[] = [];
    const compoundClasses: string[] = [];
    let root = false;
    let onlyChild = false;
    let firstChild = false;
    if (text[index] === "*") {
      index += 1;
    } else {
      const name = identAt(text, index);
      if (name !== null) {
        tag = name.value.toLowerCase();
        tags += 1;
        index = name.end;
      }
    }
    let read = tag !== null || text[index - 1] === "*";
    while (index < text.length) {
      const mark = text[index];
      if (mark === "#" || mark === ".") {
        const name = identAt(text, index + 1);
        if (name === null) {
          return null;
        }
        if (mark === "#") {
          compoundIds.push(name.value);
          ids += 1;
        } else {
          compoundClasses.push(name.value);
          classLike += 1;
        }
        index = name.end;
      } else if (mark === ":") {
        if (text[index + 1] === ":") {
          return null;
        }
        const name = identAt(text, index + 1);
        const pseudo = name?.value.toLowerCase();
        if (name === null || text[name.end] === "(") {
          return null;
        }
        if (pseudo === "root") {
          root = true;
        } else if (pseudo === "only-child") {
          onlyChild = true;
        } else if (pseudo === "first-child") {
          firstChild = true;
        } else {
          return null;
        }
        classLike += 1;
        index = name.end;
      } else {
        break;
      }
      read = true;
    }
    if (!read) {
      return null;
    }
    compounds.push({
      tag,
      ids: compoundIds,
      classes: compoundClasses,
      root,
      onlyChild,
      firstChild,
    });
  }
  if (compounds.length === 0 || pending === ">") {
    return null;
  }
  return { compounds, combinators, specificity: [ids, classLike, tags] };
}

const compoundMatches = (compound: Compound, node: Node, index: number): boolean =>
  (compound.tag === null || compound.tag === node.tag) &&
  compound.ids.every((id) => id === node.id) &&
  compound.classes.every((name) => node.classes.includes(name)) &&
  (!compound.root || index === 0) &&
  (!compound.onlyChild || node.onlyChild) &&
  (!compound.firstChild || node.firstChild);

/** Whether `selector` matches `chain[index]` (each element's parent is the one before it). */
function matches(selector: Selector, chain: readonly Node[], index: number): boolean {
  const at = (k: number, i: number): boolean => {
    const compound = selector.compounds[k];
    const node = chain[i];
    if (compound === undefined || node === undefined || !compoundMatches(compound, node, i)) {
      return false;
    }
    if (k === 0) {
      return true;
    }
    if (selector.combinators[k - 1] === ">") {
      return at(k - 1, i - 1);
    }
    for (let j = i - 1; j >= 0; j -= 1) {
      if (at(k - 1, j)) {
        return true;
      }
    }
    return false;
  };
  return at(selector.compounds.length - 1, index);
}

/** The longhands this check reads, from the properties that set them. */
function longhands(property: string, value: string): [string, string][] {
  const parts = value.split(/\s+/u).filter((each) => each !== "");
  switch (property) {
    case "overflow":
      return [
        ["overflow-x", parts[0] ?? ""],
        ["overflow-y", parts[1] ?? parts[0] ?? ""],
      ];
    case "inset":
      return [
        ["top", parts[0] ?? ""],
        ["bottom", parts[2] ?? parts[0] ?? ""],
      ];
    case "inset-block":
      return [
        ["top", parts[0] ?? ""],
        ["bottom", parts[1] ?? parts[0] ?? ""],
      ];
    case "overflow-x":
    case "overflow-y":
    case "height":
    case "max-height":
    case "position":
    case "top":
    case "bottom":
      return [[property, value]];
    default:
      return [];
  }
}

/** Tailwind's utilities that hold a page, as the CSS they are. */
const UTILITIES: Readonly<Record<string, readonly [string, string]>> = {
  "h-screen": ["height", "100vh"],
  "h-dvh": ["height", "100dvh"],
  "h-svh": ["height", "100svh"],
  "h-lvh": ["height", "100lvh"],
  "h-full": ["height", "100%"],
  "h-auto": ["height", "auto"],
  "max-h-screen": ["max-height", "100vh"],
  "max-h-dvh": ["max-height", "100dvh"],
  "max-h-svh": ["max-height", "100svh"],
  "max-h-full": ["max-height", "100%"],
  "overflow-hidden": ["overflow", "hidden"],
  "overflow-clip": ["overflow", "clip"],
  "overflow-auto": ["overflow", "auto"],
  "overflow-scroll": ["overflow", "scroll"],
  "overflow-visible": ["overflow", "visible"],
  "overflow-y-hidden": ["overflow-y", "hidden"],
  "overflow-y-clip": ["overflow-y", "clip"],
  "overflow-y-auto": ["overflow-y", "auto"],
  "overflow-y-scroll": ["overflow-y", "scroll"],
  "overflow-y-visible": ["overflow-y", "visible"],
  fixed: ["position", "fixed"],
  absolute: ["position", "absolute"],
  relative: ["position", "relative"],
  static: ["position", "static"],
  sticky: ["position", "sticky"],
  "inset-0": ["inset", "0"],
  "inset-y-0": ["inset-block", "0"],
  "top-0": ["top", "0"],
  "bottom-0": ["bottom", "0"],
};

const compare = (a: readonly number[], b: readonly number[]): number => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

/** An element a rule's selector matches, and how specifically (its most specific one). */
interface Target {
  readonly node: Node;
  readonly specificity: readonly number[];
  readonly selector: string;
}

/** A stylesheet found for the page, once: its path and text. */
type Found = { readonly path: string; readonly text: string } | null;

/** The cascade over the chain: each declaration that matches, then the one that wins. */
class Cascade {
  readonly chain: readonly Node[];
  /** Layer names, in the order they were first declared or opened (`a`, `a.b`). */
  readonly layers: string[] = [];
  readonly known = new Set<string>();
  /** Some rule the check reads gives an element below body overflow-y auto or scroll. */
  scrollsInside = false;
  order = 0;
  anonymous = 0;
  /** The stylesheets read for this page, by path: each once, within the budget. */
  readonly read = new Set<string>();
  bytes = 0;
  readonly find: (href: string, from: string) => Found;

  constructor(chain: readonly Node[], find: (href: string, from: string) => Found) {
    this.chain = chain;
    this.find = find;
  }

  /** A layer, declared (its parents first): its place is where it first comes. */
  declare(name: string) {
    if (this.known.has(name)) {
      return;
    }
    const dot = name.lastIndexOf(".");
    if (dot > 0) {
      this.declare(name.slice(0, dot));
    }
    this.known.add(name);
    this.layers.push(name);
  }

  /**
   * Each layer's rank, low to high: a layer's sub-layers before its own rules, layers in the order
   * they were first declared, unlayered rules (the document's own) above them all.
   */
  ranks(): Map<string | null, number> {
    const children = new Map<string | null, string[]>();
    for (const name of this.layers) {
      const dot = name.lastIndexOf(".");
      const parent = dot > 0 ? name.slice(0, dot) : null;
      children.set(parent, [...(children.get(parent) ?? []), name]);
    }
    const out = new Map<string | null, number>();
    const visit = (name: string | null) => {
      for (const child of children.get(name) ?? []) {
        visit(child);
      }
      out.set(name, out.size);
    };
    visit(null);
    return out;
  }

  /** Whether a stylesheet may still be read for this page (once, within the budget). */
  take(found: Found): found is { path: string; text: string } {
    if (found === null || this.read.has(found.path) || this.read.size >= SHEETS) {
      return false;
    }
    const size = Math.min(found.text.length, SCANNED);
    if (this.bytes + size > READ) {
      return false;
    }
    this.read.add(found.path);
    this.bytes += size;
    return true;
  }

  /** A declaration for `node`, kept until the cascade picks. */
  set(
    node: Node,
    property: string,
    value: string,
    rank: {
      important: boolean;
      layer: string | null;
      inline: boolean;
      specificity: readonly number[];
    },
    where: {
      source: Source;
      at: number;
      selector: string;
      written?: string;
      kind?: Value["kind"];
    },
  ) {
    if (rank.layer !== null) {
      this.declare(rank.layer);
    }
    this.order += 1;
    for (const [longhand, longValue] of longhands(property, value)) {
      const each: Value = {
        value: longValue,
        written:
          where.written ?? `${echoed(property, value)}${rank.important ? " !important" : ""}`,
        kind: where.kind ?? (rank.inline ? "inline" : "rule"),
        selector: where.selector,
        important: rank.important,
        layer: rank.layer,
        inline: rank.inline,
        specificity: rank.specificity,
        order: this.order,
        source: where.source,
        at: where.at,
      };
      node.candidates.set(longhand, [...(node.candidates.get(longhand) ?? []), each]);
    }
  }

  /** Picks each longhand's winner, once every rule is read and the layers' order is known. */
  resolve() {
    const ranks = this.ranks();
    const top = ranks.get(null) ?? 0;
    const priority = (each: Value): number[] => {
      const rank = ranks.get(each.layer) ?? top;
      // Normal: later layers win, unlayered most. !important: reversed. style="" above both.
      const score = each.inline ? (each.important ? 1 : top + 1) : each.important ? -rank : rank;
      return [each.important ? 1 : 0, score, ...each.specificity, each.order];
    };
    for (const node of this.chain) {
      for (const [property, candidates] of node.candidates) {
        let best: Value | undefined;
        let bestPriority: number[] = [];
        for (const each of candidates) {
          const mine = priority(each);
          if (best === undefined || compare(mine, bestPriority) > 0) {
            best = each;
            bestPriority = mine;
          }
        }
        if (best !== undefined) {
          node.values.set(property, best);
        }
      }
    }
  }

  /** The declarations of a block (`from`..`to` of `text`), for the nodes given. */
  declarations(
    text: string,
    from: number,
    to: number,
    targets: readonly Target[],
    rank: { layer: string | null; inline: boolean },
    source: Source,
    base: number,
  ) {
    let start = from;
    let index = from;
    let parens = 0;
    const take = (end: number) => {
      const segment = text.slice(start, end);
      const colon = segment.indexOf(":");
      if (colon > 0) {
        const property = segment.slice(0, colon).trim().toLowerCase();
        let value = segment
          .slice(colon + 1)
          .trim()
          .toLowerCase()
          .replace(/\s+/gu, " ");
        const important = /!\s*important$/u.test(value);
        if (important) {
          value = value.replace(/\s*!\s*important$/u, "");
        }
        if (!property.startsWith("--") && longhands(property, value).length > 0) {
          const offset = start + (segment.length - segment.trimStart().length);
          for (const target of targets) {
            this.set(
              target.node,
              property,
              value,
              {
                important,
                layer: rank.layer,
                inline: rank.inline,
                specificity: target.specificity,
              },
              { source, at: base + offset, selector: target.selector },
            );
          }
        }
      }
    };
    while (index < to) {
      const code = text[index];
      if (code === '"' || code === "'") {
        index = stringEnd(text, index, to);
        continue;
      }
      if (code === "(") {
        parens += 1;
      } else if (code === ")") {
        parens = Math.max(0, parens - 1);
      } else if (parens === 0 && code === ";") {
        take(index);
        start = index + 1;
      } else if (parens === 0 && code === "{") {
        // A nested rule: not read (its prelude is dropped with it).
        index = blockEnd(text, index, to);
        start = index;
        continue;
      }
      index += 1;
    }
    take(to);
  }

  /** A stylesheet the page links or a sheet imports, if it may still be read. */
  file(found: Found, layer: string | null) {
    if (!this.take(found)) {
      return;
    }
    const text = found.text.slice(0, SCANNED);
    this.sheet(withoutComments(text), 0, text.length, {
      source: { path: found.path, text },
      base: 0,
      layer,
      // A file starts again at the top: it is read once, within the budget, however it's reached.
      depth: 0,
      from: found.path,
    });
  }

  /** A stylesheet's rules (`text` is comment-free; offsets are `base` + its own). */
  sheet(
    text: string,
    from: number,
    to: number,
    context: {
      source: Source;
      base: number;
      layer: string | null;
      depth: number;
      /** Where its imports are found from: its own path, or the page's. */
      from: string;
    },
  ) {
    if (context.depth > DEEPEST) {
      return;
    }
    let ruled = false;
    let at = from;
    for (let item = nextItem(text, at, to); item !== null; item = nextItem(text, at, to)) {
      at = item.end;
      const { prelude, block } = item;
      const within = (name: string) => (context.layer === null ? name : `${context.layer}.${name}`);
      if (prelude.startsWith("@")) {
        const name = /^@([\w-]+)/u.exec(prelude)?.[1]?.toLowerCase() ?? "";
        const rest = prelude.slice(name.length + 1).trim();
        if (name === "import" && block === null && !ruled) {
          this.import(rest, context, within);
        } else if (name === "layer") {
          const names = splitList(rest);
          if (block === null) {
            for (const each of names) {
              this.declare(within(each));
            }
          } else {
            this.anonymous += 1;
            const layer = within(names[0] ?? `\u0000${this.anonymous}`);
            // Its place is where its block opens, whatever it holds.
            this.declare(layer);
            this.sheet(text, block[0], block[1], { ...context, layer, depth: context.depth + 1 });
          }
        } else if (
          name === "media" &&
          block !== null &&
          /^(?:only\s+)?(?:all|screen)$/iu.test(rest)
        ) {
          this.sheet(text, block[0], block[1], { ...context, depth: context.depth + 1 });
        }
        continue;
      }
      ruled = true;
      if (block === null) {
        continue;
      }
      const targets: Target[] = [];
      let below = false;
      for (const each of splitList(prelude)) {
        const selector = parseSelector(each);
        let top = false;
        if (selector !== null) {
          this.chain.forEach((node, index) => {
            if (!matches(selector, this.chain, index)) {
              return;
            }
            top ||= index < 2;
            const found = targets.find((target) => target.node === node);
            if (found === undefined) {
              targets.push({ node, specificity: selector.specificity, selector: each });
            } else if (compare(selector.specificity, found.specificity) > 0) {
              targets.splice(targets.indexOf(found), 1, {
                node,
                specificity: selector.specificity,
                selector: each,
              });
            }
          });
        }
        // A selector for anything but html or body may name an element below body.
        below ||= !top;
      }
      if (below && !this.scrollsInside && declaresScroll(text.slice(block[0], block[1]))) {
        this.scrollsInside = true;
      }
      if (targets.length > 0) {
        this.declarations(
          text,
          block[0],
          block[1],
          targets,
          { layer: context.layer, inline: false },
          context.source,
          context.base,
        );
      }
    }
  }

  import(rest: string, context: Parameters<Cascade["sheet"]>[3], within: (name: string) => string) {
    const parsed = /^(?:url\(\s*(["']?)([^"'()\s]+)\1\s*\)|(["'])([^"']+)\3)\s*([\s\S]*)$/iu.exec(
      rest,
    );
    if (parsed === null) {
      return;
    }
    const href = parsed[2] ?? parsed[4] ?? "";
    let tail = parsed[5]?.trim() ?? "";
    let layer = context.layer;
    const named = /^layer\(\s*([\w.-]+)\s*\)\s*/iu.exec(tail);
    if (named !== null) {
      layer = within(named[1] ?? "");
      tail = tail.slice(named[0].length);
    } else if (/^layer\b\s*/iu.test(tail)) {
      this.anonymous += 1;
      layer = within(`\u0000${this.anonymous}`);
      tail = tail.replace(/^layer\b\s*/iu, "");
    }
    if (tail !== "" && !/^(?:only\s+)?(?:all|screen)$/iu.test(tail)) {
      return;
    }
    if (layer !== null) {
      this.declare(layer);
    }
    this.file(this.find(href, context.from), layer);
  }
}

/** A value of a shape the check knows, as the agent may be told it; else its property alone. */
const KNOWN =
  /^(?:(?:-?(?:\d{1,6}(?:\.\d{1,4})?|\.\d{1,4})(?:px|%|d?vh|svh|lvh|vw|em|rem)?|auto|hidden|clip|visible|scroll|overlay|fixed|absolute|static|relative|sticky|none)(?: |$)){1,4}$/u;
const echoed = (property: string, value: string): string => {
  const said = `${property}: ${KNOWN.test(value) ? value : "…"}`;
  return said.length > ECHOED ? `${said.slice(0, ECHOED - 1)}…` : said;
};
/** A selector the agent may be told: plain characters, short. */
const PLAIN_SELECTOR = new RegExp(`^[\\w#.:>* ()-]{1,${ECHOED}}$`, "u");

const SCREEN = /^100(?:d|s|l)?vh$/u;
const CLIPS = new Set(["hidden", "clip"]);
const SCROLLS = new Set(["auto", "scroll", "overlay"]);
const RESET = new Set(["initial", "unset", "revert", "revert-layer"]);

const lineOf = (text: string, index: number): number => {
  let line = 1;
  for (let at = text.indexOf("\n"); at >= 0 && at < index; at = text.indexOf("\n", at + 1)) {
    line += 1;
  }
  return line;
};

/** What holds one element: the values that do, its line, and the fix's parts. */
interface Hold {
  readonly node: Node;
  readonly shown: readonly Value[];
  readonly at: Value;
}

/**
 * Whether `page`'s own styles hold it to one screen, and what to tell the agent; null where they
 * don't (or where it can't tell). `sheet` finds what the page links (a version's own files).
 */
export function scrollLock(
  page: string,
  options: { readonly noun: string; readonly path?: string; readonly sheet?: LinkedSheet },
): ScrollLock | null {
  const scanned = scanPage(page);
  const pageSource: Source = { path: options.path, text: page };
  const nodeOf = (tag: Tag | null, name: string, label: string, child: boolean): Node => {
    const style = attribute(tag, "style");
    const classes = attribute(tag, "class");
    return {
      label,
      tag: name,
      id: attribute(tag, "id")?.value ?? "",
      classes: (classes?.value ?? "").split(/\s+/u).filter((each) => each !== ""),
      onlyChild: child && scanned.childCount === 1,
      firstChild: child && scanned.children[0] === tag,
      style:
        style === undefined || tag === null ? null : { text: style.value, at: tag.at + style.at },
      classAt: tag === null || classes === undefined ? 0 : tag.at + classes.at,
      candidates: new Map(),
      values: new Map(),
    };
  };
  const chain: Node[] = [
    nodeOf(scanned.html, "html", "html", false),
    nodeOf(scanned.body, "body", "body", false),
  ];
  const rootTag =
    scanned.body !== null && scanned.contentCount === 1 ? scanned.content[0] : undefined;
  if (rootTag !== undefined) {
    const id = attribute(rootTag, "id")?.value ?? "";
    chain.push(
      nodeOf(
        rootTag,
        rootTag.name,
        /^[a-z_][\w-]*$/iu.test(id) ? `#${id}` : `body > ${rootTag.name}`,
        true,
      ),
    );
  }

  // Each stylesheet is asked for once per place it is named from, and read once (`take`).
  const linked = options.sheet;
  const asked = new Map<string, Found>();
  const find = (href: string, from: string): Found => {
    if (linked === undefined) {
      return null;
    }
    const key = `${from}\n${href}`;
    if (!asked.has(key)) {
      asked.set(key, linked(href, from));
    }
    return asked.get(key) ?? null;
  };
  const cascade = new Cascade(chain, find);
  const from = options.path ?? "";
  for (const sheet of scanned.sheets) {
    const media = attribute(sheet.tag, "media")?.value.trim() ?? "";
    if (media !== "" && !/^(?:only\s+)?(?:all|screen)$/iu.test(media)) {
      continue;
    }
    if (sheet.kind === "style") {
      const text = withoutComments(page.slice(sheet.start, sheet.end));
      cascade.sheet(text, 0, text.length, {
        source: pageSource,
        base: sheet.start,
        layer: null,
        depth: 0,
        from,
      });
      continue;
    }
    const rel = (attribute(sheet.tag, "rel")?.value ?? "").toLowerCase().split(/\s+/u);
    const href = attribute(sheet.tag, "href")?.value ?? "";
    if (
      !rel.includes("stylesheet") ||
      rel.includes("alternate") ||
      attribute(sheet.tag, "disabled") !== undefined ||
      href === ""
    ) {
      continue;
    }
    cascade.file(find(href, from), null);
  }
  for (const node of chain) {
    if (node.style !== null) {
      cascade.declarations(
        node.style.text,
        0,
        node.style.text.length,
        [{ node, specificity: [0, 0, 0], selector: "" }],
        { layer: null, inline: true },
        pageSource,
        node.style.at,
      );
    }
  }
  if (scanned.tailwind) {
    for (const node of chain) {
      for (const name of node.classes) {
        const utility = Object.hasOwn(UTILITIES, name) ? UTILITIES[name] : undefined;
        if (utility !== undefined) {
          cascade.set(
            node,
            utility[0],
            utility[1],
            { important: false, layer: null, inline: false, specificity: [0, 1, 0] },
            { source: pageSource, at: node.classAt, selector: "", written: name, kind: "utility" },
          );
        }
      }
    }
  }

  cascade.resolve();
  // Something below body scrolls itself: the page may scroll in it (the manual's line on the
  // wheel says the rest). Not a hold the check can be sure of.
  if (cascade.scrollsInside || scanned.styleScrolls || (scanned.tailwind && scanned.classScrolls)) {
    return null;
  }

  // Each element's computed values, from the outside in.
  const value = (node: Node, property: string): Value | undefined => {
    const found = node.values.get(property);
    return found === undefined || RESET.has(found.value) ? undefined : found;
  };
  const overflowY = (node: Node): string => {
    const y = value(node, "overflow-y")?.value ?? "visible";
    const x = value(node, "overflow-x")?.value ?? "visible";
    // One axis that isn't visible or clip makes the other's visible auto (and its clip hidden).
    if (y === "visible" && (CLIPS.has(x) || SCROLLS.has(x)) && x !== "clip") {
      return "auto";
    }
    return y;
  };
  const htmlVisible = (() => {
    const html = chain[0];
    return (
      html !== undefined &&
      (value(html, "overflow-x")?.value ?? "visible") === "visible" &&
      (value(html, "overflow-y")?.value ?? "visible") === "visible"
    );
  })();
  interface State {
    readonly screen: boolean;
    readonly shown: readonly Value[];
    readonly position: string;
  }
  const states: State[] = [];
  for (const [index, node] of chain.entries()) {
    const parent = index === 0 ? true : (states[index - 1]?.screen ?? false);
    const position = value(node, "position");
    const positioned = position?.value === "fixed" || position?.value === "absolute";
    const shown: Value[] = [];
    const tall = (property: string): boolean => {
      const found = value(node, property);
      const is =
        found !== undefined &&
        (SCREEN.test(found.value) || (found.value === "100%" && (parent || positioned)));
      if (is && found !== undefined) {
        shown.push(found);
      }
      return is;
    };
    const top = value(node, "top");
    const bottom = value(node, "bottom");
    const spanned =
      positioned &&
      top !== undefined &&
      bottom !== undefined &&
      top.value !== "auto" &&
      bottom.value !== "auto";
    if (spanned) {
      shown.unshift(top, bottom);
    }
    const height = tall("height");
    const maxHeight = tall("max-height");
    if (positioned && position !== undefined && (spanned || height || maxHeight)) {
      shown.unshift(position);
    }
    states.push({ screen: height || maxHeight || spanned, shown, position: position?.value ?? "" });
  }
  const scrollBox = (index: number): boolean => {
    const node = chain[index];
    return node !== undefined && SCROLLS.has(overflowY(node)) && (states[index]?.screen ?? false);
  };
  const holds: Hold[] = [];
  for (const [index, node] of chain.entries()) {
    const state = states[index];
    if (state === undefined) {
      continue;
    }
    if (chain.slice(index + 1).some((_, deeper) => scrollBox(index + 1 + deeper))) {
      continue;
    }
    const clips = CLIPS.has(overflowY(node));
    const overflow = value(node, "overflow-y");
    const clipped =
      clips && (index === 0 ? true : index === 1 ? state.screen || htmlVisible : state.screen);
    const fixed = state.position === "fixed" && state.screen && !SCROLLS.has(overflowY(node));
    if (!clipped && !fixed) {
      continue;
    }
    const shown = [...state.shown, ...(clips && overflow !== undefined ? [overflow] : [])];
    const at = clipped && overflow !== undefined ? overflow : (shown[0] ?? overflow);
    if (at !== undefined) {
      holds.push({ node, shown: [...new Set(shown)], at });
    }
  }
  const first = holds[0];
  if (first === undefined) {
    return null;
  }

  // What holds it, as the agent wrote it: "html and body (height: 100%; overflow: hidden)".
  const written = (hold: Hold, kind: Value["kind"]): string[] => [
    ...new Set(hold.shown.filter((each) => each.kind === kind).map((each) => each.written)),
  ];
  const described = (hold: Hold): string => {
    const inline = written(hold, "inline");
    const utilities = written(hold, "utility");
    return [
      written(hold, "rule").join("; "),
      inline.length === 0 ? "" : `style="${inline.join("; ")}"`,
      utilities.length === 0 ? "" : `class ${utilities.join(" ")}`,
    ]
      .filter((each) => each !== "")
      .join("; ");
  };
  const groups: { labels: string[]; what: string }[] = [];
  for (const hold of holds) {
    const what = described(hold);
    const last = groups.at(-1);
    if (last !== undefined && last.what === what) {
      last.labels.push(hold.node.label);
    } else {
      groups.push({ labels: [hold.node.label], what });
    }
  }
  const and = (items: readonly string[]): string =>
    items.length <= 1
      ? (items[0] ?? "")
      : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
  const what = and(groups.map((group) => `${and(group.labels)} (${group.what})`));

  // The fix: a later rule that undoes the rules' values, under their own selectors (so it wins
  // by coming later); what style="" and utility classes say is taken out where it is.
  const rules = holds.flatMap((hold) => hold.shown.filter((each) => each.kind === "rule"));
  const selectors = [
    ...new Set(
      holds.flatMap((hold) => {
        const own = hold.shown.filter((each) => each.kind === "rule");
        const strongest = own.reduce<Value | undefined>(
          (best, each) =>
            best === undefined || compare(each.specificity, best.specificity) > 0 ? each : best,
          undefined,
        );
        // A selector the agent may be told as it is; else the element's own name.
        return strongest === undefined
          ? []
          : [PLAIN_SELECTOR.test(strongest.selector) ? strongest.selector : hold.node.label];
      }),
    ),
  ];
  const says = (prefixes: readonly string[]) =>
    rules.some((each) => prefixes.some((prefix) => each.written.startsWith(prefix)));
  const important = rules.some((each) => each.important) ? " !important" : "";
  const reset = [
    says(["height", "inset", "top", "bottom"]) ? "height: auto" : null,
    says(["max-height"]) ? "max-height: none" : null,
    says(["overflow"]) ? "overflow: visible" : null,
    says(["position"]) ? "position: static" : null,
  ]
    .filter((each) => each !== null)
    .map((each) => `${each}${important}`);
  const fixes: string[] = [];
  if (selectors.length > 0 && reset.length > 0) {
    fixes.push(`add ${selectors.join(", ")} { ${reset.join("; ")} } after those rules`);
  }
  for (const hold of holds) {
    const inline = written(hold, "inline");
    if (inline.length > 0) {
      fixes.push(`take ${inline.join("; ")} out of ${hold.node.label}'s style attribute`);
    }
    const utilities = written(hold, "utility");
    if (utilities.length > 0) {
      fixes.push(`take ${utilities.join(" ")} off ${hold.node.label}'s class`);
    }
  }
  return {
    message: `The ${options.noun} won't scroll in its frame: ${what} hold${holds.length === 1 ? "s" : ""} it to one screen, and what's below can't be reached. Unless it is meant to fit one screen, let it scroll as a document: ${and(fixes)}.`,
    ...(first.at.source.path === undefined ? {} : { path: first.at.source.path }),
    line: lineOf(first.at.source.text, first.at.at),
  };
}
