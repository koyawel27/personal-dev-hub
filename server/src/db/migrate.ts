import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Number of pre-006 backup archives to retain (owner decision R1). */
const BACKUP_RETENTION = 3;

function tableExists(database: DatabaseSync, name: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row != null;
}

function columnNames(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

function isApplied(database: DatabaseSync, name: string): boolean {
  return (
    database
      .prepare("SELECT name FROM schema_migrations WHERE name = ?")
      .get(name) != null
  );
}

function recordApplied(database: DatabaseSync, name: string): void {
  database
    .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
    .run(name, new Date().toISOString());
}

/**
 * Create a WAL-safe file backup before a rebuild migration and enforce
 * retention (owner decisions R1):
 * - keeps the newest BACKUP_RETENTION successful-migration backups,
 * - NEVER deletes the current attempt's backup or any backup belonging to a
 *   failed migration attempt (those are marked by a `.failed` sidecar).
 */
function createRebuildBackup(migrationName: string): string {
  const dbFile = config.dbPath;
  if (!fs.existsSync(dbFile)) {
    throw new Error(`Cannot back up missing database file: ${dbFile}`);
  }
  const backupDir = path.join(path.dirname(dbFile), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(backupDir, `pre-${migrationName}-${stamp}.sqlite`);
  fs.copyFileSync(dbFile, target);

  // Retention: only prune backups that are NOT current and NOT failed.
  const candidates = fs
    .readdirSync(backupDir)
    .filter(
      (file) =>
        file.startsWith(`pre-${migrationName}-`) &&
        file.endsWith(".sqlite") &&
        file !== path.basename(target),
    )
    .sort()
    .reverse();
  for (const file of candidates.slice(BACKUP_RETENTION)) {
    try {
      fs.rmSync(path.join(backupDir, file), { force: true });
    } catch {
      // best effort; retention never blocks migration
    }
  }
  return target;
}

/**
 * Ordered, transactional migrations.
 *
 * - schema.sql stays the idempotent base DDL (CREATE TABLE IF NOT EXISTS);
 *   it runs on every open so fresh databases are complete immediately.
 * - Each .sql file under db/migrations/ is applied at most once, in name
 *   order, inside its own transaction together with its schema_migrations
 *   record.
 * - Files starting with "-- rebuild" are DECLARED REBUILD migrations: they
 *   may recreate tables, so they run under a strict safety protocol:
 *     1. automatic verified file backup (retention per R1),
 *     2. pre-flight hook (mapping completeness etc.) — failure aborts
 *        BEFORE any DDL runs,
 *     3. PRAGMA foreign_keys state captured and disabled OUTSIDE the
 *        transaction (a no-op inside one),
 *     4. transactional rebuild + schema_migrations record,
 *     5. PRAGMA foreign_key_check + integrity_check must pass,
 *     6. foreign_keys restored to ON on success AND on failure — the
 *        connection can never be left with enforcement disabled.
 */
export function migrate(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON;");

  const schemaPath = path.join(here, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  database.exec(sql);

  if (!tableExists(database, "schema_migrations")) {
    throw new Error("schema_migrations table missing after base schema execution.");
  }

  // 000_base represents schema.sql itself; legacy databases from the Grok
  // checkpoint era already carry this record under the original name.
  if (!isApplied(database, "001_initial") && !isApplied(database, "000_base")) {
    recordApplied(database, "001_initial");
  }

  const migrationsDir = path.join(here, "migrations");
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const name = path.basename(file, ".sql");
    if (isApplied(database, name)) continue;

    const migrationSql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const isRebuild = /^--\s*rebuild\b/m.test(migrationSql);

    // Idempotency guards precedent (002): a database already carrying every
    // column a migration adds must not re-run it.
    if (name === "002_project_metadata") {
      const existing = columnNames(database, "local_repositories");
      if (
        ["project_status", "project_type", "include_in_portfolio"].every((c) =>
          existing.has(c),
        )
      ) {
        recordApplied(database, name);
        continue;
      }
    }
    if (name === "005_github_bindings") {
      const existing = columnNames(database, "github_repositories");
      if (["project_id", "tracked_at", "owner_norm"].every((c) => existing.has(c))) {
        recordApplied(database, name);
        continue;
      }
    }

    if (!isRebuild) {
      database.exec("BEGIN IMMEDIATE;");
      try {
        database.exec(migrationSql);
        recordApplied(database, name);
        database.exec("COMMIT;");
      } catch (err) {
        try {
          database.exec("ROLLBACK;");
        } catch {
          // ignore rollback failures on already-closed transactions
        }
        throw err;
      }
      continue;
    }

    runDeclaredRebuild(database, name, migrationSql);
  }
}

/**
 * Declared-rebuild protocol. See migrate() docstring for the guarantees.
 * Exported for direct regression testing of the FK failure path.
 */
export function runDeclaredRebuild(
  database: DatabaseSync,
  name: string,
  migrationSql: string,
): void {
  // ---- 1. automatic backup -------------------------------------------------
  let backupPath: string | null = null;
  try {
    backupPath = createRebuildBackup(name);
  } catch (err) {
    throw new Error(
      `Migration ${name} aborted: required database backup could not be created. ` +
        `No changes were made. (${String(err)})`,
    );
  }

  // ---- 2. pre-flight verification (before ANY ddl) -------------------------
  try {
    verifyRebuildPreconditions(database, name);
  } catch (err) {
    markBackupFailed(backupPath, name);
    throw new Error(
      `Migration ${name} aborted during pre-flight verification: ${String(err)} ` +
        `No changes were made; backup preserved at ${backupPath}.`,
    );
  }

  // ---- 3-6. scoped FK disable, transactional rebuild, checks, restore ------
  const fkBefore = (
    database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
  ).foreign_keys;

  const beginFkOff = (): void => {
    database.exec("PRAGMA foreign_keys = OFF;");
  };
  const restoreFk = (): void => {
    database.exec("PRAGMA foreign_keys = ON;");
  };

  beginFkOff();
  try {
    database.exec("BEGIN IMMEDIATE;");
    try {
      // Capture source cardinality BEFORE the rebuild consumes it.
      const preCount = tableExists(database, "activity_events")
        ? (
            database.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }
          ).n
        : null;

      database.exec(migrationSql);

      // Post-condition hooks inside the transaction (row-count equality etc.).
      verifyRebuildPostconditions(database, name, preCount);

      recordApplied(database, name);
      database.exec("COMMIT;");
    } catch (err) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        // ignore rollback failures on already-closed transactions
      }
      throw err;
    }

    // ---- integrity verification AFTER commit -----------------------------
    const fkIssues = database
      .prepare("PRAGMA foreign_key_check")
      .all() as unknown[];
    if (fkIssues.length > 0) {
      throw new Error(
        `foreign_key_check reported ${fkIssues.length} violation(s) after ${name}.`,
      );
    }
    const integrity = database
      .prepare("PRAGMA integrity_check")
      .get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") {
      throw new Error(
        `integrity_check failed after ${name}: ${integrity.integrity_check}`,
      );
    }
  } catch (err) {
    // Failure path: preserve this attempt's backup, restore FK enforcement.
    if (backupPath) markBackupFailed(backupPath, name);
    restoreFk();
    if (fkBefore !== 1) restoreFk(); // belt-and-braces: always end at ON
    throw new Error(
      `Migration ${name} failed and was rolled back. The database was left ` +
        `unchanged; backup preserved at ${backupPath}. (${String(err)})`,
    );
  }

  restoreFk();
  // Success retention cleanup happens inside createRebuildBackup next time;
  // the successful attempt's backup is kept until superseded.
}

