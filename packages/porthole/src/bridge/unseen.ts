/**
 * What a person can't see in text that a model or a host's UI reads (P100; P105 for labels): one
 * definition, for the bridge's check of a model context update and the annotation labels' strip.
 */

/**
 * What a person can't see but a model reads (the review of P100): format characters (zero-width
 * ones, bidi controls, the tags U+E0000–E007F, a soft hyphen, a byte-order mark), variation
 * selectors (U+FE00–FE0F, U+E0100–E01EF), private-use characters, lone surrogates, every
 * default-ignorable code point (the re-check: U+034F, Mongolian's free variation selectors, the
 * Hangul fillers, Khmer's inherent vowels), and controls other than a new line and a tab. An update with any is refused, never escaped: an escaped one
 * reads to the model differently from what the person was shown.
 */
const UNSEEN =
  /[\p{Cf}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]|[^\P{Cc}\n\t]/u;

/**
 * The parts of real emoji that draw as nothing alone, allowed only where an emoji has them (the
 * re-review of P100): U+FE0E or U+FE0F directly after a pictograph, or after a keycap base
 * (`[0-9#*]`) that U+20E3 follows; U+200D only between two pictographs, a selector or a skin tone
 * after the first. Each carries at most one choice beside a visible emoji (a selector there or
 * not, a joiner there or not), never letters a model would read. Tag characters stay refused:
 * subdivision flags too.
 */
const EMOJI_PARTS =
  "(?<=\\p{Extended_Pictographic})[\\uFE0E\\uFE0F]|(?<=[0-9#*])[\\uFE0E\\uFE0F](?=\\u20E3)|(?<=\\p{Extended_Pictographic}[\\uFE0F\\p{Emoji_Modifier}]?)\\u200D(?=\\p{Extended_Pictographic})";

/**
 * The scripts whose letters U+200C and U+200D shape (Unicode's notes on the joiners: the cursive
 * scripts, where they break or make a join, and the Indic ones and Myanmar, where they choose a
 * conjunct, a half form or a ligature), by Script_Extensions.
 */
const SHAPING_SCRIPTS = [
  "Arabic",
  "Syriac",
  "Nko",
  "Mongolian",
  "Devanagari",
  "Bengali",
  "Gurmukhi",
  "Gujarati",
  "Oriya",
  "Tamil",
  "Telugu",
  "Kannada",
  "Malayalam",
  "Sinhala",
  "Myanmar",
] as const;

const SHAPED = `[${SHAPING_SCRIPTS.map((name) => `\\p{scx=${name}}`).join("")}]`;

/**
 * A joiner or non-joiner between two letters or marks of those scripts (Persian's می‌خواهم, a
 * Hindi half form): the shape it chooses is what the person sees. One at a letter boundary, never
 * doubled, first or last, or beside a letter of another script.
 */
const SHAPING_JOINERS = `(?<=[\\p{L}\\p{M}])(?<=${SHAPED})[\\u200C\\u200D](?=[\\p{L}\\p{M}])(?=${SHAPED})`;

/** What may be invisible alone and is allowed where it is seen: one pass, on the text as sent. */
const SEEN_IN_PLACE = new RegExp(`${EMOJI_PARTS}|${SHAPING_JOINERS}`, "gu");

/** Whether `text` holds what a person can't see, the parts of emoji and shaped letters aside. */
export const unseen = (text: string): boolean => UNSEEN.test(text.replace(SEEN_IN_PLACE, ""));

/** Every code point `UNSEEN` names, each on its own. */
const UNSEEN_EACH = new RegExp(UNSEEN.source, "gu");

/**
 * `text` without anything a person can't see (P105), for text Porthole only shows, never matches,
 * as a wordless element's label is (an `alt`, `aria-label` or `title` the person never sees on the
 * page): every format character (bidi controls and the zero-width ones among them), every
 * default-ignorable code point, variation selector, private-use character and lone surrogate, and
 * every control but a new line and a tab. No exceptions: not the parts of emoji, nor the joiners
 * between shaped letters that `unseen` lets by, whose surroundings a page can fake (the review of
 * P105: a Mongolian variation selector beside each joiner carried 48 of them through, a payload
 * of six bytes). An emoji may lose its joiners (a family shows as its faces). Nothing `unseen`
 * refuses is left.
 */
export function withoutUnseen(text: string): string {
  return text.replace(UNSEEN_EACH, "");
}
