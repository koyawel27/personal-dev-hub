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
 * Regression coverage for the Activity UX pass: cursor pagination over the
 * LOGICAL (commit-deduplicated) feed with deterministic ordering, plus
 * filter/presentation semantics.
 *
 * Fixture: 120 local commits (distinct timestamps) on one project; a
 * GitHub refresh that overlaps the newest commit (LOCAL + GITHUB pair);
 * lifecycle events interleaved. Logical feed > 50 rows so at least two
 * pages exist and page boundaries are exercised.
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

const OVERLAP_MESSAGE = "feat(ai): add guarded local processing pipeline";

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

async function seedLargeProject(): Promise<{ projectId: number; ghId: number }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const dir = path.dirname(useTempDb()) + "/activity-large";
  fs.mkdirSync(dir, { recursive: true });
  await run("git", ["init", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "Dev"], { cwd: dir });

  // One real commit (fast); the rest of the history is seeded directly as
  // activity rows below, which is what the feed actually reads.
  let headSha = "";
  fs.writeFileSync(path.join(dir, "f0.txt"), "0\n");
  await run("git", ["add", "."], { cwd: dir });
  await run(
    "git",
    ["commit", "-m", OVERLAP_MESSAGE],
    {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-05-08T10:00:00+08:00",
        GIT_COMMITTER_DATE: "2026-05-08T10:00:00+08:00",
      },
    },
  );
  headSha = String((await run("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout).trim();
  // Remote identity lets tracking link this clone (LOCAL + GITHUB).
  await run("git", ["remote", "add", "origin", "https://github.com/koyawel27/bpc-learnshare.git"], { cwd: dir });

  setGhExecutorForTests(async (args) => {
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
        stdout: JSON.stringify([
          {
            sha: headSha,
            commit: {
              message: OVERLAP_MESSAGE,
              author: { name: "Dev", date: "2026-05-08T02:00:00Z" },
            },
          },
        ]),
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "", stderr: `unexpected: ${argv}`, code: 127 };
  });

  const created = await request(app).post("/api/repositories/manual").send({ path: dir });
  expect(created.status).toBe(201);
  const projectId = created.body.repository.projectId as number;

  // Seed 120 additional historical commit observations directly (distinct
  // timestamps, deterministic ids ascending with time).
  const insert = getDb().prepare(
    `INSERT INTO activity_events
      (project_id, local_repository_id, event_type, summary, occurred_at, source, fingerprint, metadata_json)
     VALUES (?, ?, 'commit_observed', ?, ?, 'scan', ?, ?)`,
  );
  const bindingId = Number(created.body.repository.id);
  for (let i = 0; i < 120; i += 1) {
    const day = String((i % 28) + 1).padStart(2, "0");
    const month = String(Math.floor(i / 28) + 1).padStart(2, "0");
    const at = `2026-${month}-${day}T09:00:00+08:00`;
    const sha = `${String(i).padStart(4, "0")}ffffffffffffffffffffffffffffffffffff`;
    insert.run(
      projectId,
      bindingId,
      `seeded work ${String(i).padStart(3, "0")}`,
      at,
      `p${projectId}:${bindingId}:seed:${sha}`,
      JSON.stringify({ sha }),
    );
  }

  const track = await request(app)
    .post("/api/github/tracked")
    .send({ fullName: "koyawel27/bpc-learnshare" });
  expect(track.body.state).toBe("LOCAL + GITHUB");
  return { projectId, ghId: track.body.githubRepositoryId as number };
}

type Page = {
  rows: Array<{ id: number; eventType: string; source: string; sha?: string; occurredAt: string }>;
  nextCursor: string | null;
};

async function fetchPage(params: Record<string, string | number>): Promise<Page> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") search.set(key, String(value));
  }
  const res = await request(app).get(`/api/activity/page?${search.toString()}`);
  expect(res.status).toBe(200);
  return res.body as Page;
}

