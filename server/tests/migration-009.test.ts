import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, openDatabase } from "../src/db/client.js";

/**
 * Migration 009_local_binding_health (V1.2 M2 M2-D).
 *
 * Contract under test:
 * - last_health_state / last_health_checked_at added to local_repositories
 *   for BOTH V1.1/V1.2-M1 upgrades (this file) and fresh databases
 *   (schema.sql intentionally stays the base shape; 009 owns the change)
 * - backfill: successfully scanned bindings (last_scanned_at set) become
 *   OK with checked_at = last_scanned_at; never-scanned bindings stay
 *   NULL/NULL
 * - CHECK constraint admits only NULL/'OK'/'NOT_A_GIT_REPO' — PATH_MISSING
 *   and UNSCANNED are derived states and must never be storable
 * - migration recorded exactly once; FK/integrity clean
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
 * Build a realistic PRE-009 database (baseline + 001..008 applied, no health
 * columns): one project with a scanned binding, a never-scanned binding, and
 * (via a second project) coverage of the MIN(id) primary backfill era. 009 is
 * left unapplied so openDatabase() performs the real upgrade.
 */
function createPre009Db(): string {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? ".", "ldd-pre009-"));
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "pre009.sqlite");
  process.env.DASHBOARD_DB_PATH = dbPath;
  closeDb();

  const database = new DatabaseSync(dbPath);
  const apply = (name: string): void => {
    database.exec(fs.readFileSync(path.join(here, "migrations", `${name}.sql`), "utf8"));
  };
  const record = (name: string): void => {
    database
      .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
      .run(name, "2026-08-20T10:00:00.000Z");
  };

  database.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  apply("002_project_metadata");
  apply("003_app_settings");
  apply("004_projects_core");
  apply("005_github_bindings");
  apply("006_project_activity");
  apply("007_repair_zero_binding_ghosts");
  apply("008_primary_local_binding");
  for (const name of [
    "001_initial",
    "002_project_metadata",
    "003_app_settings",
    "004_projects_core",
    "005_github_bindings",
    "006_project_activity",
    "007_repair_zero_binding_ghosts",
    "008_primary_local_binding",
  ]) {
    record(name);
  }

  const now = "2026-08-20T10:00:00.000Z";
  const seedProject = (name: string): number =>
    Number(
      database
        .prepare("INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)")
        .run(name, now, now).lastInsertRowid,
    );
  const seedBinding = (
    projectId: number,
    localPath: string,
    lastScannedAt: string | null,
  ): number =>
    Number(
      database
        .prepare(
          `INSERT INTO local_repositories
             (source_id, project_id, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at)
           VALUES (NULL, ?, ?, ?, ?, 'manual', ?, ?)`,
        )
        .run(projectId, path.basename(localPath), localPath, localPath.toLowerCase(), now, lastScannedAt)
        .lastInsertRowid,
    );

  const project = seedProject("health-fixture");
  seedBinding(project, "C:\\proj\\health-scanned", "2026-08-19T09:30:00.000Z");
  seedBinding(project, "C:\\proj\\health-never-scanned", null);

  database.close();
  return dbPath;
}

