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
 *
 * A nested page's shell (P111) says when its activation turned on, which a press in the page does,
 * and so does a key the person typed into it: one meant for the host's composer, after the page took
 * the keyboard and before the guard took it back (the audit of P111's guard, NG-1). Neither the
 * shell nor the host's page can tell the two apart from the activation (the shell gets no event as
 * focus comes into its child, measured), so (P120): in a fight over a text field the shell's word
 * isn't asked; a wait on a move from a text field doesn't end with the frame holding focus unjudged;
 * and where the host's page sees the pointer over its frames, an activation while it isn't over the
 * frame and the person was typing is no press.
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
 * No press of the person's lands on a frame this soon after a key they typed on the host's page
 * (P122): a hand on the keys doesn't reach the pointer and press that fast (the Keystroke-Level
 * Model gives 400 ms to the hand's move from the keys to the mouse alone; Card, Moran and Newell,
 * 1980). A move into a nested page's frame, or its shell's activation turning on, within this long
 * is the person's next key landing in the page, which turns its activation on as a press does.
 * Where neither the host's page nor the shell sees the pointer (full Chromium), it holds a page that
 * takes the keyboard while the person types even when their key outruns the shell's answer.
 */
export const KEY_PRESS_MS = 250;

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

/**
 * A nested page's shell (P111) says its own activation turned on: a press or key of the person's
 * in that page (activation goes up to ancestors, never down, so nothing on the host's page turns
 * it on). A move of focus into the frame within this long of it, with no press or key on the
 * host's page since, is the person's; so is a `comments.open` the page sends within it.
 */
export const SHELL_GESTURE_MS = 1_000;

/**
 * How long a move into a nested page's frame waits for its shell's word before it is taken for
 * the page's: the shell says what it saw at its next animation frame, after the host's page
 * already heard the move. A shell that says nothing in time (gone, stalled) has its frame's move
 * taken back, as any page's.
 */
export const SHELL_WAIT_MS = 500;

/**
 * A shell's word that came this long before the host's page heard the move is about that move
 * (the shell's frame can come first); one from before then is about an earlier one.
 */
export const SHELL_EARLY_MS = 150;

/**
 * A shell that went this long without a look, or without a word to the host (its heartbeat is every
 * 50 ms), was stalled (P111, after its review): where the page shares the shell's thread (WebKit,
 * Firefox), a page that holds it from its own click handler pushes the moment the shell sees its
 * activation turn on past the person's next keys on the host's page. An activation it saw then is
 * uncertain: it is no one's gesture until it lapses.
 */
export const SHELL_STALL_MS = 100;

