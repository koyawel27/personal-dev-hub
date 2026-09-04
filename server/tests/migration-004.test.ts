import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDb,
  getDb,
  openDatabase,
} from "../src/db/client.js";
import { createLegacyDb } from "./helpers.js";

/**
 * Migration 004_projects_core: foundational Project entity.
 *
 * Contract under test:
 * - deterministic 1:1 backfill from local_repositories
 * - project-owned metadata migrates byte-for-byte without loss
 * - every local binding gains a project_id; no UNCONDITIONAL uniqueness
 *   constraint on it (V1.2 M1 later adds a partial is_primary-only index)
 * - snapshots / remotes / commits are untouched
 * - post-conditions gate the commit (row counts, mapping completeness, FK)
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
  // Handles opened directly via openDatabase() bypass the module singleton;
  // close them explicitly so Windows releases the file locks for cleanup.
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
      // Windows may briefly hold temp-file locks; cleanup is best-effort
      // and never a test failure.
    }
  }
});

beforeEach(() => {
  closeDb();
});

describe("migration 004_projects_core", () => {
  it("creates one project per local repository with metadata preserved", () => {
    const db = openLegacy();

    const projects = db.prepare("SELECT * FROM projects ORDER BY id").all() as Array<{
      id: number;
      name: string;
      project_status: string | null;
      project_type: string | null;
      project_note: string | null;
      include_in_portfolio: number;
      portfolio_order: number | null;
      created_at: string;
      updated_at: string;
    }>;
    expect(projects).toHaveLength(2);

    const [alpha, beta] = projects;
    expect(alpha.name).toBe("alpha");
    expect(alpha.project_status).toBe("Active");
    expect(alpha.project_type).toBe("Personal");
    expect(alpha.project_note).toBe("core app");
    expect(alpha.include_in_portfolio).toBe(1);
    expect(alpha.portfolio_order).toBe(1);

    expect(beta.name).toBe("beta");
    expect(beta.project_status).toBeNull();
    expect(beta.project_note).toBeNull();

    // updated_at is initialized to the original creation timestamp.
    expect(alpha.updated_at).toBe(alpha.created_at);
  });

  it("links every local binding to its project and adds no uniqueness constraint", () => {
    const db = openLegacy();

    const bindings = db
      .prepare(
        "SELECT canonical_path, project_id FROM local_repositories ORDER BY id",
      )
      .all() as Array<{ canonical_path: string; project_id: number }>;
    for (const binding of bindings) {
      expect(binding.project_id).not.toBeNull();
    }

    // Mapping must be order-preserving: first repo -> first project.
    expect(bindings[0].project_id).toBeLessThan(bindings[1].project_id);

    // No UNIQUE index may constrain local_repositories.project_id
    // UNCONDITIONALLY (multiple local copies per project must remain
    // structurally possible). V1.2 M1 sanctions exactly one exception: the
    // PARTIAL display-primary index scoped to is_primary = 1, which still
    // allows any number of non-primary bindings per project.
    const indexes = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'local_repositories'`,
      )
      .all() as Array<{ name: string; sql: string | null }>;
    for (const index of indexes) {
      if (!index.sql || !index.sql.toUpperCase().includes("UNIQUE")) continue;
      if (!index.sql.toUpperCase().includes("PROJECT_ID")) continue;
      // Only the M1 partial display-primary index may reference project_id,
      // and it must stay partial (is_primary = 1 rows only).
      expect(index.name).toBe("idx_local_repo_project_primary");
      expect(index.sql.toUpperCase()).toContain("WHERE");
      expect(index.sql.toUpperCase()).toContain("IS_PRIMARY = 1");
    }

    // The column itself must exist and reference projects.
    const columns = db.prepare("PRAGMA table_info(local_repositories)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((c) => c.name)).toContain("project_id");
  });

  it("preserves snapshots, remotes, and commits untouched", () => {
    const db = openLegacy();

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM repository_snapshots").get() as { n: number }).n,
    ).toBe(2);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM git_remotes").get() as { n: number }).n,
    ).toBe(2);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM commits").get() as { n: number }).n,
    ).toBe(2);
    expect(
      (
        db
          .prepare(
            "SELECT subject FROM commits WHERE commit_sha = 'sha_alpha_1'",
          )
          .get() as { subject: string }
      ).subject,
    ).toBe("alpha initial");
  });

  it("records itself in schema_migrations exactly once and is idempotent on reopen", () => {
    let db = openLegacy();
    const applied = db
      .prepare(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '004_projects_core'",
      )
      .get() as { n: number };
    expect(applied.n).toBe(1);

    // Reopen the same database through the normal path: no duplicate work.
    const path = (
      db.prepare("PRAGMA database_list").all() as Array<{
        file: string;
      }>
    )[0].file;
    closeDb();
    db = openDatabase(path) as ReturnType<typeof openDatabase>;
    const again = db
      .prepare(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '004_projects_core'",
      )
      .get() as { n: number };
    expect(again.n).toBe(1);
  });
});
