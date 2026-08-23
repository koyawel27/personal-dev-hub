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
    try {
      runDeclaredRebuild(db as never, "900_broken", broken);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);

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
});
