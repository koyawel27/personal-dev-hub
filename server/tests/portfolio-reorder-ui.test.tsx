// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortfolioItemDto } from "../../shared/api-types.js";

/**
 * Component-level coverage for the Portfolio reorder path.
 *
 * Owner defect: the handler resolved neighbors from a FILTERED array while
 * the UI rendered the RAW API array. An item without an explicit
 * portfolioOrder rendered enabled but silently no-op'ed (findIndex -1 ->
 * early return -> zero network requests). These tests drive the ACTUAL
 * click handler through jsdom and pin the single-canonical-order invariant.
 */

const updateProjectMetadata = vi.fn();

vi.mock("../../client/src/api.js", () => ({
  client: {
    portfolio: () => Promise.resolve({ projects: currentFixture() }),
    updateProjectMetadata: (...args: unknown[]) => updateProjectMetadata(...args),
  },
}));

let fixture: PortfolioItemDto[] = [];

function currentFixture(): PortfolioItemDto[] {
  return fixture;
}

function item(
  partial: Partial<PortfolioItemDto> & { id: number; name: string },
): PortfolioItemDto {
  return {
    sourceState: "LOCAL ONLY",
    projectType: null,
    projectStatus: null,
    projectNote: null,
    githubHtmlUrl: null,
    portfolioOrder: null,
    technologyHints: [],
    firstCommitAt: null,
    latestCommitAt: null,
    ...partial,
  } as PortfolioItemDto;
}

async function renderPage() {
  const { PortfolioPage } = await import("../../client/src/pages/PortfolioPage.js");
  return render(
    <MemoryRouter>
      <PortfolioPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetModules();
  updateProjectMetadata.mockReset();
  updateProjectMetadata.mockResolvedValue({ project: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.textContent = "";
});

describe("portfolio reorder click path", () => {
  it("moves a NULL-order second item up when raw order differs from visible order", async () => {
    // THE DEFECT FIXTURE: raw API array has Test-Folder FIRST but visually
    // it renders SECOND (explicit order wins). The old handler found index
    // -1 in its filtered array and returned before any request.
    fixture = [
      item({ id: 7, name: "Test-Folder", sourceState: "GITHUB ONLY", portfolioOrder: null }),
      item({ id: 3, name: "hub-fixture", portfolioOrder: 1 }),
    ];
    const user = userEvent.setup();
    await renderPage();

    const up = (await screen.findByRole("button", {
      name: "Move Test-Folder up",
    })) as HTMLButtonElement;
    expect(up.disabled).toBe(false);
    await user.click(up);

    await waitFor(() => expect(updateProjectMetadata).toHaveBeenCalledTimes(2));
    // Test-Folder takes hub-fixture's explicit slot; hub-fixture moves to
    // max+1 so both items keep distinct order values after the swap.
    expect(updateProjectMetadata).toHaveBeenNthCalledWith(1, 7, { portfolioOrder: 1 });
    expect(updateProjectMetadata).toHaveBeenNthCalledWith(2, 3, { portfolioOrder: 2 });
  });

  it("first item's up control is disabled; last item's down control is disabled", async () => {
    fixture = [
      item({ id: 1, name: "Alpha", portfolioOrder: 1 }),
      item({ id: 2, name: "Beta", portfolioOrder: 2 }),
      item({ id: 3, name: "Gamma", portfolioOrder: 3 }),
    ];
    await renderPage();

    expect(
      (await screen.findByRole("button", { name: "Move Alpha up" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Move Gamma down" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Move Alpha down" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Move Gamma up" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("two-item portfolio swaps via one up click on the second row", async () => {
    fixture = [
      item({ id: 10, name: "Only Local", portfolioOrder: 1 }),
      item({ id: 11, name: "Remote Only", sourceState: "GITHUB ONLY" }),
    ];
    const user = userEvent.setup();
    await renderPage();

    await user.click(await screen.findByRole("button", { name: "Move Remote Only up" }));
    await waitFor(() => expect(updateProjectMetadata).toHaveBeenCalledTimes(2));
    expect(updateProjectMetadata).toHaveBeenNthCalledWith(1, 11, { portfolioOrder: 1 });
    expect(updateProjectMetadata).toHaveBeenNthCalledWith(2, 10, { portfolioOrder: 2 });
  });

  it("boundary clicks never issue requests", async () => {
    fixture = [item({ id: 5, name: "Solo", portfolioOrder: 1 })];
    const user = userEvent.setup();
    await renderPage();

    await user.click(await screen.findByRole("button", { name: "Move Solo up" }));
    expect(updateProjectMetadata).not.toHaveBeenCalled();
  });

  it("mixed-source reorder resolves targets from the rendered collection", async () => {
    fixture = [
      item({ id: 20, name: "Linked Work", sourceState: "LOCAL + GITHUB", portfolioOrder: 2 }),
      item({ id: 21, name: "Local Work", sourceState: "LOCAL ONLY", portfolioOrder: 1 }),
    ];
    const user = userEvent.setup();
    await renderPage();

    // Visible order is Local Work (order 1) then Linked Work (order 2).
    // Moving Linked Work UP must target Local Work — even though Linked Work
    // appears FIRST in the raw API array.
    await user.click(await screen.findByRole("button", { name: "Move Linked Work up" }));
    await waitFor(() => expect(updateProjectMetadata).toHaveBeenCalledTimes(2));
    expect(updateProjectMetadata).toHaveBeenNthCalledWith(1, 20, { portfolioOrder: 1 });
    expect(updateProjectMetadata).toHaveBeenNthCalledWith(2, 21, { portfolioOrder: 2 });
  });

  it("failed mutation surfaces an error instead of faking success", async () => {
    fixture = [
      item({ id: 30, name: "One", portfolioOrder: 1 }),
      item({ id: 31, name: "Two", portfolioOrder: 2 }),
    ];
    updateProjectMetadata.mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    await renderPage();

    await user.click(await screen.findByRole("button", { name: "Move Two up" }));
    await waitFor(() => {
      const alert = screen.queryByRole("alert");
      expect(alert).not.toBeNull();
      expect(alert!.textContent ?? "").toMatch(/reorder failed/i);
    });
  });
});
