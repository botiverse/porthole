# Insertion entry points the frame guard covers

The shell's frame guard (step 3 of the runtime, `src/shell/runtime.ts`; P030, P128, P129, P130)
keeps frame-like elements (`FRAMES`: `iframe`, `frame`, `frameset`, `object`, `embed`, `portal`,
`fencedframe`) and the resource hints a CSP doesn't govern (`HINTS`) out of every tree content can
reach. This page lists every way content can put a node into a document, or get a subtree it can
put in later, and how each is guarded. `test/shell.test.ts` checks each row against the runtime.

The invariant (P130): **every insertion entry point is guarded, every subtree producer strips
before it returns, and under the default configuration no frame-capable element can exist in a
content-reachable tree.** The mutation observer stays behind all of it as the backstop.

Statuses:

- **wrapped**: the method or setter runs every node argument through `admit`/`strip` (built-ins
  captured before content runs, called through `callOf`) before the platform connects anything.
  This holds whatever the parent is, connected or detached.
- **parsed and stripped**: the markup is parsed in a detached element of the same kind (`parseIn`)
  or by the platform's own parser, stripped, then moved in through a wrapped method or returned.
- **producer stripped**: an API that hands content a subtree strips that subtree synchronously
  before content gets it.
- **refused**: the call throws a neutral error, as `document.write` does, and nothing is made.
- **text only**: the entry point inserts text, never elements.
- **nothing to guard**: the entry point makes only empty elements of fixed kinds, or copies or
  moves nodes that already went through the guard (and, under the default configuration, can't
  hold a frame-like element).

`strip` walks a node's own tree (what `querySelectorAll` reaches) and also what that never enters:
each template's content and each open shadow root's tree, however deeply they nest (a work list,
not recursion). A shadow root it finds is also watched by the observer.

## Putting nodes into a document

