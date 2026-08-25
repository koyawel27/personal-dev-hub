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
 * Regression coverage: overlapping LOCAL + GitHub commit observations
 * collapse into ONE Activity row per Project + SHA (canonical identity),
 * while genuine non-commit events remain distinct.
 *
 * Fixture mirrors the real owner scenario: bpc-learnshare-like project,
 * same SHA observed once locally and once via a tracked GitHub refresh.
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

/** Real HEAD SHA of the local fixture; the gh stub echoes it back. */
let SHARED_SHA = "";

function ghStub(commits: Array<{ sha: string; message: string; date?: string }>): GhExecutor {
  return async (args) => {
    const argv = args.join(" ");
    if (/^api repos\/[^/]+\/[^/]+$/.test(argv)) {
      return {
        stdout: JSON.stringify({
          owner: { login: "koyawel27" },
          name: "bpc-learnshare",
          full_name: "koyawel27/bpc-learnshare",
          visibility: "public",
          default_branch: "main",
          html_url: "https://github.com/koyawel27/bpc-learnshare",
          pushed_at: "2026-08-21T00:00:00Z",
        }),
        stderr: "",
        code: 0,
      };
    }
    if (/^api repos\/.+\/commits/.test(argv)) {
      return {
        stdout: JSON.stringify(
          commits.map((commit) => ({
            sha: commit.sha,
            commit: {
              message: commit.message,
              author: { name: "Jezer Macaslang", date: commit.date ?? "2026-08-14T09:42:40Z" },
            },
          })),
        ),
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

type Row = {
  eventType: string;
  source: string;
  summary: string;
  occurredAt: string;
  sha?: string;
  projectId?: number;
};

async function activity(query = ""): Promise<Row[]> {
  const res = await request(app).get(`/api/activity${query}`);
  expect(res.status).toBe(200);
  return res.body.activity as Row[];
}

describe("activity commit dedup", () => {
  async function seedOverlappingProject(): Promise<number> {
    // Local clone with a real commit whose SHA the gh stub echoes back as
    // the GitHub observation — the exact bpc-learnshare overlap shape.
    setGhExecutorForTests(ghStub([]));
    const repoPath = await createGitRepo();
    await gitExec(repoPath, ["remote", "add", "origin", "https://github.com/koyawel27/bpc-learnshare.git"]);
    fs.writeFileSync(path.join(repoPath, "f.txt"), "content\n");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["add", "f.txt"], { cwd: repoPath });
    const run = promisify(execFile);
    await run(
      "git",
      ["commit", "-m", "feat(ai): add guarded local processing pipeline"],
      {
        cwd: repoPath,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-08-14T17:42:40+08:00",
          GIT_COMMITTER_DATE: "2026-08-14T17:42:40+08:00",
        },
      },
    );
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    SHARED_SHA = String(stdout).trim().toLowerCase();

    const created = await request(app).post("/api/repositories/manual").send({ path: repoPath });
    const projectId = created.body.repository.projectId as number;

    // Track + refresh; the stub serves the SAME sha as a github observation.
    setGhExecutorForTests(ghStub([
      { sha: SHARED_SHA, message: "feat(ai): add guarded local processing pipeline" },
    ]));
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/bpc-learnshare" });
    expect(track.body.state).toBe("LOCAL + GITHUB");
    return projectId;
  }

  it("same Project + SHA observed locally and on GitHub appears ONCE with LOCAL + GITHUB", async () => {
    const projectId = await seedOverlappingProject();
    const rows = await activity(`?projectId=${projectId}`);

    // The shared logical commit collapses into exactly ONE row.
    const shared = rows.filter((row) => row.sha === SHARED_SHA);
    expect(shared).toHaveLength(1);
    expect(shared[0].summary).toBe("feat(ai): add guarded local processing pipeline");
    expect(shared[0].source).toBe("LOCAL + GITHUB");
    // Local observation timestamp wins (true Git author date, original zone).
    expect(shared[0].occurredAt).toContain("+08:00");

    // Raw observations preserved in storage (both sides still on disk).
    const stored = (
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM activity_events WHERE project_id = ? AND lower(json_extract(metadata_json,'$.sha')) = ?",
        )
        .get(projectId, SHARED_SHA) as { n: number }
    ).n;
    expect(stored).toBe(2);
  });

  it("local-only and github-only commits each appear once with their own source", async () => {
    // Local side: one commit that GitHub will NOT report.
    setGhExecutorForTests(ghStub([]));
    const repoPath = await createGitRepo();
    const created = await request(app).post("/api/repositories/manual").send({ path: repoPath });
    const localProjectId = created.body.repository.projectId as number;

    // GitHub-only side: tracked project whose commits were never scanned locally.
    setGhExecutorForTests(ghStub([
      { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", message: "github only work" },
    ]));
    const ghTrack = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/solo-gh" });

    const localRows = await activity(`?projectId=${localProjectId}`);
    const localCommit = localRows.find((row) => row.eventType === "commit_observed");
    expect(localCommit?.source ?? "LOCAL").toBe("LOCAL");

    const ghRows = await activity(`?projectId=${ghTrack.body.projectId}`);
    const ghCommit = ghRows.find((row) => row.eventType === "github_commit_observed");
    expect(ghCommit).toBeDefined();
    expect(ghCommit!.source).toBe("GITHUB");
  });

  it("same subject with different SHAs remains two commits", async () => {
    const repoPath = await createGitRepo();
    fs.writeFileSync(path.join(repoPath, "a.txt"), "1\n");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("git", ["add", "a.txt"], { cwd: repoPath });
    await run("git", ["commit", "-m", "twin subject"], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, "b.txt"), "2\n");
    await run("git", ["add", "b.txt"], { cwd: repoPath });
    await run("git", ["commit", "--allow-empty", "-m", "twin subject"], { cwd: repoPath });

    const created = await request(app).post("/api/repositories/manual").send({ path: repoPath });
    const projectId = created.body.repository.projectId as number;

    const rows = await activity(`?projectId=${projectId}`);
    const twins = rows.filter((row) => row.summary === "twin subject");
    expect(twins.length).toBeGreaterThanOrEqual(2);
    expect(new Set(twins.map((row) => row.occurredAt)).size).toBeGreaterThan(0);
  });

  it("same SHA under different projects stays separate", async () => {
    // Two local repos sharing one identical commit (same tree/message/author
    // -> same SHA), registered as separate projects.
    const make = async (dirName: string): Promise<string> => {
      const dir = path.dirname(useTempDb()) + "/" + dirName;
      fs.mkdirSync(dir, { recursive: true });
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      await run("git", ["init", "-b", "main"], { cwd: dir });
      await run("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
      await run("git", ["config", "user.name", "Dev"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "same.txt"), "identical\n");
      await run("git", ["add", "same.txt"], { cwd: dir });
      await run("git", ["commit", "-m", "identical twin"], { cwd: dir });
      return dir;
    };
    const a = await make("twina");
    const b = await make("twinb");
    await request(app).post("/api/repositories/manual").send({ path: a });
    await request(app).post("/api/repositories/manual").send({ path: b });

    const rows = await activity();
    const twins = rows.filter((row) => row.summary === "identical twin" && row.eventType === "commit_observed");
    expect(twins.length).toBe(2); // different projects -> both remain
    expect(new Set(twins.map((row) => row.projectId)).size).toBe(2);
  });

  it("non-commit events are never collapsed by commit dedup", async () => {
    const projectId = await seedOverlappingProject();
    // Track/untrack cycles emit distinct lifecycle rows; they must survive.
    const rows = await activity(`?projectId=${projectId}`);
    const lifecycle = rows.filter((row) =>
      ["repository_discovered", "github_repo_tracked"].includes(row.eventType),
    );
    expect(lifecycle.length).toBeGreaterThanOrEqual(2);
    for (const row of lifecycle) {
      expect(row.eventType).not.toContain("commit");
    }
  });

  it("project filter and date filtering still apply to the deduplicated feed", async () => {
    const projectId = await seedOverlappingProject();
    const filtered = await activity(`?projectId=${projectId}`);
    expect(filtered.every((row) => row.projectId === projectId)).toBe(true);

    const ranged = await activity("?from=2099-01-01T00:00:00Z&to=2099-12-31T00:00:00Z");
    expect(ranged).toEqual([]);
  });

  it("refreshing GitHub again does not multiply activity rows for known SHAs", async () => {
    const projectId = await seedOverlappingProject();
    const before = await activity(`?projectId=${projectId}`);
    const commitsBefore = before.filter((row) => row.eventType.includes("commit_observed")).length;

    // Re-refresh the binding: same SHAs come back; noise rule already keeps
    // storage stable, and read-time dedup keeps the view stable either way.
    const picker = await request(app).get("/api/github/repositories");
    const entry = (
      picker.body.entries as Array<{ fullName: string; trackedBindingId: number | null }>
    ).find((candidate) => candidate.fullName === "koyawel27/bpc-learnshare");
    await request(app).post(`/api/github/tracked/${entry!.trackedBindingId}/refresh`);

    const after = await activity(`?projectId=${projectId}`);
    const commitsAfter = after.filter((row) => row.eventType.includes("commit_observed")).length;
    expect(commitsAfter).toBe(commitsBefore);
  });

  it("historical duplicate observations in an existing database collapse on read", async () => {
    // Simulate pre-fix history directly: two raw rows, same project + SHA.
    const db = getDb();
    db.prepare(
      "INSERT INTO projects (name, created_at, updated_at) VALUES ('historic-project', ?, ?)",
    ).run(new Date().toISOString(), new Date().toISOString());
    const projectId = Number(
      (db.prepare("SELECT id FROM projects ORDER BY id DESC LIMIT 1").get() as { id: number }).id,
    );
    db.prepare(
      `INSERT INTO activity_events
        (project_id, local_repository_id, event_type, summary, occurred_at, source, fingerprint, metadata_json)
       VALUES (?, NULL, 'commit_observed', 'historic overlap', '2026-05-01T10:00:00+08:00', 'scan', ?, '{"sha":"aaa1111111111111111111111111111111111111"}')`,
    ).run(projectId, "p424242:hist:commit:aaa1111111111111111111111111111111111111");
    db.prepare(
      `INSERT INTO activity_events
        (project_id, local_repository_id, event_type, summary, occurred_at, source, fingerprint, metadata_json)
       VALUES (?, NULL, 'github_commit_observed', 'historic overlap', '2026-05-02T02:00:00Z', 'user', ?, '{"sha":"aaa1111111111111111111111111111111111111"}')`,
    ).run(projectId, "p424242:hist:github_commit:aaa1111111111111111111111111111111111111");

    const rows = await activity(`?projectId=${projectId}`);
    const commits = rows.filter((row) => row.eventType.includes("commit_observed"));
    expect(commits).toHaveLength(1);
    expect(commits[0].source).toBe("LOCAL + GITHUB");
    // Local observation timestamp wins even for historical rows.
    expect(commits[0].occurredAt).toBe("2026-05-01T10:00:00+08:00");
  });

  it("repo tracked/untracked lifecycle rows stay visible alongside deduped commits", async () => {
    const projectId = await seedOverlappingProject();
    // Untrack then re-track through the approved lifecycle to generate rows.
    const picker = await request(app).get("/api/github/repositories");
    const entry = (
      picker.body.entries as Array<{ fullName: string; trackedBindingId: number | null }>
    ).find((candidate) => candidate.fullName === "koyawel27/bpc-learnshare");
    await request(app).delete(`/api/github/tracked/${entry!.trackedBindingId}`);

    const rows = await activity(`?projectId=${projectId}`);
    expect(rows.some((row) => row.eventType === "github_repo_untracked")).toBe(true);
    // The deduped shared commit row is still exactly one.
    expect(rows.filter((row) => row.sha === SHARED_SHA)).toHaveLength(1);
  });
});
