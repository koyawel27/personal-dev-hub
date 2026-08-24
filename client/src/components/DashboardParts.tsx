import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ContributionDayDto } from "@shared/api-types";
import { client } from "../api";
import { notifyMutations } from "../lib/mutations";
import { EmptyState } from "./EmptyState";
import {
  IconAttention,
  IconCalendar,
  IconJournal,
  IconPlus,
  IconRefresh,
} from "./icons";
import { relativeTime } from "../format";

/**
 * Compact summary strip: five real metrics as connected units.
 * Values are the focus; small square indicators give quiet state color.
 */
export function StatStrip({
  tracked,
  active,
  commitsThisWeek,
  activeDays,
  uncommitted,
}: {
  tracked: number;
  active: number;
  commitsThisWeek: number;
  activeDays: number;
  uncommitted: number;
}) {
  return (
    <div className="stat-strip" role="group" aria-label="Summary metrics">
      <StatUnit label="Tracked Projects" value={tracked} dot="accent" />
      <StatUnit label="Active Projects" value={active} dot={active > 0 ? "ok" : undefined} />
      <StatUnit label="Commits This Week" value={commitsThisWeek} dot="accent" />
      <StatUnit label="Active Days This Week" value={activeDays} />
      <StatUnit
        label="Uncommitted Repos"
        value={uncommitted}
        dot={uncommitted > 0 ? "warn" : "ok"}
      />
    </div>
  );
}

function StatUnit({
  label,
  value,
  dot,
}: {
  label: string;
  value: number;
  dot?: "ok" | "warn" | "accent";
}) {
  return (
    <div className="stat-unit">
      <span className={`stat-dot${dot ? ` ${dot}` : ""}`} aria-hidden="true" />
      <span className="stat-meta">
        <span className="stat-label">{label}</span>
        <span className="stat-value">{value}</span>
      </span>
    </div>
  );
}

/**
 * Miniature of the Contributions feature for the Dashboard: the same
 * square-cell language at a smaller scale. Renders only meaningful days
 * plus trailing quiet days — never an oversized empty rectangle.
 */
export function ContributionPreview({ days }: { days: ContributionDayDto[] }) {
  const recent = days.slice(-21);
  if (recent.length === 0) {
    return (
      <EmptyState message="No contribution activity recorded yet." hint={<Link to="/contributions">Open Contributions</Link>} />
    );
  }
  return (
    <div className="calendar-preview">
      <div className="preview-strip" aria-hidden="true">
        {recent.map((day) => (
          <span
            key={day.date}
            className={`cell l${day.total === 1 ? 1 : day.total <= 3 ? 2 : 3}`}
            title={`${day.date}: ${day.total} commit(s)`}
          />
        ))}
      </div>
      <p className="mono empty-state-hint">
        Last {recent.length} active day{recent.length === 1 ? "" : "s"} ·{" "}
        {recent.reduce((sum, day) => sum + day.total, 0)} commits ·{" "}
        <Link to="/contributions">full history →</Link>
      </p>
    </div>
  );
}

/** Section heading with square mark + optional count chip (mono). */
export function SectionHead({
  icon,
  title,
  count,
}: {
  icon?: ReactNode;
  title: string;
  count?: string;
}) {
  return (
    <h2>
      <span className="h2-mark" aria-hidden="true" />
      {icon}
      {title}
      {count != null ? <span className="section-count">{count}</span> : null}
    </h2>
  );
}

/** Compact rescan control used in page headers (visually secondary). */
export function RescanButton() {
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function rescanAll() {
    setScanning(true);
    setNotice(null);
    try {
      const result = await client.scanAll();
      setNotice(
        `${result.summary.repositoriesDiscovered} discovered · ${result.summary.repositoriesRefreshed} refreshed`,
      );
      // A rescan can discover/refresh anything — reconcile all derived views.
      notifyMutations("projects", "sources", "dashboard", "activity", "contributions", "portfolio", "picker");
    } catch {
      setNotice("Rescan failed.");
    } finally {
      setScanning(false);
    }
  }

  return (
    <span className="rescan-group">
      {notice ? <span className="mono empty-state-hint">{notice}</span> : null}
      <button type="button" className="subtle" disabled={scanning} onClick={() => void rescanAll()}>
        <IconRefresh size={13} />
        {scanning ? "Scanning…" : "Rescan"}
      </button>
    </span>
  );
}

export { IconAttention, IconCalendar, IconJournal, IconPlus };
