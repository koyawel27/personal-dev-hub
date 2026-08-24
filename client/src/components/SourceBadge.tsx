import type { SourceState } from "@shared/api-types";

const CLASS_BY_STATE: Record<SourceState, string> = {
  "LOCAL + GITHUB": "state-local-github",
  "LOCAL ONLY": "state-local-only",
  "GITHUB ONLY": "state-github-only",
};

/**
 * Compact square-indicator badge for a Project's source composition
 * (derived server-side, never user-editable).
 */
export function SourceBadge({ state }: { state: SourceState }) {
  return (
    <span className={`source-badge ${CLASS_BY_STATE[state]}`} title={`Source: ${state}`}>
      {state}
    </span>
  );
}
