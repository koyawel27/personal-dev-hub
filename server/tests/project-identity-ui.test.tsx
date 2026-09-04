// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityEventDto,
  RepositoryListItem,
  SourceDto,
} from "../../shared/api-types.js";

/**
 * PROJECT route identity regression coverage (baseline repair).
 *
 * Ids deliberately DIVERGE: projectId=17 vs localRepositoryId=4. Project
 * navigation must always carry the PROJECT id; local-binding ids belong
 * exclusively to binding operations (rescan/remove/open). GitHub-only
 * projects have NO local binding at all.
 */

const sources = vi.fn();
const repositories = vi.fn();
const githubPicker = vi.fn();

vi.mock("../../client/src/api.js", () => ({
  ApiError: class ApiError extends Error {},
  client: {
    sources: (...args: unknown[]) => sources(...args),
    repositories: (...args: unknown[]) => repositories(...args),
    githubPicker: (...args: unknown[]) => githubPicker(...args),
    githubStatus: () =>
      Promise.resolve({
        status: { installed: false, authenticated: false, accountName: null },
      }),
    scanSource: () => Promise.resolve({ summary: {} }),
    deleteSource: () => Promise.resolve({ ok: true }),
    refresh: () => Promise.resolve({}),
    addManual: () => Promise.resolve({}),
    scanAll: () => Promise.resolve({ summary: {} }),
    selectFolder: () => Promise.resolve({ selected: false, path: null }),
  },
}));

import { EventFeed } from "../../client/src/components/EventFeed.js";
import { SourcesPage } from "../../client/src/pages/SourcesPage.js";

function event(partial: Partial<ActivityEventDto> & { id: number }): ActivityEventDto {
  return {
    projectId: 17,
    localRepositoryId: 4,
    projectName: "local-dev-dashboard",
    eventType: "commit_observed",
    summary: "did something",
    occurredAt: "2026-08-21T07:49:34Z",
    source: "scan",
    ...partial,
  };
}

function repo(partial: Partial<RepositoryListItem>): RepositoryListItem {
  return {
    id: 4,
    projectId: 17,
    isPrimary: false,
    name: "local-dev-dashboard",
    localPath: "C:\\xampp-projects\\local-dev-dashboard",
    canonicalPath: "c:\\xampp-projects\\local-dev-dashboard",
    discoveryType: "scanned",
    sourceId: 1,
    lastScannedAt: null,
    snapshot: null,
    projectStatus: null,
    projectType: null,
    projectNote: null,
    includeInPortfolio: false,
    portfolioOrder: null,
    workingTree: "Clean",
    sync: "",
    github: "Local Only",
    githubHtmlUrl: null,
    lastActivityAt: null,
    lastActivitySummary: null,
    ...partial,
  };
}

afterEach(() => {
  cleanup();
});

describe("project route identity", () => {
  it("EventFeed links commits with divergent ids to /projects/:projectId", () => {
    render(
      <MemoryRouter>
        <EventFeed
          events={[
            event({ id: 1 }), // projectId 17, localRepositoryId 4
          ]}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "local-dev-dashboard" });
    expect(link.getAttribute("href")).toBe("/projects/17");
  });

  it("GitHub-only commit events never link to /projects/0", () => {
    render(
      <MemoryRouter>
        <EventFeed
          events={[
            event({
              id: 2,
              projectId: 21,
              localRepositoryId: 0, // GitHub-origin rows carry 0 here
              projectName: "github-only-project",
              eventType: "github_commit_observed",
              source: "GITHUB",
            }),
          ]}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "github-only-project" });
    expect(link.getAttribute("href")).toBe("/projects/21");
    expect(link.getAttribute("href")).not.toBe("/projects/0");
  });

  it("metadata events without a local binding link to the owning project", () => {
    render(
      <MemoryRouter>
        <EventFeed
          events={[
            event({
              id: 3,
              eventType: "project_note_updated",
              source: "user",
              localRepositoryId: 0,
            }),
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe("/projects/17");
  });

  it("Sources repository rows link to the owning PROJECT id, not repo.id", async () => {
    sources.mockResolvedValue({ sources: [] as SourceDto[] });
    repositories.mockResolvedValue({
      repositories: [repo({ id: 4, projectId: 17 })],
    });
    githubPicker.mockResolvedValue({ entries: [], available: false });

    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: "local-dev-dashboard" });
    expect(link.getAttribute("href")).toBe("/projects/17");
    // Never the local repository id as a Project route.
    expect(link.getAttribute("href")).not.toBe("/projects/4");
  });
});
