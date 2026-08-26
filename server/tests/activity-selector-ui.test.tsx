// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityEventDto,
  ProjectListItemDto,
} from "../../shared/api-types.js";

/**
 * Activity page regression coverage (baseline repair):
 * - the Project selector is PROJECT-centric (includes GITHUB ONLY projects,
 *   values are Project ids) — local repositories never populate it;
 * - the owner-approved filter interaction model is preserved exactly:
 *   Project applies IMMEDIATELY with the previously APPLIED date range,
 *   date edits stay drafts until Filter commits them.
 */

const activityPage = vi.fn();
const projects = vi.fn();

vi.mock("../../client/src/api.js", () => ({
  ApiError: class ApiError extends Error {},
  client: {
    activityPage: (...args: unknown[]) => activityPage(...args),
    projects: (...args: unknown[]) => projects(...args),
  },
}));

import { ActivityPage } from "../../client/src/pages/ActivityPage.js";

const ALL_PROJECTS: ProjectListItemDto[] = [
  {
    id: 17,
    name: "local-dev-dashboard",
    sourceState: "LOCAL + GITHUB",
    projectStatus: null,
    projectType: null,
    includeInPortfolio: false,
    portfolioOrder: null,
    localPath: "C:\\xampp-projects\\local-dev-dashboard",
    githubFullName: "koyawel27/local-dev-dashboard",
    githubHtmlUrl: null,
    lastMeaningfulAt: null,
  },
  {
    id: 21,
    name: "github-only-project",
    sourceState: "GITHUB ONLY",
    projectStatus: null,
    projectType: null,
    includeInPortfolio: false,
    portfolioOrder: null,
    localPath: null,
    githubFullName: "koyawel27/github-only-project",
    githubHtmlUrl: null,
    lastMeaningfulAt: null,
  },
];

function row(id: number): ActivityEventDto {
  return {
    id,
    projectId: 17,
    localRepositoryId: 4,
    projectName: "local-dev-dashboard",
    eventType: "commit_observed",
    summary: `commit ${id}`,
    occurredAt: `2026-08-${20 + (id % 5)}T10:00:00Z`,
    source: "scan",
  };
}

function page(rows: ActivityEventDto[], nextCursor: string | null = null) {
  return Promise.resolve({ rows, nextCursor });
}

beforeEach(() => {
  activityPage.mockReset();
  projects.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderActivity() {
  render(
    <MemoryRouter>
      <ActivityPage />
    </MemoryRouter>,
  );
}

describe("activity project selector", () => {
  it("lists every Project (LOCAL ONLY, LOCAL + GITHUB, GITHUB ONLY) with Project-id values", async () => {
    activityPage.mockReturnValue(page([row(1)]));
    projects.mockResolvedValue({ projects: ALL_PROJECTS });
    renderActivity();

    const selector = (await screen.findByRole("combobox")) as HTMLSelectElement;
    const options = Array.from(selector.options).map((option) => option.value);
    expect(options).toContain("17"); // LOCAL + GITHUB
    expect(options).toContain("21"); // GITHUB ONLY — was missing before
  });

  it("selecting a GITHUB ONLY project filters by its PROJECT id immediately", async () => {
    const user = userEvent.setup();
    activityPage.mockImplementation((params: { projectId?: number }) =>
      params.projectId === 21 ? page([{ ...row(9), id: 9 }]) : page([]),
    );
    projects.mockResolvedValue({ projects: ALL_PROJECTS });
    renderActivity();
    await screen.findByRole("combobox");

    await user.selectOptions(screen.getByRole("combobox"), "21");

    await waitFor(() => {
      const call = activityPage.mock.calls.at(-1)?.[0] as { projectId?: number };
      expect(call.projectId).toBe(21);
    });
  });
});

describe("activity draft/apply date semantics (owner-approved model)", () => {
  it("project change applies immediately; unsubmitted dates stay drafts until Filter", async () => {
    const user = userEvent.setup();

    // Applied state starts empty; every first-page load resolves rows.
    activityPage.mockImplementation(() => page([]));
    projects.mockResolvedValue({ projects: ALL_PROJECTS });
    renderActivity();
    await screen.findByRole("combobox");

    // Apply a real applied-date range via Filter: Aug 20 → Aug 24.
    await user.type(screen.getByLabelText("From"), "2026-08-20");
    await user.type(screen.getByLabelText("To"), "2026-08-24");
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await waitFor(() => {
      const call = activityPage.mock.calls.at(-1)?.[0] as {
        from?: string;
        to?: string;
      };
      expect(call.from).toContain("2026-08-20");
      expect(call.to).toContain("2026-08-24");
    });
    const appliedCalls = activityPage.mock.calls.length;

    // Draft-only edit: To becomes Aug 25 but is NOT submitted.
    await user.clear(screen.getByLabelText("To"));
    await user.type(screen.getByLabelText("To"), "2026-08-25");

    // Change the Project — must apply immediately WITH THE APPLIED RANGE
    // (Aug 20–24), never the Aug 25 draft.
    await user.selectOptions(screen.getByRole("combobox"), "21");
    await waitFor(() => {
      expect(activityPage.mock.calls.length).toBeGreaterThan(appliedCalls);
    });
    const afterProjectChange = activityPage.mock.calls.at(-1)?.[0] as {
      projectId?: number;
      from?: string;
      to?: string;
    };
    expect(afterProjectChange.projectId).toBe(21);
    expect(afterProjectChange.from).toContain("2026-08-20");
    expect(afterProjectChange.to).toContain("2026-08-24");
    expect(afterProjectChange.to).not.toContain("2026-08-25");

    // The draft survives in the control; Filter commits it afterwards.
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe(
      "2026-08-25",
    );
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await waitFor(() => {
      const finalCall = activityPage.mock.calls.at(-1)?.[0] as {
        to?: string;
      };
      expect(finalCall.to).toContain("2026-08-25");
    });
  });
});