describe("migration 009_local_binding_health", () => {
  it("backfills scanned bindings to OK (checked_at = last_scanned_at) and leaves never-scanned bindings NULL", () => {
    const db = openDatabase(createPre009Db()) as ReturnType<typeof openDatabase>;
    openHandles.push(db as unknown as { close: () => void });

    const columns = db.prepare("PRAGMA table_info(local_repositories)").all() as Array<{
      name: string;
    }>;
    expect(columns.some((column) => column.name === "last_health_state")).toBe(true);
    expect(columns.some((column) => column.name === "last_health_checked_at")).toBe(true);

    const rows = db
      .prepare(
        "SELECT local_path, last_health_state, last_health_checked_at, last_scanned_at FROM local_repositories ORDER BY id ASC",
      )
      .all() as Array<{
      local_path: string;
      last_health_state: string | null;
      last_health_checked_at: string | null;
      last_scanned_at: string | null;
    }>;

    const scanned = rows.find((row) => row.local_path.startsWith("C:\\proj\\health-scanned"));
    expect(scanned!.last_health_state).toBe("OK");
    // checked timestamp equals the historical scan time, not the migration time.
    expect(scanned!.last_health_checked_at).toBe("2026-08-19T09:30:00.000Z");
    expect(scanned!.last_health_checked_at).toBe(scanned!.last_scanned_at);

    const never = rows.find((row) => row.local_path.startsWith("C:\\proj\\health-never-scanned"));
    expect(never!.last_health_state).toBeNull();
    expect(never!.last_health_checked_at).toBeNull();

    // Migration recorded exactly once; upgrade database structurally sound.
    const applied = db
      .prepare(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '009_local_binding_health'",
      )
      .get() as { n: number };
    expect(applied.n).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check,
    ).toBe("ok");
  });

  it("admits only NULL/'OK'/'NOT_A_GIT_REPO' — derived states are not storable", () => {
    const db = openDatabase(createPre009Db()) as ReturnType<typeof openDatabase>;
    openHandles.push(db as unknown as { close: () => void });

    const binding = (
      db.prepare("SELECT id FROM local_repositories ORDER BY id ASC LIMIT 1").get() as {
        id: number;
      }
    ).id;

    // Cached Git verdicts are persistable.
    db.prepare("UPDATE local_repositories SET last_health_state = 'OK' WHERE id = ?").run(binding);
    db.prepare("UPDATE local_repositories SET last_health_state = 'NOT_A_GIT_REPO' WHERE id = ?").run(binding);
    db.prepare("UPDATE local_repositories SET last_health_state = NULL WHERE id = ?").run(binding);

    // Derived states must be rejected loudly.
    expect(() =>
      db
        .prepare("UPDATE local_repositories SET last_health_state = 'PATH_MISSING' WHERE id = ?")
        .run(binding),
    ).toThrow();
    expect(() =>
      db
        .prepare("UPDATE local_repositories SET last_health_state = 'UNSCANNED' WHERE id = ?")
        .run(binding),
    ).toThrow();
  });

  it("applies cleanly to a fresh database through the ordered runner", () => {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? ".", "ldd-fresh009-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "fresh.sqlite");
    process.env.DASHBOARD_DB_PATH = dbPath;
    closeDb();

    const db = openDatabase(dbPath) as ReturnType<typeof openDatabase>;
    openHandles.push(db as unknown as { close: () => void });

    const columns = db.prepare("PRAGMA table_info(local_repositories)").all() as Array<{
      name: string;
    }>;
    expect(columns.some((column) => column.name === "last_health_state")).toBe(true);
    expect(columns.some((column) => column.name === "last_health_checked_at")).toBe(true);

    // Fresh rows can persist the two cached states and nothing else.
    const now = new Date().toISOString();
    const projectId = Number(
      db
        .prepare("INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)")
        .run("fresh-health", now, now).lastInsertRowid,
    );
    const insert = db.prepare(
      `INSERT INTO local_repositories
         (source_id, project_id, name, local_path, canonical_path, discovery_type, created_at, last_health_state, last_health_checked_at)
       VALUES (NULL, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
    );
    const okId = Number(
      insert.run(projectId, "fresh-ok", "C:\\proj\\fresh-ok", "c:\\proj\\fresh-ok", now, "OK", now)
        .lastInsertRowid,
    );
    expect(
      (
        db
          .prepare("SELECT last_health_state FROM local_repositories WHERE id = ?")
          .get(okId) as { last_health_state: string }
      ).last_health_state,
    ).toBe("OK");
    expect(() =>
      insert.run(projectId, "fresh-bad", "C:\\proj\\fresh-bad", "c:\\proj\\fresh-bad", now, "PATH_MISSING", now),
    ).toThrow();

    const applied = db
      .prepare(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '009_local_binding_health'",
      )
      .get() as { n: number };
    expect(applied.n).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check,
    ).toBe("ok");
  });
});
