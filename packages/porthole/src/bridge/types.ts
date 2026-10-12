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
  context: CallContext,
) => CapabilityResults[N] | Promise<CapabilityResults[N]>;

/** The host's handlers: one for each declared capability served by a handler. */
export type CapabilityHandlers = { readonly [N in HandledCapability]?: CapabilityHandler<N> };

/**
 * The display a confirmation is for, as the host named it: its id and title, and the instance it
 * shows where it is served (P076), so a host can word its dialog from its own records.
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
  | "rate-limited"
  /** The host's handler threw or rejected. */
  | "failed";

export type CallOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: Refusal; readonly message?: string };

/** What adapters call; one per display. */
export interface HostFunctionBridge {
  /** Validates `args` for `capability`, applies its gates, then runs the host's handler. */
  call<N extends CapabilityName>(
    capability: N,
    args: unknown,
    options?: { readonly userActivated?: boolean },
  ): Promise<CallOutcome<CapabilityResults[N]>>;
  declared(capability: CapabilityName): boolean;
}
