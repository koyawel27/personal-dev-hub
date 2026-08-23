import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, openDatabase } from "../src/db/client.js";
import { createLegacyDb } from "./helpers.js";

/**
 * Migration 005_github_bindings: promote the github_repositories cache into
 * first-class project bindings.
 *
 * Contract under test:
 * - existing enrichment cache rows preserved verbatim (no data loss)
 * - picker metadata columns added (tracked_at, archived, fork, description, language)
 * - owner/name normalized columns backfilled deterministically (lowercase)
 * - UNIQUE(owner_norm, name_norm) — case-variant duplicates must fail loudly
 * - partial UNIQUE(project_id) — at most one GitHub binding per project
 * - github_commits storage created
 */

const cleanupDirs: string[] = [];
const openHandles: Array<{ close: () => void }> = [];

function openLegacy(): ReturnType<typeof openDatabase> {
  const legacyPath = createLegacyDb();
  cleanupDirs.push(path.dirname(legacyPath));
  const handle = openDatabase(legacyPath) as ReturnType<typeof openDatabase>;
  openHandles.push(handle as unknown as { close: () => void });
  return handle;
}

afterAll(() => {
  for (const handle of openHandles.splice(0)) {
    try {
      handle.close();
    } catch {
      // already closed
    }
  }
  closeDb();
  for (const dir of cleanupDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort on Windows lock timing
    }
  }
});

describe("migration 005_github_bindings", () => {
  it("preserves existing enrichment rows and adds picker metadata columns", () => {
    const db = openLegacy();

    const row = db
      .prepare(
        `SELECT owner, name, full_name, visibility, default_branch, html_url,
                last_pushed_at, last_refreshed_at, project_id, tracked_at,
                archived, fork, description, language
         FROM github_repositories WHERE lower(name) = 'alpha'`,
      )
      .get() as {
      owner: string;
      name: string;
      full_name: string;
      visibility: string;
      default_branch: string;
      html_url: string;
      last_pushed_at: string;
      last_refreshed_at: string;
      project_id: number | null;
      tracked_at: string | null;
      archived: number | null;
      fork: number | null;
      description: string | null;
      language: string | null;
    };

    // Pre-existing enrichment data intact.
    expect(row.owner).toBe("OctoCat");
    expect(row.full_name).toBe("OctoCat/alpha");
    expect(row.visibility).toBe("private");
    expect(row.last_refreshed_at).toBe("2026-08-20T10:00:00.000Z");

    // New binding columns exist and start untracked/null.
    expect(row.project_id).toBeNull();
    expect(row.tracked_at).toBeNull();
    expect(row.archived).toBeNull();
    expect(row.fork).toBeNull();
    expect(row.description).toBeNull();
    expect(row.language).toBeNull();
  });

  it("backfills normalized identity columns in lowercase and enforces uniqueness", () => {
    const db = openLegacy();

    const norm = db
      .prepare(
        "SELECT owner_norm, name_norm FROM github_repositories WHERE lower(name) = 'alpha'",
      )
      .get() as { owner_norm: string; name_norm: string };
    expect(norm.owner_norm).toBe("octocat");
    expect(norm.name_norm).toBe("alpha");

    const indexes = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'github_repositories' AND sql IS NOT NULL",
      )
      .all() as Array<{ sql: string }>;
    const uniqueSqls = indexes
      .map((index) => index.sql.toUpperCase())
      .filter((sql) => sql.includes("UNIQUE"));
    expect(uniqueSqls.some((sql) => sql.includes("(OWNER_NORM, NAME_NORM)"))).toBe(true);
    expect(uniqueSqls.some((sql) => sql.includes("PROJECT_ID") && sql.includes("WHERE"))).toBe(true);
  });

  it("creates the github_commits store with dedup constraints", () => {
    const db = openLegacy();
    const table = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'github_commits'",
      )
      .get() as { sql: string };
    const upper = table.sql.toUpperCase();
    expect(upper).toContain("PROJECT_ID");
    expect(upper).toContain("GITHUB_REPOSITORY_ID");
    expect(upper).toContain("UNIQUE");

    // Insert + duplicate SHA on one repo is rejected (dedup at schema level).
    const ghRepo = db
      .prepare("SELECT id FROM github_repositories WHERE lower(name) = 'alpha'")
      .get() as { id: number };
    const project = db.prepare("SELECT id FROM projects LIMIT 1").get() as { id: number };
    db.prepare(
      `INSERT INTO github_commits
         (project_id, github_repository_id, commit_sha, subject, committed_at, fetched_at)
       VALUES (?, ?, 'shaX', 'subject', '2026-08-21T00:00:00Z', '2026-08-22T00:00:00Z')`,
    ).run(project.id, ghRepo.id);
    expect(() =>
      db
        .prepare(
          `INSERT INTO github_commits
             (project_id, github_repository_id, commit_sha, subject, committed_at, fetched_at)
           VALUES (?, ?, 'shaX', 'subject again', '2026-08-21T00:00:00Z', '2026-08-22T00:00:00Z')`,
        )
        .run(project.id, ghRepo.id),
    ).toThrow();
  });

  it("rejects a second GitHub binding for the same project (partial unique)", () => {
    const db = openLegacy();
    const project = db
      .prepare("SELECT id FROM projects ORDER BY id LIMIT 1")
      .get() as { id: number };
    db.prepare(
      `INSERT INTO github_repositories
         (owner, name, full_name, owner_norm, name_norm, project_id, tracked_at)
       VALUES ('someone', 'repo-one', 'someone/repo-one', 'someone', 'repo-one', ?, ?)`,
    ).run(project.id, "2026-08-22T00:00:00Z");
    expect(() =>
      db
        .prepare(
          `INSERT INTO github_repositories
             (owner, name, full_name, owner_norm, name_norm, project_id, tracked_at)
           VALUES ('other', 'repo-two', 'other/repo-two', 'other', 'repo-two', ?, ?)`,
        )
        .run(project.id, "2026-08-22T01:00:00Z"),
    ).toThrow();
  });
});
