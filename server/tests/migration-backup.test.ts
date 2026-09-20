import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runDeclaredRebuild } from "../src/db/migrate.js";

/**
 * Rebuild-backup safety regressions (M5-B2), all driven through the exported
 * runDeclaredRebuild() protocol:
 *
 * 1. WAL safety — the backup (VACUUM INTO on the live connection) must
 *    include committed state that still resides in the write-ahead log; a
 *    plain main-file-only copy structurally cannot. The oracle is backup
 *    content, made deterministic by PRAGMA wal_autocheckpoint = 0 and by
 *    keeping the source connection open.
 * 2. Retention — the newest BACKUP_RETENTION ordinary older backups are
 *    retained; backups carrying a matching `.failed` sidecar are exempt
 *    from pruning and do not consume an ordinary retention slot.
 * 3. Destination collision — a pre-existing target file is preserved
 *    byte-for-byte; backup failure aborts before pre-flight/DDL.
 * 4. Location — the backup follows the actual connection (PRAGMA
 *    database_list), not DASHBOARD_DB_PATH.
 */

const cleanupDirs: string[] = [];
const openHandles: DatabaseSync[] = [];

afterAll(() => {
  for (const handle of openHandles.splice(0)) {
    try {
      handle.close();
    } catch {
      // already closed
    }
  }
  for (const dir of cleanupDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort on Windows lock timing
    }
  }
});

afterEach(() => {
  vi.useRealTimers();
});

function makeTempDb(
  name: string,
  wal = false,
): { db: DatabaseSync; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ldd-bkp-${name}-`));
  cleanupDirs.push(dir);
  const db = new DatabaseSync(path.join(dir, `${name}.sqlite`));
  openHandles.push(db);
  if (wal) {
    db.exec("PRAGMA journal_mode = WAL;");
    // Determinism: nothing may checkpoint committed state into the main
    // database file behind the test's back.
    db.exec("PRAGMA wal_autocheckpoint = 0;");
  }
  db.exec(`
    CREATE TABLE schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  return { db, dir };
}

function backupDirFor(dir: string): string {
  return path.join(dir, "backups");
}

function listBackups(dir: string, migrationName: string): string[] {
  const backupDir = backupDirFor(dir);
  return fs.existsSync(backupDir)
    ? fs
        .readdirSync(backupDir)
        .filter(
          (file) =>
            file.startsWith(`pre-${migrationName}-`) &&
            file.endsWith(".sqlite"),
        )
    : [];
}

