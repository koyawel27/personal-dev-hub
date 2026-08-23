import type { ReactNode } from "react";

type Tone = "neutral" | "clean" | "warn" | "status-active" | "status-paused" | "status-finished" | "status-archived" | "status-experiment";

/**
 * Square micro-element badge fed by shared/status-terms vocabulary.
 */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function WorkingTreeBadge({ isDirty }: { isDirty: boolean }) {
  return <Badge tone={isDirty ? "warn" : "clean"}>{isDirty ? "Uncommitted" : "Clean"}</Badge>;
}

const STATUS_TONES: Record<string, Tone> = {
  Active: "status-active",
  Paused: "status-paused",
  Finished: "status-finished",
  Archived: "status-archived",
  Experiment: "status-experiment",
};

export function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="muted">—</span>;
  return <Badge tone={STATUS_TONES[status] ?? "neutral"}>{status}</Badge>;
}
