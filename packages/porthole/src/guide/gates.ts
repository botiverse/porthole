import type { Gate } from "../config/capabilities.ts";

/** How a capability's gates read to the author: one sentence each. */
export function gateWords(gates: readonly Gate[], effect: string): string {
  const sentences: string[] = [];
  if (gates.includes("consent")) {
    sentences.push(
      "The first data call asks the person to allow it; if they don't, every one fails with code denied (show that the data isn't allowed, not an error).",
    );
  }
  if (gates.includes("confirm")) {
    sentences.push(
      `The app shows the person ${effect} first, and nothing happens unless they confirm.`,
    );
  }
  if (gates.includes("user-activation")) {
    sentences.push("Call it from a click (it needs one).");
  }
  for (const gate of gates) {
    if (typeof gate === "object") {
      sentences.push(`At most ${gate.rateLimit.perMinute} a minute.`);
    }
  }
  return sentences.join(" ");
}
