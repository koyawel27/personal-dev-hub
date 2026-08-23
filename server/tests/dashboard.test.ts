import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import { createGitRepo, useTempDb } from "./helpers.js";
import { getDashboardForTest } from "../src/services/RepositoryService.js";

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

function daysAgoIso(days: number, hour = 9): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

beforeEach(async () => {
  cleanup.push(path.dirname(useTempDb()));
  getDb();
  app = createApp();

  const repo = await createGitRepo({ dirty: true });
  cleanup.push(repo);
  const created = await request(app).post("/api/repositories/manual").send({ path: repo });
  expect(created.status).toBe(201);
});

afterEach(() => {
  closeDb();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Dashboard aggregation", () => {
  it("reports real summary metrics", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.trackedProjects).toBe(1);
    // The manual add itself produced a commit_observed event for the initial commit.
    expect(res.body.activeProjects).toBe(1);
    expect(res.body.activeDaysThisWeek).toBeGreaterThanOrEqual(1);
    expect(res.body.commitsThisWeek).toBeGreaterThanOrEqual(1);
    expect(res.body.uncommittedRepositories).toBe(1);
  });

  it("counts active days from distinct qualifying activity days only", () => {
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO activity_events
        (local_repository_id, event_type, summary, occurred_at, source, fingerprint)
       VALUES (1, ?, 'subject', ?, 'scan', ?)`,
    );
    // Two qualifying events on the same day count as ONE active day;
    // a third qualifying day brings the total to three.
    insert.run("commit_observed", daysAgoIso(1, 8), "f-1");
    insert.run("branch_changed", daysAgoIso(1, 15), "f-2");
    insert.run("commit_observed", daysAgoIso(2, 10), "f-3");
    // Non-qualifying events must never contribute active days.
    insert.run("repository_discovered", daysAgoIso(0, 7), "f-4");

    const dashboard = getDashboardForTest();
    // Today's initial-commit event plus the two distinct inserted days.
    expect(dashboard.activeDaysThisWeek).toBe(3);
  });

  it("derives recently-active projects from activity_events, never scan recency", async () => {
    const db = getDb();
    // A future-dated event no scan could ever generate: if lastMeaningfulAt
    // equals this exact timestamp, it came from activity_events.
    const futureIso = "2027-01-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO activity_events
        (local_repository_id, event_type, summary, occurred_at, source, fingerprint)
       VALUES (1, 'commit_observed', 'real work', ?, 'scan', 'f-real')`,
    ).run(futureIso);

    const res = await request(app).get("/api/dashboard");
    const recent = res.body.recentlyActive as {
      id: number;
      lastMeaningfulAt: string | null;
      latestCommitSubject: string | null;
    }[];
    expect(recent).toHaveLength(1);
    expect(recent[0].lastMeaningfulAt).toBe(futureIso);
    expect(recent[0].latestCommitSubject).toBe("initial");
    expect(recent[0]).toHaveProperty("projectStatus");
    expect(recent[0]).toHaveProperty("workingTree");
  });

  it("derives needs-attention reasons including missing upstream and dirty trees", async () => {
    const res = await request(app).get("/api/dashboard");
    const attention = res.body.needsAttention as { id: number; attentionReasons: string[] }[];
    const row = attention.find((item) => item.id === 1);
    expect(row).toBeDefined();
    expect(row?.attentionReasons).toContain("uncommitted changes");
    expect(row?.attentionReasons).toContain("no upstream branch");

    // A clean repository without an upstream still needs attention.
    const clean = await createGitRepo();
    cleanup.push(clean);
    await request(app).post("/api/repositories/manual").send({ path: clean });
    const again = await request(app).get("/api/dashboard");
    const reasons = (again.body.needsAttention as { attentionReasons: string[] }[])
      .map((item) => item.attentionReasons)
      .flat();
    expect(reasons).toContain("no upstream branch");
  });
});
