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
 * Restart-mediated restore (V1.3 M3 / M5-B1 crash-safe attempt journal).
 *
 * The running app only SCHEDULES a restore into filesystem-backed
 * restore-state.json. Actual replacement happens in processPendingRestore()
 * at startup, BEFORE getDb() opens the application database.
 *
 * Safety rules:
 * - never replace the live DB from an HTTP request
 * - never accept an arbitrary restore source path from the client
 * - persist an attempt journal (pre-restore id + stage/hold basenames) BEFORE
 *   any destructive filesystem mutation
 * - rollback / interrupted recovery use ONLY the verified pre-restore snapshot
 *   (VACUUM INTO) — the sole artifact that includes committed WAL state
 * - .restore-old-* hold is forensic material only — never automated recovery
 * - unproven recovery persists startupBlocked and blocks EVERY later startup
 * - malformed restore-state.json at startup fails closed (no silent empty DB)
 */

export const RESTORE_STATE_FILENAME = "restore-state.json";
const RESTORE_STATE_VERSION = 2 as const;

const ATTEMPT_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
const STAGE_FILENAME_RE = /^\.restore-stage-[A-Za-z0-9-]{8,80}\.sqlite$/;
const HOLD_FILENAME_RE = /^\.restore-old-[A-Za-z0-9-]{8,80}\.sqlite$/;

type RestoreStateRecord = {
  version: typeof RESTORE_STATE_VERSION;
  status: RestoreStatus;
  backupId: string;
  requestedAt: string;
  completedAt: string | null;
  preRestoreBackupId: string | null;
  message: string | null;
  /** Internal attempt identity (not part of the public DTO). */
  attemptId: string | null;
  /** Internal stage basename in the database directory. */
  stageFilename: string | null;
  /** Internal hold basename in the database directory. */
  holdFilename: string | null;
  /** When true, every later startup must refuse to continue. */
  startupBlocked: boolean;
};

type ReadStateResult =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "ok"; record: RestoreStateRecord };

/** Optional collaborators for deterministic failure tests (not a test mode). */
export type RestoreProcessorDeps = {
  verifyBackup: (target: string) => void;
  createSnapshot: (sourceDbPath: string, target: string) => void;
  validateInstalled: (dbFile: string) => void;
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

function isSafeArtifactName(value: unknown, re: RegExp): value is string {
  return typeof value === "string" && re.test(value);
}

/** Resolve an internal artifact basename strictly inside the database directory. */
function resolveArtifactInDbDir(dbFile: string, filename: string): string {
  const dir = path.resolve(path.dirname(dbFile));
  const target = path.resolve(dir, filename);
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (!target.startsWith(prefix)) {
    throw new AppError(
      ErrorCodes.RESTORE_STATE_INVALID,
      "Restore attempt artifact is outside the application data directory.",
    );
  }
  return target;
}

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
  if (obj.preRestoreBackupId != null && !isSafeBackupId(obj.preRestoreBackupId)) {
    return null;
  }
  if (!isShortMessage(obj.message)) return null;
  if (obj.startupBlocked != null && typeof obj.startupBlocked !== "boolean") {
    return null;
  }
  if (obj.attemptId != null && !isSafeArtifactName(obj.attemptId, ATTEMPT_ID_RE)) {
    return null;
  }
  if (obj.stageFilename != null && !isSafeArtifactName(obj.stageFilename, STAGE_FILENAME_RE)) {
    return null;
  }
  if (obj.holdFilename != null && !isSafeArtifactName(obj.holdFilename, HOLD_FILENAME_RE)) {
    return null;
  }

  return {
    version: RESTORE_STATE_VERSION,
    status,
    backupId: obj.backupId,
    requestedAt: obj.requestedAt,
    completedAt: obj.completedAt == null ? null : (obj.completedAt as string),
    preRestoreBackupId:
      obj.preRestoreBackupId == null ? null : (obj.preRestoreBackupId as string),
    message: obj.message == null ? null : (obj.message as string),
    attemptId: obj.attemptId == null ? null : (obj.attemptId as string),
    stageFilename: obj.stageFilename == null ? null : (obj.stageFilename as string),
    holdFilename: obj.holdFilename == null ? null : (obj.holdFilename as string),
    startupBlocked: obj.startupBlocked === true,
  };
}

