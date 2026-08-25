import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import { createGitRepo, gitExec, makeTempDir, useTempDb } from "./helpers.js";

const cleanup: string[] = [];

beforeEach(() => {
  const dbPath = useTempDb();
  cleanup.push(path.dirname(dbPath));
  getDb();
});

afterEach(() => {
  closeDb();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("API validation and persistence", () => {
  it("reports health", async () => {
    const res = await request(createApp()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(["available", "unavailable"]).toContain(res.body.git);
  });

  it("answers malformed JSON with a 400 validation error, not a 500", async () => {
    const res = await request(createApp())
      .post("/api/sources")
      .set("Content-Type", "application/json")
      .send('{"path":"C:\\Users\\nope"}'); // invalid JSON escape (\U)
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
  });

  it("rejects a missing path", async () => {
    const missing = path.join(makeTempDir("ldd-missing-"), "nope");
    cleanup.push(path.dirname(missing));
    fs.rmSync(path.dirname(missing), { recursive: true, force: true });
    const res = await request(createApp())
      .post("/api/repositories/manual")
      .send({ path: missing });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PATH_NOT_FOUND");
  });

  it("rejects a normal folder that is not a Git repository", async () => {
    const dir = makeTempDir("ldd-nongit-");
    cleanup.push(dir);
    const res = await request(createApp())
      .post("/api/repositories/manual")
      .send({ path: dir });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("NOT_GIT_REPOSITORY");
  });

  it("rejects an unknown repository id", async () => {
    const res = await request(createApp()).get("/api/repositories/999");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("REPOSITORY_NOT_FOUND");
  });

  it("rejects a duplicate scan source", async () => {
    const dir = makeTempDir("ldd-source-");
    cleanup.push(dir);
    const app = createApp();
    const first = await request(app).post("/api/sources").send({ path: dir, scanDepth: 2 });
    expect(first.status).toBe(201);
    const second = await request(app).post("/api/sources").send({ path: dir + "\\" });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("SOURCE_ALREADY_EXISTS");
  });

  it("accepts a Git repository and rejects tracking it twice", async () => {
    const repo = await createGitRepo();
    cleanup.push(repo);
    const app = createApp();
    const first = await request(app).post("/api/repositories/manual").send({ path: repo });
    expect(first.status).toBe(201);
    expect(first.body.repository.workingTree).toBe("Clean");
    expect(first.body.repository.commits).toHaveLength(1);

    const second = await request(app).post("/api/repositories/manual").send({ path: repo });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("REPOSITORY_ALREADY_TRACKED");
  });

  it("does not duplicate commits on repeated refresh", async () => {
    const repo = await createGitRepo();
    cleanup.push(repo);
    const app = createApp();
    const created = await request(app).post("/api/repositories/manual").send({ path: repo });
    const id = created.body.repository.id as number;
    await request(app).post(`/api/repositories/${id}/refresh`);
    const detail = await request(app).get(`/api/repositories/${id}`);
    expect(detail.body.repository.commits).toHaveLength(1);

    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM commits WHERE local_repository_id = ?")
      .get(id) as { n: number };
    expect(count.n).toBe(1);
  });

  it("reflects an external branch change after refresh", async () => {
    const repo = await createGitRepo();
    cleanup.push(repo);
    const app = createApp();
    const created = await request(app).post("/api/repositories/manual").send({ path: repo });
    const id = created.body.repository.id as number;
    await gitExec(repo, ["checkout", "-b", "feature"]);
    const refreshed = await request(app).post(`/api/repositories/${id}/refresh`);
    expect(refreshed.body.repository.snapshot.branch).toBe("feature");
  });

  it("distinguishes clean and uncommitted working trees", async () => {
    const dirty = await createGitRepo({ dirty: true, untracked: true, staged: true });
    cleanup.push(dirty);
    const app = createApp();
    const res = await request(app).post("/api/repositories/manual").send({ path: dirty });
    expect(res.body.repository.workingTree).toBe("Uncommitted");
    expect(res.body.repository.snapshot.modifiedCount).toBe(1);
    expect(res.body.repository.snapshot.stagedCount).toBe(1);
    expect(res.body.repository.snapshot.untrackedCount).toBe(1);
    expect(res.body.repository.changedFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("scans two independent sources and persists them", async () => {
    const sourceA = makeTempDir("ldd-src-a-");
    const sourceB = makeTempDir("ldd-src-b-");
    cleanup.push(sourceA, sourceB);
    const repoA = await createGitRepo();
    const repoB = await createGitRepo();
    cleanup.push(repoA, repoB);
    fs.cpSync(repoA, path.join(sourceA, "alpha"), { recursive: true });
    fs.cpSync(repoB, path.join(sourceB, "beta"), { recursive: true });

    const app = createApp();
    await request(app).post("/api/sources").send({ path: sourceA, scanDepth: 2 });
    await request(app).post("/api/sources").send({ path: sourceB, scanDepth: 2 });
    const scan = await request(app).post("/api/scans");
    expect(scan.status).toBe(200);
    expect(scan.body.summary.sourcesScanned).toBe(2);
    expect(scan.body.summary.repositoriesDiscovered).toBeGreaterThanOrEqual(2);

    const listed = await request(app).get("/api/repositories");
    expect(listed.body.repositories.length).toBeGreaterThanOrEqual(2);

    const dashboard = await request(app).get("/api/dashboard");
    expect(dashboard.body.trackedProjects).toBeGreaterThanOrEqual(2);
  });

  it("does not delete files when a repository is removed from the dashboard", async () => {
    const repo = await createGitRepo();
    cleanup.push(repo);
    const app = createApp();
    const created = await request(app).post("/api/repositories/manual").send({ path: repo });
    const id = created.body.repository.id as number;
    // The fresh repo carries one commit -> meaningful history -> the Q1
    // guard refuses to destroy the Project without explicit confirmation.
    const refused = await request(app).delete(`/api/repositories/${id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("PROJECT_HAS_NO_SOURCES");
    // Confirmed removal proceeds; the filesystem folder is still untouched.
    const removed = await request(app).delete(`/api/repositories/${id}?confirmDeleteProject=true`);
    expect(removed.status).toBe(200);
    expect(removed.body.projectDeleted).toBe(true);
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true);
  });

  it("keeps GitHub optional when gh is missing", async () => {
    const res = await request(createApp()).get("/api/github/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toMatchObject({
      installed: expect.any(Boolean),
      authenticated: expect.any(Boolean),
    });
  });
});
