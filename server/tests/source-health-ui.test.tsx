// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceHealthResponse } from "@shared/api-types";

/**
 * V1.3 M4 Source Health UI: attention rows, state-specific actions,
 * relink/rescan reuse, and coexistence with backup/restore Maintenance content.
 */

const sourceHealth = vi.fn();
const listBackups = vi.fn();
const restoreState = vi.fn();
const createBackup = vi.fn();
const deleteBackup = vi.fn();
const scheduleRestore = vi.fn();
const clearRestoreState = vi.fn();
const refresh = vi.fn();
const selectFolder = vi.fn();
const relinkLocalBinding = vi.fn();
const notifyMutations = vi.fn();
const confirmSpy = vi.fn();

vi.mock("../../client/src/api.js", () => ({
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  client: {
    listBackups: (...a: unknown[]) => listBackups(...a),
    createBackup: (...a: unknown[]) => createBackup(...a),
    deleteBackup: (...a: unknown[]) => deleteBackup(...a),
    restoreState: (...a: unknown[]) => restoreState(...a),
    scheduleRestore: (...a: unknown[]) => scheduleRestore(...a),
    clearRestoreState: (...a: unknown[]) => clearRestoreState(...a),
    sourceHealth: (...a: unknown[]) => sourceHealth(...a),
    refresh: (...a: unknown[]) => refresh(...a),
    selectFolder: (...a: unknown[]) => selectFolder(...a),
    relinkLocalBinding: (...a: unknown[]) => relinkLocalBinding(...a),
  },
}));

vi.mock("../../client/src/lib/relinkLocalBinding.js", () => ({
  relinkLocalBinding: (...a: unknown[]) => relinkLocalBinding(...a),
}));

vi.mock("../../client/src/lib/mutations.js", () => ({
  notifyMutations: (...a: unknown[]) => notifyMutations(...a),
  subscribeToMutations: () => () => {},
}));

/** Existing cross-view reconciliation channels used by Rescan / Relink. */
const REPAIR_CHANNELS = [
  "projects",
  "sources",
  "dashboard",
  "activity",
  "contributions",
  "portfolio",
  "picker",
] as const;

import { MaintenancePage } from "../../client/src/pages/MaintenancePage.js";
import { SourceHealthPanel } from "../../client/src/components/SourceHealthPanel.js";

const healthy: SourceHealthResponse = {
  totalLocalBindings: 2,
  attentionCount: 0,
  pathMissingCount: 0,
  notGitRepoCount: 0,
  unscannedCount: 0,
  items: [],
};

const attention: SourceHealthResponse = {
  totalLocalBindings: 4,
  attentionCount: 3,
  pathMissingCount: 1,
  notGitRepoCount: 1,
  unscannedCount: 1,
  items: [
    {
      projectId: 11,
      projectName: "Missing Project",
      bindingId: 101,
      bindingName: "moved-repo",
      localPath: "C:\\work\\moved-repo",
      isPrimary: true,
      health: { state: "PATH_MISSING", checkedAt: null },
    },
    {
      projectId: 22,
      projectName: "Wrong Folder",
      bindingId: 102,
      bindingName: "docs-folder",
      localPath: "C:\\work\\docs",
      isPrimary: false,
      health: { state: "NOT_A_GIT_REPO", checkedAt: "2026-03-01T00:00:00.000Z" },
    },
    {
      projectId: 33,
      projectName: "New Copy",
      bindingId: 103,
      bindingName: "fresh",
      localPath: "C:\\work\\fresh",
      isPrimary: true,
      health: { state: "UNSCANNED", checkedAt: null },
    },
  ],
};

function mockMaintenanceEmpty() {
  listBackups.mockResolvedValue({ backups: [] });
  restoreState.mockResolvedValue({ restore: null });
  sourceHealth.mockResolvedValue(healthy);
}

