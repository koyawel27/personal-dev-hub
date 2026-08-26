import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import { createGitRepo, useTempDb } from "./helpers.js";

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;
let repoId: number;
let projectId: number;

beforeEach(async () => {
  cleanup.push(path.dirname(useTempDb()));
  getDb();
  app = createApp();

  const repo = await createGitRepo();
  cleanup.push(repo);
  const created = await request(app)
    .post("/api/repositories/manual")
    .send({ path: repo });
  expect(created.status).toBe(201);
  repoId = created.body.repository.id as number;
  projectId = created.body.repository.projectId as number;
});

afterEach(() => {
  closeDb();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function patch(body: Record<string, unknown>) {
  // Metadata is PROJECT state: the canonical route carries a PROJECT id.
  return request(app).patch(`/api/projects/${projectId}/metadata`).send(body);
}

async function projectActivityCount(): Promise<number> {
  const res = await request(app).get(`/api/activity?projectId=${projectId}`);
  return (res.body.activity as unknown[]).length;
}

function eventsOfType(
  res: { body: { activity: { eventType: string; summary: string }[] } },
  type: string,
) {
  return res.body.activity.filter((event) => event.eventType === type);
}

describe("Project metadata API", () => {
  it("persists manual metadata in detail and list payloads, surviving a database reopen", async () => {
    const patched = await patch({
      projectStatus: "Paused",
      projectType: "School",
      projectNote: "Waiting for adviser feedback",
      includeInPortfolio: true,
      portfolioOrder: 2,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.project.projectStatus).toBe("Paused");
    expect(patched.body.project.projectType).toBe("School");
    expect(patched.body.project.projectNote).toBe("Waiting for adviser feedback");
    expect(patched.body.project.includeInPortfolio).toBe(true);
    expect(patched.body.project.portfolioOrder).toBe(2);

    const listed = await request(app).get("/api/projects");
    expect(listed.status).toBe(200);
    const item = listed.body.projects.find(
      (project: { id: number }) => project.id === projectId,
    );
    expect(item.projectStatus).toBe("Paused");
    expect(item.includeInPortfolio).toBe(true);

    // Simulate an application restart against the same database.
    closeDb();
    getDb();
    const freshApp = createApp();
    const reopened = await request(freshApp).get(`/api/projects/${projectId}`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.project.projectStatus).toBe("Paused");
    expect(reopened.body.project.projectNote).toBe("Waiting for adviser feedback");
    expect(reopened.body.project.portfolioOrder).toBe(2);
  });

  it("clears nullable fields when explicitly set to null", async () => {
    await patch({ projectStatus: "Active", projectNote: "note" });
    const cleared = await patch({ projectStatus: null, projectNote: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.project.projectStatus).toBeNull();
    expect(cleared.body.project.projectNote).toBeNull();
  });

  it("rejects invalid status, type, portfolio flag, and order values", async () => {
    const badStatus = await patch({ projectStatus: "Boss" });
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error.code).toBe("INVALID_METADATA");

    const badType = await patch({ projectType: "Alien" });
    expect(badType.status).toBe(400);
    expect(badType.body.error.code).toBe("INVALID_METADATA");

    const badFlag = await patch({ includeInPortfolio: "yes" });
    expect(badFlag.status).toBe(400);
    expect(badFlag.body.error.code).toBe("INVALID_METADATA");

    const badOrder = await patch({ portfolioOrder: 1.5 });
    expect(badOrder.status).toBe(400);
    expect(badOrder.body.error.code).toBe("INVALID_METADATA");

    const longNote = await patch({ projectNote: "x".repeat(501) });
    expect(longNote.status).toBe(400);
    expect(longNote.body.error.code).toBe("INVALID_METADATA");

    const notObject = await request(app)
      .patch(`/api/projects/${projectId}/metadata`)
      .send("just-a-string");
    expect(notObject.status).toBe(400);
    expect(notObject.body.error.code).toBe("INVALID_METADATA");
  });

  it("rejects an unknown project id", async () => {
    const res = await request(app)
      .patch("/api/projects/999/metadata")
      .send({ projectStatus: "Active" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("REPOSITORY_NOT_FOUND");
  });
});

describe("Manual metadata activity events", () => {
  it("emits one project_status_changed per actual change and nothing on no-op saves", async () => {
    const before = await projectActivityCount();

    const first = await patch({ projectStatus: "Paused" });
    expect(first.status).toBe(200);

    let res = await request(app).get(`/api/activity?projectId=${projectId}`);
    let statusEvents = eventsOfType(res, "project_status_changed");
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].summary).toContain("Paused");
    expect(activityHasFingerprint(`fingerprint LIKE 'p%:${projectId}:project_status_changed:none->Paused'`)).toBe(true);
    expect(await projectActivityCount()).toBe(before + 1);

    // A different value produces exactly one more event.
    await patch({ projectStatus: "Finished" });
    res = await request(app).get(`/api/activity?projectId=${projectId}`);
    statusEvents = eventsOfType(res, "project_status_changed");
    expect(statusEvents).toHaveLength(2);
    expect(
      activityHasFingerprint(
        `fingerprint LIKE 'p%:${projectId}:project_status_changed:Paused->Finished'`,
      ),
    ).toBe(true);

    // Saving the same value again must not add an event.
    const noopBefore = await projectActivityCount();
    await patch({ projectStatus: "Finished" });
    expect(await projectActivityCount()).toBe(noopBefore);
  });

  it("emits project_note_updated only when the note content changes", async () => {
    const before = await projectActivityCount();

    await patch({ projectNote: "Stage 6 blur resize bug remains." });
    let res = await request(app).get(`/api/activity?projectId=${projectId}`);
    expect(eventsOfType(res, "project_note_updated")).toHaveLength(1);
    expect(eventsOfType(res, "project_note_updated")[0].summary).toContain(
      "Stage 6 blur resize bug remains.",
    );
    expect(await projectActivityCount()).toBe(before + 1);

    // Identical note: no new event.
    await patch({ projectNote: "Stage 6 blur resize bug remains." });
    res = await request(app).get(`/api/activity?projectId=${projectId}`);
    expect(eventsOfType(res, "project_note_updated")).toHaveLength(1);

    // Changed note: exactly one more.
    await patch({ projectNote: "Adviser approved the scope." });
    res = await request(app).get(`/api/activity?projectId=${projectId}`);
    expect(eventsOfType(res, "project_note_updated")).toHaveLength(2);
  });

  it("never emits metadata events for unrelated repository rescans", async () => {
    await patch({ projectStatus: "Experiment" });
    const baselineRes = await request(app).get(`/api/activity?projectId=${projectId}`);
    const baselineMeta = eventsOfType(baselineRes, "project_status_changed").length;
    expect(baselineMeta).toBe(1);

    // Rescan targets the LOCAL BINDING id; metadata events stay untouched.
    await request(app).post(`/api/repositories/${repoId}/refresh`);
    const res = await request(app).get(`/api/activity?projectId=${projectId}`);
    expect(eventsOfType(res, "project_status_changed")).toHaveLength(1);
  });
});

function activityHasFingerprint(sqlLikeClause: string): boolean {
  const row = getDb()
    .prepare(`SELECT id FROM activity_events WHERE ${sqlLikeClause}`)
    .get() as { id: number } | undefined;
  return row != null;
}
