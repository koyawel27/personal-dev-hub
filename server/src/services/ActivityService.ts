import type { EventType } from "../../../shared/api-types.js";
import type { GitInspection } from "./GitService.js";

export type PreviousSnapshot = {
  branch: string | null;
  headCommitSha: string | null;
  isDirty: boolean;
  upstreamRef: string | null;
  aheadCount: number | null;
  behindCount: number | null;
};

export type DerivedEvent = {
  eventType: EventType;
  summary: string;
  occurredAt: string;
  fingerprint: string;
  metadata: Record<string, unknown>;
};

export function deriveActivityEvents(input: {
  repositoryId: number;
  isNewRepository: boolean;
  previous: PreviousSnapshot | null;
  inspection: GitInspection;
  knownCommitShas: Set<string>;
  observedAt: string;
}): DerivedEvent[] {
  const {
    repositoryId,
    isNewRepository,
    previous,
    inspection,
    knownCommitShas,
    observedAt,
  } = input;
  const events: DerivedEvent[] = [];

  if (isNewRepository) {
    events.push({
      eventType: "repository_discovered",
      summary: "Repository discovered",
      occurredAt: observedAt,
      fingerprint: `${repositoryId}:repository_discovered`,
      metadata: { path: true },
    });
  }

  for (const commit of inspection.recentCommits) {
    if (knownCommitShas.has(commit.sha)) continue;
    const occurredAt = commit.committedAt || observedAt;
    events.push({
      eventType: "commit",
      summary: commit.subject,
      occurredAt,
      fingerprint: `${repositoryId}:commit:${commit.sha}`,
      metadata: {
        sha: commit.sha,
        authorName: commit.authorName,
      },
    });
  }

  if (previous) {
    const wasDirty = previous.isDirty;
    const isDirty = inspection.workingTree.isDirty;
    if (!wasDirty && isDirty) {
      events.push({
        eventType: "working_tree_dirty",
        summary: "Working tree became uncommitted",
        occurredAt: observedAt,
        fingerprint: `${repositoryId}:working_tree_dirty:${observedAt}`,
        metadata: {
          modifiedCount: inspection.workingTree.modifiedCount,
          stagedCount: inspection.workingTree.stagedCount,
          untrackedCount: inspection.workingTree.untrackedCount,
        },
      });
    } else if (wasDirty && !isDirty) {
      events.push({
        eventType: "working_tree_clean",
        summary: "Working tree became clean",
        occurredAt: observedAt,
        fingerprint: `${repositoryId}:working_tree_clean:${observedAt}`,
        metadata: {},
      });
    }

    if (previous.branch && inspection.branch && previous.branch !== inspection.branch) {
      events.push({
        eventType: "branch_changed",
        summary: `Branch changed from ${previous.branch} to ${inspection.branch}`,
        occurredAt: observedAt,
        fingerprint: `${repositoryId}:branch_changed:${previous.branch}->${inspection.branch}:${observedAt}`,
        metadata: { from: previous.branch, to: inspection.branch },
      });
    }

    const prevAhead = previous.aheadCount;
    const nextAhead = inspection.aheadCount;
    if (prevAhead !== nextAhead && (prevAhead != null || nextAhead != null)) {
      events.push({
        eventType: "ahead_changed",
        summary:
          nextAhead == null
            ? "Ahead count is no longer known"
            : `Ahead count is now ${nextAhead}`,
        occurredAt: observedAt,
        fingerprint: `${repositoryId}:ahead_changed:${prevAhead ?? "none"}->${nextAhead ?? "none"}:${observedAt}`,
        metadata: { from: prevAhead, to: nextAhead },
      });
    }

    const prevBehind = previous.behindCount;
    const nextBehind = inspection.behindCount;
    if (prevBehind !== nextBehind && (prevBehind != null || nextBehind != null)) {
      events.push({
        eventType: "behind_changed",
        summary:
          nextBehind == null
            ? "Behind count is no longer known"
            : `Behind count is now ${nextBehind}`,
        occurredAt: observedAt,
        fingerprint: `${repositoryId}:behind_changed:${prevBehind ?? "none"}->${nextBehind ?? "none"}:${observedAt}`,
        metadata: { from: prevBehind, to: nextBehind },
      });
    }
  }

  return events;
}
