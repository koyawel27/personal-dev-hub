import { useMemo, useRef, useState } from "react";
import type { ContributionDayDto } from "@shared/api-types";

/**
 * Year-long contribution calendar: GitHub-familiar interaction concept
 * (52 weekday columns, month labels, Less→More legend, hover/click days)
 * rendered in Personal Dev Hub's warm clay/amber workbench language.
 * Not a visual clone; counts are commits — never hours.
 *
 * Keyboard model (roving tabindex): exactly ONE day cell is in the tab
 * order at a time. Arrows move the focused day (±1 day / ±1 week),
 * Home/End jump to the year boundaries, Enter/Space activate like a mouse
 * click, and Tab leaves the calendar normally. Visual design, geometry,
 * colors, and contribution semantics are untouched.
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
  /** Second argument is the activating cell. Third argument is true when
   * activation came from the KEYBOARD (Enter/Space produce a click with
   * event.detail === 0); callers use it to decide whether to move focus
   * to the detail panel. Mouse clicks keep the accepted focus handoff. */
  onSelectDay: (
    day: string | null,
    source?: Element,
    keyboardActivated?: boolean,
  ) => void;
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

  // --- roving tabindex state ---------------------------------------------
  // focusedDate = keyboard navigation location; DISTINCT from selectedDay
  // (the day shown in the detail panel). Moving with arrows never selects.
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());

  /**
   * Effective roving anchor, resolved every render so it can never go
   * stale (year or source-lens changes cannot leave tabIndex=0 on a date
   * that is no longer rendered). Fallback chain, first match wins:
   *   1. the date the keyboard last visited (if valid in this year)
   *   2. the selected day (if valid in this year)
   *   3. today (if this year is the current year)
   *   4. the first day that carries commits (service returns days sorted
   *      ascending, so days[0] is the earliest meaningful day)
   *   5. January 1 of the displayed year
   */
  const effectiveFocused = (() => {
    if (focusedDate && focusedDate.startsWith(`${year}-`)) return focusedDate;
    if (selectedDay && selectedDay.startsWith(`${year}-`)) return selectedDay;
    const today = isoDate(new Date());
    if (today.startsWith(`${year}-`)) return today;
    // Earliest meaningful day — but only when it belongs to THIS year
    // (a stale days payload from the previous year must not win).
    if (days.length > 0 && days[0].date.startsWith(`${year}-`)) {
      return days[0].date;
    }
    return `${year}-01-01`;
  })();

  function moveTo(iso: string): void {
    setFocusedDate(iso);
    cellRefs.current.get(iso)?.focus();
  }

  function onGridKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const target = event.target;
    if (
      !(target instanceof HTMLButtonElement) ||
      target.getAttribute("role") !== "gridcell"
    ) {
      return;
    }
    const step =
      event.key === "ArrowLeft"
        ? -1
        : event.key === "ArrowRight"
          ? 1
          : event.key === "ArrowUp"
            ? -7
            : event.key === "ArrowDown"
              ? 7
              : 0;
    if (step !== 0) {
      event.preventDefault();
      // Navigate relative to the PHYSICALLY focused cell (the keydown
      // target), not remembered state — the keydown target is by
      // definition where keyboard focus is, so this stays correct even if
      // the roving state was reset by a year/lens change mid-focus.
      const originIso =
        (target instanceof HTMLButtonElement ? target.dataset.date : undefined) ??
        effectiveFocused;
      const candidate = shiftIso(originIso || effectiveFocused, step);
      // Stay inside the displayed year at boundaries; padding blanks are
      // skipped automatically because every in-year date owns a real cell.
      if (candidate.startsWith(`${year}-`)) moveTo(candidate);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      moveTo(firstDayOfYearCells(weeks) ?? `${year}-01-01`);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      moveTo(lastDayOfYearCells(weeks) ?? `${year}-12-31`);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      // Explicit activation (prevented so browsers do not ALSO synthesize
      // a native button click and double-select). Same code path as a
      // pointer click, flagged keyboardActivated=true so callers keep
      // focus in the calendar for continued arrow navigation.
      event.preventDefault();
      const iso = target.dataset.date ?? "";
      if (!iso) return;
      setFocusedDate(iso);
      onSelectDay(selectedDay === iso ? null : iso, target, true);
    }
  }

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
              onKeyDown={onGridKeyDown}
            >
              {weeks.map((week, weekIndex) => (
                <div className="yeargrid-col" key={weekIndex} role="row">
                  {week.map((cell, dayIndex) =>
                    cell ? (
                      <button
                        key={cell.iso}
                        ref={(element) => {
                          if (element) cellRefs.current.set(cell.iso, element);
                          else cellRefs.current.delete(cell.iso);
                        }}
                        type="button"
                        role="gridcell"
                        data-date={cell.iso}
                        tabIndex={cell.iso === effectiveFocused ? 0 : -1}
                        onFocus={(event) => {
                          // Focus follows reality: if the browser focused a
                          // cell outside the roving state (year/lens changed,
                          // then Shift+Tab returned to the single tab stop),
                          // adopt it as the navigation origin so arrows move
                          // from where focus actually is.
                          const iso = event.currentTarget.dataset.date;
                          if (iso && iso !== focusedDate) setFocusedDate(iso);
                        }}
                        aria-selected={selectedDay === cell.iso}
                        className={`cell l${levelFor(byDate.get(cell.iso)?.total ?? 0)} ${
                          selectedDay === cell.iso ? "selected" : ""
                        }`}
                        title={`${formatLong(cell.iso)} · ${byDate.get(cell.iso)?.total ?? 0} tracked commit(s)`}
                        onClick={(event) => {
                          // Pointer or Enter/Space: either way this day
                          // becomes the roving anchor.
                          setFocusedDate(cell.iso);
                          onSelectDay(
                            selectedDay === cell.iso ? null : cell.iso,
                            event.currentTarget,
                            event.detail === 0,
                          );
                        }}
                        aria-label={`${formatLong(cell.iso)} — ${byDate.get(cell.iso)?.total ?? 0} ${
                          (byDate.get(cell.iso)?.total ?? 0) === 1 ? "commit" : "commits"
                        }`}
                      />
                    ) : (
                      // Blank leading/trailing placeholders are keyed by their
                      // fixed weekday slot — unique and deterministic per year
                      // (String(null) previously collided across a week).
                      // Never focusable, never announced.
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

/** Calendar-day arithmetic in local time (DST-safe via setDate). */
function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return isoDate(date);
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

/** First in-year ISO date in grid order (Jan 1 regardless of weekday). */
function firstDayOfYearCells(weeks: Cell[][]): string | undefined {
  for (const week of weeks) {
    for (const cell of week) if (cell) return cell.iso;
  }
  return undefined;
}

/** Last in-year ISO date in grid order (Dec 31). */
function lastDayOfYearCells(weeks: Cell[][]): string | undefined {
  for (let w = weeks.length - 1; w >= 0; w -= 1) {
    for (let d = weeks[w].length - 1; d >= 0; d -= 1) {
      const cell = weeks[w][d];
      if (cell) return cell.iso;
    }
  }
  return undefined;
}
