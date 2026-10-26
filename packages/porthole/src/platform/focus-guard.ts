/**
 * The focus guard (P109): a display's frame can move the keyboard into itself whenever it likes
 * (`element.focus()` in its own realm; on Chromium and WebKit with no gesture at all), and what the
 * person goes on typing into the host's composer or chat box then goes to the page. Porthole can't
 * stop the call, which runs in the content's realm, but the host's page can undo it: when focus
 * leaves one of its text fields for a display's frame and the person didn't move it there, focus
 * goes back once the engine has finished moving it, the guard watches that it stays back, and the
 * display hears `focusTaken`; a display whose frame keeps doing it is stopped (`createHost`).
 *
 * What the host's page can see of a move into a frame, measured on Chromium, WebKit and Firefox
 * (P109): Chromium and WebKit blur the host's window as it happens, and a press on the frame (a
 * click, a tap, held or not) leaves the frame element `:active` then; a Tab is the host's own
 * keydown just before. Firefox doesn't blur the window and shows no `:active` (a focusout on the
 * field was seen in one review's runs, not in another's): its `document.activeElement` changes,
 * which the guard reads at each animation frame while a frame is guarded, and the pointer over the
 * frame (`:hover`, `pointerover`) is all it can tell of a press. A page that takes focus back on
 * its own blur (which a take-back fires) leaves Firefox's focus on nothing (`<body>`) or in the
 * frame again (the review of the guard, GK-1): the guard keeps watching after each take-back and
 * counts one that didn't hold. Every engine keeps a gesture's transient activation for 5 s
 * (measured: 5.04 to 5.10 s).
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
 * After a take-back, the guard keeps watching (each animation frame) until focus has stayed in the
 * text field this long: a page that takes it again at once (on its own blur, which the take-back
 * fires) is caught as it does, on Firefox too (P109, after the review of the guard: GK-1).
 */
export const HELD_MS = 300;

/** A take-back that hasn't put focus back in the field after this long failed: counted, and tried again. */
export const GIVE_BACK_MS = 50;

/**
 * A frame that holds focus isn't the person's for this long after they press the host's page: the
 * press gives the page activation before focus leaves the frame (on Firefox, a move between
 * processes), and a call the frame sends in between would borrow it.
 */
export const HOST_PRESS_MS = 1_000;

/**
 * When a display is stopped for taking the keyboard (P109): focus given back can't stop its frame
 * calling `focus()` again (nothing the host sets on the frame does, `inert` included: measured),
 * and each try leaves it the keys typed until focus is back. So three undone moves within 10 s
 * that came while the person typed on the page or that kept focus from going back (a take-back that
 * failed: the keys then go to the frame, and the page sees no typing to count), or five at all
 * within 2 s, stop it. A person's own move never fails a take-back.
 */
export const TAKES = {
  typing: { most: 3, withinMs: 10_000 },
  any: { most: 5, withinMs: 2_000 },
} as const;

/** One move of the keyboard the guard undid. */
export interface FocusTake {
  /** The person pressed a key on the host's page within the last second. */
  readonly typing: boolean;
  /**
   * Focus didn't stay back in the field: the frame kept it, took it again within `HELD_MS`, or it
   * landed nowhere.
   */
  readonly failed: boolean;
}

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
  /** Guards `frame`: `taken` hears each move into it that was undone. */
  add(frame: HTMLIFrameElement, taken: (take: FocusTake) => void): () => void;
  /** The host moves focus into `frame` itself. */
  focus(frame: HTMLIFrameElement): void;
  /**
   * Whether the page's focus is in `frame` now, the person's own (once any move into it was
   * judged; on an engine that tells the host's page nothing, here and then).
   */
  focused(frame: HTMLIFrameElement): boolean;
  /** The host moves focus into one of its text fields: see `focusField`. */
  field(field: HTMLElement): void;
}

