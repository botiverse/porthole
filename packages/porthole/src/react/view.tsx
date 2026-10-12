import {
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ColorScheme } from "../config/schema.ts";
import { frameFallback, type FrameFallback, type PortholeClient } from "../host/client.ts";
import type { FrameOutcome } from "../host/types.ts";
import type { InstanceRef } from "../isolation/types.ts";
import { PortholeFrame, PortholeContext, type PortholeFrameProps } from "./frame.tsx";

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
  /** The instance to show while frames are served. */
  readonly instance?: InstanceRef;
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
  const client = useClient();
  const meta = useMeta(client);
  const { display, instance, content, fallback, pending, onOutcome, ...frame } = props;
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
      config={config}
      generation={(frame.generation ?? 0) + generation}
      {...(served && instance !== undefined ? { instance } : {})}
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
