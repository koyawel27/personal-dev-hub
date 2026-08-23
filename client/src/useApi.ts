import { useCallback, useEffect, useState } from "react";

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
 */
export function useApi<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
  fallbackMessage = "Request failed.",
): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Stable identity for the loader across renders unless callers change it.
  const load = useCallback(loader, deps);

  const refetch = useCallback(async () => {
    setError(null);
    try {
      setData(await load());
    } catch (err: unknown) {
      setError(messageFrom(err, fallbackMessage));
    } finally {
      setLoading(false);
    }
  }, [load, fallbackMessage]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, error, loading, refetch };
}
