import type { ReactNode } from "react";

/**
 * Compact intentional empty state (owner review pass 1): a small stepped
 * pixel mark plus one short line and an optional next action. No large
 * decorative boxes.
 */
export function EmptyState({ message, hint }: { message: string; hint?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true" />
      <div>
        <p className="empty">{message}</p>
        {hint ? <div className="empty-state-hint">{hint}</div> : null}
      </div>
    </div>
  );
}
