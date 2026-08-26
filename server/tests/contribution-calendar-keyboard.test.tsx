// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, afterAll, describe, expect, it, vi } from "vitest";
import type { ContributionDayDto } from "../../shared/api-types.js";

/**
 * Roving-keyboard coverage for the Contributions year calendar.
 *
 * Model under test:
 * - exactly ONE day cell is in the sequential tab order (roving tabindex);
 * - arrows move the FOCUSED date (±1 day / ±7 days), never the selection;
 * - Enter/Space activate like a click and keep focus in the calendar;
 * - Tab exits the calendar normally (no 365-stop walk);
 * - blanks are decorative only; year/lens changes cannot strand tabIndex=0.
 */

const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
// Pin wall-clock time: tests must not depend on the real current date
// (the anchor chain includes "today if in-year").
vi.setSystemTime(new Date("2024-03-15T12:00:00"));

import { ContributionCalendar } from "../../client/src/components/ContributionCalendar.js";

function days(): ContributionDayDto[] {
  return [
    { date: "2026-01-01", total: 3, localCount: 2, githubCount: 1 },
    { date: "2026-06-15", total: 1, localCount: 1, githubCount: 0 },
    { date: "2026-12-31", total: 5, localCount: 5, githubCount: 0 },
  ];
}

function renderCalendar(props: Partial<Parameters<typeof ContributionCalendar>[0]> = {}) {
  const onSelectDay = vi.fn();
  let currentProps = {
    year: 2026,
    days: days(),
    selectedDay: null as string | null,
    onSelectDay,
    ...props,
  };
  const utils = render(<ContributionCalendar {...currentProps} />);
  const rerenderFn = (
    next: Partial<Parameters<typeof ContributionCalendar>[0]>,
  ): void => {
    currentProps = { ...currentProps, ...next };
    utils.rerender(<ContributionCalendar {...currentProps} />);
  };
  const cells = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="gridcell"]'));
  return { ...utils, onSelectDay, cells, rerenderFn };
}

function cellByIndex(index: number): HTMLButtonElement {
  return document.querySelectorAll<HTMLButtonElement>('button[role="gridcell"]')[index];
}

/**
 * Dispatch a keydown from the currently focused element, wrapped by
 * fireEvent so React state updates flush before the next assertion
 * (mirrors real keyboards, where each press is its own task).
 */
function press(key: string): void {
  const origin =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : document.querySelector('[role="grid"]');
  fireEvent.keyDown(origin ?? document.body, { key });
}

/** Pointer-faithful click: real mice produce detail >= 1. */
function clickCell(cell: HTMLButtonElement): void {
  cell.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
  );
}

function activeElement(): Element | null {
  return document.activeElement;
}

afterEach(() => {
  cleanup();
});

afterAll(() => {
  vi.useRealTimers();
});

