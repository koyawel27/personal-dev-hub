import { useMemo } from "react";
import type { ContributionDayDto } from "@shared/api-types";

/**
 * Original contribution calendar: square micro-cells on a warm accent
 * scale reinforcing the pixel/grid language (plan section 8.3). Not a
 * visual clone of GitHub or LogBytes. Counts are commits — never hours.
 */
export function ContributionCalendar({
  days,
  selectedDay,
  onSelectDay,
}: {
  days: ContributionDayDto[];
  selectedDay: string | null;
  onSelectDay: (day: string | null) => void;
}) {
  const byDate = useMemo(() => {
    const map = new Map<string, ContributionDayDto>();
    for (const day of days) map.set(day.date, day);
    return map;
  }, [days]);

  const { weeks, monthLabel } = useMemo(() => buildMonth(new Date(), byDate), [byDate]);
  const max = useMemo(
    () => Math.max(1, ...days.map((day) => day.total)),
    [days],
  );

  function levelFor(total: number): number {
    if (total <= 0) return 0;
    if (total === 1) return 1;
    if (total <= Math.ceil(max / 2)) return 2;
    return 3;
  }

  return (
    <div className="calendar">
      <div className="calendar-head">
        <span className="calendar-month">{monthLabel}</span>
        <span className="calendar-legend mono">
          <i className="cell l0" /> <i className="cell l1" /> <i className="cell l2" />{" "}
          <i className="cell l3" />
          <em>few → many</em>
        </span>
      </div>
      <div className="calendar-grid" role="grid" aria-label="Contribution calendar">
        {weeks.map((week, index) => (
          <div className="calendar-week" key={index} role="row">
            {week.map((cell) =>
              cell ? (
                <button
                  key={cell.iso}
                  type="button"
                  role="gridcell"
                  className={`cell l${levelFor(byDate.get(cell.iso)?.total ?? 0)} ${
                    selectedDay === cell.iso ? "selected" : ""
                  }`}
                  title={`${cell.iso}: ${byDate.get(cell.iso)?.total ?? 0} commit(s)`}
                  onClick={() =>
                    onSelectDay(selectedDay === cell.iso ? null : cell.iso)
                  }
                  aria-label={`${cell.iso}, ${byDate.get(cell.iso)?.total ?? 0} commits`}
                />
              ) : (
                <span className="cell blank" key={`blank-${index}-${String(cell)}`} />
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type Cell = { iso: string; day: number } | null;

function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Build a month grid (Monday-first weeks) for the current real month. */
function buildMonth(anchor: Date, byDate: Map<string, ContributionDayDto>) {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);

  const monthLabel = anchor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  // Only render the calendar when there is anything to show inside this month;
  // otherwise still render an empty grid so the layout stays stable.
  void byDate;

  const lead = (first.getDay() + 6) % 7; // Monday-first offset
  const weeks: Cell[][] = [];
  let week: Cell[] = [];
  for (let i = 0; i < lead; i += 1) week.push(null);
  for (let day = 1; day <= last.getDate(); day += 1) {
    week.push({ iso: isoDate(new Date(year, month, day)), day });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return { weeks, monthLabel };
}