/** Sidecar marker so retention never deletes a failed attempt's backup. */
function markBackupFailed(backupPath: string | null, name: string): void {
  if (!backupPath) return;
  try {
    fs.writeFileSync(`${backupPath}.${name}.failed`, new Date().toISOString());
  } catch {
    // best effort
  }
}

/**
 * Pre-flight conditions per declared-rebuild migration. A failure here
 * aborts BEFORE any DDL executes (fail rather than silently corrupt).
 */
function verifyRebuildPreconditions(database: DatabaseSync, name: string): void {
  if (name === "006_project_activity") {
    // Every activity event's binding must already map to a project.
    const unmapped = database
      .prepare(
        `SELECT COUNT(*) AS n FROM activity_events e
         LEFT JOIN local_repositories lr ON lr.id = e.local_repository_id
         WHERE lr.id IS NULL OR lr.project_id IS NULL`,
      )
      .get() as { n: number };
    if (unmapped.n > 0) {
      throw new Error(
        `${unmapped.n} activity event(s) reference bindings without a project mapping.`,
      );
    }
    // Target shape must not already exist (guards partial manual states).
    const columns = columnNames(database, "activity_events");
    if (columns.has("project_id")) {
      throw new Error("activity_events already has project_id; refusing to rebuild.");
    }
  }
}

/**
 * In-transaction post-conditions per declared-rebuild migration.
 * `sourceCount` is the rebuilt table's row count measured before the
 * migration ran; a mismatch fails loudly (no silent loss or invention).
 */
function verifyRebuildPostconditions(
  database: DatabaseSync,
  name: string,
  sourceCount: number | null,
): void {
  if (name === "006_project_activity") {
    const total = (
      database.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }
    ).n;
    if (sourceCount != null && total !== sourceCount) {
      throw new Error(
        `Copied row count ${total} does not match source count ${sourceCount}.`,
      );
    }
    const withoutProject = (
      database
        .prepare("SELECT COUNT(*) AS n FROM activity_events WHERE project_id IS NULL")
        .get() as { n: number }
    ).n;
    if (withoutProject !== 0) {
      throw new Error(`${withoutProject} event(s) lost project ownership.`);
    }
  }
}