describe("rebuild backup hardening (M5-B2)", () => {
  it("captures committed WAL state in the backup (fails under a main-file-only copy)", () => {
    const { db, dir } = makeTempDb("walsrc", true);

    // Committed state that lives in the WAL: with wal_autocheckpoint = 0 and
    // the connection kept open, no checkpoint can move these pages into the
    // main file, so a raw copy of the main file structurally misses them.
    db.exec(
      "CREATE TABLE marker_notes (id INTEGER PRIMARY KEY, note TEXT NOT NULL);",
    );
    db.prepare("INSERT INTO marker_notes (note) VALUES (?)").run(
      "wal-only-marker-row",
    );

    runDeclaredRebuild(
      db,
      "900_wal_safety",
      [
        "-- rebuild",
        "CREATE TABLE rebuilt_900 (id INTEGER PRIMARY KEY);",
      ].join("\n"),
    );

    const backups = listBackups(dir, "900_wal_safety");
    expect(backups).toHaveLength(1);

    const backup = new DatabaseSync(path.join(backupDirFor(dir), backups[0]), {
      readOnly: true,
    });
    try {
      const integrity = backup
        .prepare("PRAGMA integrity_check")
        .get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe("ok");

      const markerTable = backup
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'marker_notes'",
        )
        .all();
      expect(markerTable).toHaveLength(1);

      const markerRow = backup
        .prepare("SELECT note FROM marker_notes")
        .get() as { note: string };
      expect(markerRow.note).toBe("wal-only-marker-row");
    } finally {
      backup.close();
    }

    // The rebuild itself completed on the live connection.
    const applied = db
      .prepare(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '900_wal_safety'",
      )
      .get() as { n: number };
    expect(applied.n).toBe(1);
  });

  it("retains the newest ordinary backups and never prunes failed-sidecar backups", () => {
    const { db, dir } = makeTempDb("retention");
    const migrationName = "901_retention";
    const backupDir = backupDirFor(dir);
    fs.mkdirSync(backupDir, { recursive: true });

    // Ordinary eligible backups, oldest (a1) → newest (a5).
    const ordinary = ["a1", "a2", "a3", "a4", "a5"].map(
      (ordinal) => `pre-${migrationName}-${ordinal}.sqlite`,
    );
    for (const file of ordinary) {
      fs.writeFileSync(path.join(backupDir, file), `fixture:${file}`);
    }

    // Deliberately the NEWEST older backup: a retention without the sidecar
    // check would spend one of the three slots on it and prune an ordinary
    // backup that must survive.
    const failedFile = `pre-${migrationName}-z9-failed.sqlite`;
    const failedSidecar = `${failedFile}.${migrationName}.failed`;
    fs.writeFileSync(path.join(backupDir, failedFile), "fixture:failed");
    fs.writeFileSync(path.join(backupDir, failedSidecar), "failed-marker");

    // An unrelated migration's backups must be untouched.
    const unrelated = "pre-999_unrelated-x1.sqlite";
    fs.writeFileSync(path.join(backupDir, unrelated), "fixture:unrelated");

    runDeclaredRebuild(
      db,
      migrationName,
      "-- rebuild\nCREATE TABLE rebuilt_901 (id INTEGER PRIMARY KEY);",
    );

    const files = fs.readdirSync(backupDir).sort();
    const fixtureFiles = new Set([...ordinary, failedFile, unrelated]);
    const current = files.filter(
      (file) =>
        file.startsWith(`pre-${migrationName}-`) &&
        file.endsWith(".sqlite") &&
        !fixtureFiles.has(file),
    );

    // 1. the current attempt's backup exists
    expect(current).toHaveLength(1);
    // 2./3. the failed backup and its sidecar survive
    expect(files).toContain(failedFile);
    expect(files).toContain(failedSidecar);
    // 4./5. the failed backup did not consume a slot: the newest
    // BACKUP_RETENTION (3) ordinary backups all survive.
    for (const kept of ["a5", "a4", "a3"]) {
      expect(files).toContain(`pre-${migrationName}-${kept}.sqlite`);
    }
    // 6. older ordinary backups beyond the retention count are pruned
    for (const pruned of ["a2", "a1"]) {
      expect(files).not.toContain(`pre-${migrationName}-${pruned}.sqlite`);
    }
    // 7. unrelated migration-name backups are untouched
    expect(files).toContain(unrelated);
  });

  it("preserves a pre-existing destination file byte-for-byte when the backup collides", () => {
    const { db, dir } = makeTempDb("collision");
    const migrationName = "902_collision";
    const stamp = "2026-03-04T05-06-07-890Z";
    const target = path.join(
      backupDirFor(dir),
      `pre-${migrationName}-${stamp}.sqlite`,
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "PRE-EXISTING-BACKUP-DO-NOT-DELETE");

    // Pin the clock only for this test so createRebuildBackup computes
    // exactly the colliding target name above.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T05:06:07.890Z"));
    try {
      let threw: unknown = null;
      try {
        runDeclaredRebuild(
          db,
          migrationName,
          "-- rebuild\nCREATE TABLE rebuilt_902 (id INTEGER PRIMARY KEY);",
        );
      } catch (err) {
        threw = err;
      }

      // Fail loudly before pre-flight/DDL...
      expect(threw).toBeInstanceOf(Error);
      expect((threw as Error).message).toContain(
        "aborted: required database backup could not be created",
      );
      expect((threw as Error).message).toContain(
        "Backup destination already exists",
      );
      // ...leaving the pre-existing file intact and the source untouched.
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe(
        "PRE-EXISTING-BACKUP-DO-NOT-DELETE",
      );
      const applied = db
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
        .get() as { n: number };
      expect(applied.n).toBe(0);
      const rebuilt = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rebuilt_902'",
        )
        .all();
      expect(rebuilt).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("places the backup next to the actual connection's database, not DASHBOARD_DB_PATH", () => {
    const { db, dir } = makeTempDb("connderived");
    const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ldd-bkp-decoy-"));
    cleanupDirs.push(decoyDir);
    const previousDbPath = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB_PATH = path.join(decoyDir, "decoy.sqlite");
    try {
      runDeclaredRebuild(
        db,
        "903_connection_location",
        "-- rebuild\nCREATE TABLE rebuilt_903 (id INTEGER PRIMARY KEY);",
      );

      const backups = listBackups(dir, "903_connection_location");
      expect(backups).toHaveLength(1);
      expect(fs.existsSync(path.join(decoyDir, "backups"))).toBe(false);
    } finally {
      if (previousDbPath === undefined) {
        delete process.env.DASHBOARD_DB_PATH;
      } else {
        process.env.DASHBOARD_DB_PATH = previousDbPath;
      }
    }
  });
});