interface Guarded {
  readonly taken: Set<(take: FocusTake) => void>;
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
  let pressAt = -Infinity;
  /** When focus last went into a guarded frame, and whether the person moved it there. */
  let enteredAt = -Infinity;
  let earned = false;
  /** The text field the person last pressed, and when. */
  let pressed: { readonly field: HTMLElement; readonly at: number } | null = null;
  let hostMove: { frame: HTMLIFrameElement; at: number } | null = null;
  let polling = 0;
  /**
   * A take-back in progress: the field focus goes back to, the frame it came from, when focus was
   * last given back, and since when it has stayed in the field. Ends once it has stayed `HELD_MS`,
   * the person moves focus somewhere of their own, or the field or frame is gone.
   */
  let contest: {
    readonly field: HTMLElement;
    readonly frame: HTMLIFrameElement;
    readonly guarded: Guarded;
    gaveAt: number;
    heldSince: number | null;
  } | null = null;

  const activation = (): boolean | undefined => {
    try {
      const state = (view.navigator as Navigator & { userActivation?: { isActive: boolean } })
        .userActivation;
      return state === undefined ? undefined : state.isActive;
    } catch {
      return undefined;
    }
  };

  /** What the person's move would need, read now: see `personMoved`. */
  const judge = (
    frame: HTMLIFrameElement,
    guarded: Guarded,
    seen: boolean,
    at: number,
  ): boolean => {
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
    return moved;
  };

  /**
   * Focus goes back to `field` once the engine has finished the move: given back inside its blur
   * it stays with the frame on Chromium and WebKit, and Firefox takes it back only from a frame
   * that was blurred first (measured). Unless the person has since put focus somewhere of their own.
   */
  const giveBack = (field: HTMLElement, frame: HTMLIFrameElement) => {
    view.setTimeout(() => {
      const current = deepActive(document);
      if (
        field.isConnected &&
        (current === frame || current === null || current === document.body)
      ) {
        frame.blur();
        field.focus({ preventScroll: true });
      }
    }, 0);
  };

  /** A move the guard undoes: focus goes back, the display hears it, and the guard keeps watching. */
  const takeBack = (
    field: HTMLElement,
    frame: HTMLIFrameElement,
    guarded: Guarded,
    at: number,
    failed: boolean,
  ) => {
    // Until it is back, the field counts as the page's focus, so a move that didn't take is seen.
    known = field;
    focusedAt = at;
    contest = { field, frame, guarded, gaveAt: at, heldSince: null };
    giveBack(field, frame);
    schedule();
    const take: FocusTake = { typing: at - typedAt <= TYPING_MS, failed };
    for (const taken of guarded.taken) {
      taken(take);
    }
  };

  /**
   * While a take-back is in progress: whether focus stayed in the field, or the frame has it again
   * (or it landed on nothing), which is the page's doing unless the person moved it there.
   */
  const watch = (seen: boolean, active: Element | null, at: number): boolean => {
    const watched = contest;
    if (watched === null) {
      return false;
    }
    const { field, frame, guarded } = watched;
    if (!field.isConnected || !frames.has(frame) || pressAt > watched.gaveAt) {
      // Gone, or the person pressed the page since: theirs to place focus now.
      contest = null;
      return false;
    }
    if (active === field) {
      watched.heldSince ??= at;
      if (at - watched.heldSince >= HELD_MS) {
        contest = null;
      }
      known = field;
      return true;
    }
    const lost = active === frame || active === null || active === document.body;
    if (!lost) {
      // Somewhere else of the person's (another field, a button, another frame): judged as any.
      contest = null;
      return false;
    }
    if (active === frame && judge(frame, guarded, seen, at)) {
      contest = null;
      known = frame;
      enteredAt = at;
      earned = true;
      return true;
    }
    // Taken again once it was back (within `HELD_MS`), or not back yet after `GIVE_BACK_MS`: a
    // take-back that failed, given again and counted.
    if (watched.heldSince !== null || at - watched.gaveAt >= GIVE_BACK_MS) {
      takeBack(field, frame, guarded, at, true);
    }
    return true;
  };

