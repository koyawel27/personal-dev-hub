// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Release QA defect fix: Settings "App data" must render the backend's
 * actual resolved database path (config.dbPath / DASHBOARD_DB_PATH), not the
 * old hardcoded "data/dashboard.sqlite (project folder)" text.
 */

const OVERRIDE_PATH = "C:\\qa-override\\fresh.sqlite";

vi.mock("../../client/src/api.js", () => ({
  ApiError: class ApiError extends Error {},
  client: {
    health: () => Promise.resolve({ git: "available" }),
    githubStatus: () =>
      Promise.resolve({
        status: { installed: false, authenticated: false, accountName: null },
      }),
    settings: () =>
      Promise.resolve({
        settings: {
          defaultScanDepth: 3,
          gitExecutable: "git",
          dataPath: OVERRIDE_PATH,
        },
      }),
    updateSettings: () => Promise.reject(new Error("not used in this test")),
    scanAll: () => Promise.reject(new Error("not used in this test")),
  },
}));

import { SettingsPage } from "../../client/src/pages/SettingsPage.js";

afterEach(() => {
  cleanup();
});

describe("Settings App data display", () => {
  it("renders the API-provided resolved database path, not a hardcoded default", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    // The exact override path from the mocked GET /api/settings appears.
    expect(await screen.findByText(OVERRIDE_PATH)).toBeTruthy();
    // The previously hardcoded default text must be gone.
    expect(screen.queryByText(/data\/dashboard\.sqlite/)).toBeNull();
    expect(screen.queryByText(/\(project folder\)/)).toBeNull();
  });
});