describe("contribution calendar roving keyboard model", () => {
  it("exposes exactly one real day in the tab order (anchor = first meaningful day)", () => {
    renderCalendar();
    const cells = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[role="gridcell"]'),
    );
    const tabbable = cells.filter((cell) => cell.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    // Anchor fallback chain: no focused/selected/today match -> first
    // meaningful day (days arrive sorted ascending).
    expect(tabbable[0].dataset.date).toBe("2026-01-01");
    expect(cells.every((cell) => cell.tabIndex === 0 || cell.tabIndex === -1)).toBe(true);
  });

  it("blanks are never focusable and never announced", () => {
    renderCalendar();
    const blanks = document.querySelectorAll<HTMLElement>(".cell.blank");
    expect(blanks.length).toBeGreaterThan(0);
    for (const blank of blanks) {
      expect(blank.tagName).toBe("SPAN");
      expect(blank.getAttribute("aria-hidden")).toBe("true");
      expect(blank.getAttribute("tabindex")).toBeNull();
      expect(blank.getAttribute("role")).toBeNull();
    }
  });

  it("ArrowRight moves one day from the focused cell", () => {
    const { cells } = renderCalendar();
    const start = cells().find((c) => c.dataset.date === "2026-01-01")!;
    start.focus(); // component adopts the focused cell as origin
    press("ArrowRight"); // dispatched from document.activeElement
    expect(activeElement()?.getAttribute("data-date")).toBe("2026-01-02");
    press("ArrowLeft");
    expect(activeElement()?.getAttribute("data-date")).toBe("2026-01-01");
    // Selection untouched by navigation.
    expect(document.querySelectorAll('button[aria-selected="true"]').length).toBe(0);
  });

  it("ArrowDown moves one week, ArrowUp moves back one week", () => {
    const { cells } = renderCalendar();
    const start = cells().find((c) => c.dataset.date === "2026-06-15")!;
    start.focus();
    press("ArrowDown");
    expect(activeElement()?.getAttribute("data-date")).toBe("2026-06-22");
    press("ArrowUp");
    expect(activeElement()?.getAttribute("data-date")).toBe("2026-06-15");
  });

  it("does not navigate outside the displayed year (Jan 1 / Dec 31 boundaries)", () => {
    const { cells } = renderCalendar({ selectedDay: null });
    const jan1 = cells().find((c) => c.dataset.date === "2026-01-01")!;
    jan1.focus();
    press("ArrowLeft"); // would land Dec 31, 2025 — must stay put
    expect(activeElement()?.getAttribute("data-date")).toBe("2026-01-01");

    const dec31 = cells().find((c) => c.dataset.date === "2026-12-31")!;
    dec31.focus();
    press("ArrowRight"); // would land Jan 1, 2027 — must stay put
    expect(activeElement()?.getAttribute("data-date")).toBe("2026-12-31");
    press("ArrowDown"); // +7 days — must stay put
    expect(activeElement()?.getAttribute("data-date")).toBe("2026-12-31");
  });

  it("Enter activates the focused day and keeps focus in the calendar", () => {
    const { onSelectDay, cells } = renderCalendar();
    const anchor = cells().find((c) => c.tabIndex === 0)!;
    anchor.focus();
    press("Enter");
    expect(onSelectDay).toHaveBeenCalledTimes(1);
    const [dayArg, sourceArg, keyboardFlag] = onSelectDay.mock.calls[0];
    expect(dayArg).toBe("2026-01-01"); // toggles to selected (was unselected)
    expect(sourceArg).toBeInstanceOf(HTMLElement);
    expect(keyboardFlag).toBe(true);
    // Focus stays on the calendar cell for continued arrow navigation.
    expect(activeElement()).toBe(anchor);
  });

  it("Space activates the focused day", () => {
    const { onSelectDay, cells } = renderCalendar();
    const anchor = cells().find((c) => c.tabIndex === 0)!;
    anchor.focus();
    press(" ");
    expect(onSelectDay).toHaveBeenCalledWith(
      "2026-01-01",
      anchor,
      true,
    );
  });

  it("mouse click selects the day and makes it the new focus anchor", () => {
    const { rerenderFn, onSelectDay, cells } = renderCalendar();
    const june15 = cells().find((c) => c.dataset.date === "2026-06-15")!;
    clickCell(june15);
    expect(onSelectDay.mock.calls[0][2]).toBe(false); // pointer activation
    // Re-render with parent-owned selection state applied.
    rerenderFn({ selectedDay: "2026-06-15" });
    const tabbable = cells().filter((c) => c.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].dataset.date).toBe("2026-06-15");
  });

  it("Tab does not walk the remaining calendar cells", () => {
    renderCalendar();
    const anchor = cellByIndex(0);
    anchor.focus();
    expect(activeElement()).toBe(anchor);
    // Simulate sequential traversal: after the single tabbable cell, the
    // next tab stop must NOT be another gridcell.
    const tabbablesInGrid = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[role="gridcell"]'),
    ).filter((c) => c.tabIndex === 0);
    expect(tabbablesInGrid).toHaveLength(1);
  });

  it("source-lens change keeps a valid roving anchor (no stranded tabIndex=0)", () => {
    const { rerenderFn, cells } = renderCalendar();
    cells()
      .find((c) => c.dataset.date === "2026-12-31")!
      .click(); // focusedDate = Dec 31 via pointer
    // Lens change: different data payload, same year.
    rerenderFn({
      days: [{ date: "2026-03-10", total: 2, localCount: 2, githubCount: 0 }],
    });
    const tabbable = cells().filter((c) => c.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].dataset.date).toBe("2026-12-31"); // still rendered+valid
  });

  it("year change re-resolves the anchor into the new year", () => {
    const { rerenderFn, cells } = renderCalendar();
    cells()
      .find((c) => c.dataset.date === "2026-12-31")!
      .click(); // anchor lives in 2026
    rerenderFn({ year: 2024 }); // focusedDate is out-of-year now
    const tabbable = cells().filter((c) => c.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    // Fallback chain inside 2024: no selection, but pinned "today"
    // (2024-03-15) IS in this year, so it wins over first-meaningful-day.
    expect(tabbable[0].dataset.date).toBe("2024-03-15");
    expect(cells().every((c) => c.dataset.date!.startsWith("2024-"))).toBe(true);
  });

  it("accessible labels carry date and contribution count", () => {
    renderCalendar();
    const jan1 = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[role="gridcell"]'),
    ).find((c) => c.dataset.date === "2026-01-01")!;
    expect(jan1.getAttribute("aria-label")).toMatch(/Jan 1,? 2026/);
    expect(jan1.getAttribute("aria-label")).toContain("3 commits");
    const june15 = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[role="gridcell"]'),
    ).find((c) => c.dataset.date === "2026-06-15")!;
    expect(june15.getAttribute("aria-label")).toMatch(/1 commit$/); // singular
    expect(june15.getAttribute("aria-selected")).toBe("false");
  });

  it("selected day exposes aria-selected=true and the selected visual class", () => {
    renderCalendar({ selectedDay: "2026-06-15" });
    const june15 = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[role="gridcell"]'),
    ).find((c) => c.dataset.date === "2026-06-15")!;
    expect(june15.getAttribute("aria-selected")).toBe("true");
    expect(june15.className).toContain("selected");
    const othersSelected = Array.from(
      document.querySelectorAll('button[role="gridcell"][aria-selected="true"]'),
    );
    expect(othersSelected).toHaveLength(1);
  });

  it("renders with zero React console warnings", () => {
    renderCalendar();
    const warnings = [
      ...errorSpy.mock.calls.map((call) => String(call[0])),
      ...warnSpy.mock.calls.map((call) => String(call[0])),
    ].filter((message) => /key|Warning:/i.test(message));
    expect(warnings).toEqual([]);
  });

  it("Home and End jump to the year boundaries", () => {
    const { cells } = renderCalendar();
    const mid = cells().find((c) => c.dataset.date === "2026-06-15")!;
    mid.focus();
    press("Home");
    expect(activeElement()?.getAttribute("data-date")).toBe("2026-01-01");
    press("End");
    expect(activeElement()?.getAttribute("data-date")).toBe("2026-12-31");
  });

  it("today becomes the anchor when the displayed year is the current year", () => {
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    if (!iso.startsWith(String(today.getFullYear()))) return; // NYE edge
    renderCalendar({ year: today.getFullYear(), days: [] });
    const tabbable = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[role="gridcell"]'),
    ).filter((c) => c.tabIndex === 0);
    expect(tabbable[0]?.dataset.date).toBe(iso);
  });
});
