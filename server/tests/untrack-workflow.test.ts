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
import { createGitRepo, gitExec, useTempDb } from "./helpers.js";

/**
 * UI-lifecycle regression coverage for the untrack/disconnect workflow.
 * The Q1 lifecycle itself is already covered by project-tracking.test.ts;
 * these tests pin the remaining owner acceptance points: portfolio and
 * local history survival, unknown-id safety, retry determinism, and the
 * picker payload the new Sources controls consume.
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

const ghStub: GhExecutor = async (args) => {
  const argv = args.join(" ");
  if (/^api repos\/[^/]+\/[^/]+$/.test(argv)) {
    const [, , name] = argv.split("/");
    return {
      stdout: JSON.stringify({
        owner: { login: "koyawel27" },
        name,
        full_name: `koyawel27/${name}`,
        visibility: "public",
        default_branch: "main",
        html_url: `https://github.com/koyawel27/${name}`,
        pushed_at: "2026-08-01T00:00:00Z",
      }),
      stderr: "",
      code: 0,
    };
  }
  if (/^api repos\/.+\/commits/.test(argv)) {
    return {
      stdout: JSON.stringify([
        {
          sha: "cafef00dcafef00dcafef00dcafef00dcafef00d",
          commit: {
            message: "github-side history",
            author: { name: "Dev", date: "2026-07-01T09:00:00Z" },
          },
        },
      ]),
      stderr: "",
      code: 0,
    };
  }
  return { stdout: "", stderr: `unexpected: ${argv}`, code: 127 };
};

beforeEach(() => {
  cleanup.push(path.dirname(useTempDb()));
  getDb();
  app = createApp();
  setGhExecutorForTests(ghStub);
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

describe("untrack / disconnect workflow", () => {
  it("disconnect preserves portfolio state and local commit history", async () => {
    const repoPath = await createGitRepo();
    await gitExec(repoPath, ["remote", "add", "origin", "https://github.com/koyawel27/portfolio-keep.git"]);
    const created = await request(app).post("/api/repositories/manual").send({ path: repoPath });
    const projectId = created.body.repository.projectId as number;

    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/portfolio-keep" });
    expect(track.body.state).toBe("LOCAL + GITHUB");

    // Meaningful retained state: manual metadata + portfolio inclusion.
    await request(app)
      .patch(`/api/projects/${projectId}/metadata`)
      .send({
        projectStatus: "Finished",
        includeInPortfolio: true,
        portfolioOrder: 2,
        projectNote: "capstone",
      });

    const del = await request(app).delete(`/api/github/tracked/${track.body.githubRepositoryId}`);
    expect(del.status).toBe(200);
    expect(del.body.projectDeleted).toBe(false);

    const detail = await request(app).get(`/api/projects/${projectId}`);
    const p = detail.body.project;
    expect(p.sourceState).toBe("LOCAL ONLY");
    expect(p.includeInPortfolio).toBe(true);
    expect(p.portfolioOrder).toBe(2);
    expect(p.localPath).toBeTruthy();

    // Local commits survive; the github-side commits no longer attach.
    const localCommits = (p.commits as Array<{ source: string }>).filter(
      (commit) => commit.source === "local",
    );
    expect(localCommits.length).toBeGreaterThan(0);

    // The project still exists in the portfolio view.
    const portfolio = await request(app).get("/api/portfolio");
    expect(
      (portfolio.body.projects as Array<{ id: number }>).some((item) => item.id === projectId),
    ).toBe(true);

    // Picker row flips back to untracked-with-local-copy.
    const picker = await request(app).get("/api/github/repositories");
    const entry = (
      picker.body.entries as Array<{
        fullName: string;
        tracked: boolean;
        trackedBindingId: number | null;
        localCopyPath: string | null;
      }>
    ).find((candidate) => candidate.fullName === "koyawel27/portfolio-keep");
    expect(entry?.tracked).toBe(false);
    expect(entry?.localCopyPath).toBeTruthy();
  });

  it("unknown binding id is a safe 404 with domain error code", async () => {
    const res = await request(app).delete("/api/github/tracked/999999");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("GITHUB_REPO_NOT_FOUND");
    // App remains healthy.
    expect((await request(app).get("/api/health")).status).toBe(200);
  });

  it("repeat untrack is deterministic (stable refusal, then confirmed delete)", async () => {
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/once-only" });
    const ghId = track.body.githubRepositoryId as number;

    // Initial refresh on track stored history -> meaningful state -> guard.
    const first = await request(app).delete(`/api/github/tracked/${ghId}`);
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe("PROJECT_HAS_NO_SOURCES");

    // Retrying without confirmation yields the SAME stable domain answer.
    const second = await request(app).delete(`/api/github/tracked/${ghId}`);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("PROJECT_HAS_NO_SOURCES");

    // Confirmed removal proceeds once; further calls are stable 404s.
    const confirmed = await request(app).delete(
      `/api/github/tracked/${ghId}?confirmDeleteProject=true`,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.projectDeleted).toBe(true);

    const third = await request(app).delete(`/api/github/tracked/${ghId}`);
    expect(third.status).toBe(404);
    expect(third.body.error.code).toBe("GITHUB_REPO_NOT_FOUND");

    // No duplicate projects or ghost rows resulted from any of the calls.
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM github_repositories WHERE full_name LIKE '%once-only%'")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("meaningful GITHUB ONLY project is never silently deleted without confirm", async () => {
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/enrollment-like" });
    const projectId = track.body.projectId as number;
    const refresh = await request(app).post(
      `/api/github/tracked/${track.body.githubRepositoryId}/refresh`,
    );
    expect(refresh.body.ok).toBe(true); // fetches commit history -> meaningful state
    await request(app)
      .patch(`/api/projects/${projectId}/metadata`)
      .send({ includeInPortfolio: true });

    const refused = await request(app).delete(
      `/api/github/tracked/${track.body.githubRepositoryId}`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("PROJECT_HAS_NO_SOURCES");

    // Project fully intact after the refusal.
    const detail = await request(app).get(`/api/projects/${projectId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.project.sourceState).toBe("GITHUB ONLY");
    expect(detail.body.project.commits.length).toBeGreaterThan(0);

    // Explicit confirmed deletion follows the approved lifecycle.
    const confirmed = await request(app).delete(
      `/api/github/tracked/${track.body.githubRepositoryId}?confirmDeleteProject=true`,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.projectDeleted).toBe(true);
    expect((await request(app).get(`/api/projects/${projectId}`)).status).toBe(404);
  });
});
