import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeToMutations } from "./lib/mutations";

export type ApiState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => Promise<void>;
};

function messageFrom(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/**
 * Minimal server-state hook for the typed api client (no external store).
 *
 * `invalidateOn` lists logical datasets (e.g. ["projects", "activity"])
 * whose mutation elsewhere in the app should trigger an automatic refetch
 * of this view's data, keeping every visible list authoritative after
 * mutations without full-page reloads.
 */
export function useApi<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
  options?: {
    invalidateOn?: string[];
    fallbackMessage?: string;
  },
): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fallbackMessage = options?.fallbackMessage ?? "Request failed.";

  // Stable identity for the loader across renders unless callers change it.
  const load = useCallback(loader, deps);
  const loadingRef = useRef(false);

  const refetch = useCallback(async (): Promise<void> => {
    if (loadingRef.current) return; // coalesce bursts
    loadingRef.current = true;
    setError(null);
    try {
      setData(await load());
    } catch (err: unknown) {
      setError(messageFrom(err, fallbackMessage));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [load, fallbackMessage]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const topicsKey = (options?.invalidateOn ?? []).join("|");
  useEffect(() => {
    const topics = topicsKey ? topicsKey.split("|") : [];
    if (topics.length === 0) return;
    return subscribeToMutations((changed) => {
      if (topics.some((topic) => changed.includes(topic))) {
        void refetch();
      }
    });
  }, [topicsKey, refetch]);

  return { data, error, loading, refetch };
}

/**
 * Reconcile helper for pages that own imperative load() functions instead
 * of useApi. Subscribes to the given datasets and re-runs `reload` when any
 * of them changes elsewhere. Returns an unsubscribe function.
 */
export function useInvalidate(
  topics: string[],
  reload: () => Promise<void> | void,
): void {
  const key = topics.join("|");
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!key) return;
    const names = key.split("|");
    return subscribeToMutations((changed) => {
      if (names.some((topic) => changed.includes(topic))) {
        void Promise.resolve(reloadRef.current()).catch(() => {
          // Refetch failures are surfaced by the page's own error state on
          // its next successful/failed load; never crash the subscriber.
        });
      }
    });
  }, [key]);
}
