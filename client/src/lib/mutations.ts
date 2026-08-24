/**
 * App-wide mutation notification bus (no external store).
 *
 * Mutation handlers publish the logical datasets they changed; every mounted
 * view subscribed to one of those datasets refetches authoritative server
 * state immediately. The server/database remains the single source of truth
 * — this bus never carries payloads, only "this kind of data changed".
 */
type Listener = (topics: string[]) => void;

const listeners = new Set<Listener>();

/** Announce that the given datasets changed (e.g. "projects", "activity"). */
export function notifyMutations(...topics: string[]): void {
  if (topics.length === 0) return;
  for (const listener of [...listeners]) {
    try {
      listener(topics);
    } catch {
      // A broken subscriber must never break the mutation flow.
    }
  }
}

/** Listen for dataset changes; returns an unsubscribe function. */
export function subscribeToMutations(handler: Listener): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}
