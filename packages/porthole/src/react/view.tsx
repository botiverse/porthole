import {
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ColorScheme } from "../config/schema.ts";
import { frameFallback, type FrameFallback, type PortholeClient } from "../host/client.ts";
import { oneShot } from "../host/locator.ts";
import { originMatchesSource } from "../isolation/served.ts";
import type { FrameOutcome } from "../host/types.ts";
import type { FrameLocation, InstanceRef } from "../isolation/types.ts";
import {
  PortholeFrame,
  PortholeContext,
  type PortholeFrameHandle,
  type PortholeFrameProps,
} from "./frame.tsx";

/**
 * The host kit's React side (P072): a display by its kind, served or opaque as the server says
 * now, located through the provider's client, with a fallback when its frame shows nothing.
 *
 *   <PortholeProvider client={porthole} scheme={mode}>
 *     <PortholeView display="page" instance={instance} content={opaqueCopy}
 *       fallback={({ title, message, link, retry }) => <Fallback … />} />
 *   </PortholeProvider>
 */

/** What a fallback is drawn from: why the frame showed nothing, its clean address, a retry. */
export interface PortholeFallbackProps extends FrameFallback {
  /** The instance's clean address (its "open in a new tab"), or null. */
  readonly link: string | null;
  /** Shows the display again. */
  readonly retry: () => void;
}

export interface PortholeViewProps extends Omit<
  PortholeFrameProps,
  "config" | "instance" | "content" | "fill"
> {
  /** The display kind (`defineDisplays`). */
  readonly display: string;
  /**
   * The instance: what a served frame shows; for an opaque one, the host's own name for it, given
   * back in its confirmations only, never sent to the frame (P077).
   */
  readonly instance?: InstanceRef;
  /**
   * A clean address to show instead of an instance (P125): resolved through the client
   * (`client.resolve`) before any frame. What it names is framed through its issued location (a
   * door, a ticket); signed out, denied or not found, the fallback is drawn from that answer, and
   * no frame is made. A clean address is never framed itself.
   */
  readonly address?: string;
  /**
   * The content: a served shell's to draw, and what an opaque frame shows while frames aren't
   * served (a stored page's HTML). Without it, a served-only display shows the fallback then.
   */
  readonly content?: string;
  /** Drawn instead of the frame when it showed nothing. Default: a line and a link. */
  readonly fallback?: (props: PortholeFallbackProps) => ReactNode;
  /** Drawn while the server's meta isn't known yet. */
  readonly pending?: ReactNode;
}

function useClient(): PortholeClient {
  const client = useContext(PortholeContext).client;
  if (client === undefined) {
    throw new Error("PortholeView needs a PortholeProvider with a client (portholeClient)");
  }
  return client;
}

/** The client's meta, as a React value (re-renders when frames start or stop being served). */
/**
 * The client's meta. On the server too (P074): a client made with the meta it will start with
 * (`portholeClient({ meta })`) renders the frame's placeholder or the fallback there, and the
 * page hydrates from the same.
 */
function useMeta(client: PortholeClient) {
  return useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.meta(),
    () => client.meta(),
  );
}

function DefaultFallback({ title, message, link }: PortholeFallbackProps): ReactElement {
  return (
    <div data-porthole-fallback="" role="status" style={{ padding: 16 }}>
      <strong>{title}</strong> <span>{message}</span>{" "}
      {link === null ? null : (
        <a href={link} target="_blank" rel="noopener">
          Open in a new tab
        </a>
      )}
    </div>
  );
}

export function PortholeView(props: PortholeViewProps): ReactElement | null {
  return props.address !== undefined && props.instance === undefined ? (
    <AddressView {...props} address={props.address} />
  ) : (
    <InstanceView {...props} />
  );
}

/**
 * Whether `address` may be offered as a fallback's "open in a new tab": a clean address on the
 * served content domain (`contentSource`, its scheme and port), not Porthole's own paths. Anything
 * else (another site, a typo the server answered 404 for elsewhere) gets no link.
 */
