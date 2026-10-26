/**
 * The focus guard (P109): a display's frame can move the keyboard into itself whenever it likes
 * (`element.focus()` in its own realm; on Chromium and WebKit with no gesture at all), and what the
 * person goes on typing into the host's composer or chat box then goes to the page. Porthole can't
 * stop the call, which runs in the content's realm, but the host's page can undo it: when focus
 * leaves one of its text fields for a display's frame and the person didn't move it there, focus
 * goes back once the engine has finished moving it, and the display hears `focusTaken`; a display
 * whose frame keeps doing it is stopped (`createHost`).
 *
 * What the host's page can see of a move into a frame, measured on Chromium, WebKit and Firefox
 * (P109): Chromium and WebKit blur the host's window as it happens, and a press on the frame (a
 * click, a tap, held or not) leaves the frame element `:active` then; a Tab is the host's own
 * keydown just before. Firefox tells the host's page nothing (no blur, no focusout, no `:active`):
 * its `document.activeElement` changes, which the guard reads at each animation frame, and the
 * pointer over the frame (`:hover`, `pointerover`) is all it can tell of a press. Every engine
 * keeps a gesture's transient activation for 5 s (measured: 5.04 to 5.10 s).
 */

/** How long the person's Tab counts as moving focus (the move follows its keydown at once). */
export const TAB_MS = 1_000;

/**
 * How long transient activation lasts after a gesture (measured: 5 s on all three engines): a
 * host page with activation and no gesture of its own for longer had one in a frame.
 */
export const ACTIVATION_SPAN_MS = 5_000;

/** The person is typing: a key on the host's page within this long. */
export const TYPING_MS = 1_000;

/**
 * When a display is stopped for taking the keyboard (P109): focus given back can't stop its frame
 * calling `focus()` again (nothing the host sets on the frame does, `inert` included: measured),
 * and each try leaves it the keys typed until focus is back (at most one or two, measured). So
 * three undone moves while the person types within 10 s, or five at all within 2 s, stop it.
 */
export const TAKES = {
  typing: { most: 3, withinMs: 10_000 },
  any: { most: 5, withinMs: 2_000 },
} as const;

/** What the host's page knew when focus left one of its text fields for a display's frame. */
export interface FocusMove {
  readonly now: number;
  /** The engine told the host's page as it happened (its window blurred): Chromium, WebKit. */
  readonly seen: boolean;
  /** The frame element is `:active`: a press on it, pointer or touch (Chromium, WebKit). */
  readonly pressed: boolean;
  /** The pointer is over the frame element (`:hover`). */
  readonly over: boolean;
  /** When the pointer last came over the frame element (`pointerover`); -Infinity if never. */
  readonly overSince: number;
  /** The person's last key on the host's page, and when. */
  readonly lastKey: { readonly key: string; readonly at: number } | null;
  /** When the person last typed on the host's page (a key other than Tab and the modifiers). */
  readonly typedAt: number;
  /** When the text field focus left got it. */
  readonly focusedAt: number;
  /** When the host's page last saw a gesture of its own (a key, a press, a click, typed text). */
  readonly gestureAt: number;
  /** Whether the host's page has transient activation now; undefined where it can't tell. */
  readonly activation: boolean | undefined;
  /** The host moved focus into the frame itself (`DisplayHandle.focus()`), just now. */
  readonly hostMoved: boolean;
}

/**
 * Whether the person moved focus into the frame themselves:
 * - the host did (`DisplayHandle.focus()`);
 * - by the keyboard: their last key on the host's page was Tab (or Shift+Tab), just now;
 * - by a press on the frame: where the engine tells the move as it happens (Chromium, WebKit),
 *   the frame element is `:active`; where it doesn't (Firefox), the pointer is over the frame and
 *   came over it after the text field got focus and after the person last typed in the host's page
 *   (a page can't move the pointer; a composer that opened beside the frame while the pointer
 *   rested over it, and a person typing with it there, keep their keys);
 * - by a gesture the host's own events don't explain: the host's page has transient activation,
 *   and for longer than activation lasts it saw no gesture of its own and the text field has had
 *   focus, so the person pressed or activated something in a frame since (an assistive
 *   technology's activation, which moves no pointer and sends the host no key, is one). The
 *   gesture that opened a composer (a selection in the frame, `selected`) is older than the
 *   composer's focus, and doesn't count.
 * Anything else is the page's: focus goes back.
 */
export function personMoved(move: FocusMove): boolean {
  if (move.hostMoved) {
    return true;
  }
  if (move.lastKey !== null && move.lastKey.key === "Tab" && move.now - move.lastKey.at <= TAB_MS) {
    return true;
  }
  if (
    move.seen ? move.pressed : move.over && move.overSince > Math.max(move.typedAt, move.focusedAt)
  ) {
    return true;
  }
  return (
    move.activation === true &&
    move.now - Math.max(move.gestureAt, move.focusedAt) > ACTIVATION_SPAN_MS
  );
}

/** Keys that type nothing on their own: they don't count as typing (a gesture still). */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn"]);

/** The `<input>` types that take typed text (an unknown type is `text`). */
const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/** Whether `element` takes the person's typed text: a text field, a text area, an editable region. */
export function takesText(element: Element | null): element is HTMLElement {
  if (element === null) {
    return false;
  }
  switch (element.localName) {
    case "textarea":
      return true;
    case "input":
      return TEXT_INPUTS.has((element as HTMLInputElement).type);
    default:
      return (element as Partial<HTMLElement>).isContentEditable ?? false;
  }
}

/** The element that has focus, inside open shadow roots too. */
function deepActive(document: Document): Element | null {
  let active = document.activeElement;
  for (
    let inner = active?.shadowRoot?.activeElement;
    inner !== null && inner !== undefined;
    inner = active?.shadowRoot?.activeElement
  ) {
    active = inner;
  }
  return active;
}

