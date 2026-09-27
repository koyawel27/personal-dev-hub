// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupDto } from "@shared/api-types";

/**
 * V1.3 M2 Maintenance UI: route renders, create refresh, type/verification
 * display, MANUAL-only delete with owner confirmation, and no Restore action.
 */

const listBackups = vi.fn();
const createBackup = vi.fn();
const deleteBackup = vi.fn();
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

beforeEach(() => {
  listBackups.mockReset();
  createBackup.mockReset();
  deleteBackup.mockReset();
  confirmSpy.mockReset();
  confirmSpy.mockReturnValue(false);
  vi.stubGlobal("confirm", confirmSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Maintenance page (V1.3 M2)", () => {
  it("renders the Maintenance route/page with backups panel copy", async () => {
    listBackups.mockResolvedValue({ backups: [] });

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
    // Scope note is split by a <strong>not</strong>; match the paragraph text.
    const scope = document.querySelector(".backup-scope-note");
    expect(scope?.textContent ?? "").toMatch(/do not back up, clone, copy, modify, or delete tracked/i);
    expect(screen.getByText(/No application backups yet/i)).toBeTruthy();
  });

  it("Create Backup calls the API and refreshes the list", async () => {
    listBackups.mockResolvedValueOnce({ backups: [] });
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
    listBackups.mockResolvedValue({
      backups: [sampleManual, sampleMigration, sampleRestoreSafety, sampleInvalid],
    });

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

  it("shows Delete only for MANUAL backups and never a Restore action", async () => {
    listBackups.mockResolvedValue({
      backups: [sampleManual, sampleMigration],
    });

    render(
      <MemoryRouter>
        <MaintenancePage />
      </MemoryRouter>,
    );

    await screen.findByText(sampleManual.filename);
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    expect(deleteButtons).toHaveLength(1);

    expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
    expect(screen.queryByText(/^Restore$/i)).toBeNull();
    expect(screen.getByText("Kept")).toBeTruthy();
  });

  it("Delete requires owner confirmation and runs when accepted", async () => {
    listBackups.mockResolvedValueOnce({ backups: [sampleManual] });
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
    listBackups.mockResolvedValue({ backups: [sampleManual] });
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
    // Initial load only — no mutation reload.
    expect(listBackups).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Backup deleted.")).toBeNull();
    expect(screen.getByText(sampleManual.filename)).toBeTruthy();
  });
});