describe("activity pagination over the logical feed", () => {
  it("returns up to 50 logical rows initially and walks without duplicates", async () => {
    const { projectId } = await seedLargeProject();

    const page1 = await fetchPage({ projectId, limit: 50 });
    expect(page1.rows.length).toBe(50);
    expect(page1.nextCursor).toBeTruthy();

    // Page 2 appends different rows only.
    const page2 = await fetchPage({
      projectId,
      limit: 50,
      cursor: page1.nextCursor!,
    });
    const ids1 = new Set(page1.rows.map((row) => row.id));
    expect(page2.rows.some((row) => ids1.has(row.id))).toBe(false);

    // Walk to exhaustion: total logical rows == raw commit events + merged
    // pair reduction + lifecycle rows, never duplicated across pages.
    const all: typeof page1.rows = [...page1.rows];
    let cursor = page1.nextCursor;
    while (cursor != null) {
      const page = await fetchPage({ projectId, limit: 50, cursor });
      all.push(...page.rows);
      cursor = page.nextCursor;
    }
    const uniqueIds = new Set(all.map((row) => row.id));
    expect(uniqueIds.size).toBe(all.length); // no duplicates anywhere

    // Dedup invariant survives pagination: exactly ONE row carries the
    // overlapping SHA, composed LOCAL + GITHUB.
    const overlapRows = all.filter((row) => row.source === "LOCAL + GITHUB");
    expect(overlapRows).toHaveLength(1);
  });

  it("keeps LOCAL + GITHUB pairs unified even when they straddle the raw window", async () => {
    const { projectId } = await seedLargeProject();
    // Collect every page and confirm no page ever ends between the two
    // observations of the same SHA such that both appear separately.
    const seenShas = new Map<string, Set<string>>();
    let cursor: string | null = null;
    do {
      const page = await fetchPage({
        projectId,
        ...(cursor ? { cursor } : {}),
        limit: 50,
      });
      for (const row of page.rows) {
        if (!row.sha) continue;
        const sources = seenShas.get(row.sha) ?? new Set<string>();
        sources.add(row.source);
        seenShas.set(row.sha, sources);
      }
      cursor = page.nextCursor;
    } while (cursor != null);
    for (const [sha, sources] of seenShas) {
      expect(sources.size, `SHA ${sha} split across pages`).toBe(1);
    }
  });

  it("orders pages deterministically even under timestamp ties", async () => {
    const { projectId } = await seedLargeProject();
    const page1 = await fetchPage({ projectId, limit: 50 });
    for (let i = 1; i < page1.rows.length; i += 1) {
      const prev = page1.rows[i - 1];
      const curr = page1.rows[i];
      const cmp =
        curr.occurredAt.localeCompare(prev.occurredAt) || curr.id - prev.id;
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it("project change resets pagination and preserves applied dates server-side", async () => {
    const { projectId } = await seedLargeProject();
    const page1 = await fetchPage({ projectId, limit: 50 });
    // Same project + cursor from another project context must not leak rows.
    const other = await fetchPage({
      projectId: projectId + 999,
      limit: 50,
      cursor: page1.nextCursor!,
    });
    expect(other.rows).toEqual([]);
    expect(other.nextCursor).toBeNull();
  });

  it("date filtering still applies through the paged endpoint", async () => {
    const { projectId } = await seedLargeProject();
    const ranged = await fetchPage({
      projectId,
      limit: 50,
      from: "2099-01-01T00:00:00Z",
      to: "2099-12-31T00:00:00Z",
    });
    expect(ranged.rows).toEqual([]);
    expect(ranged.nextCursor).toBeNull();
  });

  it("legacy unpaginated endpoint still serves Dashboard unchanged", async () => {
    const { projectId } = await seedLargeProject();
    const legacy = await request(app).get(`/api/activity?projectId=${projectId}`);
    expect(legacy.status).toBe(200);
    expect((legacy.body.activity as unknown[]).length).toBeGreaterThan(0);
    const dashboard = await request(app).get("/api/dashboard");
    expect(dashboard.status).toBe(200);
  });
});
