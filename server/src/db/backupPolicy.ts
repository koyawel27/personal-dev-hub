import path from "node:path";
import type { BackupType } from "@shared/api-types";
import { AppError, ErrorCodes } from "../lib/errors.js";

/**
 * Shared app-managed backup policy (V1.3).
 *
 * ONE interpretation of backup ids, classification, and backups-directory
 * placement for BackupService (live connection) and RestoreService (startup
 * / configured path). Pure path/name helpers only — no getDb(), no I/O.
 */

/** Filesystem-safe UTC stamp shared with migration/manual backup naming. */
export function utcStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * App-managed backup filename → createdAt.
 * Reliable when the filename carries the standard stamp
 * (YYYY-MM-DDTHH-MM-SS-mmmZ, optional _N disambiguator).
 */
export function createdAtFromFilename(filename: string): string | null {
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

/**
 * Recognized app-managed backup classes.
 * Restore-safety first: `pre-restore-*` is reserved for M3 safety snapshots.
 */
export function classifyBackupFilename(filename: string): BackupType | null {
  if (!filename.endsWith(".sqlite")) return null;
  if (filename.startsWith("pre-restore-")) return "RESTORE_SAFETY";
  if (filename.startsWith("manual-")) return "MANUAL";
  if (filename.startsWith("pre-")) return "MIGRATION";
  return null;
}

/** Opaque handle = exact app-managed filename. Reject any path shape. */
export function isSafeBackupId(id: unknown): id is string {
  if (typeof id !== "string" || !id || id.length > 255) return false;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  if (id === "." || id === ".." || id.includes("..")) return false;
  return classifyBackupFilename(id) != null;
}

/** Backups directory next to a database file (no live connection required). */
export function backupDirForDbFile(dbFile: string): string {
  return path.join(path.dirname(path.resolve(dbFile)), "backups");
}

/**
 * Resolve a backup id strictly inside `backupDir`.
 * Throws AppError on traversal / escaping the directory.
 */
export function resolveInsideBackupDir(backupDir: string, filename: string): string {
  const dir = path.resolve(backupDir);
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

/** Allocate a unique pre-restore-<stamp>.sqlite target under backupDir. */
export function uniqueRestoreSafetyTarget(
  backupDir: string,
  exists: (p: string) => boolean,
): string {
  const stamp = utcStamp();
  let target = path.join(backupDir, `pre-restore-${stamp}.sqlite`);
  let n = 1;
  while (exists(target)) {
    target = path.join(backupDir, `pre-restore-${stamp}_${n}.sqlite`);
    n += 1;
    if (n > 1000) {
      throw new AppError(
        ErrorCodes.BACKUP_CREATE_FAILED,
        "Could not allocate a unique pre-restore safety backup filename.",
        500,
      );
    }
  }
  return target;
}

export function uniqueManualBackupTarget(
  backupDir: string,
  exists: (p: string) => boolean,
): string {
  const stamp = utcStamp();
  let target = path.join(backupDir, `manual-${stamp}.sqlite`);
  let n = 1;
  while (exists(target)) {
    target = path.join(backupDir, `manual-${stamp}_${n}.sqlite`);
    n += 1;
    if (n > 1000) {
      throw new AppError(
        ErrorCodes.BACKUP_CREATE_FAILED,
        "Could not allocate a unique manual backup filename.",
        500,
      );
    }
  }
  return target;
}
