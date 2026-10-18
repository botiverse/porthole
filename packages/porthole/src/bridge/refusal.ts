import type { CapabilityName } from "../config/capabilities.ts";
import type { Refusal } from "./types.ts";

/**
 * Why a call was refused, as content is told (P080): a code it can branch on and a sentence it can
 * show the person viewing it. Carried in a refused request's JSON-RPC error, as its `data`; the
 * shell's globals reject with an error that has both (`error.code`, `error.message`).
 *
 * - `consent_required`: the viewer hasn't allowed it yet (their answer is still to come).
 * - `denied`: the viewer (or the person asked to confirm) said no.
 * - `rate_limited`: too many calls this minute.
 * - `not_allowed`: the host doesn't let this content have it, here or at all (a URI it doesn't
 *   serve, a page where data never runs).
 * - `failed`: the host tried and couldn't.
 * - `forbidden` (P087): the person viewing it may see the content but not do this (their level).
 * - `conflict` (P088): what it changes moved since it was read (a document's version, the
 *   artifact's base): read it again, then write.
 * - `too_large` (P088): more than a limit (a document, a batch, an upload, a publish).
 */
export const REFUSAL_CODES = [
  "consent_required",
  "denied",
  "rate_limited",
  "not_allowed",
  "failed",
  "forbidden",
  "conflict",
  "too_large",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** What content is told about a refusal: the JSON-RPC error's `data`. */
export interface RefusalReason {
  readonly code: RefusalCode;
  /** A sentence for the person viewing the content: the host's, else Porthole's. */
  readonly message: string;
}

/** The most a refusal's message carries to content. */
const MAX_MESSAGE = 500;

export function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === "string" && (REFUSAL_CODES as readonly string[]).includes(value);
}

/**
 * A refusal the host gives, with the reason content is told (P080). Throw it from a handler (this
 * URI isn't one you serve: `not_allowed`; the viewer didn't allow this kind of data: `denied`), or
 * from a `consent` function (kept as the display's answer, as `false` is). Or pass one as
 * `HostOptions.consent` itself: every `consent`-gated call is refused with it, and those
 * capabilities need no handler (a page where data never runs).
 *
 * Any other error a handler throws is `failed` with Porthole's words: its message stays the host's.
 */
export class Refused extends Error {
  readonly code: RefusalCode;

  /** `message`: a sentence for the viewer; absent, Porthole's for the code. */
  constructor(code: RefusalCode, message?: string) {
    if (!isRefusalCode(code)) {
      throw new TypeError(`Refused: code must be one of ${REFUSAL_CODES.join(", ")}`);
    }
    super(message === undefined || message.trim() === "" ? DEFAULT_MESSAGES[code] : message);
    this.name = "Refused";
    this.code = code;
  }
}

/**
 * Whether `value` is a `Refused`: by class, or by shape where two copies of Porthole meet (a
 * host's bundle and a library's).
 */
export function isRefused(value: unknown): value is Refused {
  return (
    value instanceof Refused ||
    (value instanceof Error &&
      value.name === "Refused" &&
      isRefusalCode((value as { code?: unknown }).code))
  );
}

/** The reason a host's `Refused` gives content. */
export function reasonOf(refused: Refused): RefusalReason {
  const message = refused.message.trim();
  return {
    code: refused.code,
    message: (message === "" ? DEFAULT_MESSAGES[refused.code] : message).slice(0, MAX_MESSAGE),
  };
}

/** Porthole's sentence for each code, where the host gave none. */
const DEFAULT_MESSAGES: { readonly [Code in RefusalCode]: string } = {
  consent_required: "This needs your permission first.",
  denied: "You didn't allow this.",
  rate_limited: "Too many requests: try again in a minute.",
  not_allowed: "This isn't available here.",
  failed: "The app couldn't do this.",
  forbidden: "You don't have permission to do this here.",
  conflict: "This changed since it was read: read it again, then try again.",
  too_large: "This is too large.",
};

/** Where a data capability's words differ: they name the data. */
const DATA_MESSAGES: { readonly [Code in RefusalCode]: string } = {
  consent_required: "Reading this data needs your permission first.",
  denied: "You didn't allow this to read your data.",
  rate_limited: "Too many data requests: try again in a minute.",
  not_allowed: "This data isn't available here.",
  failed: "The app couldn't get this data.",
  forbidden: "You don't have permission to read this data.",
  conflict: DEFAULT_MESSAGES.conflict,
  too_large: DEFAULT_MESSAGES.too_large,
};

/** Each refusal's code, as content is told it. */
const CODES: { readonly [R in Refusal]: RefusalCode } = {
  "not-declared": "not_allowed",
  invalid: "not_allowed",
  "no-user-activation": "not_allowed",
  "no-confirm": "not_allowed",
  declined: "denied",
  redirected: "denied",
  muted: "denied",
  "no-consent": "not_allowed",
  denied: "denied",
  "rate-limited": "rate_limited",
  failed: "failed",
  undeclared: "not_allowed",
  level: "forbidden",
  "too-large": "too_large",
};

/** Refusals whose own words say more than their code's. */
const OWN_MESSAGES: { readonly [R in Refusal]?: string } = {
  "no-user-activation": "This needs a click.",
  invalid: "The app can't take this request.",
  muted: "You declined this too often: it isn't asked again until it runs again.",
};

/** What content is told about a refusal Porthole made (the host gave no `Refused`). */
export function defaultReason(capability: CapabilityName, refusal: Refusal): RefusalReason {
  const code = CODES[refusal];
  const data = capability === "readData" || capability === "subscribeData";
  return {
    code,
    message: OWN_MESSAGES[refusal] ?? (data ? DATA_MESSAGES : DEFAULT_MESSAGES)[code],
  };
}

/** What content is told about a refused call: the bridge's reason, else Porthole's for it. */
export function reasonFor(
  capability: CapabilityName,
  outcome: { readonly refusal: Refusal; readonly reason?: RefusalReason },
): RefusalReason {
  const reason = outcome.reason ?? defaultReason(capability, outcome.refusal);
  return { code: reason.code, message: reason.message };
}

/** A consent function that failed (threw, rejected): not an answer, so asked again at the next. */
export function pendingReason(capability: CapabilityName): RefusalReason {
  const data = capability === "readData" || capability === "subscribeData";
  return {
    code: "consent_required",
    message: (data ? DATA_MESSAGES : DEFAULT_MESSAGES).consent_required,
  };
}