function writeRestoreStateAtomically(
  statePath: string,
  record: RestoreStateRecord,
): void {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${RESTORE_STATE_FILENAME}.tmp`);
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, statePath);
}

/** Distinguish absent / malformed / valid. Never invent a record. */
export function readRestoreStateResult(statePath: string): ReadStateResult {
  if (!fs.existsSync(statePath)) return { kind: "absent" };
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const record = parseRestoreState(raw);
    if (!record) return { kind: "invalid" };
    return { kind: "ok", record };
  } catch {
    return { kind: "invalid" };
  }
}

export function readRestoreState(statePath: string): RestoreStateRecord | null {
  const result = readRestoreStateResult(statePath);
  return result.kind === "ok" ? result.record : null;
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

function newAttemptId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `a${Date.now().toString(36)}-${process.pid}-${rand}`;
}

function emptyRecord(
  status: RestoreStatus,
  backupId: string,
  requestedAt: string,
): RestoreStateRecord {
  return {
    version: RESTORE_STATE_VERSION,
    status,
    backupId,
    requestedAt,
    completedAt: null,
    preRestoreBackupId: null,
    message: null,
    attemptId: null,
    stageFilename: null,
    holdFilename: null,
    startupBlocked: false,
  };
}

/** Current restore state for the live application database (or null). */
export function getRestoreState(): RestoreStateDto | null {
  const statePath = liveRestoreStatePath();
  const result = readRestoreStateResult(statePath);
  if (result.kind === "absent") return null;
  if (result.kind === "invalid") {
    throw new AppError(
      ErrorCodes.RESTORE_STATE_INVALID,
      "Restore state file is malformed and must be repaired or removed.",
      500,
    );
  }
  return toDto(result.record);
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
  const existingResult = readRestoreStateResult(statePath);
  if (existingResult.kind === "invalid") {
    throw new AppError(
      ErrorCodes.RESTORE_STATE_INVALID,
      "Restore state file is malformed and must be repaired or removed.",
      500,
    );
  }
  if (existingResult.kind === "ok" && existingResult.record.status === "PENDING") {
    throw new AppError(
      ErrorCodes.RESTORE_ALREADY_PENDING,
      "A restore is already scheduled. Cancel it before scheduling another.",
      409,
    );
  }

  const backupDir = backupDirForDbFile(liveMainDbFile());
  const selected = resolveInsideBackupDir(backupDir, id);
  if (!fs.existsSync(selected)) {
    throw new AppError(ErrorCodes.RESTORE_NOT_FOUND, "Backup was not found.", 404);
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

  const record = emptyRecord("PENDING", id, nowIso());
  writeRestoreStateAtomically(statePath, record);
  return toDto(record);
}

/**
 * Cancel a PENDING restore, or dismiss a terminal SUCCEEDED/FAILED result.
 * Also the manual intervention path for malformed or startup-blocked state.
 */
export function clearRestoreState(): void {
  const statePath = liveRestoreStatePath();
  if (!fs.existsSync(statePath)) return;
  safeUnlink(statePath);
}

export type ProcessPendingRestoreOptions = {
  dbPath?: string;
  deps?: Partial<RestoreProcessorDeps>;
};

/**
 * Startup restore processor. MUST run before getDb() opens the application DB.
 */
export function processPendingRestore(
  options: ProcessPendingRestoreOptions = {},
): void {
  const dbFile = path.resolve(options.dbPath ?? config.dbPath);
  const statePath = restoreStatePathForDbFile(dbFile);
  const deps: RestoreProcessorDeps = { ...defaultDeps, ...options.deps };

  const read = readRestoreStateResult(statePath);

  // Fail closed: a present-but-malformed recovery journal must never become
  // a silent empty application database.
  if (read.kind === "invalid") {
    throw new AppError(
      ErrorCodes.RESTORE_STATE_INVALID,
      "Restore state file exists but is malformed. Startup refused. " +
        "Repair or remove restore-state.json after manual investigation.",
    );
  }
  if (read.kind === "absent") return;

  const state = read.record;

  // Persistent startup block from an earlier unproven recovery.
  if (state.status === "FAILED" && state.startupBlocked) {
    throw new AppError(
      ErrorCodes.RESTORE_FAILED,
      "Startup remains blocked: a previous restore recovery could not be verified. " +
        "Preserved recovery artifacts require manual investigation. " +
        "Clear restore-state.json only after the application database is confirmed safe.",
    );
  }

  if (state.status !== "PENDING") return;

  // Interrupted prior attempt: journal already has authoritative recovery info.
  if (state.preRestoreBackupId != null) {
    recoverInterruptedAttempt(dbFile, statePath, state, deps);
    return;
  }

  // Fresh scheduled attempt: journal BEFORE any destructive mutation.
  runFreshAttempt(dbFile, statePath, state, deps);
}

function recoverInterruptedAttempt(
  dbFile: string,
  statePath: string,
  state: RestoreStateRecord,
  deps: RestoreProcessorDeps,
): void {
  const backupDir = backupDirForDbFile(dbFile);
  const safetyPath = path.join(backupDir, state.preRestoreBackupId!);
  const stagePath =
    state.stageFilename != null
      ? resolveArtifactInDbDir(dbFile, state.stageFilename)
      : null;
  const holdPath =
    state.holdFilename != null
      ? resolveArtifactInDbDir(dbFile, state.holdFilename)
      : null;

  const recovered =
    fs.existsSync(safetyPath) &&
    (() => {
      try {
        deps.verifyBackup(safetyPath);
        return rollbackFromPreRestoreSnapshot(dbFile, safetyPath);
      } catch {
        return false;
      }
    })();

  if (recovered) {
    writeRestoreStateAtomically(statePath, {
      ...state,
      status: "FAILED",
      completedAt: nowIso(),
      startupBlocked: false,
      message:
        "Restore was interrupted; previous application state recovered from the pre-restore snapshot.",
    });
    // Proven recovery: clean this attempt's swap artifacts only.
    safeUnlink(stagePath);
    safeUnlink(holdPath);
    return;
  }

  // Hold must NEVER convert this into success. Preserve artifacts; block startup.
  writeRestoreStateAtomically(statePath, {
    ...state,
    status: "FAILED",
    completedAt: nowIso(),
    startupBlocked: true,
    message:
      "Restore was interrupted and the pre-restore snapshot could not be verified as recovered. Startup refused.",
  });
  throw new AppError(
    ErrorCodes.RESTORE_FAILED,
    "Interrupted restore could not recover previous application state from the " +
      "verified pre-restore snapshot. Startup aborted. Recovery artifacts were preserved " +
      "for manual investigation.",
  );
}

function runFreshAttempt(
  dbFile: string,
  statePath: string,
  state: RestoreStateRecord,
  deps: RestoreProcessorDeps,
): void {
  const backupDir = backupDirForDbFile(dbFile);
  let preRestoreBackupId: string | null = null;
  let attemptId: string | null = null;
  let stageFilename: string | null = null;
  let holdFilename: string | null = null;
  let safetyPath: string | null = null;
  let stagePath: string | null = null;
  let holdPath: string | null = null;
  let replacementStarted = false;
  let journalPersisted = false;

  try {
    // ---- PHASE A: validate without mutating the current DB -----------------
    if (!isSafeBackupId(state.backupId)) {
      throw new AppError(
        ErrorCodes.RESTORE_STATE_INVALID,
        "Scheduled backup id is not an app-managed backup filename.",
      );
    }
    const selectedPath = resolveInsideBackupDir(backupDir, state.backupId);
    if (!fs.existsSync(selectedPath)) {
      throw new AppError(ErrorCodes.RESTORE_NOT_FOUND, "Scheduled backup is missing.");
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
    fs.mkdirSync(backupDir, { recursive: true });
    const safetyTarget = uniqueRestoreSafetyTarget(backupDir, (p) =>
      fs.existsSync(p),
    );
    deps.createSnapshot(dbFile, safetyTarget);
    safetyPath = safetyTarget;
    preRestoreBackupId = path.basename(safetyTarget);

    // ---- JOURNAL (before any destructive filesystem mutation) -------------
    attemptId = newAttemptId();
    stageFilename = `.restore-stage-${attemptId}.sqlite`;
    holdFilename = `.restore-old-${attemptId}.sqlite`;
    stagePath = resolveArtifactInDbDir(dbFile, stageFilename);
    holdPath = resolveArtifactInDbDir(dbFile, holdFilename);

    writeRestoreStateAtomically(statePath, {
      ...state,
      preRestoreBackupId,
      attemptId,
      stageFilename,
      holdFilename,
      startupBlocked: false,
    });
    journalPersisted = true;

    // ---- STAGED CANDIDATE -------------------------------------------------
    safeUnlink(stagePath);
    fs.copyFileSync(selectedPath, stagePath);
    deps.verifyBackup(stagePath);

    // ---- SWAP -------------------------------------------------------------
    replacementStarted = true;
    removeWalShm(dbFile);
    safeUnlink(holdPath);
    if (fs.existsSync(dbFile)) {
      fs.renameSync(dbFile, holdPath);
    }
    fs.copyFileSync(stagePath, dbFile);
    safeUnlink(stagePath);

    deps.afterSwap?.({ dbFile, safetyPath, holdPath, stagePath: null });

    // ---- POST-INSTALL VALIDATION -----------------------------------------
    deps.validateInstalled(dbFile);

    // ---- SUCCESS ----------------------------------------------------------
    writeRestoreStateAtomically(statePath, {
      ...state,
      status: "SUCCEEDED",
      completedAt: nowIso(),
      preRestoreBackupId,
      attemptId,
      stageFilename,
      holdFilename,
      startupBlocked: false,
      message: null,
    });
    safeUnlink(holdPath);
  } catch (err) {
    const failureMessage = restrainMessage(err);

    if (replacementStarted) {
      const recovered = rollbackFromPreRestoreSnapshot(dbFile, safetyPath);
      if (!recovered) {
        writeRestoreStateAtomically(statePath, {
          ...state,
          status: "FAILED",
          completedAt: nowIso(),
          preRestoreBackupId,
          attemptId,
          stageFilename,
          holdFilename,
          startupBlocked: true,
          message:
            "Restore failed and the pre-restore snapshot could not be verified as recovered. Startup refused.",
        });
        throw new AppError(
          ErrorCodes.RESTORE_FAILED,
          "Restore failed and rollback from the verified pre-restore snapshot " +
            "could not be completed and verified. Startup aborted. " +
            "Recovery artifacts were preserved for manual investigation.",
        );
      }
      // Proven in-process rollback: safe to start; clean this attempt's swap artifacts.
      writeRestoreStateAtomically(statePath, {
        ...state,
        status: "FAILED",
        completedAt: nowIso(),
        preRestoreBackupId,
        attemptId,
        stageFilename,
        holdFilename,
        startupBlocked: false,
        message: failureMessage,
      });
      safeUnlink(stagePath);
      safeUnlink(holdPath);
      return;
    }

    // No live-DB replacement in this process — but that is NOT sufficient
    // proof that startup is safe. The current DB must still exist and pass
    // independent real verification (missing/unusable DB must block forever).
    const currentDbSafe = isCurrentDbSafeToStart(dbFile);
    writeRestoreStateAtomically(statePath, {
      ...state,
      status: "FAILED",
      completedAt: nowIso(),
      preRestoreBackupId: journalPersisted ? preRestoreBackupId : null,
      attemptId: journalPersisted ? attemptId : null,
      stageFilename: journalPersisted ? stageFilename : null,
      holdFilename: journalPersisted ? holdFilename : null,
      startupBlocked: !currentDbSafe,
      message: currentDbSafe
        ? failureMessage
        : "Restore failed before swap and the current application database could not be proven safe. Startup refused.",
    });
    safeUnlink(stagePath);
    safeUnlink(holdPath);
    if (!currentDbSafe) {
      throw new AppError(
        ErrorCodes.RESTORE_FAILED,
        "Restore failed before swap and the current application database is missing " +
          "or could not be verified as safe. Startup aborted. " +
          "Clear restore-state.json only after the application database is confirmed safe.",
      );
    }
  }
}

/**
 * Prove the current live database is safe to hand to normal application
 * startup after a pre-swap restore failure. Uses the REAL M1 verifier only
 * (never injectable seams): exists, non-empty, read-only open,
 * integrity_check == ok, schema objects present. Does not run migrations,
 * does not clear WAL/SHM, and never creates a replacement database.
 */
function isCurrentDbSafeToStart(dbFile: string): boolean {
  try {
    if (!fs.existsSync(dbFile)) return false;
    verifySqliteBackup(dbFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recover previous logical state from the verified pre-restore snapshot ONLY.
 * The .restore-old-* hold is never accepted as automated recovery.
 */
function rollbackFromPreRestoreSnapshot(
  dbFile: string,
  safetyPath: string | null,
): boolean {
  if (!safetyPath || !fs.existsSync(safetyPath)) {
    return false;
  }

  try {
    safeUnlink(`${dbFile}-wal`);
    safeUnlink(`${dbFile}-shm`);
    safeUnlink(dbFile);
    fs.copyFileSync(safetyPath, dbFile);

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
