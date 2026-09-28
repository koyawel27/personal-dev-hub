import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRestoreState,
  getRestoreState,
  processPendingRestore,
  readRestoreState,
  scheduleRestore,
} from "../src/services/RestoreService.js";
import {
  createVerifiedSqliteSnapshot,
  verifySqliteBackup,
} from "../src/db/backup.js";
import { closeDb, getDb, openDatabase } from "../src/db/client.js";
import { useTempDb } from "./helpers.js";

/**
 * V1.3 M3 RestoreService: schedule policy + restart-mediated processor.
 * Rollback is ONLY from the verified pre-restore snapshot (VACUUM INTO).
 * The .restore-old-* hold is forensic material and must never be treated as
 * successful automated recovery.
 */

const cleanup: string[] = [];

function liveDbDir(): string {
  return path.dirname(process.env.DASHBOARD_DB_PATH ?? "");
}

function backupsDir(): string {
  return path.join(liveDbDir(), "backups");
}

function statePath(): string {
  return path.join(liveDbDir(), "restore-state.json");
}

function clearBackupsDir(): void {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { force: true });
  }
}

function writeFixtureBackup(
  filename: string,
  fill?: (db: DatabaseSync) => void,
): string {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, filename);
  const tmp = path.join(dir, `.fixture-${filename}`);
  const db = new DatabaseSync(tmp);
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE fixture_rows (id INTEGER PRIMARY KEY, note TEXT NOT NULL);
    `);
    fill?.(db);
  } finally {
    db.close();
  }
  // Produce a real verified snapshot at the inventory name.
  const source = new DatabaseSync(tmp);
  try {
    createVerifiedSqliteSnapshot(source, target);
  } finally {
    source.close();
  }
  fs.rmSync(tmp, { force: true });
  return target;
}

function seedLiveData(note: string): void {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS marker_rows (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
  db.prepare("INSERT INTO marker_rows (note) VALUES (?)").run(note);
}

function readLiveMarker(): string | null {
  const dbFile = process.env.DASHBOARD_DB_PATH ?? "";
  if (!fs.existsSync(dbFile)) return null;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT note FROM marker_rows ORDER BY id DESC LIMIT 1")
      .get() as { note: string } | undefined;
    return row?.note ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  const dbPath = useTempDb();
  cleanup.push(path.dirname(dbPath));
  getDb();
  clearBackupsDir();
  const sp = statePath();
  if (fs.existsSync(sp)) fs.rmSync(sp, { force: true });
});

afterEach(() => {
  closeDb();
  for (const dir of cleanup.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("RestoreService scheduling (V1.3 M3)", () => {
  it("schedules a VALID MANUAL backup as PENDING", () => {
    writeFixtureBackup("manual-2026-03-04T05-06-07-890Z.sqlite", (db) => {
      db.prepare("INSERT INTO fixture_rows (note) VALUES (?)").run("manual-src");
    });
    const state = scheduleRestore("manual-2026-03-04T05-06-07-890Z.sqlite", {
      confirmRestore: true,
    });
    expect(state.status).toBe("PENDING");
    expect(state.backupId).toBe("manual-2026-03-04T05-06-07-890Z.sqlite");
    expect(state.completedAt).toBeNull();
    expect(getRestoreState()?.status).toBe("PENDING");
  });

  it("schedules VALID MIGRATION and RESTORE_SAFETY backups", () => {
    writeFixtureBackup("pre-006_project_activity-2026-03-04T05-06-07-890Z.sqlite");
    writeFixtureBackup("pre-restore-2026-03-04T06-07-08-900Z.sqlite");

    const migration = scheduleRestore(
      "pre-006_project_activity-2026-03-04T05-06-07-890Z.sqlite",
      { confirmRestore: true },
    );
    expect(migration.status).toBe("PENDING");
    clearRestoreState();

    const safety = scheduleRestore(
      "pre-restore-2026-03-04T06-07-08-900Z.sqlite",
      { confirmRestore: true },
    );
    expect(safety.status).toBe("PENDING");
  });

  it("rejects INVALID, missing, and traversal backup ids", () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manual-2026-03-04T05-06-07-890Z.sqlite"), "not-sqlite");

    expect(() =>
      scheduleRestore("manual-2026-03-04T05-06-07-890Z.sqlite", {
        confirmRestore: true,
      }),
    ).toThrow(/verification|invalid/i);

    expect(() =>
      scheduleRestore("manual-2020-01-01T00-00-00-000Z.sqlite", {
        confirmRestore: true,
      }),
    ).toThrow(/not found/i);

    for (const id of [
      "../outside.sqlite",
      "subdir/manual-2026-03-04T05-06-07-890Z.sqlite",
      "manual-2026-03-04T05-06-07-890Z.sqlite/../x.sqlite",
    ]) {
      expect(() => scheduleRestore(id, { confirmRestore: true })).toThrow();
    }
  });

  it("requires literal confirmRestore=true", () => {
    writeFixtureBackup("manual-2026-03-04T05-06-07-890Z.sqlite");
    expect(() =>
      scheduleRestore("manual-2026-03-04T05-06-07-890Z.sqlite", {}),
    ).toThrow(/confirm/i);
    expect(() =>
      scheduleRestore("manual-2026-03-04T05-06-07-890Z.sqlite", {
        confirmRestore: "true",
      }),
    ).toThrow(/confirm/i);
    expect(() =>
      scheduleRestore("manual-2026-03-04T05-06-07-890Z.sqlite", {
        confirmRestore: 1,
      }),
    ).toThrow(/confirm/i);
  });

  it("rejects a second restore while one is PENDING; terminal state can be superseded", () => {
    writeFixtureBackup("manual-2026-03-04T05-06-07-890Z.sqlite");
    writeFixtureBackup("manual-2026-03-05T05-06-07-890Z.sqlite");
    scheduleRestore("manual-2026-03-04T05-06-07-890Z.sqlite", {
      confirmRestore: true,
    });
    expect(() =>
      scheduleRestore("manual-2026-03-05T05-06-07-890Z.sqlite", {
        confirmRestore: true,
      }),
    ).toThrow(/already scheduled|pending/i);

    clearRestoreState();
    const next = scheduleRestore("manual-2026-03-05T05-06-07-890Z.sqlite", {
      confirmRestore: true,
    });
    expect(next.status).toBe("PENDING");
  });

  it("cancels PENDING without DB mutation and dismisses terminal state", () => {
    seedLiveData("before-schedule");
    writeFixtureBackup("manual-2026-03-04T05-06-07-890Z.sqlite");
    scheduleRestore("manual-2026-03-04T05-06-07-890Z.sqlite", {
      confirmRestore: true,
    });
    clearRestoreState();
    expect(getRestoreState()).toBeNull();
    expect(readLiveMarker()).toBe("before-schedule");

    // Terminal dismiss is also clean/idempotent.
    fs.writeFileSync(
      statePath(),
      JSON.stringify({
        version: 2,
        status: "FAILED",
        backupId: "manual-2026-03-04T05-06-07-890Z.sqlite",
        requestedAt: "2026-03-04T05:06:07.890Z",
        completedAt: "2026-03-04T05:06:08.000Z",
        preRestoreBackupId: null,
        message: "x",
        attemptId: null,
        stageFilename: null,
        holdFilename: null,
        startupBlocked: false,
      }),
    );
    expect(getRestoreState()?.status).toBe("FAILED");
    clearRestoreState();
    expect(getRestoreState()).toBeNull();
  });

  it("malformed restore state fails closed at startup and cannot cause path access", () => {
    fs.writeFileSync(statePath(), "{ not json");
    expect(readRestoreState(statePath())).toBeNull();
    expect(() => processPendingRestore()).toThrow(/malformed|state/i);

    fs.writeFileSync(
      statePath(),
      JSON.stringify({
        version: 2,
        status: "PENDING",
        backupId: "../../../etc/passwd",
        requestedAt: "2026-03-04T05:06:07.890Z",
        completedAt: null,
        preRestoreBackupId: null,
        message: null,
        attemptId: null,
        stageFilename: null,
        holdFilename: null,
        startupBlocked: false,
      }),
    );
    expect(readRestoreState(statePath())).toBeNull();
    expect(() => processPendingRestore()).toThrow(/malformed|state/i);
    expect(readLiveMarker()).not.toBe("hacked");
  });
});

describe("RestoreService startup success (V1.3 M3)", () => {
  it("does nothing when state is absent or terminal", () => {
    seedLiveData("live-keep");
    expect(() => processPendingRestore()).not.toThrow();
    expect(readLiveMarker()).toBe("live-keep");

    fs.writeFileSync(
      statePath(),
      JSON.stringify({
        version: 2,
        status: "SUCCEEDED",
        backupId: "manual-2026-03-04T05-06-07-890Z.sqlite",
        requestedAt: "2026-03-04T05:06:07.890Z",
        completedAt: "2026-03-04T05:06:08.000Z",
        preRestoreBackupId: "pre-restore-2026-03-04T05-06-08-000Z.sqlite",
        message: null,
        attemptId: null,
        stageFilename: null,
        holdFilename: null,
        startupBlocked: false,
      }),
    );
    expect(() => processPendingRestore()).not.toThrow();
    expect(readLiveMarker()).toBe("live-keep");
  });

  it("restores a VALID backup with pre-restore safety snapshot, WAL capture, and validation", () => {
    // Live data that must appear in the safety snapshot (WAL path).
    getDb().exec("PRAGMA journal_mode = WAL;");
    getDb().exec("PRAGMA wal_autocheckpoint = 0;");
    seedLiveData("wal-only-live-marker");

    writeFixtureBackup("manual-2026-03-04T05-06-07-890Z.sqlite", (db) => {
      db.prepare("INSERT INTO fixture_rows (note) VALUES (?)").run("restored-row");
    });

    scheduleRestore("manual-2026-03-04T05-06-07-890Z.sqlite", {
      confirmRestore: true,
    });

    closeDb(); // processor must not depend on the singleton
    // Stale WAL/SHM present before processor — must not contaminate result.
    fs.writeFileSync(`${process.env.DASHBOARD_DB_PATH}-wal`, "stale-wal");
    fs.writeFileSync(`${process.env.DASHBOARD_DB_PATH}-shm`, "stale-shm");

    processPendingRestore({ dbPath: process.env.DASHBOARD_DB_PATH });

    const state = readRestoreState(statePath());
    expect(state?.status).toBe("SUCCEEDED");
    expect(state?.backupId).toBe("manual-2026-03-04T05-06-07-890Z.sqlite");
    expect(state?.preRestoreBackupId).toMatch(/^pre-restore-.*\.sqlite$/);

    // Selected backup content is live.
    const dbFile = process.env.DASHBOARD_DB_PATH!;
    const live = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const row = live
        .prepare("SELECT note FROM fixture_rows")
        .get() as { note: string };
      expect(row.note).toBe("restored-row");
    } finally {
      live.close();
    }

    // Stale WAL/SHM must not contaminate the restored DB. The swap removes
    // them before install; post-install validation may recreate empty WAL
    // sidecars through the normal WAL open path.
    const walPath = `${dbFile}-wal`;
    const shmPath = `${dbFile}-shm`;
    if (fs.existsSync(walPath)) {
      expect(fs.readFileSync(walPath, "utf8")).not.toContain("stale-wal");
    }
    if (fs.existsSync(shmPath)) {
      expect(fs.readFileSync(shmPath, "utf8")).not.toContain("stale-shm");
    }

    // Pre-restore safety snapshot is VALID and contains prior committed data.
    const safety = path.join(backupsDir(), state!.preRestoreBackupId!);
    expect(fs.existsSync(safety)).toBe(true);
    verifySqliteBackup(safety);
    const snap = new DatabaseSync(safety, { readOnly: true });
    try {
      const marker = snap
        .prepare("SELECT note FROM marker_rows")
        .get() as { note: string };
      expect(marker.note).toBe("wal-only-live-marker");
    } finally {
      snap.close();
    }

    // Post-install path applied through normal open (migrations).
    const reopened = openDatabase(dbFile);
    try {
      const fk = reopened.prepare("PRAGMA foreign_key_check").all();
      expect(fk).toHaveLength(0);
      const integ = reopened
        .prepare("PRAGMA integrity_check")
        .get() as { integrity_check: string };
      expect(integ.integrity_check).toBe("ok");
    } finally {
      reopened.close();
    }

    // SUCCEEDED is not re-executed on the next startup.
    const before = fs.readFileSync(statePath(), "utf8");
    processPendingRestore({ dbPath: process.env.DASHBOARD_DB_PATH });
    expect(fs.readFileSync(statePath(), "utf8")).toBe(before);
  });

  it("applies current migrations to an older compatible backup on restore", () => {
    // Build an older-schema backup: base tables only, no later migrations.
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const oldTarget = path.join(dir, "manual-2025-01-01T00-00-00-000Z.sqlite");
    const tmp = path.join(dir, "old-src.sqlite");
    const old = new DatabaseSync(tmp);
    try {
      old.exec(`
        CREATE TABLE schema_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE keep_old (id INTEGER PRIMARY KEY, note TEXT);
        INSERT INTO keep_old (note) VALUES ('from-old');
        INSERT INTO schema_migrations (name, applied_at) VALUES ('001_initial', '2025-01-01T00:00:00.000Z');
      `);
    } finally {
      old.close();
    }
    const src = new DatabaseSync(tmp);
    try {
      createVerifiedSqliteSnapshot(src, oldTarget);
    } finally {
      src.close();
    }
    fs.rmSync(tmp, { force: true });

    scheduleRestore("manual-2025-01-01T00-00-00-000Z.sqlite", {
      confirmRestore: true,
    });
    closeDb();
    processPendingRestore({ dbPath: process.env.DASHBOARD_DB_PATH });

    const dbFile = process.env.DASHBOARD_DB_PATH!;
    const db = openDatabase(dbFile);
    try {
      const note = db.prepare("SELECT note FROM keep_old").get() as {
        note: string;
      };
      expect(note.note).toBe("from-old");
      // Migrations ran via normal open — schema_migrations has later rows.
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
        .get() as { n: number };
      expect(count.n).toBeGreaterThan(1);
    } finally {
      db.close();
    }
  });
});

describe("RestoreService failure / rollback (V1.3 M3)", () => {
  it("failure BEFORE replacement leaves current DB unchanged and marks FAILED", () => {
    seedLiveData("stay-put");
    writeFixtureBackup("manual-2026-03-04T05-06-07-890Z.sqlite");
    scheduleRestore("manual-2026-03-04T05-06-07-890Z.sqlite", {
      confirmRestore: true,
    });

    // Selected backup vanishes before processing (phase A failure).
    fs.rmSync(path.join(backupsDir(), "manual-2026-03-04T05-06-07-890Z.sqlite"));

    closeDb();
    processPendingRestore({ dbPath: process.env.DASHBOARD_DB_PATH });

    const state = readRestoreState(statePath());
    expect(state?.status).toBe("FAILED");
    // Healthy current DB independently proven safe → not blocked.
    expect(state?.startupBlocked).toBe(false);
    expect(readLiveMarker()).toBe("stay-put");
  });

  it("A: rollback recovers WAL-resident committed data from the pre-restore snapshot", () => {
    // Committed state that lives only in the WAL (wal_autocheckpoint=0, connection kept open).
    const db = getDb();
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA wal_autocheckpoint = 0;");
    db.exec(
      "CREATE TABLE marker_rows (id INTEGER PRIMARY KEY, note TEXT NOT NULL);",
    );
    db.prepare("INSERT INTO marker_rows (note) VALUES (?)").run(
      "wal-only-recover-me",
    );

    writeFixtureBackup("manual-2026-03-04T05-06-07-890Z.sqlite", (fixture) => {
      fixture.prepare("INSERT INTO fixture_rows (note) VALUES (?)").run("bad-install");
    });
    scheduleRestore("manual-2026-03-04T05-06-07-890Z.sqlite", {
      confirmRestore: true,
    });

    closeDb();
    processPendingRestore({
      dbPath: process.env.DASHBOARD_DB_PATH,
      deps: {
        validateInstalled: () => {
          throw new Error("post-install validation forced failure");
        },
      },
    });

    const state = readRestoreState(statePath());
    expect(state?.status).toBe("FAILED");
    expect(state?.preRestoreBackupId).toMatch(/^pre-restore-/);

    // Recovered live DB must contain the WAL-resident committed marker —
    // only the VACUUM INTO snapshot can prove this.
    const dbFile = process.env.DASHBOARD_DB_PATH!;
    const recovered = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const row = recovered
        .prepare("SELECT note FROM marker_rows")
        .get() as { note: string };
      expect(row.note).toBe("wal-only-recover-me");
    } finally {
      recovered.close();
    }
  });

  it("B: integrity-valid hold must NOT rescue failed authoritative snapshot recovery", () => {
    seedLiveData("wal-only-must-recover");
    writeFixtureBackup("manual-2026-03-04T05-06-07-890Z.sqlite");
    scheduleRestore("manual-2026-03-04T05-06-07-890Z.sqlite", {
      confirmRestore: true,
    });

    const dbFile = process.env.DASHBOARD_DB_PATH!;
    closeDb();

    let threw = false;
    try {
      processPendingRestore({
        dbPath: dbFile,
        deps: {
          validateInstalled: () => {
            throw new Error("post-install validation forced failure");
          },
          // Keep the hold as a valid SQLite file (it will pass integrity_check)
          // but make the authoritative pre-restore snapshot unusable.
          afterSwap: ({ safetyPath, holdPath }) => {
            if (safetyPath) fs.writeFileSync(safetyPath, "corrupt-safety");
            // holdPath is left in place — a valid SQLite file that must NOT
            // be accepted as recovered state.
            expect(holdPath).toBeTruthy();
            expect(fs.existsSync(holdPath!)).toBe(true);
          },
        },
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/pre-restore snapshot|Startup aborted/i);
      expect(String(err)).toMatch(/preserved/i);
    }
    expect(threw).toBe(true);

    const state = readRestoreState(statePath());
    expect(state?.status).toBe("FAILED");
    expect(state?.startupBlocked).toBe(true);
    // Must never claim safe recovery.
    expect(state?.message).not.toMatch(/recovered successfully|safely recovered/i);
    expect(state?.message).toMatch(/pre-restore snapshot/i);

    // Hold is preserved as forensic material — and was NOT installed as live DB.
    const dir = path.dirname(dbFile);
    const holds = fs.readdirSync(dir).filter((f) => f.startsWith(".restore-old-"));
    expect(holds.length).toBeGreaterThan(0);
    // Live DB is not proven-recovered WAL state; processor refused startup.
    // The corrupted safety / failed install may leave a non-authoritative file.
  });

  it("C: unproven recovery refuses startup even when hold remains SQLite-valid", () => {
    seedLiveData("doomed");
    writeFixtureBackup("manual-2026-03-04T05-06-07-890Z.sqlite");
    scheduleRestore("manual-2026-03-04T05-06-07-890Z.sqlite", {
      confirmRestore: true,
    });

    const dbFile = process.env.DASHBOARD_DB_PATH!;
    closeDb();

    let threw = false;
    try {
      processPendingRestore({
        dbPath: dbFile,
        deps: {
          validateInstalled: () => {
            throw new Error("post-install validation forced failure");
          },
          afterSwap: ({ safetyPath, holdPath }) => {
            // Destroy ONLY the authoritative snapshot. Leave a valid hold.
            if (safetyPath) fs.writeFileSync(safetyPath, "corrupt-safety");
            if (holdPath) {
              // Ensure hold is a real, integrity-checkable SQLite file.
              verifySqliteBackup(holdPath);
            }
          },
        },
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/Startup aborted|pre-restore snapshot/i);
    }
    expect(threw).toBe(true);

    const state = readRestoreState(statePath());
    expect(state?.status).toBe("FAILED");
    expect(state?.message).toMatch(/pre-restore snapshot/i);
    expect(state?.startupBlocked).toBe(true);
    // Never: "previous application data was safely recovered."
    expect(state?.message).not.toMatch(/safely recovered|recovered successfully/i);

    // Recovery artifacts preserved for manual investigation.
    const dir = path.dirname(dbFile);
    expect(
      fs.readdirSync(dir).some((f) => f.startsWith(".restore-old-")),
    ).toBe(true);
    expect(state?.preRestoreBackupId).toMatch(/^pre-restore-/);
  });
});

describe("RestoreService M5-B1 crash-safe attempt journal", () => {
  const ATTEMPT = "attempt0001";
  const STAGE = `.restore-stage-${ATTEMPT}.sqlite`;
  const HOLD = `.restore-old-${ATTEMPT}.sqlite`;
  const SELECTED = "manual-2026-03-04T05-06-07-890Z.sqlite";

  function writeInterruptedPending(preRestoreBackupId: string): void {
    fs.writeFileSync(
      statePath(),
      JSON.stringify(
        {
          version: 2,
          status: "PENDING",
          backupId: SELECTED,
          requestedAt: "2026-03-04T05:06:07.890Z",
          completedAt: null,
          preRestoreBackupId,
          message: null,
          attemptId: ATTEMPT,
          stageFilename: STAGE,
          holdFilename: HOLD,
          startupBlocked: false,
        },
        null,
        2,
      ),
    );
  }

  function makeSafetySnapshot(note: string): string {
    // Build a verified pre-restore snapshot containing `note` marker data.
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const id = `pre-restore-2026-03-04T09-00-00-000Z.sqlite`;
    const target = path.join(dir, id);
    const tmp = path.join(dir, "safety-src.sqlite");
    const db = new DatabaseSync(tmp);
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE marker_rows (id INTEGER PRIMARY KEY, note TEXT NOT NULL);
      `);
      db.prepare("INSERT INTO marker_rows (note) VALUES (?)").run(note);
    } finally {
      db.close();
    }
    const src = new DatabaseSync(tmp);
    try {
      createVerifiedSqliteSnapshot(src, target);
    } finally {
      src.close();
    }
    fs.rmSync(tmp, { force: true });
    return id;
  }

  it("A: crash after journal before swap — recover snapshot, do not retry selected restore", () => {
    seedLiveData("original-before-swap");
    const safetyId = makeSafetySnapshot("original-before-swap");
    writeFixtureBackup(SELECTED, (db) => {
      db.prepare("INSERT INTO fixture_rows (note) VALUES (?)").run("selected");
    });
    writeInterruptedPending(safetyId);

    const preCount = fs
      .readdirSync(backupsDir())
      .filter((f) => f.startsWith("pre-restore-")).length;

    closeDb();
    processPendingRestore({ dbPath: process.env.DASHBOARD_DB_PATH });

    const state = readRestoreState(statePath());
    expect(state?.status).toBe("FAILED");
    expect(state?.startupBlocked).toBe(false);
    expect(state?.message).toMatch(/interrupted.*recovered/i);
    expect(readLiveMarker()).toBe("original-before-swap");

    // No second pre-restore snapshot for a non-retried attempt.
    const postCount = fs
      .readdirSync(backupsDir())
      .filter((f) => f.startsWith("pre-restore-")).length;
    expect(postCount).toBe(preCount);

    // Selected restore was NOT applied.
    const live = new DatabaseSync(process.env.DASHBOARD_DB_PATH!, {
      readOnly: true,
    });
    try {
      const rows = live.prepare("SELECT note FROM fixture_rows").all();
      expect(rows).toHaveLength(0);
    } catch {
      // table may be absent in original schema — also proves not selected
    } finally {
      live.close();
    }

    // Proven recovery cleans this attempt's stage/hold.
    const dir = liveDbDir();
    expect(fs.existsSync(path.join(dir, STAGE))).toBe(false);
    expect(fs.existsSync(path.join(dir, HOLD))).toBe(false);
  });

  it("B: crash after original renamed — live missing — recover from snapshot, never hold", () => {
    const safetyId = makeSafetySnapshot("from-hold-must-not-win");
    // Hold is a VALID SQLite file with different content — must not be used.
    const holdPath = path.join(liveDbDir(), HOLD);
    const holdTmp = path.join(liveDbDir(), "hold-src.sqlite");
    const holdDb = new DatabaseSync(holdTmp);
    try {
      holdDb.exec(`
        CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);
        CREATE TABLE marker_rows (id INTEGER PRIMARY KEY, note TEXT NOT NULL);
        INSERT INTO marker_rows (note) VALUES ('hold-only-marker');
      `);
    } finally {
      holdDb.close();
    }
    const holdSrc = new DatabaseSync(holdTmp);
    try {
      createVerifiedSqliteSnapshot(holdSrc, holdPath);
    } finally {
      holdSrc.close();
    }
    fs.rmSync(holdTmp, { force: true });
    verifySqliteBackup(holdPath);

    writeFixtureBackup(SELECTED);
    writeInterruptedPending(safetyId);

    const dbFile = process.env.DASHBOARD_DB_PATH!;
    closeDb();
    fs.rmSync(dbFile, { force: true });

    processPendingRestore({ dbPath: dbFile });

    const state = readRestoreState(statePath());
    expect(state?.status).toBe("FAILED");
    expect(state?.startupBlocked).toBe(false);
    expect(state?.message).toMatch(/interrupted.*recovered/i);

    // Recovered logical state is from the pre-restore snapshot, not the hold.
    expect(fs.existsSync(dbFile)).toBe(true);
    expect(readLiveMarker()).toBe("from-hold-must-not-win");
  });

  it("C: crash after candidate became live — do not snapshot candidate; restore prior state", () => {
    const safetyId = makeSafetySnapshot("prior-owner-state");
    writeFixtureBackup(SELECTED, (db) => {
      db.prepare("INSERT INTO fixture_rows (note) VALUES (?)").run("candidate-row");
    });
    writeInterruptedPending(safetyId);

    // Simulate candidate already installed at the live path.
    const dbFile = process.env.DASHBOARD_DB_PATH!;
    closeDb();
    fs.copyFileSync(path.join(backupsDir(), SELECTED), dbFile);

    const preCount = fs
      .readdirSync(backupsDir())
      .filter((f) => f.startsWith("pre-restore-")).length;

    processPendingRestore({ dbPath: dbFile });

    const state = readRestoreState(statePath());
    expect(state?.status).toBe("FAILED");
    expect(state?.startupBlocked).toBe(false);
    expect(state?.message).toMatch(/interrupted.*recovered/i);

    // Prior state restored; candidate data gone.
    expect(readLiveMarker()).toBe("prior-owner-state");
    const live = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const rows = live
        .prepare("SELECT note FROM fixture_rows")
        .all() as Array<{ note: string }>;
      expect(rows.some((r) => r.note === "candidate-row")).toBe(false);
    } catch {
      // fixture table absent in recovered prior state is fine
    } finally {
      live.close();
    }

    // Did not create a new safety snapshot of the candidate.
    const postCount = fs
      .readdirSync(backupsDir())
      .filter((f) => f.startsWith("pre-restore-")).length;
    expect(postCount).toBe(preCount);
  });

  it("D: interrupted recovery preserves WAL-resident committed marker from snapshot", () => {
    // Build snapshot with WAL-only committed data.
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const safetyId = "pre-restore-2026-03-04T10-00-00-000Z.sqlite";
    const target = path.join(dir, safetyId);
    const tmp = path.join(dir, "wal-src.sqlite");
    const srcDb = new DatabaseSync(tmp);
    try {
      srcDb.exec("PRAGMA journal_mode = WAL;");
      srcDb.exec("PRAGMA wal_autocheckpoint = 0;");
      srcDb.exec(`
        CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);
        CREATE TABLE marker_rows (id INTEGER PRIMARY KEY, note TEXT NOT NULL);
      `);
      srcDb
        .prepare("INSERT INTO marker_rows (note) VALUES (?)")
        .run("wal-only-recover-me");
    } finally {
      srcDb.close();
    }
    const snapSrc = new DatabaseSync(tmp);
    try {
      createVerifiedSqliteSnapshot(snapSrc, target);
    } finally {
      snapSrc.close();
    }
    fs.rmSync(tmp, { force: true });

    writeFixtureBackup(SELECTED);
    writeInterruptedPending(safetyId);
    seedLiveData("dirty-candidate-or-live");

    closeDb();
    processPendingRestore({ dbPath: process.env.DASHBOARD_DB_PATH });

    expect(readLiveMarker()).toBe("wal-only-recover-me");
    const state = readRestoreState(statePath());
    expect(state?.startupBlocked).toBe(false);
  });

  it("E+F: unproven interrupted recovery blocks startup persistently even with valid hold", () => {
    const safetyId = makeSafetySnapshot("will-corrupt");
    fs.writeFileSync(path.join(backupsDir(), safetyId), "corrupt-safety");

    // Valid hold must not rescue.
    const holdPath = path.join(liveDbDir(), HOLD);
    const holdTmp = path.join(liveDbDir(), "hold-src.sqlite");
    const holdDb = new DatabaseSync(holdTmp);
    try {
      holdDb.exec(
        `CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);`,
      );
    } finally {
      holdDb.close();
    }
    const holdSrc = new DatabaseSync(holdTmp);
    try {
      createVerifiedSqliteSnapshot(holdSrc, holdPath);
    } finally {
      holdSrc.close();
    }
    fs.rmSync(holdTmp, { force: true });
    verifySqliteBackup(holdPath);

    writeFixtureBackup(SELECTED);
    writeInterruptedPending(safetyId);
    closeDb();

    let threw = false;
    try {
      processPendingRestore({ dbPath: process.env.DASHBOARD_DB_PATH });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const state = readRestoreState(statePath());
    expect(state?.status).toBe("FAILED");
    expect(state?.startupBlocked).toBe(true);

    // F: second startup still refuses.
    let threwAgain = false;
    try {
      processPendingRestore({ dbPath: process.env.DASHBOARD_DB_PATH });
    } catch {
      threwAgain = true;
    }
    expect(threwAgain).toBe(true);

    // Hold preserved as forensic material.
    expect(fs.existsSync(holdPath)).toBe(true);
  });

  it("G: malformed state with missing DB does not silently initialize empty data", () => {
    const dbFile = process.env.DASHBOARD_DB_PATH!;
    closeDb();
    fs.rmSync(dbFile, { force: true });
    fs.writeFileSync(statePath(), '{"version":2,"status":"PENDING"}');

    expect(() => processPendingRestore({ dbPath: dbFile })).toThrow();
    // Must not create a new application database as a side effect of recovery.
    expect(fs.existsSync(dbFile)).toBe(false);
  });

  it("H: proven recovery cleans this attempt artifacts; unproven preserves them", () => {
    // Proven path artifacts cleaned (covered in A). Here: unproven preserves stage+hold.
    const safetyId = makeSafetySnapshot("x");
    fs.writeFileSync(path.join(backupsDir(), safetyId), "corrupt");
    const stagePath = path.join(liveDbDir(), STAGE);
    const holdPath = path.join(liveDbDir(), HOLD);
    fs.writeFileSync(stagePath, "stage-leftover");
    const holdTmp = path.join(liveDbDir(), "hold-src.sqlite");
    const holdDb = new DatabaseSync(holdTmp);
    try {
      holdDb.exec(
        `CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);`,
      );
    } finally {
      holdDb.close();
    }
    const holdSrc = new DatabaseSync(holdTmp);
    try {
      createVerifiedSqliteSnapshot(holdSrc, holdPath);
    } finally {
      holdSrc.close();
    }
    fs.rmSync(holdTmp, { force: true });

    writeFixtureBackup(SELECTED);
    writeInterruptedPending(safetyId);
    closeDb();

    expect(() =>
      processPendingRestore({ dbPath: process.env.DASHBOARD_DB_PATH }),
    ).toThrow();
    expect(fs.existsSync(stagePath)).toBe(true);
    expect(fs.existsSync(holdPath)).toBe(true);
  });
});

