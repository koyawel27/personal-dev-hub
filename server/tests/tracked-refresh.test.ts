import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import {
  setGhExecutorForTests,
  type GhExecutor,
} from "../src/services/GitHubService.js";
import { useTempDb } from "./helpers.js";

/**
 * Regression coverage: tracked GitHub repositories must have a usable
 * refresh workflow (real-account defect on koyawel27/Enrollment-System).
 *
 * - POST /api/github/tracked/:id/refresh existed but was never exposed;
 *   these tests pin the backend contract and the picker payload that the
 *   UI now uses (trackedBindingId), plus initial-refresh-on-track.
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

function ghExecutor(options?: { commitsFail?: boolean }): GhExecutor {
  return async (args) => {
    const argv = args.join(" ");
    if (/^api repos\/[^/]+\/[^/]+$/.test(argv)) {
      return {
        stdout: JSON.stringify({
          owner: { login: "koyawel27" },
          name: "Enrollment-System",
          full_name: "koyawel27/Enrollment-System",
          visibility: "public",
          default_branch: "main",
          html_url: "https://github.com/koyawel27/Enrollment-System",
          pushed_at: "2026-08-21T00:00:00Z",
        }),
        stderr: "",
        code: 0,
      };
    }
    if (/^api repos\/.+\/commits/.test(argv)) {
      if (options?.commitsFail) return { stdout: "", stderr: "boom", code: 1 };
      return {
        stdout: JSON.stringify([
          {
            sha: "aaa1111111111111111111111111111111111111",
            commit: { message: "feat: latest enrollment work", author: { name: "K", date: "2026-08-21T09:00:00Z" } },
          },
          {
            sha: "bbb2222222222222222222222222222222222222",
            commit: { message: "chore: earlier commit", author: { name: "K", date: "2026-08-20T09:00:00Z" } },
          },
        ]),
        stderr: "",
        code: 0,
      };
    }
    if (argv.startsWith("api user")) return { stdout: JSON.stringify({ login: "koyawel27" }), stderr: "", code: 0 };
    return { stdout: "", stderr: `unexpected: ${argv}`, code: 127 };
  };
}

beforeEach(() => {
  cleanup.push(path.dirname(useTempDb()));
  getDb();
  app = createApp();
  setGhExecutorForTests(ghExecutor());
});

afterEach(() => {
  setGhExecutorForTests(null);
  closeDb();
  for (const dir of cleanup.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("tracked GitHub repository refresh workflow", () => {
  it("exposes trackedBindingId in the picker and refresh persists commits", async () => {
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/Enrollment-System" });
    expect(track.status).toBe(201);
    const ghId = track.body.githubRepositoryId as number;

    // Picker payload carries the safe registered handle for tracked rows.
    const picker = await request(app).get("/api/github/repositories");
    const entry = (
      picker.body.entries as Array<{ fullName: string; trackedBindingId: number | null; tracked: boolean }>
    ).find((candidate) => candidate.fullName === "koyawel27/Enrollment-System");
    expect(entry?.tracked).toBe(true);
    expect(entry?.trackedBindingId).toBe(ghId);

    // Explicit per-repository refresh is idempotent: initial tracking already
    // fetched these SHAs, so nothing new is added (dedup by SHA).
    const refresh = await request(app).post(`/api/github/tracked/${ghId}/refresh`);
    expect(refresh.status).toBe(200);
    expect(refresh.body.ok).toBe(true);
    expect(refresh.body.newCommits).toBe(0);

    // The GitHub-only project's Commits view returns the stored history.
    const detail = await request(app).get(`/api/projects/${track.body.projectId}`);
    const commits = detail.body.project.commits as Array<{ source: string; sha: string }>;
    expect(commits.some((commit) => commit.source === "github" && commit.sha.startsWith("aaa1111"))).toBe(
      true,
    );
    expect(commits.some((commit) => commit.sha.startsWith("bbb2222"))).toBe(true);
  });

  it("initial tracking performs a bounded first refresh automatically", async () => {
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/Enrollment-System" });
    expect(track.status).toBe(201);
    expect(track.body.initialRefresh).toBe("ok");

    // Commits were already stored by the initial refresh — no manual step needed.
    const detail = await request(app).get(`/api/projects/${track.body.projectId}`);
    expect(
      (detail.body.project.commits as unknown[]).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("refresh failure never untracks or deletes the project; local functionality unaffected", async () => {
    setGhExecutorForTests(ghExecutor({ commitsFail: true }));
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/Enrollment-System" });
    expect(track.status).toBe(201); // tracking still succeeds
    expect(track.body.initialRefresh).toBe("failed");

    const projectId = track.body.projectId as number;
    const ghId = track.body.githubRepositoryId as number;

    const refresh = await request(app).post(`/api/github/tracked/${ghId}/refresh`);
    expect(refresh.status).toBe(200);
    expect(refresh.body.ok).toBe(false);
    expect(refresh.body.reason).toBe("unavailable");

    // Project survives with its binding intact.
    const detail = await request(app).get(`/api/projects/${projectId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.project.sourceState).toBe("GITHUB ONLY");
    expect(detail.body.project.githubMetadata).not.toBeNull();

    // Local dashboard remains fully functional.
    const dashboard = await request(app).get("/api/dashboard");
    expect(dashboard.status).toBe(200);

    // Recovery works once GitHub is reachable again.
    setGhExecutorForTests(ghExecutor());
    const retry = await request(app).post(`/api/github/tracked/${ghId}/refresh`);
    expect(retry.body.ok).toBe(true);
  });

  it("refresh list stays separate from tracked-repository refresh semantics", async () => {
    // Track WITHOUT initial refresh succeeding: commits endpoint fails so we
    // can observe the explicit refresh adding rows.
    setGhExecutorForTests(ghExecutor({ commitsFail: true }));
    await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/Enrollment-System" });
    setGhExecutorForTests(ghExecutor());

    // Re-reading the picker ("Refresh list") does NOT touch commit storage.
    const before = (
      getDb().prepare("SELECT COUNT(*) AS n FROM github_commits").get() as { n: number }
    ).n;
    await request(app).get("/api/github/repositories");
    const after = (
      getDb().prepare("SELECT COUNT(*) AS n FROM github_commits").get() as { n: number }
    ).n;
    expect(after).toBe(before);

    // Only the explicit per-repository refresh mutates commit history.
    const picker = await request(app).get("/api/github/repositories");
    const entry = (
      picker.body.entries as Array<{ fullName: string; trackedBindingId: number | null }>
    ).find((candidate) => candidate.fullName === "koyawel27/Enrollment-System");
    const refresh = await request(app).post(
      `/api/github/tracked/${entry!.trackedBindingId}/refresh`,
    );
    expect(refresh.body.ok).toBe(true);
    expect(
      (getDb().prepare("SELECT COUNT(*) AS n FROM github_commits").get() as { n: number }).n,
    ).toBeGreaterThan(after);
  });
});