export function tabLinkOf(
  address: string,
  contentSource: string | null | undefined,
): string | null {
  if (contentSource === null || contentSource === undefined) {
    return null;
  }
  try {
    const url = new URL(address);
    return originMatchesSource(url.origin, contentSource) &&
      !url.pathname.startsWith("/__porthole/")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** A clean address's view (P125): resolved first; its instance's view, or the answer's fallback. */
function AddressView(props: PortholeViewProps & { readonly address: string }): ReactElement | null {
  const client = useClient();
  const page = useContext(PortholeContext);
  const meta = useMeta(client);
  const { address, fallback, pending, onOutcome } = props;
  const [state, setState] = useState<
    | { readonly kind: "resolving" }
    | {
        readonly kind: "instance";
        readonly instance: InstanceRef;
        readonly location: FrameLocation;
      }
    | { readonly kind: "refused"; readonly said: FrameFallback }
  >({ kind: "resolving" });
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => setGeneration((each) => each + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "resolving" });
    client.resolve(address, controller.signal).then(
      (resolved) => {
        if (controller.signal.aborted) {
          return;
        }
        if ("outcome" in resolved) {
          onOutcome?.(resolved.outcome);
          const said = frameFallback(resolved.outcome);
          setState(
            said === null
              ? {
                  kind: "refused",
                  said: { kind: "failed", title: "This can't be shown now", message: "" },
                }
              : { kind: "refused", said },
          );
          return;
        }
        setState({ kind: "instance", instance: resolved.instance, location: resolved.location });
      },
      () => {
        if (controller.signal.aborted) {
          return;
        }
        const outcome: FrameOutcome = { state: "blocked", reason: "locate" };
        onOutcome?.(outcome);
        setState({
          kind: "refused",
          said: frameFallback(outcome) ?? {
            kind: "failed",
            title: "This can't be shown now",
            message: "",
          },
        });
      },
    );
    return () => controller.abort();
    // The address and a retry decide; a new onOutcome doesn't resolve it again.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [client, address, generation]);
  // This view's own locator (P125): its frame's first run takes the location it resolved, once;
  // every later run issues afresh. No other view of the instance can take it.
  const located = state.kind === "instance" ? state.location : null;
  const own = useMemo(() => {
    if (located === null) {
      return null;
    }
    const locator = oneShot(located, { locate: (each, signal) => client.locate(each, signal) });
    return {
      ...page,
      locate: (each: InstanceRef, signal?: AbortSignal) => locator.locate(each, signal),
    };
  }, [page, located, client]);
  if (state.kind === "resolving") {
    return <>{pending ?? null}</>;
  }
  if (state.kind === "refused") {
    // The clean address is the "open in a new tab" only where it is one: on the content domain.
    return (
      <>
        {(fallback ?? DefaultFallback)({
          ...state.said,
          link: tabLinkOf(address, meta?.contentSource),
          retry,
        })}
      </>
    );
  }
  const { address: _address, ...rest } = props;
  return (
    <PortholeContext.Provider value={own ?? page}>
      <InstanceView {...rest} instance={state.instance} />
    </PortholeContext.Provider>
  );
}

function InstanceView(props: PortholeViewProps): ReactElement | null {
  const client = useClient();
  const meta = useMeta(client);
  const {
    display,
    instance,
    content,
    fallback,
    pending,
    onOutcome,
    ref,
    address: _address,
    ...frame
  } = props;
  // The view's handle (P118) is there while the view is, a fallback drawn or not: its calls reach
  // the frame's display when one runs, and do nothing otherwise.
  const shown = useRef<PortholeFrameHandle>(null);
  useImperativeHandle(
    ref,
    (): PortholeFrameHandle => ({
      clearSelection: () => shown.current?.clearSelection(),
    }),
    [],
  );
  const [failed, setFailed] = useState<FrameFallback | null>(null);
  const [generation, setGeneration] = useState(0);
  const [link, setLink] = useState<string | null>(null);
  const kind = display;
  const config = client.config(kind);
  const served = meta?.served === true && config?.isolation !== "opaque";
  const url = config?.mode === "url";

  const retry = useCallback(() => {
    setFailed(null);
    setGeneration((each) => each + 1);
  }, []);
  useEffect(() => {
    if (failed === null || instance === undefined) {
      return;
    }
    let live = true;
    void client.link(instance).then((found) => {
      if (live) {
        setLink(found);
      }
    });
    return () => {
      live = false;
    };
  }, [client, failed, instance]);

  if (meta === null || config === null) {
    // Not known yet; or a url kind while frames aren't served.
    if (meta !== null && config === null) {
      const said: FrameFallback = {
        kind: "failed",
        title: "This can't be shown now",
        message: "Its content isn't being served.",
      };
      return <>{(fallback ?? DefaultFallback)({ ...said, link: null, retry })}</>;
    }
    return <>{pending ?? null}</>;
  }
  if (!served && content === undefined) {
    const said: FrameFallback = {
      kind: "failed",
      title: "This can't be shown now",
      message: "Its content isn't being served.",
    };
    return <>{(fallback ?? DefaultFallback)({ ...said, link: null, retry })}</>;
  }
  if (failed !== null) {
    return <>{(fallback ?? DefaultFallback)({ ...failed, link, retry })}</>;
  }
  return (
    <PortholeFrame
      {...frame}
      ref={shown}
      config={config}
      generation={(frame.generation ?? 0) + generation}
      {...(instance === undefined ? {} : { instance })}
      {...(content === undefined ? {} : { content })}
      onOutcome={(outcome: FrameOutcome) => {
        onOutcome?.(outcome);
        const said = frameFallback(outcome, { url });
        if (said !== null) {
          setFailed(said);
        }
      }}
    />
  );
}

/** An instance's clean address, and its "open in a new tab" and "copy link" (P072). */
export function usePortholeLink(instance: InstanceRef | null): {
  readonly link: string | null;
  readonly open: () => void;
  readonly copy: () => Promise<boolean>;
} {
  const client = useClient();
  const key = instance === null ? "" : JSON.stringify(instance);
  // The address found for the instance it was found for: another instance shows none until its own.
  const [found, setFound] = useState<{ readonly key: string; readonly link: string | null }>(
    () => ({ key, link: instance === null ? null : client.knownLink(instance) }),
  );
  useEffect(() => {
    if (key === "") {
      return;
    }
    let live = true;
    void client.link(JSON.parse(key) as InstanceRef).then((each) => {
      if (live) {
        setFound({ key, link: each });
      }
    });
    return () => {
      live = false;
    };
  }, [client, key]);
  const link = found.key === key ? found.link : null;
  const open = useCallback(() => {
    if (key !== "") {
      client.openInTab(JSON.parse(key) as InstanceRef);
    }
  }, [client, key]);
  const copy = useCallback(async () => {
    if (link === null) {
      return false;
    }
    try {
      await navigator.clipboard.writeText(link);
      return true;
    } catch {
      return false;
    }
  }, [link]);
  return { link, open, copy };
}

/**
 * Theme values read from the page's own CSS variables (P072): `tokens` maps each of Porthole's
 * theme variables to the app's (`{ "--color-text-primary": "--app-fg" }`). Read when a frame asks,
 * so pass `themeKey` to re-read after the app's theme changes.
 */
export function cssVariableTheme(
  tokens: Readonly<Record<string, string>>,
  root?: () => Element,
): (scheme: ColorScheme) => Record<string, string> {
  return () => {
    const element = root?.() ?? globalThis.document?.documentElement;
    if (element === undefined) {
      return {};
    }
    const style = getComputedStyle(element);
    const values: Record<string, string> = {};
    for (const [ours, theirs] of Object.entries(tokens)) {
      const value = style.getPropertyValue(theirs).trim();
      if (value !== "") {
        values[ours] = value;
      }
    }
    return values;
  };
}

/** A display's "run again": pass `generation` to the frame, call `runAgain` from a button. */
export function useRunAgain(): { readonly generation: number; readonly runAgain: () => void } {
  const [generation, setGeneration] = useState(0);
  const runAgain = useCallback(() => setGeneration((each) => each + 1), []);
  return { generation, runAgain };
}
