import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, openDatabase } from "../src/db/client.js";

/**
 * Migration 008_primary_local_binding (V1.2 M1).
 *
 * Contract under test:
 * - is_primary column added (NOT NULL, DEFAULT 0, CHECK 0/1) for BOTH
 *   V1.1 upgrades (this file) and fresh databases (schema.sql intentionally
 *   stays the old/base shape; 008 owns the change per owner decision D5)
 * - backfill: exactly one is_primary=1 per project that has local bindings,
 *   primary = MIN(id) — reproducing the V1.1 effective-primary rule
 *   byte-for-byte (owner decisions D1/D2)
 * - partial UNIQUE(project_id) WHERE is_primary = 1: at most one explicit
 *   primary per project
 * - CHECK constraint rejects values outside {0,1}
 */

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "db");
const cleanupDirs: string[] = [];
const openHandles: Array<{ close: () => void }> = [];

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

/**
 * Build a realistic PRE-008 database (baseline + 001..007 applied, no
 * is_primary column) with one multi-binding project and one single-binding
 * project. Returns the db path; 008 is left unapplied so openDatabase()
 * below performs the real upgrade, exactly like a live V1.1 -> V1.2 run.
 */
function createPre008Db(): string {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? ".", "ldd-pre008-"));
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "pre008.sqlite");
  process.env.DASHBOARD_DB_PATH = dbPath;
  closeDb();

  const database = new DatabaseSync(dbPath);
  const apply = (name: string): void => {
    database.exec(fs.readFileSync(path.join(here, "migrations", `${name}.sql`), "utf8"));
  };
  database.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  // 001's shape is already inside schema.sql; record it like the real runner.
  apply("002_project_metadata");
  apply("003_app_settings");
  apply("004_projects_core");
  const record = (name: string): void => {
    database
      .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
      .run(name, "2026-08-20T10:00:00.000Z");
  };
  for (const name of ["001_initial", "002_project_metadata", "003_app_settings", "004_projects_core"]) {
    record(name);
  }

  // Seed AFTER 004 so local_repositories already carries project_id.
  const now = "2026-08-20T10:00:00.000Z";
  const seedProject = (name: string): number =>
    Number(
      database
        .prepare("INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)")
        .run(name, now, now).lastInsertRowid,
    );
  const seedBinding = (projectId: number, localPath: string): number =>
    Number(
      database
        .prepare(
          `INSERT INTO local_repositories
             (source_id, project_id, name, local_path, canonical_path, discovery_type, created_at)
           VALUES (NULL, ?, ?, ?, ?, 'manual', ?)`,
        )
        .run(projectId, path.basename(localPath), localPath, localPath.toLowerCase(), now)
        .lastInsertRowid,
    );

  const multi = seedProject("multi-binding-fixture");
  seedBinding(multi, "C:\\proj\\multi-first");
  seedBinding(multi, "C:\\proj\\multi-second");
  seedBinding(multi, "C:\\proj\\multi-third");
  const solo = seedProject("solo-binding-fixture");
  seedBinding(solo, "C:\\proj\\solo-only");

  apply("005_github_bindings");
  apply("006_project_activity");
  apply("007_repair_zero_binding_ghosts");
  for (const name of [
    "005_github_bindings",
    "006_project_activity",
    "007_repair_zero_binding_ghosts",
  ]) {
    record(name);
  }
  database.close();
  return dbPath;
}

function bindingIds(db: ReturnType<typeof openDatabase>, name: string): number[] {
  return (
    db
      .prepare("SELECT id FROM local_repositories WHERE local_path LIKE ? ORDER BY id ASC")
      .all(`C:\\proj\\${name}%`) as Array<{ id: number }>
  ).map((row) => row.id);
}

describe("migration 008_primary_local_binding", () => {
  it("adds is_primary and backfills exactly one MIN(id) primary per project", () => {
    const db = openDatabase(createPre008Db()) as ReturnType<typeof openDatabase>;
    openHandles.push(db as unknown as { close: () => void });

    const columns = db.prepare("PRAGMA table_info(local_repositories)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const primaryColumn = columns.find((column) => column.name === "is_primary");
    expect(primaryColumn).toBeTruthy();
    expect(primaryColumn!.notnull).toBe(1);

    const [first, second, third] = bindingIds(db, "multi");
    const [solo] = bindingIds(db, "solo");
    const flags = db
      .prepare("SELECT id, is_primary FROM local_repositories ORDER BY id ASC")
      .all() as Array<{ id: number; is_primary: number }>;

    // Multi-binding project: exactly MIN(id) is primary (V1.1 rule, D1/D2).
    expect(flags.find((row) => row.id === first)!.is_primary).toBe(1);
    expect(flags.find((row) => row.id === second)!.is_primary).toBe(0);
    expect(flags.find((row) => row.id === third)!.is_primary).toBe(0);
    // Single-binding project: its only binding is primary.
    expect(flags.find((row) => row.id === solo)!.is_primary).toBe(1);

    // Exactly one primary per project that has bindings.
    const violations = db
      .prepare(
        `SELECT project_id, COUNT(*) AS n FROM local_repositories
         WHERE project_id IS NOT NULL
         GROUP BY project_id HAVING SUM(is_primary) <> 1`,
      )
      .all() as unknown[];
    expect(violations).toHaveLength(0);

    // Post-upgrade database must be structurally sound: no FK violations,
    // integrity check reports "ok" (node:sqlite exposes PRAGMA through
    // prepared statements, not a .pragma() helper).
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check,
    ).toBe("ok");
  });

  it("enforces the partial unique index and the 0/1 CHECK constraint", () => {
    const db = openDatabase(createPre008Db()) as ReturnType<typeof openDatabase>;
    openHandles.push(db as unknown as { close: () => void });

    const index = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_local_repo_project_primary'",
      )
      .get() as { sql: string };
    expect(index.sql.toUpperCase()).toContain("UNIQUE");
    expect(index.sql.toUpperCase()).toContain("IS_PRIMARY = 1");

    const [, second] = bindingIds(db, "multi");
    // A second explicit primary for the same project must fail loudly.
    expect(() =>
      db.prepare("UPDATE local_repositories SET is_primary = 1 WHERE id = ?").run(second),
    ).toThrow();
    // Values outside {0,1} must fail loudly.
    expect(() =>
      db.prepare("UPDATE local_repositories SET is_primary = 2 WHERE id = ?").run(second),
    ).toThrow();
  });

  it("applies cleanly to a fresh database (no rows to backfill)", () => {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? ".", "ldd-fresh-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "fresh.sqlite");
    process.env.DASHBOARD_DB_PATH = dbPath;
    closeDb();

    const db = openDatabase(dbPath) as ReturnType<typeof openDatabase>;
    openHandles.push(db as unknown as { close: () => void });

    const columns = db.prepare("PRAGMA table_info(local_repositories)").all() as Array<{
      name: string;
    }>;
    expect(columns.some((column) => column.name === "is_primary")).toBe(true);
    const index = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_local_repo_project_primary'",
      )
      .get();
    expect(index).toBeTruthy();
    // 008 recorded exactly once.
    const applied = db
      .prepare(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '008_primary_local_binding'",
      )
      .get() as { n: number };
    expect(applied.n).toBe(1);

    // Fresh-migration database must be structurally sound: no FK violations,
    // integrity check reports "ok" (node:sqlite exposes PRAGMA through
    // prepared statements, not a .pragma() helper).
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check,
    ).toBe("ok");
  });
});


