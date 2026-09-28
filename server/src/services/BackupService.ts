import fs from "node:fs";
import path from "node:path";
import type { BackupDto, BackupVerification } from "@shared/api-types";
import {
  createVerifiedSqliteSnapshot,
  resolveMainDatabaseFile,
  verifySqliteBackup,
} from "../db/backup.js";
import {
  backupDirForDbFile,
  classifyBackupFilename,
  createdAtFromFilename,
  isSafeBackupId,
  resolveInsideBackupDir,
  uniqueManualBackupTarget,
} from "../db/backupPolicy.js";
import { getDb } from "../db/client.js";
import { AppError, ErrorCodes } from "../lib/errors.js";

/**
 * Application backup inventory and policy (V1.3 M2).
 *
 * The filesystem under <live-db-dir>/backups/ is the source of truth.
 * Classification and id safety live in db/backupPolicy.ts (shared with
 * RestoreService). Location for M2 operations comes from the LIVE connection.
 * Migration retention and failed-sidecar policy stay in migrate.ts.
 */

/** Backups directory for the live connection (M2 path — uses getDb()). */
export function backupDirForLiveDb(): string {
  return backupDirForDbFile(resolveMainDatabaseFile(getDb()));
}

function verificationFor(target: string): BackupVerification {
  try {
    verifySqliteBackup(target);
    return "VALID";
  } catch {
    return "INVALID";
  }
}

function describeBackup(absolutePath: string, filename: string): BackupDto | null {
  const type = classifyBackupFilename(filename);
  if (type == null) return null;

  let sizeBytes = 0;
  let createdAt: string | null = null;
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return null;
    sizeBytes = stat.size;
    createdAt =
      createdAtFromFilename(filename) ??
      (Number.isNaN(stat.mtimeMs) ? null : stat.mtime.toISOString());
  } catch {
    return null;
  }

  return {
    id: filename,
    filename,
    type,
    createdAt: createdAt ?? new Date(0).toISOString(),
    sizeBytes,
    verification: verificationFor(absolutePath),
  };
}

/**
 * Recognized app-managed backups, newest first.
 * One corrupt file is reported INVALID and never fails the whole list.
 */
export function listBackups(): BackupDto[] {
  const dir = backupDirForLiveDb();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir);
  const items: BackupDto[] = [];
  for (const filename of entries) {
    const item = describeBackup(path.join(dir, filename), filename);
    if (item) items.push(item);
  }

  items.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.filename < b.filename ? 1 : a.filename > b.filename ? -1 : 0;
  });
  return items;
}

/**
 * Create one verified MANUAL backup of the live application database.
 * Uses the M1 verified snapshot primitive (VACUUM INTO + verification).
 */
export function createManualBackup(): BackupDto {
  const dir = backupDirForLiveDb();
  fs.mkdirSync(dir, { recursive: true });
  const target = uniqueManualBackupTarget(dir, (p) => fs.existsSync(p));

  try {
    createVerifiedSqliteSnapshot(getDb(), target);
  } catch (err) {
    throw new AppError(
      ErrorCodes.BACKUP_CREATE_FAILED,
      `Backup could not be created. No invalid backup file was kept. (${String(err)})`,
      500,
    );
  }

  const filename = path.basename(target);
  const item = describeBackup(target, filename);
  if (!item) {
    throw new AppError(
      ErrorCodes.BACKUP_CREATE_FAILED,
      "Backup was written but could not be described.",
      500,
    );
  }
  return item;
}

/**
 * Delete one MANUAL backup by opaque filename handle.
 * MIGRATION and RESTORE_SAFETY backups are never deletable here.
 */
export function deleteManualBackup(id: unknown): void {
  if (!isSafeBackupId(id)) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      "Backup id must be an app-managed backup filename.",
      400,
    );
  }
  const type = classifyBackupFilename(id);
  if (type !== "MANUAL") {
    throw new AppError(
      ErrorCodes.BACKUP_DELETE_FORBIDDEN,
      "Only manual application backups can be deleted.",
      403,
    );
  }

  const target = resolveInsideBackupDir(backupDirForLiveDb(), id);
  if (!fs.existsSync(target)) {
    throw new AppError(ErrorCodes.BACKUP_NOT_FOUND, "Backup was not found.", 404);
  }

  try {
    fs.rmSync(target, { force: true });
  } catch (err) {
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      `Backup could not be deleted. (${String(err)})`,
      500,
    );
  }
}