/** What a nested page's shell last said (P111), on the host's clock. */
export interface ShellWord {
  /** Whether its engine tells activation at all (`navigator.userActivation`). */
  readonly supported: boolean;
  /** When its activation last turned on; -Infinity if it hasn't, or is off. */
  readonly activatedAt: number;
  /** Whether it last said the page's focus is in it, and when it last said focus came in. */
  readonly focused: boolean;
  readonly focusedAt: number;
  /** Its activation turned on while it was stalled: uncertain until it goes off (`SHELL_STALL_MS`). */
  readonly uncertain?: boolean;
  /**
   * Its activation turned on within `TYPING_MS` of the person's typing on the host's page, the
   * pointer not come over the frame since (`pressPossible`, judged as it turned on): where the
   * host's page sees the pointer, their key landing in the page, no press (P120).
   */
  readonly keyed?: boolean;
}

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
  /**
   * A nested page's frame (P111): what its shell said, and when the host's page last had a
   * trusted press or key of its own. Absent for any other frame.
   */
  readonly shell?: {
    readonly word: ShellWord;
    readonly hostInputAt: number;
    /** The host's page sees the pointer over its frames on this engine (`pressPossible`, P120). */
    readonly pointerShown?: boolean;
  };
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
  // A nested page (P111): its shell's activation turned on within the last second, and the host's
  // page had no press or key of its own since (the person went back to it), where it may have been
  // a press (P120) and not within `KEY_PRESS_MS` of the person's last key (P122); or, where the
  // engine tells it, a press on the frame. Nothing else: no pointer over it, no host-wide
  // activation.
  if (move.shell !== undefined && move.shell.word.supported) {
    return (
      (move.seen && move.pressed) ||
      (move.now - move.typedAt >= KEY_PRESS_MS &&
        shellGesture(move.shell.word, move.shell.hostInputAt, move.now) &&
        !(move.shell.pointerShown === true && move.shell.word.keyed === true))
    );
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

/**
 * Whether a nested page's shell saw the person's gesture just now (P111): its activation turned on
 * within `SHELL_GESTURE_MS`, after the host's page's last trusted press or key.
 */
export function shellGesture(word: ShellWord, hostInputAt: number, now: number): boolean {
  return (
    word.supported &&
    now - word.activatedAt <= SHELL_GESTURE_MS &&
    now >= word.activatedAt &&
    hostInputAt < word.activatedAt
  );
}

/**
 * Whether the person could have pressed the frame just before `at` (P120): a nested page's shell
 * says its activation turned on, which a key typed into the page does as well as a press. Where the
 * host's page sees the pointer over its frames (`shown`: Firefox; Chromium and WebKit where the frame
 * is in their process, not full Chromium), a press needs the pointer over the frame, come over it
 * since the person last typed on the host's page; within `TYPING_MS` of that typing, an activation
 * with the pointer elsewhere is their keys landing in the page. Anywhere else it may be a press.
 */
export function pressPossible(
  shown: boolean,
  over: boolean,
  overSince: number,
  typedAt: number,
  at: number,
): boolean {
  return !shown || at - typedAt > TYPING_MS || (over && overSince > typedAt);
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
  /**
   * Guards `frame`: `taken` hears each move into it that was undone. `nested`: it holds a nested
   * page's shell (P111), whose word (`shell`) decides the moves into it.
   */
  add(
    frame: HTMLIFrameElement,
    taken: (take: FocusTake) => void,
    options?: {
      readonly nested?: boolean;
      /** Asks a nested page's shell to look now (P120); it answers with a report naming `n`. */
      readonly ask?: (n: number) => void;
    },
  ): () => void;
  /** What a nested page's shell said (P111): its activation, its focus. */
  shell(
    frame: HTMLIFrameElement,
    said: {
      readonly supported: boolean;
      readonly ago: number | null;
      readonly focused: boolean;
      /** How long the shell went without a look before this one (its own clock). */
      readonly gap: number;
      /** The ask this report answers (P120), if it answers one. */
      readonly asked?: number;
    },
  ): void;
  /** A nested page's shell's heartbeat (P111): it is looking. */
  beat(frame: HTMLIFrameElement): void;
  /** Whether a nested page's shell saw the person's gesture just now (`shellGesture`). */
  gesture(frame: HTMLIFrameElement): boolean;
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
  /** A nested page's shell's word (P111); null for any other frame. */
  word: ShellWord | null;
  /** When the host last heard the shell (a report or a heartbeat). */
  heardAt: number;
  /** Asks the shell to look now (P120), the last ask's number, and whether it was answered. */
  readonly ask: ((n: number) => void) | undefined;
  asked: number;
  answered: boolean;
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
  /** When the person typed on the host's page, the last two seconds of it (P122). */
  const typings: number[] = [];
  const typed = (at: number) => {
    typedAt = at;
    typings.push(at);
    while (typings.length > 0 && at - (typings[0] as number) > 2 * TYPING_MS) {
      typings.shift();
    }
  };
  /** The person's last typing on the host's page at or before `at` (-Infinity: none known). */
  const typedBefore = (at: number): number => {
    for (let index = typings.length - 1; index >= 0; index -= 1) {
      const each = typings[index] as number;
      if (each <= at) {
        return each;
      }
    }
    return -Infinity;
  };
  let gestureAt = -Infinity;
  let pressAt = -Infinity;
  /** The host's page's last trusted press or key (P111: a nested page's gesture must be later). */
  let inputAt = -Infinity;
  /**
   * A move into a nested page's frame waiting for its shell's word (P111): from a text field
   * (`field`: taken back unless the shell says the person's), or from anything else (null: only
   * whether the frame is the person's for a gesture gate).
   */
  let waiting: {
    readonly field: HTMLElement | null;
    readonly frame: HTMLIFrameElement;
    readonly guarded: Guarded;
    readonly since: number;
  } | null = null;
  /**
   * Whether the host's page sees the pointer over its frames (P120): learned once the pointer comes
   * over one (`pointerover` on its element: Firefox, and Chromium and WebKit where frames are in their
   * process), or a move from a text field into one doesn't blur the window (Firefox, which shows
   * the pointer over a frame, measured). Full Chromium shows neither, and never learns it.
   */
  let pointerShown = false;
  /** When focus last went into a guarded frame, and whether the person moved it there. */
  let enteredAt = -Infinity;
  let earned = false;
  /** The text field the person last pressed, when, and what had focus as they pressed it. */
  let pressed: {
    readonly field: HTMLElement;
    readonly at: number;
    readonly from: Element | null;
  } | null = null;
  let hostMove: { frame: HTMLIFrameElement; at: number } | null = null;
  let polling = 0;
  /**
   * A take-back in progress: the field focus goes back to, the frame it came from, when focus was
   * last given back, and since when it has stayed in the field. Ends once it has stayed `HELD_MS`,
   * the person moves focus somewhere of their own, or the field or frame is gone. A `fight` undoes
   * the page's own move (a take-back, `focusField`, or the person leaving a frame that took focus
   * itself), not the person leaving a frame they moved into (P120).
   */
  let contest: {
    readonly field: HTMLElement;
    readonly frame: HTMLIFrameElement;
    readonly guarded: Guarded;
    readonly fight: boolean;
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

  /**
   * What the person's move would need, read now: see `personMoved`. Into a nested page's frame
   * whose shell hasn't spoken of this move yet, `wait` (P111). In a fight over a text field
   * (`fight`, P120), a nested page's frame is judged as any frame is, its shell's word not asked:
   * an activation it says turned on then is the person's keys landing in it far more often than a
   * press (a press back into the page within `HELD_MS` of focus landing in the field).
   */
  const judge = (
    frame: HTMLIFrameElement,
    guarded: Guarded,
    seen: boolean,
    at: number,
    fight = false,
  ): boolean | "wait" => {
    const word = fight ? null : guarded.word;
    const over = frame.matches(":hover");
    const moved = personMoved({
      now: at,
      seen,
      pressed: frame.matches(":active"),
      over,
      overSince: guarded.overSince,
      lastKey,
      typedAt,
      focusedAt,
      gestureAt,
      activation: activation(),
      hostMoved: hostMove !== null && hostMove.frame === frame && at - hostMove.at <= TAB_MS,
      ...(word === null ? {} : { shell: { word, hostInputAt: inputAt, pointerShown } }),
    });
    hostMove = null;
    // The shell tells a move at its next frame, the host's page hears it first: until the shell
    // said focus came in (around now), its activation may be on its way; unless no press could
    // have made the move (P120), which nothing the shell says changes.
    if (
      !moved &&
      word !== null &&
      word.supported &&
      word.focusedAt < at - SHELL_EARLY_MS &&
      at - typedAt >= KEY_PRESS_MS &&
      pressPossible(pointerShown, over, guarded.overSince, typedAt, at)
    ) {
      return "wait";
    }
    return moved;
  };

  /** Waits for a nested page's shell's word on a move (P111): decided by `settle`. */
  const wait = (
    field: HTMLElement | null,
    frame: HTMLIFrameElement,
    guarded: Guarded,
    at: number,
  ) => {
    waiting = { field, frame, guarded, since: at };
    // The shell looks at its next frame, and a key the person types into the page before then
    // turns its activation on as a press does: asked to look now, it says what it saw as the move
    // was heard (P120).
    guarded.asked += 1;
    guarded.answered = false;
    guarded.ask?.(guarded.asked);
    known = frame;
    enteredAt = at;
    earned = false;
    schedule();
  };

  /**
   * A waiting move, once its shell spoke or the wait is over: the person's (the frame keeps
   * focus), or the page's (from a text field, taken back). A move elsewhere since ends it.
   */
  const settle = (at: number) => {
    const held = waiting;
    if (held === null) {
      return;
    }
    const { field, frame, guarded } = held;
    const active = deepActive(document);
    if (active !== frame || !frames.has(frame)) {
      waiting = null;
      // Moved on since to nothing, or back to the field, with no press of the person's on the
      // host's page: still the page's move from that field (P120, after the audit of P111's guard:
      // NG-1, where the frame took it again at once and was then let be), watched as a take-back
      // is, focus on nothing given back and counted.
      if (
        field !== null &&
        field.isConnected &&
        pressAt <= held.since &&
        (active === null || active === document.body || active === field)
      ) {
        known = field;
        contest = { field, frame, guarded, fight: true, gaveAt: held.since, heldSince: null };
        schedule();
        return;
      }
      // Anywhere else: from the frame, as the next look judges it.
      known = frame;
      return;
    }
    const word = guarded.word;
    // The shell's activation, where a press could have made it: within a second of the person's
    // typing on the host's page with the pointer elsewhere, it is their keys landing in the page
    // (P120). Read as of the move.
    const theirs =
      word !== null && shellGesture(word, inputAt, at) && !(pointerShown && word.keyed === true);
    // It said focus came in around the move, or answered the ask the move made with focus in it.
    const spoke =
      word !== null &&
      (word.focusedAt >= held.since - SHELL_EARLY_MS || (guarded.answered && word.focused));
    if (theirs) {
      waiting = null;
      known = frame;
      earned = true;
      return;
    }
    if (!spoke && at - held.since < SHELL_WAIT_MS) {
      return;
    }
    waiting = null;
    if (field !== null && field.isConnected) {
      takeBack(field, frame, guarded, at, false);
    }
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
    contest = { field, frame, guarded, fight: true, gaveAt: at, heldSince: null };
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
    if (!field.isConnected || pressAt > watched.gaveAt) {
      // Gone, or the person pressed the page since: theirs to place focus now.
      contest = null;
      return false;
    }
    if (!frames.has(frame)) {
      // The frame was removed mid-fight (its display stopped): Firefox may leave focus on nothing
      // once the focused frame goes. Back into the field, for a moment after.
      if ((active === null || active === document.body) && at - watched.gaveAt <= HELD_MS) {
        field.focus({ preventScroll: true });
        return true;
      }
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
    if (active === frame) {
      // The frame has it again. In a fight, the person's only by a Tab, the host's own move, or a
      // press the engine shows: a nested page's too, its shell's word not asked (P120, after the
      // audit of P111's guard, NG-1, where waiting for it let the frame keep the keyboard).
      const verdict = judge(frame, guarded, seen, at, watched.fight);
      if (verdict === true) {
        contest = null;
        known = frame;
        enteredAt = at;
        earned = true;
        return true;
      }
      if (verdict === "wait") {
        // The person left a nested page they had moved into, and focus went back in (P111): its
        // shell decides, as it would at first.
        if (watched.heldSince !== null || at - watched.gaveAt >= GIVE_BACK_MS) {
          contest = null;
          wait(field, frame, guarded, at);
        }
        return true;
      }
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
    if (waiting !== null) {
      settle(at);
      return;
    }
    if (watch(seen, active, at)) {
      return;
    }
    const was = known;
    // The person pressed a text field and focus is on nothing: on Firefox, a page that takes focus
    // as they press, or takes it back on its blur with a gesture of theirs, leaves it there
    // (measured, on a slow machine too), and their keys are lost. Into the field, once: as a
    // take-back the page failed if a frame had focus as they pressed, else simply.
    const press = pressed;
    if (
      press !== null &&
      (active === null || active === document.body) &&
      at - press.at <= HELD_MS &&
      press.field.isConnected
    ) {
      pressed = null;
      const from = press.from ?? was;
      const blamed = from === null ? undefined : frames.get(from as HTMLIFrameElement);
      if (blamed === undefined) {
        known = active;
        press.field.focus({ preventScroll: true });
      } else {
        takeBack(press.field, from as HTMLIFrameElement, blamed, at, true);
      }
      return;
    }
    known = active;
    if (active === was || active === null) {
      return;
    }
    const entered = frames.get(active as HTMLIFrameElement);
    if (entered !== undefined) {
      // From a text field it is judged below; from anything else it is let be, but only the
      // person's own move makes the frame theirs for a gesture gate (`focused`).
      enteredAt = at;
      const verdict = takesText(was) || judge(active as HTMLIFrameElement, entered, seen, at);
      if (verdict === "wait") {
        // A nested page's (P111): theirs once its shell says so; nothing to take back.
        wait(null, active as HTMLIFrameElement, entered, at);
        return;
      }
      earned = verdict;
    }
    // Into a text field from a display's frame (the person pressed the composer while the frame
    // had focus): watched as a take-back is, since a page that takes focus back on its own blur
    // leaves it on nothing on Firefox (measured), where the keys are lost to the page's doing.
    const left = was === null ? undefined : frames.get(was as HTMLIFrameElement);
    if (left !== undefined && takesText(active)) {
      contest = {
        field: active,
        frame: was as HTMLIFrameElement,
        guarded: left,
        fight: !earned,
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
    if (!seen) {
      // A move out of a text field the window didn't blur for: Firefox, which shows the host's
      // page the pointer over a frame (P120).
      pointerShown = true;
    }
    const verdict = judge(frame, guarded, seen, at);
    if (verdict === true) {
      return;
    }
    if (verdict === "wait") {
      wait(was, frame, guarded, at);
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
    if (polling === 0 && (frames.size > 0 || contest !== null || waiting !== null)) {
      polling = view.requestAnimationFrame(poll);
    }
  };

  const gesture = () => {
    gestureAt = now();
  };
  const press = (event: Event) => {
    pressAt = now();
    if (event.isTrusted) {
      inputAt = pressAt;
    }
    gestureAt = pressAt;
    const target = event.composedPath()[0];
    pressed =
      target instanceof Element && takesText(target)
        ? { field: target, at: pressAt, from: deepActive(document) }
        : null;
  };
  view.addEventListener(
    "keydown",
    (event) => {
      const at = now();
      gestureAt = at;
      lastKey = { key: event.key, at };
      if (event.isTrusted) {
        inputAt = at;
      }
      if (event.key !== "Tab" && !MODIFIERS.has(event.key)) {
        typed(at);
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
      typed(now());
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
    add(frame, taken, options) {
      let guarded = frames.get(frame);
      if (guarded === undefined) {
        const entry: Guarded = {
          taken: new Set(),
          overSince: -Infinity,
          heardAt: -Infinity,
          ask: options?.nested === true ? options.ask : undefined,
          asked: 0,
          answered: false,
          word:
            options?.nested === true
              ? { supported: true, activatedAt: -Infinity, focused: false, focusedAt: -Infinity }
              : null,
        };
        frame.addEventListener("pointerover", () => {
          entry.overSince = now();
          pointerShown = true;
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
    shell(frame, said) {
      const guarded = frames.get(frame);
      const before = guarded?.word ?? null;
      if (guarded === undefined || before === null) {
        return;
      }
      const at = now();
      // Off to on after a stall, the shell's or the host's (no word for longer than its beat
      // allows): uncertain, and so until it goes off (P111, after its review). So is one that
      // turned on while the guard fights this frame for a text field (P120): the person's keys,
      // meant for the field, landing in the page.
      // So is one that turned on within `KEY_PRESS_MS` of a key the person typed on the host's page
      // before it (P122): that key's successor, landing in the page.
      const turnedOn = said.ago !== null && before.activatedAt === -Infinity && !before.uncertain;
      const stalled = said.gap > SHELL_STALL_MS || at - guarded.heardAt > SHELL_STALL_MS;
      const fought = contest !== null && contest.fight && contest.frame === frame;
      // The typing before it, never after: a key the person typed on the host's page after they
      // pressed the page, before the shell's word came, says nothing of that press (P122, after
      // CI). The shell saw it turn on at its look, so it turned on at most a look's gap before:
      // only a key before then counts.
      const turnedAt =
        said.ago === null ? -Infinity : at - said.ago - Math.min(said.gap, SHELL_STALL_MS);
      const typing = typedBefore(turnedAt);
      const soon = said.ago !== null && turnedAt - typing < KEY_PRESS_MS;
      const uncertain =
        said.ago !== null &&
        (before.uncertain === true || (turnedOn && (stalled || fought || soon)));
      guarded.heardAt = at;
      if (said.asked !== undefined && said.asked === guarded.asked) {
        guarded.answered = true;
      }
      // Whether a press could have turned it on, judged as it did (P120, after its review): the
      // person's typing then, and the pointer then, not when a move is later judged.
      const activatedAt = said.ago === null || uncertain ? -Infinity : at - said.ago;
      const keyed =
        activatedAt === -Infinity
          ? false
          : turnedOn
            ? !pressPossible(true, frame.matches(":hover"), guarded.overSince, typing, turnedAt)
            : before.keyed === true;
      guarded.word = {
        supported: said.supported,
        activatedAt,
        focused: said.focused,
        focusedAt: said.focused && !before.focused ? at : before.focusedAt,
        ...(uncertain ? { uncertain: true } : {}),
        ...(keyed ? { keyed: true } : {}),
      };
      if (waiting?.frame === frame) {
        settle(at);
      }
    },
    beat(frame) {
      const guarded = frames.get(frame);
      if (guarded !== undefined && guarded.word !== null) {
        guarded.heardAt = now();
      }
    },
    gesture(frame) {
      const guarded = frames.get(frame);
      const word = guarded?.word ?? null;
      const at = now();
      // Where a press could have made it (P120): a key the person typed into the page, meant for
      // the host's composer, turns the shell's activation on too.
      return (
        guarded !== undefined &&
        word !== null &&
        shellGesture(word, inputAt, at) &&
        !(pointerShown && word.keyed === true)
      );
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
      contest = { field, frame, guarded, fight: true, gaveAt: focusedAt, heldSince: null };
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
