import type {
  CapabilityArgs,
  CapabilityName,
  CapabilityResults,
  HandledCapability,
} from "../config/capabilities.ts";

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

/** What a person is asked to confirm: the call's whole effect, not a summary the content chose. */
export type ConfirmRequest = {
  [N in CapabilityName]: {
    readonly capability: N;
    readonly args: CapabilityArgs[N];
    readonly display: { readonly id: string; readonly title: string };
  };
}[CapabilityName];

/**
 * Asks a person. Resolves true only if they accept. The host's UI, or the React binding's default
 * dialog; drawn outside the frame, never inside it.
 */
export type Confirm = (request: ConfirmRequest) => Promise<boolean>;

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