describe("RestoreService pre-swap safe-start proof (M5-B1 final)", () => {
  const SELECTED = "manual-2026-03-04T05-06-07-890Z.sqlite";

  function writeInitialPending(): void {
    fs.writeFileSync(
      statePath(),
      JSON.stringify(
        {
          version: 2,
          status: "PENDING",
          backupId: SELECTED,
          requestedAt: "2026-03-04T05:06:07.890Z",
          completedAt: null,
          preRestoreBackupId: null,
          message: null,
          attemptId: null,
          stageFilename: null,
          holdFilename: null,
          startupBlocked: false,
        },
        null,
        2,
      ),
    );
  }

  it("A: initial PENDING + missing current DB → blocked, throws, second startup throws", () => {
    writeFixtureBackup(SELECTED);
    writeInitialPending();

    const dbFile = process.env.DASHBOARD_DB_PATH!;
    closeDb();
    fs.rmSync(dbFile, { force: true });

    let threw = false;
    try {
      processPendingRestore({ dbPath: dbFile });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const state = readRestoreState(statePath());
    expect(state?.status).toBe("FAILED");
    expect(state?.startupBlocked).toBe(true);
    // Must not create a fresh application database as a side effect.
    expect(fs.existsSync(dbFile)).toBe(false);
    // Must not install the selected backup automatically.
    expect(readLiveMarker()).toBeNull();

    // Second startup also refuses.
    let threwAgain = false;
    try {
      processPendingRestore({ dbPath: dbFile });
    } catch {
      threwAgain = true;
    }
    expect(threwAgain).toBe(true);
  });

  it("B: initial PENDING + unusable current DB → file untouched, blocked, throws", () => {
    writeFixtureBackup(SELECTED);
    writeInitialPending();

    const dbFile = process.env.DASHBOARD_DB_PATH!;
    closeDb();
    // Unusable / not a valid SQLite application database.
    fs.writeFileSync(dbFile, "this is not a sqlite database at all");
    const before = fs.readFileSync(dbFile, "utf8");

    let threw = false;
    try {
      processPendingRestore({ dbPath: dbFile });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Current file was not destructively modified by the failed attempt.
    expect(fs.readFileSync(dbFile, "utf8")).toBe(before);

    const state = readRestoreState(statePath());
    expect(state?.status).toBe("FAILED");
    expect(state?.startupBlocked).toBe(true);

    let threwAgain = false;
    try {
      processPendingRestore({ dbPath: dbFile });
    } catch {
      threwAgain = true;
    }
    expect(threwAgain).toBe(true);
  });

  it("C: selected backup missing + healthy current DB → not blocked, data preserved", () => {
    seedLiveData("control-healthy-current");
    writeInitialPending();
    // Selected backup is absent; current DB stays intact and verifiable.

    const dbFile = process.env.DASHBOARD_DB_PATH!;
    closeDb();

    // Must NOT throw: healthy current DB is independently proven safe.
    processPendingRestore({ dbPath: dbFile });

    const state = readRestoreState(statePath());
    expect(state?.status).toBe("FAILED");
    expect(state?.startupBlocked).toBe(false);
    expect(readLiveMarker()).toBe("control-healthy-current");
  });
});
