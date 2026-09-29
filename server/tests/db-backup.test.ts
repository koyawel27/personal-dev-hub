import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createVerifiedSqliteSnapshot,
  removeInvalidBackupOutput,
  resolveMainDatabaseFile,
  verifySqliteBackup,
} from "../src/db/backup.js";

/**
 * Focused regressions for the generic verified SQLite snapshot primitive
 * (V1.3 M1). Migration naming/retention stays covered by
 * migration-backup.test.ts; this suite only proves the reusable contract:
 *
 * 1. committed data is present in the snapshot
 * 2. committed-but-uncheckpointed WAL data is present
 * 3. the produced snapshot passes integrity/schema verification
 * 4. a pre-existing target is refused and preserved byte-for-byte
 * 5. invalid/failed newly-created output is not left masquerading as a backup
 * 6. the live connection (PRAGMA database_list) is authoritative
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeTempDb(
  name: string,
  wal = false,
): { db: DatabaseSync; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ldd-snap-${name}-`));
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, `${name}.sqlite`);
  const db = new DatabaseSync(dbPath);
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
  return { db, dir, dbPath };
}

describe("generic verified SQLite snapshot (V1.3 M1)", () => {
  it("snapshots committed data and passes integrity/schema verification", () => {
    const { db, dir } = makeTempDb("committed");
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
      "001_committed",
      new Date().toISOString(),
    );

    const target = path.join(dir, "out.sqlite");
    createVerifiedSqliteSnapshot(db, target);

    expect(fs.existsSync(target)).toBe(true);
    // Explicit check that the produced file passes the shared verifier.
    expect(() => verifySqliteBackup(target)).not.toThrow();

    const snap = new DatabaseSync(target, { readOnly: true });
    try {
      const row = snap
        .prepare("SELECT name FROM schema_migrations WHERE name = '001_committed'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("001_committed");
    } finally {
      snap.close();
    }
  });

  it("includes committed-but-uncheckpointed WAL state", () => {
    const { db, dir } = makeTempDb("walsnap", true);

    // Committed state that lives only in the WAL: with wal_autocheckpoint = 0
    // and the connection kept open, a raw main-file copy would miss these rows.
    db.exec(
      "CREATE TABLE marker_notes (id INTEGER PRIMARY KEY, note TEXT NOT NULL);",
    );
    db.prepare("INSERT INTO marker_notes (note) VALUES (?)").run(
      "wal-only-marker-row",
    );

    const target = path.join(dir, "wal-out.sqlite");
    createVerifiedSqliteSnapshot(db, target);

    const snap = new DatabaseSync(target, { readOnly: true });
    try {
      const integrity = snap
        .prepare("PRAGMA integrity_check")
        .get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe("ok");

      const markerRow = snap
        .prepare("SELECT note FROM marker_notes")
        .get() as { note: string };
      expect(markerRow.note).toBe("wal-only-marker-row");
    } finally {
      snap.close();
    }
  });

  it("refuses a pre-existing target and preserves it byte-for-byte", () => {
    const { db, dir } = makeTempDb("collide");
    const target = path.join(dir, "existing.sqlite");
    const original = Buffer.from("PRE-EXISTING-TARGET-DO-NOT-DELETE");
    fs.writeFileSync(target, original);

    expect(() => createVerifiedSqliteSnapshot(db, target)).toThrow(
      /Backup destination already exists/,
    );
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target)).toEqual(original);
  });

  it("removes invalid newly-created output instead of leaving a fake backup", () => {
    const { db, dir } = makeTempDb("badout");
    const target = path.join(dir, "bad-out.sqlite");

    // Force this attempt to write a non-SQLite payload, then let verification
    // fail. Cleanup must remove the file this attempt created.
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("VACUUM INTO")) {
        return {
          run: (dest: string) => {
            fs.writeFileSync(dest, "not-a-sqlite-database");
          },
        } as unknown as ReturnType<DatabaseSync["prepare"]>;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare);

    // Open/verify fails on the non-SQLite payload; the important contract is
    // that this attempt's output is not left behind as a fake backup.
    expect(() => createVerifiedSqliteSnapshot(db, target)).toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });

  it("removes partial output when VACUUM INTO fails after creating a file", () => {
    const { db, dir } = makeTempDb("partial");
    const target = path.join(dir, "partial-out.sqlite");

    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("VACUUM INTO")) {
        return {
          run: (dest: string) => {
            fs.writeFileSync(dest, "partial-garbage");
            throw new Error("VACUUM INTO failed mid-write");
          },
        } as unknown as ReturnType<DatabaseSync["prepare"]>;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare);

    expect(() => createVerifiedSqliteSnapshot(db, target)).toThrow(
      /VACUUM INTO failed mid-write/,
    );
    expect(fs.existsSync(target)).toBe(false);
  });

  it("treats the live connection as authoritative via PRAGMA database_list", () => {
    const { db, dir, dbPath } = makeTempDb("livesrc");
    const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ldd-snap-decoy-"));
    cleanupDirs.push(decoyDir);
    const previousDbPath = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB_PATH = path.join(decoyDir, "decoy.sqlite");
    try {
      expect(resolveMainDatabaseFile(db)).toBe(dbPath);

      const target = path.join(dir, "from-live.sqlite");
      createVerifiedSqliteSnapshot(db, target);
      expect(fs.existsSync(target)).toBe(true);
      // Snapshot destination is caller-chosen; the source identity still
      // comes from the live connection, not DASHBOARD_DB_PATH.
      expect(fs.existsSync(path.join(decoyDir, "from-live.sqlite"))).toBe(false);
    } finally {
      if (previousDbPath === undefined) {
        delete process.env.DASHBOARD_DB_PATH;
      } else {
        process.env.DASHBOARD_DB_PATH = previousDbPath;
      }
    }
  });

  it("refuses non-filesystem-backed main databases", () => {
    const memory = new DatabaseSync(":memory:");
    openHandles.push(memory);
    memory.exec("CREATE TABLE t (id INTEGER PRIMARY KEY);");

    expect(() => resolveMainDatabaseFile(memory)).toThrow(
      /no filesystem-backed main database/,
    );
    expect(() =>
      createVerifiedSqliteSnapshot(memory, path.join(os.tmpdir(), "never.sqlite")),
    ).toThrow(/no filesystem-backed main database/);
  });

  it("removeInvalidBackupOutput is best-effort and never required for success", () => {
    const { dir } = makeTempDb("cleanup-helper");
    const target = path.join(dir, "stale-output.sqlite");
    fs.writeFileSync(target, "stale");
    removeInvalidBackupOutput(target);
    expect(fs.existsSync(target)).toBe(false);
    // Missing file is fine.
    expect(() => removeInvalidBackupOutput(target)).not.toThrow();
  });
});
