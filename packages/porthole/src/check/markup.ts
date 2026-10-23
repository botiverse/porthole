/** Reading markup without parsing it: what the checks share. Linear, however it was written. */

const isSpace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

/** A tag's attributes, read once from left to right (linear): each name, value and its offset. */
export function attributesOf(text: string): { name: string; value: string; at: number }[] {
  const out: { name: string; value: string; at: number }[] = [];
  let at = 0;
  while (at < text.length) {
    while (at < text.length && (isSpace(text.charCodeAt(at)) || text[at] === "/")) {
      at += 1;
    }
    const nameStart = at;
    while (
      at < text.length &&
      !isSpace(text.charCodeAt(at)) &&
      text[at] !== "=" &&
      text[at] !== "/"
    ) {
      at += 1;
    }
    const name = text.slice(nameStart, at).toLowerCase();
    if (name === "") {
      at += 1;
      continue;
    }
    while (at < text.length && isSpace(text.charCodeAt(at))) {
      at += 1;
    }
    if (text[at] !== "=") {
      continue;
    }
    at += 1;
    while (at < text.length && isSpace(text.charCodeAt(at))) {
      at += 1;
    }
    const quote = text[at];
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, at + 1);
      const end = close < 0 ? text.length : close;
      out.push({ name, value: text.slice(at + 1, end), at: at + 1 });
      at = end + 1;
    } else {
      const start = at;
      while (at < text.length && !isSpace(text.charCodeAt(at))) {
        at += 1;
      }
      out.push({ name, value: text.slice(start, at), at: start });
    }
  }
  return out;
}