| # | Entry point | Status | How |
| --- | --- | --- | --- |
| A1 | `Node.appendChild` / `insertBefore` / `replaceChild` | wrapped | the node argument is admitted; a refused one goes in as an empty text node |
| A2 | `append` / `prepend` / `replaceChildren` on Element, Document, DocumentFragment (ShadowRoot inherits them) | wrapped | every argument is admitted |
| A3 | `before` / `after` / `replaceWith` on Element, CharacterData, DocumentType | wrapped | every argument is admitted |
| A4 | `Element.insertAdjacentElement` | wrapped | the element argument is admitted |
| A5 | `insertAdjacentText`, `innerText`, `outerText`, `textContent`, `nodeValue` | text only | `textContent` and `nodeValue` also go through the attribute-turn guard |
| A6 | `Range.insertNode` / `surroundContents` | wrapped | the node argument is admitted |
| A7 | `innerHTML` setter (Element, ShadowRoot) | parsed and stripped | parsed in a detached element of the same kind; on an HTML `<template>` the markup goes into its content, which is stripped before the setter returns |
| A8 | `outerHTML` setter | parsed and stripped | parsed in the parent's kind; where the parent is a document the platform's setter refuses |
| A9 | `insertAdjacentHTML` | parsed and stripped | the position is read once; the nodes go in through the wrapped methods |
| A10 | `setHTML` (Sanitizer API; Element, ShadowRoot) | parsed and stripped | sent to the `innerHTML` path |
| A11 | `setHTMLUnsafe` (Element, ShadowRoot) | parsed and stripped | sent to the `innerHTML` path (no declarative shadow DOM) |
| A12 | `document.open` / `write` / `writeln` | refused | throw |
| A13 | `execCommand("insertHTML")` (and `copy`, `cut`, `paste`) | refused | the command name is read once |
| A14 | `document.body` setter | wrapped | the value is admitted; a refused one refuses the set (`HierarchyRequestError`) |
| A15 | `HTMLTableElement` `tHead` / `tFoot` / `caption` setters | wrapped | as A14 |
| A16 | `createTHead` / `createTFoot` / `createCaption` / `createTBody` / `insertRow` / `insertCell` | nothing to guard | they make empty elements of fixed kinds; anything put into them goes through A1–A3 |
| A17 | `HTMLSelectElement.add`, `HTMLOptionsCollection.add` | wrapped | the element argument is admitted |
| A18 | `select[i] = option`, `options[i] = option`, the `length` setters (indexed setters can't be wrapped) | nothing to guard | under the default configuration no frame-like element can be made (A21, A25) or parsed into a subtree content gets (section B), so a detached option can't hold one |
| A19 | `Element.attachShadow` | wrapped | `init` is read once, field by field, into a fresh object with no prototype, which is all the platform is given; the new root is guarded |
| A20 | Declarative shadow DOM | parsed and stripped | the parser entry points that would build it are closed (A11, A12) or sent to `DOMParser`'s parse (`Document.parseHTMLUnsafe`, `Document.parseHTML`), which builds none |
| A21 | `createElement` / `createElementNS` (Document; ShadowRoot where an engine has them), and what copies nodes: `cloneNode`, `importNode`, `Range.cloneContents` | nothing to guard | under the default configuration a `FRAMES` name is refused at creation, in any case and any namespace (the local name after a prefix included); the name is read once and that reading is what the platform gets. Nothing else makes a frame-like element: `new Option(…)`, `new Image()` and `new Audio()` make their own kinds, and a copy is of a tree that already holds none |
| A22 | `src` / `srcdoc` and other attribute setters on an iframe | wrapped | under the default configuration no iframe exists to set; under `nestedFrames: "own"` a kept iframe leaves the document before a change would make it any other (P128) |
| A23 | `<object>` / `<embed>` and the other `FRAMES` elements | refused | refused at creation under the default configuration; removed on every guarded insertion and by the observer under any configuration; never kept, not even under `"own"` |
| A24 | `moveBefore` (where an engine has it) | wrapped | the node argument is admitted |
| A25 | `CustomElementRegistry.define` with `extends` naming a `FRAMES` element | refused | under the default configuration; the options are read once into a fresh object |
| A26 | A markup method on Element, ShadowRoot, Document, DocumentFragment or Range not named above (one a later engine adds) | refused | any own method whose name contains `HTML`, other than those above, throws |

## Producers: APIs that hand content a subtree it can insert later

| # | Producer | Status | How |
| --- | --- | --- | --- |
| B1 | `DOMParser.parseFromString`, every MIME type | producer stripped | the platform's parse, then `strip` of the document |
| B2 | `HTMLTemplateElement.content` | producer stripped | the getter strips the content before it returns it (and A7 strips what the template's `innerHTML` fills) |
| B3 | `Document.parseHTMLUnsafe`, `Document.parseHTML` | producer stripped | the platform's `DOMParser` parse, stripped |
| B4 | `document.implementation.createHTMLDocument` | producer stripped | the new document is stripped |
| B5 | `document.implementation.createDocument` | producer stripped | the new document is stripped (its document element included) |
| B6 | `Range.createContextualFragment` | producer stripped | the fragment is stripped |
| B7 | `XSLTProcessor.transformToFragment` / `transformToDocument` (where an engine has them) | producer stripped | the result is stripped |
| B8 | `XMLHttpRequest` `responseXML`, and `response` when it is a document | producer stripped | each getter strips the document before it returns it |
| B9 | `Document.importNode` / `adoptNode` | producer stripped | the clone (importNode) or the node (adoptNode) is stripped; one that is itself a frame-like element is refused |
| B10 | HTML inside SVG `<foreignObject>` and MathML `<annotation-xml>`, and markup that crosses namespaces while parsing | parsed and stripped | the walk matches HTML-namespace frame-like elements wherever they are in the subtree |
| B11 | Inert documents' own `body` setter, and nodes moved into the live document | wrapped | the same prototypes, so A14 and B9 apply |
| B12 | Template contents and open shadow roots inside any subtree the guard walks | producer stripped | `strip` enters each template's content and each open shadow root's tree, recursively |

## Editing

| # | Entry point | Status | How |
| --- | --- | --- | --- |
| E1 | Paste, drop, replacement text and yank into editable content (`beforeinput` with `insertFromPaste`, `insertFromPasteAsQuotation`, `insertFromDrop`, `insertReplacementText`, `insertFromYank`) | text only | the shell's own `beforeinput` listener (on `window`, capturing, registered before content runs) cancels one whose data carries any type but `text/plain`, and inserts only its plain text through the editor's `insertText`, which carries no markup. Only the browser's own events are acted on. Composition (`insertCompositionText`) can't be cancelled, and carries text alone |

A drop or paste of formatted content into an editable region goes in as plain text. A text field
(`<input>`, `<textarea>`) takes text only and is unaffected.

## The shell's own layers

Find in page (P131), where a config declares `find`, draws its highlights in a layer of the
shell's own: an element over the content holding a closed shadow root. It adds no entry point. It
is spliced into the runtime after step 3, takes the methods below then (the guarded ones), and
calls each through `callOf` (P129), so its nodes go in the way any node does:

- `createElement` for the layer, its style element and each highlight box (A21);
- `attachShadow` for the layer's closed root (A19);
- `appendChild` of the layer into the document element (A1);
- `replaceChildren` on the shadow root and on the element holding the boxes (A2);
- the `textContent` setter for its style sheet's text (A5).

It inserts nothing into the content's own trees: no element wraps or splits the content's text, and
the matches are ranges, read for their boxes only. Its inline styles are set through CSSOM
(`cssText`), and it doesn't use the CSS Custom Highlight API.

## Under `nestedFrames: "own"`

The configuration that keeps a page's own iframes (P128) keeps creation open: an `iframe` can be
made, and the guards above decide when it is connected or changed (a kept frame leaves the
document before a change would make it any other). Elements that are never kept (`frame`,
`frameset`, `object`, `embed`, `portal`, `fencedframe`, an iframe that isn't the page's own) are
removed on every guarded insertion and by the observer. The trade-offs P128 records stand.