  /** Judges a change of focus since the last look: `seen` when the engine told it (a blur). */
  const look = (seen: boolean) => {
    const active = deepActive(document);
    const at = now();
    if (watch(seen, active, at)) {
      return;
    }
    const was = known;
    known = active;
    if (active === was || active === null) {
      return;
    }
    const entered = frames.get(active as HTMLIFrameElement);
    if (entered !== undefined) {
      // From a text field it is judged below; from anything else it is let be, but only the
      // person's own move makes the frame theirs for a gesture gate (`focused`).
      enteredAt = at;
      earned = takesText(was) || judge(active as HTMLIFrameElement, entered, seen, at);
    }
    // Into a text field from a display's frame (the person pressed the composer while the frame
    // had focus): watched as a take-back is, since a page that takes focus back on its own blur
    // leaves it on nothing on Firefox (measured), where the keys are lost to the page's doing.
    const left = was === null ? undefined : frames.get(was as HTMLIFrameElement);
    // Or the person pressed a text field and focus went from the frame to nothing: on Firefox, a
    // page that has a gesture of the person's and takes focus back on its blur leaves it there.
    if (
      left !== undefined &&
      (active === document.body || active === null) &&
      pressed !== null &&
      at - pressed.at <= HELD_MS &&
      pressed.field.isConnected
    ) {
      takeBack(pressed.field, was as HTMLIFrameElement, left, at, true);
      return;
    }
    if (left !== undefined && takesText(active)) {
      contest = {
        field: active,
        frame: was as HTMLIFrameElement,
        guarded: left,
        gaveAt: at,
        heldSince: at,
      };
      return;
    }
    const guarded = frames.get(active as HTMLIFrameElement);
    if (guarded === undefined || !takesText(was) || !was.isConnected) {
      return;
    }
    const frame = active as HTMLIFrameElement;
    if (judge(frame, guarded, seen, at)) {
      return;
    }
    takeBack(was, frame, guarded, at, false);
  };

  /**
   * Firefox moves focus into a frame without a word to the host's page: while a frame is guarded,
   * look at each animation frame (one read of the focused element), so the guard knows where focus
   * is when it next leaves a text field, or comes into one from a frame.
   */
  const poll = () => {
    polling = 0;
    look(false);
    schedule();
  };
  const schedule = () => {
    if (polling === 0 && frames.size > 0) {
      polling = view.requestAnimationFrame(poll);
    }
  };

  const gesture = () => {
    gestureAt = now();
  };
  const press = (event: Event) => {
    pressAt = now();
    gestureAt = pressAt;
    const target = event.composedPath()[0];
    pressed =
      target instanceof Element && takesText(target) ? { field: target, at: pressAt } : null;
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
  for (const type of ["pointerup", "touchend", "click"]) {
    view.addEventListener(type, gesture, true);
  }
  for (const type of ["pointerdown", "mousedown"]) {
    view.addEventListener(type, press, true);
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
      focusedAt = now();
      look(false);
      schedule();
    },
    true,
  );
  // Chromium and WebKit blur the window as focus goes into a frame. Firefox may send the field a
  // focusout first (seen in one review's runs, not in another's): looked at once it's over.
  view.addEventListener("blur", (event) => {
    if (event.target === view) {
      look(true);
    }
  });
  document.addEventListener(
    "focusout",
    () => {
      view.setTimeout(() => look(false), 0);
    },
    true,
  );

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
      // A press on the host's page since focus went into the frame, just now: the activation is
      // that press's, and focus is about to leave (a call that lands in between doesn't count).
      const pressedHost = pressAt > enteredAt && now() - pressAt < HOST_PRESS_MS;
      return known === frame && document.activeElement === frame && earned && !pressedHost;
    },
    field(field) {
      const holder = deepActive(document);
      const guarded = holder === null ? undefined : frames.get(holder as HTMLIFrameElement);
      if (guarded === undefined) {
        field.focus({ preventScroll: true });
        return;
      }
      // Watched as a take-back: a frame that keeps focus fails it, and is counted.
      const frame = holder as HTMLIFrameElement;
      frame.blur();
      field.focus({ preventScroll: true });
      known = field;
      focusedAt = now();
      contest = { field, frame, guarded, gaveAt: focusedAt, heldSince: null };
      schedule();
    },
  };
  guards.set(view, guard);
  return guard;
}

/**
 * Moves focus into one of the host page's text fields (a composer that opens beside a display,
 * P109): `field.focus()` for a host to call instead. Firefox doesn't move focus from a frame that
 * holds it with a gesture of the person's and takes it back on its own blur (measured: the keys
 * then go to the frame); this blurs the frame first, and the focus guard watches that focus lands,
 * counting a frame that keeps it toward stopping its display. Elsewhere it is `field.focus()`.
 */
export function focusField(field: HTMLElement): void {
  const view = field.ownerDocument.defaultView;
  if (view === null) {
    field.focus({ preventScroll: true });
    return;
  }
  focusGuard(view).field(field);
}
