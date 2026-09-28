// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupDto, RestoreStateDto } from "@shared/api-types";

/**
 * V1.3 Maintenance UI: backups panel + restart-mediated restore states.
 */

const listBackups = vi.fn();
const createBackup = vi.fn();
const deleteBackup = vi.fn();
const restoreState = vi.fn();
const scheduleRestore = vi.fn();
const clearRestoreState = vi.fn();
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
    listBackups: (...args: unknown[]) => listBackups(...args),
    createBackup: (...args: unknown[]) => createBackup(...args),
    deleteBackup: (...args: unknown[]) => deleteBackup(...args),
    restoreState: (...args: unknown[]) => restoreState(...args),
    scheduleRestore: (...args: unknown[]) => scheduleRestore(...args),
    clearRestoreState: (...args: unknown[]) => clearRestoreState(...args),
  },
}));

import { MaintenancePage } from "../../client/src/pages/MaintenancePage.js";
import { App } from "../../client/src/App.js";

const sampleManual: BackupDto = {
  id: "manual-2026-03-04T05-06-07-890Z.sqlite",
  filename: "manual-2026-03-04T05-06-07-890Z.sqlite",
  type: "MANUAL",
  createdAt: "2026-03-04T05:06:07.890Z",
  sizeBytes: 2048,
  verification: "VALID",
};

const sampleMigration: BackupDto = {
  id: "pre-006_project_activity-2026-03-04T05-06-07-890Z.sqlite",
  filename: "pre-006_project_activity-2026-03-04T05-06-07-890Z.sqlite",
  type: "MIGRATION",
  createdAt: "2026-03-03T05:06:07.890Z",
  sizeBytes: 4096,
  verification: "VALID",
};

const sampleInvalid: BackupDto = {
  id: "manual-2025-01-01T00-00-00-000Z.sqlite",
  filename: "manual-2025-01-01T00-00-00-000Z.sqlite",
  type: "MANUAL",
  createdAt: "2025-01-01T00:00:00.000Z",
  sizeBytes: 12,
  verification: "INVALID",
};

const sampleRestoreSafety: BackupDto = {
  id: "pre-restore-2026-03-04T06-07-08-900Z.sqlite",
  filename: "pre-restore-2026-03-04T06-07-08-900Z.sqlite",
  type: "RESTORE_SAFETY",
  createdAt: "2026-03-04T06:07:08.900Z",
  sizeBytes: 8192,
  verification: "VALID",
};

function mockInventory(backups: BackupDto[], restore: RestoreStateDto | null = null) {
  listBackups.mockResolvedValue({ backups });
  restoreState.mockResolvedValue({ restore });
}

