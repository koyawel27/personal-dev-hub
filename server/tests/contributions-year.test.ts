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
import { createGitRepo, gitExec, makeTempDir, useTempDb } from "./helpers.js";

/**
 * Regression coverage for the year activity view (owner Contributions pass):
 * per-source annual aggregation, honest dedup transparency (overlap derived
 * from identity+SHA), compact totals, year selection, day detail with
 * dual-observation labels, and Dashboard-preview compatibility.
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

/**
 * The overlapping commit's real SHA. The gh stub reads this at request time
 * so the local fixture commit and the "GitHub" observation genuinely share
 * an identity (the approved dedup key), like bpc-learnshare does.
 */
let overlapSha = "";

function makeGhStub(): GhExecutor {
  return async (args) => {
    const argv = args.join(" ");
    if (/^api repos\/[^/]+\/[^/]+$/.test(argv)) {
      return {
        stdout: JSON.stringify({
          owner: { login: "koyawel27" },
          name: "year-repo",
          full_name: "koyawel27/year-repo",
          visibility: "public",
          default_branch: "main",
          html_url: "https://github.com/koyawel27/year-repo",
          pushed_at: "2026-06-10T00:00:00Z",
        }),
        stderr: "",
        code: 0,
      };
    }
    if (/^api repos\/.+\/commits/.test(argv)) {
      return {
        stdout: JSON.stringify([
          // Overlapping commit: SAME real SHA as the local fixture.
          {
            sha: overlapSha,
            commit: {
              message: "shared history commit",
              author: { name: "Dev", date: "2026-03-15T09:00:00Z" },
            },
          },
          {
            sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            commit: {
              message: "github-only commit",
              author: { name: "Dev", date: "2026-04-02T09:00:00Z" },
            },
          },
        ]),
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "", stderr: `unexpected: ${argv}`, code: 127 };
  };
}

beforeEach(() => {
  cleanup.push(path.dirname(useTempDb()));
  getDb();
  app = createApp();
  setGhExecutorForTests(makeGhStub());
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

/** Local repo whose HEAD is a real commit; its SHA becomes the gh overlap. */
async function createOverlappingLocalRepo(): Promise<string> {
  const dir = makeTempDir("ldd-overlap-");
  await gitExec(dir, ["init", "-b", "main"]);
  await gitExec(dir, ["config", "user.email", "dev@example.com"]);
  await gitExec(dir, ["config", "user.name", "Dev"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "x\n");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  await run("git", ["add", "f.txt"], { cwd: dir });
  await run(
    "git",
    ["commit", "-m", "shared history commit"],
    {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-03-15T09:00:00Z",
        GIT_COMMITTER_DATE: "2026-03-15T09:00:00Z",
      },
    },
  );
  // Capture the real HEAD SHA so the gh stub can serve the same identity.
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: dir });
  overlapSha = String(stdout).trim();
  // Remote identity lets the tracking engine link this clone to the
  // GitHub repository (same rule as the real bpc-learnshare scenario).
  await gitExec(dir, ["remote", "add", "origin", "https://github.com/koyawel27/year-repo.git"]);
  return dir;
}

type YearResponse = {
  year: number;
  source: string;
  days: { date: string; total: number; localCount: number; githubCount: number }[];
  totals: { commits: number; activeDays: number; projects: number };
  dedup?: {
    localObserved: number;
    githubObserved: number;
    overlap: number;
    combinedUnique: number;
  };
};

describe("contributions year activity view", () => {
  async function seedLinkedProject(): Promise<void> {
    const repoPath = await createOverlappingLocalRepo();
    await request(app).post("/api/repositories/manual").send({ path: repoPath });
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/year-repo" });
    expect(track.body.state).toBe("LOCAL + GITHUB");
    const refresh = await request(app).post(
      `/api/github/tracked/${track.body.githubRepositoryId}/refresh`,
    );
    expect(refresh.body.ok).toBe(true);
  }

  it("aggregates each source independently for the year", async () => {
    await seedLinkedProject();

    const localView = (
      await request(app).get("/api/contributions/year?y=2026&view=local")
    ).body as YearResponse;
    expect(localView.source).toBe("local");
    expect(localView.totals.commits).toBe(1); // only the shared SHA observed locally

    const githubView = (
      await request(app).get("/api/contributions/year?y=2026&view=github")
    ).body as YearResponse;
    expect(githubView.totals.commits).toBe(2); // github lens counts independently

    expect(localView.days.every((day) => day.total === day.localCount)).toBe(true);
    expect(githubView.days.every((day) => day.total === day.githubCount)).toBe(true);
  });

  it("combined union collapses the overlap and reports transparent dedup", async () => {
    await seedLinkedProject();
    const combined = (
      await request(app).get("/api/contributions/year?y=2026&view=combined")
    ).body as YearResponse;

    // 1 local + 2 github - 1 overlap = 2 unique.
    expect(combined.totals.commits).toBe(2);
    expect(combined.dedup).toBeDefined();
    expect(combined.dedup!.localObserved).toBe(1);
    expect(combined.dedup!.githubObserved).toBe(2);
    expect(combined.dedup!.overlap).toBe(1);
    expect(combined.dedup!.combinedUnique).toBe(2);
    // Union invariant: combined != naive sum.
    expect(combined.dedup!.combinedUnique).not.toBe(
      combined.dedup!.localObserved + combined.dedup!.githubObserved,
    );
    // Day totals are unions, never sums.
    for (const day of combined.days) {
      expect(day.total).toBeLessThanOrEqual(day.localCount + day.githubCount);
    }
  });

  it("reports active days and contributing projects", async () => {
    await seedLinkedProject();
    const combined = (
      await request(app).get("/api/contributions/year?y=2026&view=combined")
    ).body as YearResponse;
    expect(combined.totals.activeDays).toBe(2); // Mar 15 + Apr 2
    expect(combined.totals.projects).toBe(1); // one linked project contributed
  });

  it("respects year boundaries and lists years newest-first", async () => {
    await seedLinkedProject();

    const empty = (
      await request(app).get("/api/contributions/year?y=2019&view=combined")
    ).body as YearResponse;
    expect(empty.days).toEqual([]);
    expect(empty.totals.commits).toBe(0);

    const years = (await request(app).get("/api/contributions/years")).body
      .years as number[];
    expect(years).toContain(2026);
    for (let i = 1; i < years.length; i += 1) {
      expect(years[i - 1]).toBeGreaterThan(years[i]);
    }
  });

  it("returns zero-activity year data without fabricating numbers", async () => {
    const res = await request(app).get("/api/contributions/year?y=1999&view=github");
    expect(res.status).toBe(200);
    const body = res.body as YearResponse;
    expect(body.totals).toEqual({ commits: 0, activeDays: 0, projects: 0 });
  });

  it("day detail shows each unique commit once with source treatment", async () => {
    await seedLinkedProject();

    const combinedDay = (
      await request(app).get("/api/contributions/2026-03-15?view=combined")
    ).body;
    expect(combinedDay.totalCommits).toBe(1); // overlap collapsed in day detail
    const project = combinedDay.projects[0];
    expect(project.commits).toHaveLength(1);
    expect(project.source).toBe("LOCAL + GITHUB");
    expect(project.commits[0].source).toBe("LOCAL + GITHUB");
    expect(project.commits[0].committedAt).toContain("2026-03-15");

    const githubOnlyDay = (
      await request(app).get("/api/contributions/2026-04-02?view=combined")
    ).body;
    expect(githubOnlyDay.projects[0].commits[0].source).toBe("github");

    const localLens = (
      await request(app).get("/api/contributions/2026-04-02?view=local")
    ).body;
    expect(localLens.totalCommits).toBe(0); // commit exists only on GitHub side
  });

  it("rejects malformed years", async () => {
    const res = await request(app).get("/api/contributions/year?y=abcd");
    expect(res.status).toBe(400);
  });

  it("keeps the legacy range endpoint working for the dashboard preview", async () => {
    await seedLinkedProject();
    const legacy = await request(app).get("/api/contributions");
    expect(legacy.status).toBe(200);
    expect((legacy.body.days as unknown[]).length).toBeGreaterThan(0);
    const dashboard = await request(app).get("/api/dashboard");
    expect(dashboard.status).toBe(200);
  });

  it("buckets by commit date, not observation time", async () => {
    await seedLinkedProject();
    const combined = (
      await request(app).get("/api/contributions/year?y=2026&view=combined")
    ).body as YearResponse;
    const dates = combined.days.map((day) => day.date);
    expect(dates).toContain("2026-03-15"); // real commit date…
    expect(dates).not.toContain(new Date().toISOString().slice(0, 10)); // …not today
  });
});
