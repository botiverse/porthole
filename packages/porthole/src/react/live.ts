/**
 * Which frames run on a page: each runs a display's scripts, so a page runs at most a few at once.
 * A frame runs when it comes near the screen (or is asked to run); past the most, the frames that
 * went off screen longest ago stop, and show a placeholder at their last height until they come
 * near again. Framework-free, so it is tested on its own.
 */

export type FrameState = "waiting" | "running" | "stopped";

/**
 * Which frames run once `key` comes near the screen or is asked to run. `live` is the frames
 * running, the least recently admitted first. `key` runs; past `max`, the frames that are not near
 * the screen stop first, oldest first (one near the screen stops only when all are near).
 */
export function admitFrame(
  live: readonly string[],
  near: ReadonlySet<string>,
  key: string,
  max: number,
): string[] {
  const next = [...live.filter((other) => other !== key), key];
  while (next.length > Math.max(1, max)) {
    const far = next.findIndex((other) => other !== key && !near.has(other));
    next.splice(far === -1 ? 0 : far, 1);
  }
  return next;
}

export interface LiveFrames {
  subscribe(listener: () => void): () => void;
  state(key: string): FrameState;
  /** The frame came near the screen, or left it. */
  near(key: string, isNear: boolean): void;
  /** `key` runs (near the screen, or asked to run again); others past `max` stop. */
  admit(key: string, max: number): void;
  /** The frame is gone. */
  release(key: string): void;
}

export function createLiveFrames(): LiveFrames {
  let live: readonly string[] = [];
  const nearScreen = new Set<string>();
  const ran = new Set<string>();
  const listeners = new Set<() => void>();
  const changed = (next: readonly string[]) => {
    live = next;
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state: (key) => (live.includes(key) ? "running" : ran.has(key) ? "stopped" : "waiting"),
    near(key, isNear) {
      if (isNear) {
        nearScreen.add(key);
      } else {
        nearScreen.delete(key);
      }
    },
    admit(key, max) {
      ran.add(key);
      changed(admitFrame(live, nearScreen, key, max));
    },
    release(key) {
      nearScreen.delete(key);
      ran.delete(key);
      if (live.includes(key)) {
        changed(live.filter((other) => other !== key));
      }
    },
  };
}