beforeEach(() => {
  listBackups.mockReset();
  createBackup.mockReset();
  deleteBackup.mockReset();
  restoreState.mockReset();
  scheduleRestore.mockReset();
  clearRestoreState.mockReset();
  confirmSpy.mockReset();
  confirmSpy.mockReturnValue(false);
  vi.stubGlobal("confirm", confirmSpy);
  mockInventory([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Maintenance page (V1.3 M2/M3)", () => {
  it("renders the Maintenance route/page with backups panel copy", async () => {
    mockInventory([]);

    render(
      <MemoryRouter initialEntries={["/maintenance"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Maintenance" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Application Backups" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create Backup Now/i })).toBeTruthy();
    const scope = document.querySelector(".backup-scope-note");
    expect(scope?.textContent ?? "").toMatch(/do not back up, clone, copy, modify, or delete tracked/i);
    expect(screen.getByText(/No application backups yet/i)).toBeTruthy();
  });

  it("Create Backup calls the API and refreshes the list", async () => {
    listBackups.mockResolvedValueOnce({ backups: [] });
    restoreState.mockResolvedValue({ restore: null });
    createBackup.mockResolvedValue({ backup: sampleManual });
    listBackups.mockResolvedValueOnce({ backups: [sampleManual] });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );

    await screen.findByText(/No application backups yet/i);
    await user.click(screen.getByRole("button", { name: /Create Backup Now/i }));

    await waitFor(() => {
      expect(createBackup).toHaveBeenCalledTimes(1);
      expect(listBackups).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("Backup created and verified.")).toBeTruthy();
    expect(screen.getByText(sampleManual.filename)).toBeTruthy();
  });

  it("renders type and verification information on backup rows", async () => {
    mockInventory([
      sampleManual,
      sampleMigration,
      sampleRestoreSafety,
      sampleInvalid,
    ]);

    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(sampleManual.filename)).toBeTruthy();
    expect(screen.getAllByText("Manual").length).toBe(2);
    expect(screen.getByText("Migration")).toBeTruthy();
    expect(screen.getByText("Restore safety")).toBeTruthy();
    expect(screen.getAllByText("Valid").length).toBe(3);
    expect(screen.getByText("Invalid")).toBeTruthy();
  });

  it("shows Delete only for MANUAL backups and never a casual Restore for INVALID", async () => {
    mockInventory([sampleManual, sampleMigration, sampleInvalid]);

    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );

    await screen.findByText(sampleManual.filename);
    // Two MANUAL rows (valid + invalid) get Delete; migration does not.
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
    // Restore exists for VALID rows only (manual + migration = 2).
    expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(2);
    expect(screen.getByText("Kept")).toBeTruthy();
  });

  it("Delete requires owner confirmation and runs when accepted", async () => {
    listBackups.mockResolvedValueOnce({ backups: [sampleManual] });
    restoreState.mockResolvedValue({ restore: null });
    deleteBackup.mockResolvedValue({ ok: true });
    listBackups.mockResolvedValueOnce({ backups: [] });
    confirmSpy.mockReturnValue(true);

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );

    await screen.findByText(sampleManual.filename);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(deleteBackup).toHaveBeenCalledWith(sampleManual.id);
      expect(listBackups).toHaveBeenCalledTimes(2);
    });

    const message = String(confirmSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toContain(sampleManual.filename);
    expect(message).toMatch(/permanent/i);
    expect(message).toMatch(/Tracked Git repositories/i);
    expect(await screen.findByText("Backup deleted.")).toBeTruthy();
  });

  it("Delete does nothing when confirmation is declined", async () => {
    mockInventory([sampleManual]);
    confirmSpy.mockReturnValue(false);

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );

    await screen.findByText(sampleManual.filename);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(deleteBackup).not.toHaveBeenCalled();
    expect(listBackups).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Backup deleted.")).toBeNull();
    expect(screen.getByText(sampleManual.filename)).toBeTruthy();
  });

  it("Restore cancelled confirm sends no request", async () => {
    mockInventory([sampleManual]);
    confirmSpy.mockReturnValue(false);

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );

    await screen.findByText(sampleManual.filename);
    await user.click(screen.getByRole("button", { name: "Restore" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(scheduleRestore).not.toHaveBeenCalled();
    expect(screen.queryByText(/Restore scheduled/i)).toBeNull();
  });

  it("Restore accepted sends confirmRestore=true and shows restart-required copy", async () => {
    listBackups.mockResolvedValueOnce({ backups: [sampleManual] });
    restoreState.mockResolvedValueOnce({ restore: null });
    scheduleRestore.mockResolvedValue({
      restore: {
        status: "PENDING",
        backupId: sampleManual.id,
        requestedAt: "2026-03-04T05:06:07.890Z",
        completedAt: null,
        preRestoreBackupId: null,
        message: null,
      },
    });
    listBackups.mockResolvedValueOnce({ backups: [sampleManual] });
    restoreState.mockResolvedValueOnce({
      restore: {
        status: "PENDING",
        backupId: sampleManual.id,
        requestedAt: "2026-03-04T05:06:07.890Z",
        completedAt: null,
        preRestoreBackupId: null,
        message: null,
      },
    });
    confirmSpy.mockReturnValue(true);

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );

    await screen.findByText(sampleManual.filename);
    await user.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => {
      expect(scheduleRestore).toHaveBeenCalledWith(sampleManual.id);
    });

    const message = String(confirmSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toContain(sampleManual.filename);
    expect(message).toMatch(/safety backup/i);
    expect(message).toMatch(/Tracked Git repositories will NOT/i);
    expect(message).toMatch(/restarting Personal Dev Hub/i);

    expect(
      await screen.findByRole("button", { name: /Cancel Scheduled Restore/i }),
    ).toBeTruthy();
    const pendingBanner = document.querySelector(".restore-pending");
    expect(pendingBanner?.textContent ?? "").toMatch(
      /Restore scheduled\.\s*Restart Personal Dev Hub to apply it\./i,
    );
  });

  it("PENDING state shows restart copy and Cancel Scheduled Restore works", async () => {
    const pending: RestoreStateDto = {
      status: "PENDING",
      backupId: sampleManual.id,
      requestedAt: "2026-03-04T05:06:07.890Z",
      completedAt: null,
      preRestoreBackupId: null,
      message: null,
    };
    listBackups.mockResolvedValueOnce({ backups: [sampleManual] });
    restoreState.mockResolvedValueOnce({ restore: pending });
    clearRestoreState.mockResolvedValue({ ok: true, restore: null });
    listBackups.mockResolvedValueOnce({ backups: [sampleManual] });
    restoreState.mockResolvedValueOnce({ restore: null });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: /Cancel Scheduled Restore/i }),
    ).toBeTruthy();
    const pendingBanner = document.querySelector(".restore-pending");
    expect(pendingBanner?.textContent ?? "").toMatch(/Restart Personal Dev Hub/i);
    await user.click(
      screen.getByRole("button", { name: /Cancel Scheduled Restore/i }),
    );

    await waitFor(() => {
      expect(clearRestoreState).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(/Scheduled restore cancelled/i)).toBeTruthy();
  });

  it("SUCCEEDED and FAILED results render with Dismiss", async () => {
    const succeeded: RestoreStateDto = {
      status: "SUCCEEDED",
      backupId: sampleManual.id,
      requestedAt: "2026-03-04T05:06:07.890Z",
      completedAt: "2026-03-04T05:07:00.000Z",
      preRestoreBackupId: "pre-restore-2026-03-04T05-06-59-000Z.sqlite",
      message: null,
    };
    listBackups.mockResolvedValueOnce({ backups: [sampleManual] });
    restoreState.mockResolvedValueOnce({ restore: succeeded });
    clearRestoreState.mockResolvedValue({ ok: true, restore: null });
    listBackups.mockResolvedValueOnce({ backups: [sampleManual] });
    restoreState.mockResolvedValueOnce({ restore: null });

    const user = userEvent.setup();
    const first = render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Restore completed/i)).toBeTruthy();
    expect(screen.getByText(/pre-restore-2026-03-04T05-06-59-000Z.sqlite/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Dismiss/i }));
    await waitFor(() => expect(clearRestoreState).toHaveBeenCalled());
    first.unmount();

    const failed: RestoreStateDto = {
      status: "FAILED",
      backupId: sampleManual.id,
      requestedAt: "2026-03-04T05:06:07.890Z",
      completedAt: "2026-03-04T05:07:00.000Z",
      preRestoreBackupId: "pre-restore-2026-03-04T05-06-59-000Z.sqlite",
      message: "Restore failed.",
    };
    listBackups.mockResolvedValue({ backups: [sampleManual] });
    restoreState.mockResolvedValue({ restore: failed });

    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Restore did not complete/i)).toBeTruthy();
    expect(screen.getByText(/Restore failed\./)).toBeTruthy();
  });

  it("keeps tracked-repository safety copy and M2 manual Delete available", async () => {
    mockInventory([sampleManual]);

    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );

    await screen.findByText(sampleManual.filename);
    const scope = document.querySelector(".backup-scope-note");
    expect(scope?.textContent ?? "").toMatch(/never changes tracked Git repositories|not.*tracked Git/i);
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});
