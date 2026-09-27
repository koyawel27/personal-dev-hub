import fs from "node:fs";
import path from "node:path";
import type { BackupDto, BackupType, BackupVerification } from "@shared/api-types";
import {
  createVerifiedSqliteSnapshot,
  resolveMainDatabaseFile,
  verifySqliteBackup,
} from "../db/backup.js";
import { getDb } from "../db/client.js";
import { AppError, ErrorCodes } from "../lib/errors.js";

/**
 * Application backup inventory and policy (V1.3 M2).
 *
 * The filesystem under <live-db-dir>/backups/ is the source of truth.
 * This module owns classification, metadata, manual create/delete policy,
 * and API-facing operations. Generic SQLite snapshot mechanics stay in
 * db/backup.ts. Migration retention and failed-sidecar policy stay in
 * migrate.ts and are never reimplemented here.
 */

/** Filesystem-safe UTC stamp shared with migration backup naming. */
function utcStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * App-managed backup filename → createdAt.
 * Reliable when the filename carries the standard stamp
 * (YYYY-MM-DDTHH-MM-SS-mmmZ, optional _N disambiguator).
 */
function createdAtFromFilename(filename: string): string | null {
  const base = filename.replace(/\.sqlite$/i, "");
  const match = base.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:_\d+)?$/,
  );
  if (!match) return null;
  const stamp = match[1];
  const iso = stamp.replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1$2:$3:$4.$5Z",
  );
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : iso;
}

function classifyBackupFilename(filename: string): BackupType | null {
  if (!filename.endsWith(".sqlite")) return null;
  // Restore-safety first: pre-restore-* is a reserved prefix owned by M3.
  if (filename.startsWith("pre-restore-")) return "RESTORE_SAFETY";
  if (filename.startsWith("manual-")) return "MANUAL";
  if (filename.startsWith("pre-")) return "MIGRATION";
  return null;
}

function isSafeBackupId(id: string): boolean {
  if (!id || id.length > 255) return false;
  // Opaque handle = exact filename. Reject any path shape outright.
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  if (id === "." || id === ".." || id.includes("..")) return false;
  return classifyBackupFilename(id) != null;
}

function backupDirForLiveDb(): string {
  const dbFile = resolveMainDatabaseFile(getDb());
  return path.join(path.dirname(dbFile), "backups");
}

function resolveInsideBackupDir(filename: string): string {
  const dir = path.resolve(backupDirForLiveDb());
  const target = path.resolve(dir, filename);
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (target !== dir && !target.startsWith(prefix)) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      "Backup id must be an app-managed backup filename.",
      400,
    );
  }
  return target;
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
    // Raced away between readdir and stat — omit rather than crash the list.
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
 * Success is reported only after verification; failed attempts leave no
 * invalid new backup behind.
 */
export function createManualBackup(): BackupDto {
  const dir = backupDirForLiveDb();
  fs.mkdirSync(dir, { recursive: true });

  const stamp = utcStamp();
  let target = path.join(dir, `manual-${stamp}.sqlite`);
  let disambiguator = 1;
  while (fs.existsSync(target)) {
    // Same-millisecond collision only. Keep the stamp prefix parseable.
    target = path.join(dir, `manual-${stamp}_${disambiguator}.sqlite`);
    disambiguator += 1;
    if (disambiguator > 1000) {
      throw new AppError(
        ErrorCodes.BACKUP_CREATE_FAILED,
        "Could not allocate a unique manual backup filename.",
        500,
      );
    }
  }

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
 * Traversal / arbitrary paths are rejected before any filesystem touch.
 */
export function deleteManualBackup(id: unknown): void {
  if (typeof id !== "string" || !isSafeBackupId(id)) {
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

  const target = resolveInsideBackupDir(id);
  if (!fs.existsSync(target)) {
    throw new AppError(
      ErrorCodes.BACKUP_NOT_FOUND,
      "Backup was not found.",
      404,
    );
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
