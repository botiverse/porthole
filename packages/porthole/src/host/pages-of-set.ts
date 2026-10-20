import { MCP_APPS_METHODS, NAVIGATING_METHOD } from "../protocol/mcp-apps.ts";
import type { JsonRpcMessage } from "../protocol/jsonrpc.ts";
import type { Surface } from "../platform/types.ts";

/** How long a set's page said its next load is another of its pages (P084), ms. */
export const PAGE_OF_SET_MS = 10_000;

/**
 * How long a load no page has announced waits for its notice before the display starts again, in
 * a display whose pages may come with files (P098), ms. The notice can come after the load: on
 * Chromium a cross-process `postMessage` is forwarded from a task of the sending document's, so
 * the leaving page's notice can arrive after the next page's load or, when the navigation commits
 * first, never; the arriving page says so too, and its word can come after its own load.
 */
export const LATE_NOTICE_MS = 2_000;

/** The artifact version a display mounted: the only set whose pages its notices may name. */
export interface FileSetRef {
  readonly id: string;
  readonly version: string;
}

interface Notice {
  readonly url: string;
  readonly arrived: boolean;
  /** Whether it names the mounted version (`ok`), another (`other`), or none (a shell before P098). */
  readonly set: "ok" | "other" | "none";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function noticeOf(raw: unknown, mounted: FileSetRef): Notice | null {
  if (!isRecord(raw) || raw.jsonrpc !== "2.0" || raw.method !== NAVIGATING_METHOD || "id" in raw) {
    return null;
  }
  const params = isRecord(raw.params) ? raw.params : {};
  const named = params.set;
  return {
    url: typeof params.url === "string" ? params.url : "",
    arrived: params.arrived === true,
    set:
      named === undefined
        ? "none"
        : isRecord(named) && named.id === mounted.id && named.version === mounted.version
          ? "ok"
          : "other",
  };
}

const isHello = (raw: unknown): boolean =>
  isRecord(raw) && raw.method === MCP_APPS_METHODS.initialize && "id" in raw;

/**
 * Which of a frame's loads are another page of its own set (P084, P098), for a display whose
 * pages may come with files; every other display passes `set: null`, and each load after the
 * first is the content navigating away (P031).
 *
 * A notice (`porthole/navigating`, from the frame's window and content origin: the transport
 * takes nothing else) names a page and the version its files are. The leaving page's notice is
 * taken for the next load within `PAGE_OF_SET_MS`; the arriving page's (`arrived`) for the next
 * load within `LATE_NOTICE_MS`, or for the load it came after. A load no notice explained waits
 * `LATE_NOTICE_MS`, holding the frame: nothing it says reaches the display (no call is answered,
 * no report taken), nothing is sent to it, and once the wait is over without a notice for the
 * mounted version, the display starts again. A notice for another version, or the new page's
 * hello before any notice, ends the wait at once: started again. Only a notice naming the mounted
 * version ends a wait without a restart; one from a shell before P098 (no version) can only be
 * taken for a load still to come, as before.
 *
 * Returns the surface the display uses: the same, its transport held while a load waits.
 */
export function pagesOfSet(options: {
  readonly surface: Surface;
  readonly set: FileSetRef | null;
  /** The frame left its content: start the display again. */
  readonly away: () => void;
}): Surface {
  const { surface, set, away } = options;
  if (set === null) {
    surface.onNavigated(away);
    return surface;
  }
  const raw = surface.transport;
  // Taken for the next load until then, as that page.
  let grantUntil = 0;
  let grantFor = "";
  // The page the frame's last load was taken as: a late copy of its notice is no new one.
  let current: string | null = null;
  // Loads waiting for their notice, and what the frame said and was sent meanwhile.
  let waiting = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const heard: unknown[] = [];
  const unsent: JsonRpcMessage[] = [];
  const listeners = new Set<(message: unknown) => void>();
  let closed = false;

  const deliver = (message: unknown) => {
    for (const listener of listeners) {
      listener(message);
    }
  };
  const settle = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const leave = () => {
    settle();
    waiting = 0;
    heard.length = 0;
    unsent.length = 0;
    away();
  };
  const taken = (url: string) => {
    current = url;
    waiting -= 1;
    if (waiting > 0) {
      return;
    }
    settle();
    for (const message of unsent.splice(0)) {
      raw.send(message);
    }
    for (const message of heard.splice(0)) {
      deliver(message);
    }
  };

  raw.listen((message) => {
    if (closed) {
      return;
    }
    const notice = noticeOf(message, set);
    if (notice !== null) {
      if (notice.set === "other" || (notice.arrived && notice.set !== "ok")) {
        // Another version's page, or one that won't say which: never this display's.
        if (waiting > 0) {
          leave();
        }
        return;
      }
      if (waiting === 0 && notice.url === current) {
        // A late copy for the page the frame is on (its leaving page's, or its own): no new page.
        return;
      }
      if (waiting > 0) {
        if (notice.set === "ok") {
          taken(notice.url);
        }
      } else {
        grantUntil = Date.now() + (notice.arrived ? LATE_NOTICE_MS : PAGE_OF_SET_MS);
        grantFor = notice.url;
      }
    } else if (waiting > 0 && isHello(message)) {
      // A page that greets the host before saying it is one of the set's isn't.
      leave();
      return;
    }
    if (waiting > 0) {
      heard.push(message);
    } else {
      deliver(message);
    }
  });

  surface.onNavigated(() => {
    if (grantUntil > Date.now()) {
      grantUntil = 0;
      current = grantFor;
      return;
    }
    grantUntil = 0;
    waiting += 1;
    // From the first load that waits: more loads don't put the restart off.
    if (timer === null) {
      timer = setTimeout(leave, LATE_NOTICE_MS);
    }
  });

  return {
    ...surface,
    transport: {
      send(message) {
        if (waiting > 0) {
          unsent.push(message);
        } else {
          raw.send(message);
        }
      },
      listen(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        closed = true;
        listeners.clear();
        raw.close();
      },
    },
    destroy() {
      closed = true;
      settle();
      heard.length = 0;
      unsent.length = 0;
      listeners.clear();
      surface.destroy();
    },
  };
}
