import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

/**
 * FK-safety regression for the declared-rebuild protocol (owner mandate):
 *
 * 1. foreign_keys state is known before the operation,
 * 2. disabling is scoped to the declared rebuild only,
 * 3. the rebuild runs transactionally,
 * 4. a throwing migration ROLLS BACK,
 * 5. foreign_keys = ON is restored on the failure path too —
 *    the connection can never be left with enforcement disabled.
 */

const cleanupDirs: string[] = [];

function makeDb(): DatabaseSync {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ldd-fk-"));
  cleanupDirs.push(dir);
  const db = new DatabaseSync(path.join(dir, "fk.sqlite")) as unknown as DatabaseSync;
  db.exec(`
    CREATE TABLE schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE keep_me (id INTEGER PRIMARY KEY);
    INSERT INTO keep_me VALUES (7);
  `);
  // DASHBOARD_DB_PATH must point at an existing file for the backup gate.
  process.env.DASHBOARD_DB_PATH = path.join(dir, "fk.sqlite");
  return db;
}

afterAll(() => {
  for (const dir of cleanupDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort on Windows lock timing
    }
  }
});

describe("declared-rebuild FK safety", () => {
  it("restores foreign_keys=ON when a rebuild fails mid-transaction", async () => {
    const { runDeclaredRebuild } = await import("../src/db/migrate.js");
    const db = makeDb();

    const broken = [
      "-- rebuild",
      "CREATE TABLE rebuilt (id INTEGER PRIMARY KEY);",
      "INSERT INTO rebuilt VALUES (1);",
      "INSERT INTO nonexistent_table VALUES ('boom');",
    ].join("\n");

    let threw = false;
    let rollbackMessage = "";
    try {
      runDeclaredRebuild(db as never, "900_broken", broken);
    } catch (err) {
      threw = true;
      rollbackMessage = String((err as Error).message);
    }

    expect(threw).toBe(true);

    // Rollback-path wording stays truthful: the transaction never committed.
    expect(rollbackMessage).toContain("failed and was rolled back");
    expect(rollbackMessage).toContain("The database was left unchanged");
    expect(rollbackMessage).not.toContain("committed, but post-commit verification failed");

    // FK enforcement restored despite the failure...
    const fk = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
      .foreign_keys;
    expect(fk).toBe(1);

    // ...and the transaction rolled back completely.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rebuilt'")
      .all();
    expect(tables).toHaveLength(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM keep_me").get() as { n: number }).n).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n,
    ).toBe(0);
  });

  it("restores foreign_keys=ON after a successful rebuild and records the migration", async () => {
    const { runDeclaredRebuild } = await import("../src/db/migrate.js");
    const db = makeDb();

    const valid = [
      "-- rebuild",
      "CREATE TABLE rebuilt (id INTEGER PRIMARY KEY, src INTEGER);",
      "INSERT INTO rebuilt SELECT id, id FROM keep_me;",
      "DROP TABLE keep_me;",
      "ALTER TABLE rebuilt RENAME TO keep_me;",
    ].join("\n");

    runDeclaredRebuild(db as never, "901_ok", valid);

    const fk = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
      .foreign_keys;
    expect(fk).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM keep_me").get() as { n: number }).n).toBe(1);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '901_ok'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it("reports a committed migration truthfully when post-commit FK verification fails", async () => {
    const { runDeclaredRebuild } = await import("../src/db/migrate.js");
    const db = makeDb();

    // FK enforcement is disabled inside the rebuild transaction, so this
    // migration COMMITS a child row referencing a missing parent; the
    // AFTER-COMMIT PRAGMA foreign_key_check then detects the violation.
    const fkViolation = [
      "-- rebuild",
      "CREATE TABLE parent (id INTEGER PRIMARY KEY);",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));",
      "INSERT INTO child (parent_id) VALUES (999);",
    ].join("\n");

    let message = "";
    let threw = false;
    try {
      runDeclaredRebuild(db as never, "902_committed_fk_violation", fkViolation);
    } catch (err) {
      threw = true;
      message = String((err as Error).message);
    }

    expect(threw).toBe(true);

    // The message must reflect the true stage: committed, not rolled back.
    expect(message).toContain("committed, but post-commit verification failed");
    expect(message).toContain("not rolled back");
    expect(message).not.toContain("was rolled back");
    expect(message).toContain("preserved backup at");
    expect(message).toContain("foreign_key_check reported");

    // FK enforcement is restored even on this path.
    const fk = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
      .foreign_keys;
    expect(fk).toBe(1);

    // The claim is real: the committed migrated state exists in the database.
    const migratedTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'child'")
      .all();
    expect(migratedTable).toHaveLength(1);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '902_committed_fk_violation'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);

    // The attempt's backup is preserved and carries its .failed sidecar.
    const backupDir = path.join(
      path.dirname(process.env.DASHBOARD_DB_PATH ?? ""),
      "backups",
    );
    const backups = fs
      .readdirSync(backupDir)
      .filter(
        (file) =>
          file.startsWith("pre-902_committed_fk_violation-") &&
          file.endsWith(".sqlite"),
      );
    expect(backups).toHaveLength(1);
    expect(
      fs.existsSync(path.join(backupDir, `${backups[0]}.902_committed_fk_violation.failed`)),
    ).toBe(true);
  });
});