beforeEach(() => {
  sourceHealth.mockReset();
  listBackups.mockReset();
  restoreState.mockReset();
  createBackup.mockReset();
  deleteBackup.mockReset();
  scheduleRestore.mockReset();
  clearRestoreState.mockReset();
  refresh.mockReset();
  selectFolder.mockReset();
  relinkLocalBinding.mockReset();
  notifyMutations.mockReset();
  confirmSpy.mockReset();
  confirmSpy.mockReturnValue(false);
  vi.stubGlobal("confirm", confirmSpy);
  mockMaintenanceEmpty();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Source Health panel (V1.3 M4)", () => {
  it("shows healthy empty state when attentionCount is 0", async () => {
    sourceHealth.mockResolvedValue(healthy);
    render(
      <MemoryRouter>
        <SourceHealthPanel />
      </MemoryRouter>,
    );
    expect(
      (await screen.findAllByText(/All tracked local copies are currently healthy/i))
        .length,
    ).toBeGreaterThan(0);
  });

  it("renders three unhealthy states with project links and state-specific actions", async () => {
    sourceHealth.mockResolvedValue(attention);
    render(
      <MemoryRouter>
        <SourceHealthPanel />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(/3 local copies need attention/i),
    ).toBeTruthy();
    expect(screen.getByText("Missing Project")).toBeTruthy();
    expect(screen.getByText("Wrong Folder")).toBeTruthy();
    expect(screen.getByText("New Copy")).toBeTruthy();

    // Project link uses projectId.
    const projectLink = screen.getByRole("link", { name: "Missing Project" });
    expect(projectLink.getAttribute("href")).toBe("/projects/11");

    // PATH_MISSING: Relink only (no Rescan on that row).
    const missingRow = document.querySelector(
      '[data-testid="source-health-101"]',
    );
    expect(missingRow?.textContent ?? "").toContain("Relink");
    expect(missingRow?.querySelectorAll("button").length).toBe(1);

    // NOT_A_GIT_REPO: Rescan + Relink.
    const notGitRow = document.querySelector(
      '[data-testid="source-health-102"]',
    );
    expect(notGitRow?.textContent ?? "").toContain("Rescan");
    expect(notGitRow?.textContent ?? "").toContain("Relink");

    // UNSCANNED: Rescan only.
    const unscannedRow = document.querySelector(
      '[data-testid="source-health-103"]',
    );
    expect(unscannedRow?.querySelectorAll("button").length).toBe(1);
    expect(unscannedRow?.textContent ?? "").toContain("Rescan");
  });

  it("Rescan success emits the full repair channel set and reloads health", async () => {
    sourceHealth.mockResolvedValueOnce(attention);
    refresh.mockResolvedValue({ repository: {} });
    sourceHealth.mockResolvedValueOnce(healthy);

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SourceHealthPanel />
      </MemoryRouter>,
    );

    const unscannedRow = await screen.findByTestId("source-health-103");
    await user.click(
      unscannedRow.querySelector("button") as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledWith(103);
      expect(sourceHealth).toHaveBeenCalledTimes(2);
    });
    expect(notifyMutations).toHaveBeenCalledWith(...REPAIR_CHANNELS);
    expect(notifyMutations).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Local copy rescanned.")).toBeTruthy();
  });

  it("failed Rescan emits no success reconciliation", async () => {
    sourceHealth.mockResolvedValue(attention);
    refresh.mockRejectedValue(new Error("rescan failed"));

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SourceHealthPanel />
      </MemoryRouter>,
    );

    const unscannedRow = await screen.findByTestId("source-health-103");
    await user.click(
      unscannedRow.querySelector("button") as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledWith(103);
    });
    expect(notifyMutations).not.toHaveBeenCalled();
    expect(screen.queryByText("Local copy rescanned.")).toBeNull();
  });

  it("picker cancellation emits no mutations and no Relink request", async () => {
    sourceHealth.mockResolvedValue(attention);
    selectFolder.mockRejectedValue(new Error("picker closed"));

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SourceHealthPanel />
      </MemoryRouter>,
    );

    const missingRow = await screen.findByTestId("source-health-101");
    await user.click(
      missingRow.querySelector("button") as HTMLButtonElement,
    );

    expect(selectFolder).toHaveBeenCalled();
    expect(relinkLocalBinding).not.toHaveBeenCalled();
    expect(notifyMutations).not.toHaveBeenCalled();
  });

  it("declined Relink confirmation emits no mutations; success emits full channels and reloads", async () => {
    sourceHealth.mockResolvedValueOnce(attention);
    selectFolder.mockResolvedValue({ path: "C:\\work\\moved-repo-new" });

    // Decline evidence confirmation via the shared helper mock returning null.
    relinkLocalBinding.mockResolvedValueOnce(null);
    const user = userEvent.setup();
    const first = render(
      <MemoryRouter>
        <SourceHealthPanel />
      </MemoryRouter>,
    );

    let missingRow = await screen.findByTestId("source-health-101");
    await user.click(missingRow.querySelector("button") as HTMLButtonElement);
    await waitFor(() => {
      expect(relinkLocalBinding).toHaveBeenCalledWith(
        101,
        "C:\\work\\moved-repo-new",
      );
    });
    // Declined: no reconciliation, no success notice, no extra health reload.
    expect(notifyMutations).not.toHaveBeenCalled();
    expect(sourceHealth).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Local copy relinked.")).toBeNull();
    first.unmount();

    // Accept path: helper succeeds → full channels + reload.
    sourceHealth.mockReset();
    sourceHealth.mockResolvedValueOnce(attention);
    selectFolder.mockResolvedValue({ path: "C:\\work\\moved-repo-new" });
    relinkLocalBinding.mockResolvedValueOnce({
      repository: {},
      confirmedUnverified: false,
    } as never);
    sourceHealth.mockResolvedValueOnce(healthy);

    render(
      <MemoryRouter>
        <SourceHealthPanel />
      </MemoryRouter>,
    );
    missingRow = await screen.findByTestId("source-health-101");
    await user.click(missingRow.querySelector("button") as HTMLButtonElement);
    await waitFor(() => {
      expect(sourceHealth.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(notifyMutations).toHaveBeenCalledWith(...REPAIR_CHANNELS);
    expect(notifyMutations).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Local copy relinked.")).toBeTruthy();
  });

  it("failed Relink emits no success reconciliation", async () => {
    sourceHealth.mockResolvedValue(attention);
    selectFolder.mockResolvedValue({ path: "C:\\work\\moved-repo-new" });
    relinkLocalBinding.mockRejectedValue(new Error("identity conflict"));

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SourceHealthPanel />
      </MemoryRouter>,
    );

    const missingRow = await screen.findByTestId("source-health-101");
    await user.click(missingRow.querySelector("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(relinkLocalBinding).toHaveBeenCalled();
    });
    expect(notifyMutations).not.toHaveBeenCalled();
    expect(screen.queryByText("Local copy relinked.")).toBeNull();
  });

  it("keeps backup/restore Maintenance content alongside Source Health", async () => {
    mockMaintenanceEmpty();
    sourceHealth.mockResolvedValue(healthy);

    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Application Backups/i)).toBeTruthy();
    expect(await screen.findByText(/Source Health/i)).toBeTruthy();
    expect(
      screen.getAllByText(/All tracked local copies are currently healthy/i).length,
    ).toBeGreaterThan(0);
  });
});
