import type {
  CapabilityArgs,
  CapabilityName,
  CapabilityResults,
  HandledCapability,
} from "../config/capabilities.ts";
import type { InstanceRef } from "../isolation/types.ts";
import type { RuntimeCapabilityName } from "../runtime/contract.ts";
import type { DeclaredData, DeclaredDb } from "../runtime/declaration.ts";
import type { ViewerInfo } from "../runtime/levels.ts";
import type { RefusalReason } from "./refusal.ts";

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
  /** The instance the host gave the display (which artifact, which version), if any. */
  readonly instance?: InstanceRef;
  /**
   * Who is viewing, as the host said (P087): the bridge already checked the method's level
   * against it. A host's own API checks again: it is its data's wall.
   */
  readonly viewer?: ViewerInfo;
  /**
   * The page's declaration for this capability (P086): its levels, `data`'s resources and tools,
   * `db`'s rules (the fields of the one it is).
   */
  readonly declared?: DeclaredData & DeclaredDb;
}

export type CapabilityHandler<N extends CapabilityName> = (
  args: CapabilityArgs[N],
  context: N extends "subscribeData"
    ? SubscriptionContext
    : N extends "db"
      ? DbContext
      : CallContext,
) => CapabilityResults[N] | Promise<CapabilityResults[N]>;

/**
 * A subscription's context (`subscribeData`, P079; a `db` watch, P088): how the host tells the
 * content its resource changed, and when to stop. A `db` watch's `changed` takes the new state
 * (a snapshot, or a collection's `{ docs }`), which goes to the content as it is.
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

/** A `db` call's context: a watch's (`op: "watch"`) carries its channel back and its end. */
export type DbContext = CallContext & Partial<Pick<SubscriptionContext, "changed" | "signal">>;

/** The host's handlers: one for each declared capability served by a handler. */
export type CapabilityHandlers = { readonly [N in HandledCapability]?: CapabilityHandler<N> };

/**
 * Asked once per display before its first call of a `consent`-gated capability (P079): may this
 * content have them (read the viewer's data)? The request is that first call. A host remembers
 * the answer where it likes (per viewer, per widget); Porthole keeps it for the display's life.
 * `false` is a no (content is told `denied`); a thrown `Refused` is a no with its reason, kept
 * the same way (P080); anything else it throws is no answer yet (`consent_required`), and the next
 * call asks again.
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
    /**
     * A confirmation only (never a consent's request): the runtime methods whose own gates
     * (`CapabilityConfig.methodGates`, the contract's) asked for it, of those the call runs (P094):
     * a db batch's writes' ops that need a yes, so a dialog can lead with them. Absent where only
     * the host function's own gates ask.
     */
    readonly askedBy?: readonly string[];
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
 * Puts a call's whole effect in front of the person, outside every frame (the `show` gate, P100):
 * a `setModelContext` update's text and structured content, which the model reads at its next
 * turns. It asks nothing; the call goes once it returns (or its promise resolves), so it resolves
 * only once this very update is visible: drawn, not queued behind a render (after the review). An
 * update the person never saw, because a later one of the display replaced it first, rejects:
 * the call doesn't go. One that throws or rejects stops the call: nobody saw it. Each update
 * replaces the display's last (MCP Apps: the host sends the model the last one), so a surface
 * shows the latest per display.
 */
export type Show = (request: ConfirmRequest) => void | Promise<void>;

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
  /** It is `show`-gated and there is no `show` function: nobody could see it (P100). */
  | "no-show"
  /** The host's `consent` said no (for this display's life). */
  | "denied"
  | "rate-limited"
  /** The host's handler threw or rejected (or its `show` did: nobody saw the call, P100). */
  | "failed"
  /**
   * The display's page declared capabilities and not this one (P086): a built-in needs none, any
   * other is reachable only by a page that declared it (and only the resources and tools it named).
   */
  | "undeclared"
  /**
   * The viewer's level doesn't reach the method's (P087), or the call reaches data that isn't
   * theirs (another person's `data/users/<id>`); or the host gave the display no viewer, which a
   * runtime capability needs.
   */
  | "level"
  /** Past a limit: a document, a batch, an upload, a publish (P088). */
  | "too-large";

export type CallOutcome<T> =
  /** `stale`: a `readData` answered from the host's cache (`DataCache`). */
  | { readonly ok: true; readonly value: T; readonly stale?: true }
  | {
      readonly ok: false;
      readonly refusal: Refusal;
      /** What the host's handler threw: the host's own words, never sent to content. */
      readonly message?: string;
      /** What content is told (P080): the host's `Refused`, else Porthole's for the refusal. */
      readonly reason?: RefusalReason;
    };

/** What an adapter adds to a call, beyond what the content sent. */
export interface CallOptions {
  readonly userActivated?: boolean;
  /** `subscribeData`: the subscription's channel back and its end (`SubscriptionContext`). */
  readonly subscription?: Pick<SubscriptionContext, "changed" | "signal">;
  /** `readData`: the host's cache may answer, marked stale (the content subscribes to it). */
  readonly stale?: boolean;
  /**
   * `readData`: a result the host already gave for this read (a subscription's `changed(result)`,
   * the fresh read after a stale answer), and the URI it was given for. It answers the read after
   * every gate a read has, without the handler or the cache (P094: a kept result is never a way
   * past the read's gates); a `uri` that isn't the read's is refused (`invalid`). Ignored for any
   * capability but `readData`.
   */
  readonly held?: { readonly uri: string; readonly value: unknown };
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
  /**
   * What the runtime offers this display (P085): each runtime capability it may `use`, with its
   * methods. Empty without `config.runtime`. The same whatever the viewer's level: levels refuse
   * at call time.
   */
  roster(): Readonly<Partial<Record<RuntimeCapabilityName, readonly string[]>>>;
}
