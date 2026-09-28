import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RestoreStateDto, RestoreStatus } from "@shared/api-types";
import {
  createVerifiedSqliteSnapshot,
  verifySqliteBackup,
} from "../db/backup.js";
import {
  backupDirForDbFile,
  classifyBackupFilename,
  isSafeBackupId,
  resolveInsideBackupDir,
  uniqueRestoreSafetyTarget,
} from "../db/backupPolicy.js";
import { config } from "../config.js";
import { getDb, openDatabase } from "../db/client.js";
import { AppError, ErrorCodes } from "../lib/errors.js";

/**
 * Restart-mediated restore (V1.3 M3).
 *
 * The running app only SCHEDULES a restore into a filesystem-backed
 * restore-state.json. Actual replacement happens in processPendingRestore()
 * at startup, BEFORE getDb() opens the application database.
 *
 * Safety rules:
 * - never replace the live DB from an HTTP request
 * - never accept an arbitrary restore source path from the client
 * - always create a verified pre-restore safety snapshot before mutation
 * - stage + verify before swap
 * - rollback uses ONLY the verified pre-restore snapshot (VACUUM INTO), which
 *   is the sole artifact guaranteed to include committed WAL state
 * - .restore-old-* hold is forensic/emergency material only — never an
 *   automated recovery source (SQLite-valid != complete logical state)
 * - tracked Git repositories are never touched
 */

export const RESTORE_STATE_FILENAME = "restore-state.json";
const RESTORE_STATE_VERSION = 1 as const;

type RestoreStateRecord = {
  version: typeof RESTORE_STATE_VERSION;
  status: RestoreStatus;
  backupId: string;
  requestedAt: string;
  completedAt: string | null;
  preRestoreBackupId: string | null;
  message: string | null;
};

/** Optional collaborators for deterministic failure tests (not a test mode). */
export type RestoreProcessorDeps = {
  verifyBackup: (target: string) => void;
  createSnapshot: (sourceDbPath: string, target: string) => void;
  validateInstalled: (dbFile: string) => void;
  /** Called after the staged candidate is in place, before post-install checks. */
  afterSwap?: (ctx: {
    dbFile: string;
    safetyPath: string | null;
    holdPath: string | null;
    stagePath: string | null;
  }) => void;
};

const defaultDeps: RestoreProcessorDeps = {
  verifyBackup: (target) => {
    verifySqliteBackup(target);
  },
  createSnapshot: (sourceDbPath, target) => {
    const source = new DatabaseSync(sourceDbPath);
    try {
      createVerifiedSqliteSnapshot(source, target);
    } finally {
      try {
        source.close();
      } catch {
        // best effort
      }
    }
  },
  validateInstalled: (dbFile) => {
    verifySqliteBackup(dbFile);
    // Normal application open path: applies migrations to older backups.
    const db = openDatabase(dbFile);
    try {
      const fkIssues = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
      if (fkIssues.length > 0) {
        throw new Error("foreign_key_check reported violations after restore.");
      }
      const integrity = db
        .prepare("PRAGMA integrity_check")
        .get() as { integrity_check: string };
      if (integrity.integrity_check !== "ok") {
        throw new Error(`integrity_check failed after restore: ${integrity.integrity_check}`);
      }
    } finally {
      try {
        db.close();
      } catch {
        // best effort
      }
    }
  },
};

function nowIso(): string {
  return new Date().toISOString();
}

function restoreStatePathForDbFile(dbFile: string): string {
  return path.join(path.dirname(path.resolve(dbFile)), RESTORE_STATE_FILENAME);
}

function liveMainDbFile(): string {
  const db = getDb();
  const rows = db.prepare("PRAGMA database_list").all() as Array<{
    name: string;
    file: string;
  }>;
  const main = rows.find((row) => row.name === "main");
  if (!main || main.file.trim() === "") {
    throw new AppError(
      ErrorCodes.RESTORE_FAILED,
      "No filesystem-backed application database is available.",
      500,
    );
  }
  return main.file;
}

/** Live-DB restore state path (M2/M3 request-time operations). */
function liveRestoreStatePath(): string {
  try {
    return restoreStatePathForDbFile(liveMainDbFile());
  } catch {
    return restoreStatePathForDbFile(config.dbPath);
  }
}

function restrainMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const cleaned = raw
    .replace(/[A-Za-z]:\\[^\s"')]+/g, "[path]")
    .replace(/\/(?:[^\s"')]*\/)*[^\s"')]+/g, (match) =>
      /backup|sqlite|restore/i.test(match) ? "[path]" : match,
    )
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 180) || "Restore failed.";
}

function isIsoLike(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  return !Number.isNaN(Date.parse(value));
}

function isShortMessage(value: unknown): value is string | null {
  if (value == null) return true;
  return typeof value === "string" && value.length <= 200;
}

/**
 * Validate a restore-state object read from disk.
 * Malformed state is treated as absent — never as a path to follow.
 */
function parseRestoreState(raw: unknown): RestoreStateRecord | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== RESTORE_STATE_VERSION) return null;
  const status = obj.status;
  if (status !== "PENDING" && status !== "SUCCEEDED" && status !== "FAILED") {
    return null;
  }
  if (!isSafeBackupId(obj.backupId)) return null;
  if (!isIsoLike(obj.requestedAt)) return null;
  if (obj.completedAt != null && !isIsoLike(obj.completedAt)) return null;
  if (obj.preRestoreBackupId != null) {
    if (!isSafeBackupId(obj.preRestoreBackupId)) return null;
  }
  if (!isShortMessage(obj.message)) return null;

  return {
    version: RESTORE_STATE_VERSION,
    status,
    backupId: obj.backupId,
    requestedAt: obj.requestedAt,
    completedAt: obj.completedAt == null ? null : (obj.completedAt as string),
    preRestoreBackupId:
      obj.preRestoreBackupId == null ? null : (obj.preRestoreBackupId as string),
    message: obj.message == null ? null : (obj.message as string),
  };
}