/** One page's guard, shared by every display's frame on it. */
export interface FocusGuard {
  /** Guards `frame`: `taken` hears each move into it that was undone, and whether the person was typing. */
  add(frame: HTMLIFrameElement, taken: (typing: boolean) => void): () => void;
  /** The host moves focus into `frame` itself. */
  focus(frame: HTMLIFrameElement): void;
  /**
   * Whether the page's focus is in `frame` now, once any move into it was judged (on an engine
   * that tells the host's page nothing, the move is judged here and then, not at the next frame).
   */
  focused(frame: HTMLIFrameElement): boolean;
}

interface Guarded {
  readonly taken: Set<(typing: boolean) => void>;
  overSince: number;
}

const guards = new WeakMap<Window, FocusGuard>();

/** The guard for `view`'s page, made on first use. */
export function focusGuard(view: Window): FocusGuard {
  const existing = guards.get(view);
  if (existing !== undefined) {
    return existing;
  }
  const document = view.document;
  const frames = new Map<HTMLIFrameElement, Guarded>();
  const now = () => view.performance.now();
  let known: Element | null = deepActive(document);
  let focusedAt = now();
  let lastKey: { key: string; at: number } | null = null;
  let typedAt = -Infinity;
  let gestureAt = -Infinity;
  let hostMove: { frame: HTMLIFrameElement; at: number } | null = null;
  let polling = 0;

  const activation = (): boolean | undefined => {
    try {
      const state = (view.navigator as Navigator & { userActivation?: { isActive: boolean } })
        .userActivation;
      return state === undefined ? undefined : state.isActive;
    } catch {
      return undefined;
    }
  };

  /** Judges a change of focus since the last look: `seen` when the engine told it (a blur). */
  const look = (seen: boolean) => {
    const was = known;
    const active = deepActive(document);
    known = active;
    if (active === was || active === null) {
      return;
    }
    const guarded = frames.get(active as HTMLIFrameElement);
    if (guarded === undefined || !takesText(was) || !was.isConnected) {
      return;
    }
    const frame = active as HTMLIFrameElement;
    const at = now();
    const moved = personMoved({
      now: at,
      seen,
      pressed: frame.matches(":active"),
      over: frame.matches(":hover"),
      overSince: guarded.overSince,
      lastKey,
      typedAt,
      focusedAt,
      gestureAt,
      activation: activation(),
      hostMoved: hostMove !== null && hostMove.frame === frame && at - hostMove.at <= TAB_MS,
    });
    hostMove = null;
    if (moved) {
      return;
    }
    // Back once the move is over: focus given back while the engine is still moving it (inside its
    // blur) stays with the frame on Chromium and WebKit, and Firefox takes it back only from a
    // frame that was blurred first (measured). Until then the field counts as the page's focus,
    // so a move that didn't take is seen and judged again.
    known = was;
    focusedAt = at;
    view.setTimeout(() => {
      // Unless the person has since put focus somewhere of their own.
      const current = deepActive(document);
      if (was.isConnected && (current === frame || current === null || current === document.body)) {
        frame.blur();
        was.focus({ preventScroll: true });
      }
    }, 0);
    schedule();
    const typing = at - typedAt <= TYPING_MS;
    for (const taken of guarded.taken) {
      taken(typing);
    }
  };

  /**
   * Firefox moves focus into a frame without a word to the host's page: while one of the page's
   * text fields has focus and a frame is guarded, look at each animation frame.
   */
  const poll = () => {
    polling = 0;
    look(false);
    schedule();
  };
  const schedule = () => {
    if (polling === 0 && frames.size > 0 && takesText(known)) {
      polling = view.requestAnimationFrame(poll);
    }
  };

  const gesture = () => {
    gestureAt = now();
  };
  view.addEventListener(
    "keydown",
    (event) => {
      const at = now();
      gestureAt = at;
      lastKey = { key: event.key, at };
      if (event.key !== "Tab" && !MODIFIERS.has(event.key)) {
        typedAt = at;
      }
    },
    true,
  );
  // A click too (an assistive technology's click on the host's own UI dispatches no press), and
  // text that comes without a key (dictation, a paste, an input method): typing all the same.
  for (const type of ["pointerdown", "pointerup", "mousedown", "touchend", "click"]) {
    view.addEventListener(type, gesture, true);
  }
  view.addEventListener(
    "input",
    () => {
      typedAt = now();
      gestureAt = typedAt;
    },
    true,
  );
  // Focus moving within the page: what had it, for the next move out of a text field.
  document.addEventListener(
    "focusin",
    () => {
      known = deepActive(document);
      focusedAt = now();
      schedule();
    },
    true,
  );
  // Chromium and WebKit blur the window as focus goes into a frame.
  view.addEventListener("blur", (event) => {
    if (event.target === view) {
      look(true);
    }
  });

  const guard: FocusGuard = {
    add(frame, taken) {
      let guarded = frames.get(frame);
      if (guarded === undefined) {
        const entry: Guarded = { taken: new Set(), overSince: -Infinity };
        frame.addEventListener("pointerover", () => {
          entry.overSince = now();
        });
        frames.set(frame, entry);
        guarded = entry;
      }
      guarded.taken.add(taken);
      schedule();
      const own = guarded;
      return () => {
        own.taken.delete(taken);
        if (own.taken.size === 0) {
          frames.delete(frame);
        }
      };
    },
    focus(frame) {
      hostMove = { frame, at: now() };
      frame.focus();
      look(true);
    },
    focused(frame) {
      look(false);
      return known === frame && document.activeElement === frame;
    },
  };
  guards.set(view, guard);
  return guard;
}
