/** The most content blocks a message's text is read from: more is no message a person sends. */
const MAX_BLOCKS = 1_000;

/**
 * The text of a `ui/message`'s content blocks, the adapters' one reading of it: its text blocks'
 * text, in order, joined by `separator`; null where there is none, or more blocks than a message
 * holds. Read before any gate, so only as far as `max` characters (S05's class, P095: structured
 * clone delivers a sparse array of any length, or one block shared a million times, for the cost
 * of one): past it, `max + 1` characters, which the bridge refuses as too long.
 */
export function messageText(
  blocks: readonly unknown[],
  separator: string,
  max: number,
): string | null {
  if (blocks.length > MAX_BLOCKS) {
    return null;
  }
  let text: string | null = null;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as { type?: unknown; text?: unknown } | null | undefined;
    if (
      block !== null &&
      typeof block === "object" &&
      !Array.isArray(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      text = text === null ? block.text : `${text}${separator}${block.text}`;
      if (text.length > max) {
        return text.slice(0, max + 1);
      }
    }
  }
  return text;
}