function writeRestoreStateAtomically(statePath: string, record: RestoreStateRecord): void {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${RESTORE_STATE_FILENAME}.tmp`);
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, statePath);
}

export function readRestoreState(statePath: string): RestoreStateRecord | null {
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parseRestoreState(raw);
  } catch {
    // Malformed state must not drive filesystem access or DB mutation.
    return null;
  }
}

function toDto(record: RestoreStateRecord): RestoreStateDto {
  return {
    status: record.status,
    backupId: record.backupId,
    requestedAt: record.requestedAt,
    completedAt: record.completedAt,
    preRestoreBackupId: record.preRestoreBackupId,
    message: record.message,
  };
}

function safeUnlink(target: string | null): void {
  if (!target) return;
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // best effort
  }
}

function removeWalShm(dbFile: string): void {
  safeUnlink(`${dbFile}-wal`);
  safeUnlink(`${dbFile}-shm`);
}

/** Current restore state for the live application database (or null). */
export function getRestoreState(): RestoreStateDto | null {
  const record = readRestoreState(liveRestoreStatePath());
  return record ? toDto(record) : null;
}

/**
 * Schedule a restart-mediated restore of one VALID app-managed backup.
 * Does NOT replace or close the live database and does NOT restart the process.
 */
export function scheduleRestore(id: unknown, body: unknown): RestoreStateDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(
      ErrorCodes.RESTORE_CONFIRM_REQUIRED,
      "Restore requires { confirmRestore: true }.",
      400,
    );
  }
  const confirm = (body as { confirmRestore?: unknown }).confirmRestore;
  if (confirm !== true) {
    throw new AppError(
      ErrorCodes.RESTORE_CONFIRM_REQUIRED,
      "Restore requires explicit confirmation { confirmRestore: true }.",
      400,
    );
  }

  if (!isSafeBackupId(id)) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      "Backup id must be an app-managed backup filename.",
      400,
    );
  }

  const statePath = liveRestoreStatePath();
  const existing = readRestoreState(statePath);
  if (existing && existing.status === "PENDING") {
    throw new AppError(
      ErrorCodes.RESTORE_ALREADY_PENDING,
      "A restore is already scheduled. Cancel it before scheduling another.",
      409,
    );
  }

  // Resolve strictly under the LIVE database's backups directory.
  const backupDir = backupDirForDbFile(liveMainDbFile());

  const selected = resolveInsideBackupDir(backupDir, id);
  if (!fs.existsSync(selected)) {
    throw new AppError(
      ErrorCodes.RESTORE_NOT_FOUND,
      "Backup was not found.",
      404,
    );
  }
  if (classifyBackupFilename(id) == null) {
    throw new AppError(
      ErrorCodes.RESTORE_BACKUP_INVALID,
      "Backup is not an app-managed backup.",
      400,
    );
  }
  try {
    verifySqliteBackup(selected);
  } catch {
    throw new AppError(
      ErrorCodes.RESTORE_BACKUP_INVALID,
      "Backup failed verification and cannot be restored.",
      400,
    );
  }

  const record: RestoreStateRecord = {
    version: RESTORE_STATE_VERSION,
    status: "PENDING",
    backupId: id,
    requestedAt: nowIso(),
    completedAt: null,
    preRestoreBackupId: null,
    message: null,
  };
  writeRestoreStateAtomically(statePath, record);
  return toDto(record);
}

/**
 * Cancel a PENDING restore, or dismiss a terminal SUCCEEDED/FAILED result.
 * Idempotent when no state exists.
 */
export function clearRestoreState(): void {
  const statePath = liveRestoreStatePath();
  if (!fs.existsSync(statePath)) return;
  safeUnlink(statePath);
}

export type ProcessPendingRestoreOptions = {
  /** Configured database file (startup has no live connection yet). */
  dbPath?: string;
  /** Injectable seams for deterministic failure tests. */
  deps?: Partial<RestoreProcessorDeps>;
};

/**
 * Startup restore processor. MUST run before getDb() opens the application DB.
 *
 * No PENDING state → no-op.
 * Terminal state → never re-executes.
 */
export function processPendingRestore(
  options: ProcessPendingRestoreOptions = {},
): void {
  const dbFile = path.resolve(options.dbPath ?? config.dbPath);
  const statePath = restoreStatePathForDbFile(dbFile);
  const deps: RestoreProcessorDeps = { ...defaultDeps, ...options.deps };

  const state = readRestoreState(statePath);
  if (state == null || state.status !== "PENDING") {
    return;
  }

  let preRestoreBackupId: string | null = state.preRestoreBackupId;
  let safetyPath: string | null = null;
  let stagePath: string | null = null;
  let holdPath: string | null = null;
  let replacementStarted = false;

  try {
    // ---- PHASE A: validate without mutating the current DB -----------------
    if (!isSafeBackupId(state.backupId)) {
      throw new AppError(
        ErrorCodes.RESTORE_STATE_INVALID,
        "Scheduled backup id is not an app-managed backup filename.",
      );
    }
    const backupDir = backupDirForDbFile(dbFile);
    const selectedPath = resolveInsideBackupDir(backupDir, state.backupId);
    if (!fs.existsSync(selectedPath)) {
      throw new AppError(
        ErrorCodes.RESTORE_NOT_FOUND,
        "Scheduled backup is missing.",
      );
    }
    if (classifyBackupFilename(state.backupId) == null) {
      throw new AppError(
        ErrorCodes.RESTORE_BACKUP_INVALID,
        "Scheduled backup is not recognized.",
      );
    }
    deps.verifyBackup(selectedPath);
    if (!fs.existsSync(dbFile)) {
      throw new AppError(
        ErrorCodes.RESTORE_FAILED,
        "Current application database is missing.",
      );
    }

    // ---- PHASE B: verified safety snapshot of CURRENT state ---------------
    // Raw open — do NOT run migrations merely to snapshot.
    fs.mkdirSync(backupDir, { recursive: true });
    const safetyTarget = uniqueRestoreSafetyTarget(backupDir, (p) =>
      fs.existsSync(p),
    );
    deps.createSnapshot(dbFile, safetyTarget);
    safetyPath = safetyTarget;
    preRestoreBackupId = path.basename(safetyTarget);

    // ---- STAGED CANDIDATE (never copy selected → live path directly) ------
    const stamp = preRestoreBackupId.replace(/^pre-restore-/, "").replace(/\.sqlite$/, "");
    stagePath = path.join(
      path.dirname(dbFile),
      `.restore-stage-${stamp}-${process.pid}.sqlite`,
    );
    safeUnlink(stagePath);
    fs.copyFileSync(selectedPath, stagePath);
    deps.verifyBackup(stagePath);

    // ---- SWAP -------------------------------------------------------------
    // Safety snapshot is verified: only now may stale WAL/SHM be cleared.
    replacementStarted = true;
    removeWalShm(dbFile);

    holdPath = path.join(
      path.dirname(dbFile),
      `.restore-old-${stamp}-${process.pid}.sqlite`,
    );
    // Hold is a swap/forensic artifact only. Automated rollback NEVER uses it
    // (it can omit committed WAL state). The pre-restore snapshot is authoritative.
    safeUnlink(holdPath);
    if (fs.existsSync(dbFile)) {
      fs.renameSync(dbFile, holdPath);
    }
    fs.copyFileSync(stagePath, dbFile);
    safeUnlink(stagePath);
    stagePath = null;

    deps.afterSwap?.({
      dbFile,
      safetyPath,
      holdPath,
      stagePath: null,
    });

    // ---- POST-INSTALL VALIDATION -----------------------------------------
    deps.validateInstalled(dbFile);

    // ---- SUCCESS ----------------------------------------------------------
    writeRestoreStateAtomically(statePath, {
      version: RESTORE_STATE_VERSION,
      status: "SUCCEEDED",
      backupId: state.backupId,
      requestedAt: state.requestedAt,
      completedAt: nowIso(),
      preRestoreBackupId,
      message: null,
    });
    // Success: hold is no longer needed as swap residue (safety snapshot is kept).
    safeUnlink(holdPath);
    holdPath = null;
  } catch (err) {
    const failureMessage = restrainMessage(err);

    if (replacementStarted) {
      const recovered = rollbackFromPreRestoreSnapshot(dbFile, safetyPath);
      if (!recovered) {
        // The pre-restore snapshot is the ONLY authoritative recovery source.
        // A .restore-old-* hold (even if SQLite-valid) must NEVER be treated
        // as safe recovery — it can omit committed WAL state. Preserve all
        // recovery artifacts and refuse startup.
        writeRestoreStateAtomically(statePath, {
          version: RESTORE_STATE_VERSION,
          status: "FAILED",
          backupId: state.backupId,
          requestedAt: state.requestedAt,
          completedAt: nowIso(),
          preRestoreBackupId,
          message:
            "Restore failed and the pre-restore snapshot could not be verified as recovered. Startup refused.",
        });
        throw new Error(
          "Restore failed and rollback from the verified pre-restore snapshot " +
            "could not be completed and verified. Startup aborted. " +
            "The pre-restore snapshot, selected backup, and swap hold were preserved " +
            "for manual investigation.",
        );
      }
    }

    writeRestoreStateAtomically(statePath, {
      version: RESTORE_STATE_VERSION,
      status: "FAILED",
      backupId: state.backupId,
      requestedAt: state.requestedAt,
      completedAt: nowIso(),
      preRestoreBackupId,
      message: failureMessage,
    });
    // Recoverable failure: allow normal startup to continue on current DB.
  } finally {
    safeUnlink(stagePath);
  }
}

/**
 * Recover previous logical state from the verified pre-restore snapshot.
 *
 * AUTHORITATIVE SOURCE ONLY: the pre-restore snapshot (VACUUM INTO) is the
 * sole artifact guaranteed to contain complete committed state, including
 * data that resided in WAL. The .restore-old-* hold is a swap/forensic
 * artifact and is NEVER accepted as automated recovery — it may open and
 * pass integrity_check while still missing committed WAL pages
 * (SQLite-valid != proven restoration of previous logical state).
 *
 * Returns true only when the snapshot is installed and verified with the
 * REAL M1 verifier — never with injectable test seams.
 */
function rollbackFromPreRestoreSnapshot(
  dbFile: string,
  safetyPath: string | null,
): boolean {
  if (!safetyPath || !fs.existsSync(safetyPath)) {
    return false;
  }

  try {
    // Clear candidate WAL/SHM so they cannot contaminate the recovered DB.
    safeUnlink(`${dbFile}-wal`);
    safeUnlink(`${dbFile}-shm`);
    safeUnlink(dbFile);

    // Install the verified pre-restore snapshot as the live DB.
    fs.copyFileSync(safetyPath, dbFile);

    // Recovery must be proven with the real verifier, not a stub.
    verifySqliteBackup(dbFile);
    const check = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const integrity = check
        .prepare("PRAGMA integrity_check")
        .get() as { integrity_check: string };
      if (integrity.integrity_check !== "ok") {
        return false;
      }
    } finally {
      try {
        check.close();
      } catch {
        // best effort
      }
    }
    return true;
  } catch {
    return false;
  }
}
