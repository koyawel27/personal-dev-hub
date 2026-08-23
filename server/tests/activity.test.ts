import { describe, expect, it } from "vitest";
import { deriveActivityEvents } from "../src/services/ActivityService.js";
import type { GitInspection } from "../src/services/GitService.js";

function inspection(overrides: Partial<GitInspection> = {}): GitInspection {
  return {
    branch: "main",
    headCommitSha: "aaa111",
    workingTree: {
      isDirty: false,
      modifiedCount: 0,
      stagedCount: 0,
      untrackedCount: 0,
      changedFiles: [],
    },
    remotes: [],
    upstreamRef: "origin/main",
    aheadCount: 0,
    behindCount: 0,
    recentCommits: [],
    ...overrides,
  };
}

const previous = {
  branch: "main",
  headCommitSha: "aaa111",
  isDirty: false,
  upstreamRef: "origin/main",
  aheadCount: 0,
  behindCount: 0,
};

describe("Activity transitions", () => {
  it("records repository discovery once", () => {
    const events = deriveActivityEvents({
      repositoryId: 1,
      isNewRepository: true,
      previous: null,
      inspection: inspection(),
      knownCommitShas: new Set(),
      observedAt: "2026-08-21T00:00:00.000Z",
    });
    expect(events.map((event) => event.eventType)).toEqual(["repository_discovered"]);
  });

  it("emits working_tree_dirty on clean → dirty", () => {
    const events = deriveActivityEvents({
      repositoryId: 1,
      isNewRepository: false,
      previous,
      inspection: inspection({
        workingTree: {
          isDirty: true,
          modifiedCount: 1,
          stagedCount: 0,
          untrackedCount: 0,
          changedFiles: [],
        },
      }),
      knownCommitShas: new Set(),
      observedAt: "2026-08-21T00:00:00.000Z",
    });
    expect(events.map((event) => event.eventType)).toEqual(["working_tree_dirty"]);
  });

  it("does not emit another dirty event on dirty → dirty", () => {
    const events = deriveActivityEvents({
      repositoryId: 1,
      isNewRepository: false,
      previous: { ...previous, isDirty: true },
      inspection: inspection({
        workingTree: {
          isDirty: true,
          modifiedCount: 2,
          stagedCount: 0,
          untrackedCount: 0,
          changedFiles: [],
        },
      }),
      knownCommitShas: new Set(),
      observedAt: "2026-08-21T00:00:00.000Z",
    });
    expect(events).toEqual([]);
  });

  it("emits working_tree_clean on dirty → clean", () => {
    const events = deriveActivityEvents({
      repositoryId: 1,
      isNewRepository: false,
      previous: { ...previous, isDirty: true },
      inspection: inspection(),
      knownCommitShas: new Set(),
      observedAt: "2026-08-21T00:00:00.000Z",
    });
    expect(events.map((event) => event.eventType)).toEqual(["working_tree_clean"]);
  });

  it("emits branch_changed when the branch changes", () => {
    const events = deriveActivityEvents({
      repositoryId: 1,
      isNewRepository: false,
      previous,
      inspection: inspection({ branch: "feature" }),
      knownCommitShas: new Set(),
      observedAt: "2026-08-21T00:00:00.000Z",
    });
    expect(events.map((event) => event.eventType)).toEqual(["branch_changed"]);
    expect(events[0]?.summary).toContain("feature");
  });

  it("does not emit a commit event for a SHA that is already known", () => {
    const events = deriveActivityEvents({
      repositoryId: 1,
      isNewRepository: false,
      previous,
      inspection: inspection({
        recentCommits: [
          {
            sha: "abc",
            shortSha: "abc",
            subject: "already stored",
            authorName: "Dev",
            committedAt: "2026-08-21T00:00:00.000Z",
          },
        ],
      }),
      knownCommitShas: new Set(["abc"]),
      observedAt: "2026-08-21T01:00:00.000Z",
    });
    expect(events).toEqual([]);
  });

  it("emits a commit event for a new SHA", () => {
    const events = deriveActivityEvents({
      repositoryId: 1,
      isNewRepository: false,
      previous,
      inspection: inspection({
        recentCommits: [
          {
            sha: "def",
            shortSha: "def",
            subject: "new work",
            authorName: "Dev",
            committedAt: "2026-08-21T00:00:00.000Z",
          },
        ],
      }),
      knownCommitShas: new Set(["abc"]),
      observedAt: "2026-08-21T01:00:00.000Z",
    });
    expect(events.map((event) => event.eventType)).toEqual(["commit_observed"]);
    expect(events[0]?.fingerprint).toBe("1:commit:def");
  });
});
