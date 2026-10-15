import type {
  CapabilityArgs,
  CapabilityName,
  CapabilityResults,
  HandledCapability,
} from "../config/capabilities.ts";
import type { InstanceRef } from "../isolation/types.ts";

/**
 * The host-function bridge (ARCHITECTURE § Framework layer): carries a capability call from the
 * frame to the host's handler and its result back, checking at the boundary that the capability
 * is declared, that its arguments are well formed, and that every gate passes, in that order.
 * Adapters decode protocol messages into calls; the bridge alone decides whether they run.
 */

/** Which display a call came from. */
export interface CallContext {
  readonly displayId: string;
  /** The display's title, as the host gave it (never the content's words). */
  readonly title: string;
  readonly capability: CapabilityName;
}

export type CapabilityHandler<N extends CapabilityName> = (
  args: CapabilityArgs[N],
  context: N extends "subscribeData" ? SubscriptionContext : CallContext,
) => CapabilityResults[N] | Promise<CapabilityResults[N]>;

/**
 * A subscription's context (`subscribeData`, P079): how the host tells the content its resource
 * changed, and when to stop.
 */
export interface SubscriptionContext extends CallContext {
  /**
   * The resource changed: the content is told (`notifications/resources/updated`) and reads it
   * again. Pass the new `resources/read` result to answer that read without another call to
   * `readData`.
   */
  readonly changed: (result?: unknown) => void;
  /** Aborted when the content unsubscribes, its frame stops, or the display is destroyed. */
  readonly signal: AbortSignal;
}

/** The host's handlers: one for each declared capability served by a handler. */
export type CapabilityHandlers = { readonly [N in HandledCapability]?: CapabilityHandler<N> };

/**
 * Asked once per display before its first call of a `consent`-gated capability (P079): may this
 * content have them (read the viewer's data)? The request is that first call. A host remembers
 * the answer where it likes (per viewer, per widget); Porthole keeps it for the display's life.
 */
export type Consent = (request: ConfirmRequest) => boolean | Promise<boolean>;

/**
 * What the host last had for a resource (P079), answered at once, marked stale, to a read of a
 * resource the content subscribes to; the fresh result follows as an update. Undefined: none.
 */
export type DataCache = (args: CapabilityArgs["readData"], context: CallContext) => unknown;

/**
 * The display a confirmation is for, as the host named it: its id and title, and the instance the
 * host gave it, served or opaque (P076, P077), so a host can word its dialog from its own records.
 * Host-side only: none of it is the content's word, and an opaque frame never gets the instance.
 */
export interface ConfirmDisplay {
  readonly id: string;
  readonly title: string;
  readonly instance?: InstanceRef;
}

/** What a person is asked to confirm: the call's whole effect, not a summary the content chose. */
export type ConfirmRequest = {
  [N in CapabilityName]: {
    readonly capability: N;
    readonly args: CapabilityArgs[N];
    readonly display: ConfirmDisplay;
  };
}[CapabilityName];

/**
 * What the person chose. `true`/`"accepted"`: the call goes. `false`/`"declined"`: it doesn't,
 * and the decline counts toward muting the display. `"redirected"`: it doesn't go, but the person
 * took it elsewhere (edited the prompt first, say), so it neither counts as a decline nor resets
 * the count. The host decides which its UI's choices are.
 */
export type ConfirmAnswer = boolean | "accepted" | "declined" | "redirected";

/**
 * Runs the call's effect now, inside the caller's own gesture, and counts as accepted. A host
 * whose effect needs the person's gesture (opening a window) calls it from the click handler of
 * its own "yes" button, rather than resolving the promise and letting the effect run after.
 */
export type Proceed = () => void;

/**
 * Asks a person. Resolves with their answer. The host's UI, or the React binding's default
 * dialog; drawn outside the frame, never inside it. `proceed` (optional to use) runs the effect
 * within the "yes" click itself.
 */
export type Confirm = (request: ConfirmRequest, proceed: Proceed) => Promise<ConfirmAnswer>;

/** Why a call didn't run. */
export type Refusal =
  /** The config doesn't declare it. */
  | "not-declared"
  /** Its arguments were malformed (an `openLink` that isn't http(s), an empty prompt). */
  | "invalid"
  /** It needed a user gesture and had none. */
  | "no-user-activation"
  /** It needed a confirmation and there is no `confirm` function. */
  | "no-confirm"
  /** The person declined. */
  | "declined"
  /** The person took it elsewhere (edited it first): not sent, not counted as a decline. */
  | "redirected"
  /** The display was muted after too many declines (until it runs again). */
  | "muted"
  /** It is `consent`-gated and there is no `consent` function. */
  | "no-consent"
  /** The host's `consent` said no (for this display's life). */
  | "denied"
  | "rate-limited"
  /** The host's handler threw or rejected. */
  | "failed";

export type CallOutcome<T> =
  /** `stale`: a `readData` answered from the host's cache (`DataCache`). */
  | { readonly ok: true; readonly value: T; readonly stale?: true }
  | { readonly ok: false; readonly refusal: Refusal; readonly message?: string };

/** What an adapter adds to a call, beyond what the content sent. */
export interface CallOptions {
  readonly userActivated?: boolean;
  /** `subscribeData`: the subscription's channel back and its end (`SubscriptionContext`). */
  readonly subscription?: Pick<SubscriptionContext, "changed" | "signal">;
  /** `readData`: the host's cache may answer, marked stale (the content subscribes to it). */
  readonly stale?: boolean;
}

/** What adapters call; one per display. */
export interface HostFunctionBridge {
  /** Validates `args` for `capability`, applies its gates, then runs the host's handler. */
  call<N extends CapabilityName>(
    capability: N,
    args: unknown,
    options?: CallOptions,
  ): Promise<CallOutcome<CapabilityResults[N]>>;
  declared(capability: CapabilityName): boolean;
}
