// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContributionDayDto } from "../../shared/api-types.js";

/**
 * ContributionCalendar baseline repair coverage:
 * - zero duplicate-key console warnings (blank leading/trailing cells
 *   previously collided on `blank-{week}-null`);
 * - contribution semantics unchanged: one button per real day, blanks
 *   remain aria-hidden placeholders;
 * - the contained keyboard fix: activating a cell hands focus to the
 *   day-detail target via onSelectDay's source argument.
 */

const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

import { ContributionCalendar } from "../../client/src/components/ContributionCalendar.js";

function days(): ContributionDayDto[] {
  return [
    { date: "2026-01-01", total: 3, localCount: 2, githubCount: 1 },
    { date: "2026-06-15", total: 1, localCount: 1, githubCount: 0 },
    { date: "2026-12-31", total: 5, localCount: 5, githubCount: 0 },
  ];
}

afterEach(() => {
  cleanup();
});

describe("contribution calendar keys + interaction", () => {
  it("renders a full year with no duplicate React key warnings", () => {
    render(
      <ContributionCalendar
        year={2026}
        days={days()}
        selectedDay={null}
        onSelectDay={() => undefined}
      />,
    );
    // 365 day buttons in 2026 (non-leap), plus placeholders for the grid.
    const cells = document.querySelectorAll('button[role="gridcell"]');
    expect(cells.length).toBe(365);
    const blankCells = document.querySelectorAll(".cell.blank");
    expect(blankCells.length).toBeGreaterThan(0);

    const keyErrors = [
      ...errorSpy.mock.calls.map((call) => String(call[0])),
      ...warnSpy.mock.calls.map((call) => String(call[0])),
    ].filter((message) => /key|Warning: Each child/i.test(message));
    expect(keyErrors).toEqual([]);
  });

  it("keeps contribution semantics: level classes and counts per real day", () => {
    render(
      <ContributionCalendar
        year={2026}
        days={days()}
        selectedDay="2026-06-15"
        onSelectDay={() => undefined}
      />,
    );
    // Locale-proof selection: cells render in strict date order starting
    // at Jan 1, so each cell's index equals its 0-based day-of-year.
    const cells = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[role="gridcell"]'),
    );
    const dayIndex = (iso: string): number =>
      Math.round(
        (Date.parse(`${iso}T00:00:00Z`) - Date.parse("2026-01-01T00:00:00Z")) /
          86_400_000,
      );
    expect(cells.length).toBe(365);
    expect(cells[dayIndex("2026-01-01")]?.className).toContain("l2"); // total 3
    const june15 = cells[dayIndex("2026-06-15")];
    expect(june15?.className).toContain("l1"); // total 1
    expect(june15?.className).toContain("selected");
    expect(cells[dayIndex("2026-12-31")]?.className).toContain("l4");
  });

  it("hands the activating cell to onSelectDay so callers can move focus", () => {
    const onSelectDay = vi.fn();
    render(
      <ContributionCalendar
        year={2026}
        days={days()}
        selectedDay={null}
        onSelectDay={onSelectDay}
      />,
    );
    // First cell in document order is January 1 regardless of which
    // weekday the year starts on.
    const firstDay =
      document.querySelectorAll<HTMLButtonElement>('button[role="gridcell"]')[0];
    firstDay?.click();
    expect(onSelectDay).toHaveBeenCalledTimes(1);
    const [dayArg, sourceArg] = onSelectDay.mock.calls[0];
    expect(dayArg).toBe("2026-01-01");
    expect(sourceArg).toBeInstanceOf(HTMLElement);
    expect(sourceArg).toBe(firstDay);
  });
});
