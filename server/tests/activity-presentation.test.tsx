// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEventDto } from "../../shared/api-types.js";

/**
 * Presentation coverage for the Activity UX pass: humanized event labels,
 * commit source badges, and the empty-filter state, rendered through the
 * real EventFeed component shared by Dashboard and Project Detail.
 */

const updateProjectMetadata = vi.fn();

vi.mock("../../client/src/api.js", () => ({
  client: {
    portfolio: () => Promise.resolve({ projects: [] }),
    updateProjectMetadata: (...args: unknown[]) => updateProjectMetadata(...args),
    repositories: () => Promise.resolve({ repositories: [] }),
  },
}));

import { EventFeed } from "../../client/src/components/EventFeed.js";

function row(partial: Partial<ActivityEventDto> & { id: number }): ActivityEventDto {
  return {
    projectId: 1,
    localRepositoryId: 0,
    projectName: "bpc-learnshare",
    eventType: "commit_observed",
    summary: "did something",
    occurredAt: "2026-08-21T07:49:34Z",
    source: "scan",
    ...partial,
  };
}

function feed(events: ActivityEventDto[]) {
  return render(
    <MemoryRouter>
      <EventFeed events={events} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  updateProjectMetadata.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("activity presentation", () => {
  it("renders humanized labels for github event types (no snake_case)", async () => {
    feed([
      row({ id: 1, eventType: "github_commit_observed", source: "GITHUB" }),
      row({ id: 2, eventType: "github_repo_tracked", summary: "koyawel27/x" }),
      row({ id: 3, eventType: "github_repo_untracked", summary: "koyawel27/x" }),
      row({ id: 4, eventType: "repository_discovered", summary: "" }),
    ]);
    expect(await screen.findByText("Commit")).toBeTruthy();
    expect(screen.getByText("GitHub connected")).toBeTruthy();
    expect(screen.getByText("GitHub disconnected")).toBeTruthy();
    expect(screen.getByText("Discovered")).toBeTruthy();
    // No raw snake_case anywhere.
    expect(document.body.textContent).not.toMatch(/github_commit_observed|github_repo_tracked/);
  });

  it("shows commit source badges: LOCAL + GITHUB / LOCAL / GITHUB", () => {
    feed([
      row({ id: 10, eventType: "commit_observed", source: "LOCAL + GITHUB" }),
      row({ id: 11, eventType: "commit_observed", source: "LOCAL" }),
      row({ id: 12, eventType: "github_commit_observed", source: "GITHUB" }),
    ]);
    const badges = screen.getAllByText(/^(LOCAL \+ GITHUB|LOCAL|GITHUB)$/);
    // Order-independent: all three compositions are present exactly once.
    expect(badges.map((badge) => badge.textContent).sort()).toEqual([
      "GITHUB",
      "LOCAL",
      "LOCAL + GITHUB",
    ]);
  });

  it("lifecycle rows do not get a commit-source badge", () => {
    feed([
      row({ id: 20, eventType: "github_repo_tracked", source: "user", summary: "koyawel27/x" }),
    ]);
    expect(screen.getByText("GitHub connected")).toBeTruthy();
    expect(screen.queryByText(/^LOCAL/)).toBeNull();
    expect(screen.queryByText(/^GITHUB$/)).toBeNull();
  });

  it("unknown future event types humanize instead of showing snake_case", () => {
    feed([
      row({
        id: 30,
        eventType: "mystery_event_type" as ActivityEventDto["eventType"],
        summary: "?",
      }),
    ]);
    expect(screen.getByText("Mystery event type")).toBeTruthy();
    expect(document.body.textContent).not.toContain("mystery_event_type");
  });
});
