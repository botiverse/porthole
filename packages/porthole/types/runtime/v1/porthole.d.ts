// Porthole capability runtime, contract 1: the call contract (how a page reaches any capability).

/**
 * Why a call was refused: branch on it; show `message` (a sentence for the person) where the
 * result would be. Never retry in a loop.
 * - consent_required: the person hasn't allowed it yet.
 * - denied: the person said no.
 * - rate_limited: too many calls this minute.
 * - not_allowed: not available here (some places show the page without it).
 * - failed: the app tried and couldn't.
 * - forbidden: this person may see the page but not do this (their level).
 * - conflict: what you change moved since you read it: read it again, then write.
 * - too_large: past a limit.
 */
type PortholeErrorCode =
  | "consent_required"
  | "denied"
  | "rate_limited"
  | "not_allowed"
  | "failed"
  | "forbidden"
  | "conflict"
  | "too_large";

/** What every capability method rejects with. */
interface PortholeError extends Error {
  readonly code: PortholeErrorCode;
}

/** Each capability's namespace, by the name `use` takes (each capability's own file adds its own). */
interface PortholeCapabilities {}

interface PortholeRuntime {
  /**
   * The capability's namespace, frozen; or null when it isn't there for this page: the app
   * doesn't offer it, the page didn't declare it, or no app is showing the page (a tab, a
   * preview). The reasons are indistinguishable: draw the page without it. `use` never rejects;
   * permission problems come when you call a method (a rejected promise, `PortholeError`).
   */
  use<N extends keyof PortholeCapabilities>(name: N): Promise<PortholeCapabilities[N] | null>;
}

/** The page's one global. Nothing else is added to `window`. */
declare const porthole: PortholeRuntime;
