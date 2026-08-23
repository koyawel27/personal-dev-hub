import type { ReactNode } from "react";

/**
 * Intentional empty state (spec section 19): stepped pixel mark,
 * clear message, optional hint pointing at the next action.
 */
export function EmptyState({ message, hint }: { message: string; hint?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty">{message}</p>
      {hint ? <div className="muted">{hint}</div> : null}
    </div>
  );
}
