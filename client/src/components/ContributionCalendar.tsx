import { useMemo } from "react";
import type { ContributionDayDto } from "@shared/api-types";

/**
 * Year-long contribution calendar: GitHub-familiar interaction concept
 * (52 weekday columns, month labels, Less→More legend, hover/click days)
 * rendered in Personal Dev Hub's warm clay/amber workbench language.
 * Not a visual clone; counts are commits — never hours.
 */
export function ContributionCalendar({
  year,
  days,
  selectedDay,
  onSelectDay,
}: {
  year: number;
  days: ContributionDayDto[];
  selectedDay: string | null;
  /** Second argument is the activating cell, so callers can move focus
   * somewhere meaningful (e.g. the day-detail panel). */
  onSelectDay: (day: string | null, source?: Element) => void;
}) {
  const byDate = useMemo(() => {
    const map = new Map<string, ContributionDayDto>();
    for (const day of days) map.set(day.date, day);
    return map;
  }, [days]);

  const max = useMemo(
    () => Math.max(1, ...days.map((day) => day.total)),
    [days],
  );

  const { weeks, months } = useMemo(() => buildYear(year), [year]);

  function levelFor(total: number): number {
    if (total <= 0) return 0;
    if (total === 1) return 1;
    if (total <= Math.ceil(max / 2)) return 2;
    if (total <= Math.ceil((max * 3) / 4)) return 3;
    return 4;
  }

  return (
    <div className="calendar">
      <div className="yeargrid-scroll" role="region" aria-label={`${year} contribution grid`}>
        <div className="yeargrid">
          <div className="yeargrid-weekdays" aria-hidden="true">
            <span>Mon</span>
            <span>Wed</span>
            <span>Fri</span>
          </div>
          <div className="yeargrid-main">
            <div className="yeargrid-months" aria-hidden="true">
              {months.map((month) => (
                <span key={month.key} className="yeargrid-month" style={{ gridColumnStart: month.column }}>
                  {month.label}
                </span>
              ))}
            </div>
            <div
              className="yeargrid-grid"
              role="grid"
              aria-label={`Tracked commits per day, ${year}`}
            >
              {weeks.map((week, weekIndex) => (
                <div className="yeargrid-col" key={weekIndex} role="row">
                  {week.map((cell, dayIndex) =>
                    cell ? (
                      <button
                        key={cell.iso}
                        type="button"
                        role="gridcell"
                        className={`cell l${levelFor(byDate.get(cell.iso)?.total ?? 0)} ${
                          selectedDay === cell.iso ? "selected" : ""
                        }`}
                        title={`${formatLong(cell.iso)} · ${byDate.get(cell.iso)?.total ?? 0} tracked commit(s)`}
                        onClick={(event) =>
                          onSelectDay(selectedDay === cell.iso ? null : cell.iso, event.currentTarget)
                        }
                        aria-label={`${formatLong(cell.iso)}, ${byDate.get(cell.iso)?.total ?? 0} tracked commits`}
                      />
                    ) : (
                      // Blank leading/trailing placeholders are keyed by their
                      // fixed weekday slot — unique and deterministic per year
                      // (String(null) previously collided across a week).
                      <span
                        className="cell blank"
                        key={`blank-${year}-${weekIndex}-${dayIndex}`}
                        aria-hidden="true"
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="calendar-legend mono">
        <em>Less</em>
        <i className="cell l0" />
        <i className="cell l1" />
        <i className="cell l2" />
        <i className="cell l3" />
        <i className="cell l4" />
        <em>More</em>
      </div>
    </div>
  );
}

type Cell = { iso: string } | null;

function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatLong(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Build a GitHub-style year grid: columns are weeks (Monday-first),
 * rows are weekdays Mon..Sun. Also returns month label positions.
 */
function buildYear(year: number) {
  const weeks: Cell[][] = [];
  const months: { key: string; label: string; column: number }[] = [];

  // Start at the first Monday on/before Jan 1 so row alignment matches
  // weekday references across the whole year.
  const cursor = new Date(year, 0, 1);
  cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));

  const end = new Date(year, 11, 31);
  let lastMonthSeen = -1;
  let weekIndex = 0;

  while (cursor <= end || cursor.getDay() !== 2) {
    // Fill columns until we pass Dec 31 and complete the current week
    // (loop exits at the first Monday after year end).
    if (cursor > end && cursor.getDay() === 1) break;
    const column: Cell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const inYear = cursor.getFullYear() === year;
      if (inYear) {
        if (cursor.getMonth() !== lastMonthSeen) {
          lastMonthSeen = cursor.getMonth();
          months.push({
            key: `${year}-${lastMonthSeen}`,
            label: cursor.toLocaleDateString(undefined, { month: "short" }),
            column: weekIndex + 1,
          });
        }
        column.push({ iso: isoDate(cursor) });
      } else {
        column.push(null);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(column);
    weekIndex += 1;
    if (weeks.length > 60) break; // safety bound
  }

  return { weeks, months };
}
