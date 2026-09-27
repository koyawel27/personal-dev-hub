import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Generic verified SQLite snapshot primitives.
 *
 * These are deliberately free of migration naming, retention, sidecar, and
 * rebuild-workflow policy. Callers supply an explicit target path and own
 * inventory/retention decisions. V1.2 migration backups remain the first
 * consumer; later manual-backup work will reuse the same primitive.
 */

/**
 * Resolve the filesystem path of the connection's main database via
 * PRAGMA database_list. The live connection — not config.dbPath — is the
 * authoritative source for what gets backed up. An empty `file` column
 * (in-memory or otherwise non-file database) is not a backupable source
 * and fails loudly.
 */
export function resolveMainDatabaseFile(database: DatabaseSync): string {
  const rows = database.prepare("PRAGMA database_list").all() as Array<{
    seq: number;
    name: string;
    file: string;
  }>;
  const main = rows.find((row) => row.name === "main");
  if (!main || main.file.trim() === "") {
    throw new Error(
      "Cannot back up: the connection has no filesystem-backed main database.",
    );
  }
  return main.file;
}

/**
 * Minimal verification that a freshly created backup is a complete,
 * readable SQLite database: file exists, non-empty, integrity_check = ok,
 * schema objects present. VACUUM INTO already guarantees a transactionally
 * consistent, page-valid copy, so full application validation is
 * intentionally not performed. The verification connection is always closed
 * and the backup is never mutated.
 */
export function verifySqliteBackup(target: string): void {
  if (!fs.existsSync(target)) {
    throw new Error(
      `Backup verification failed: backup file is missing: ${target}`,
    );
  }
  if (fs.statSync(target).size === 0) {
    throw new Error(
      `Backup verification failed: backup file is empty: ${target}`,
    );
  }
  let verifier: DatabaseSync | null = null;
  try {
    verifier = new DatabaseSync(target, { readOnly: true });
    const integrity = verifier
      .prepare("PRAGMA integrity_check")
      .get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") {
      throw new Error(
        `Backup verification failed: integrity_check reported "${integrity.integrity_check}".`,
      );
    }
    const objects = verifier
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master")
      .get() as { n: number };
    if (objects.n === 0) {
      throw new Error(
        "Backup verification failed: backup contains no schema objects.",
      );
    }
  } finally {
    if (verifier) {
      try {
        verifier.close();
      } catch {
        // best effort
      }
    }
  }
}

/**
 * Best-effort removal of partial/invalid output created by a failed snapshot
 * attempt so it never masquerades as a backup. Callers must only invoke this
 * for targets THIS attempt created — never for a pre-existing file.
 */
export function removeInvalidBackupOutput(target: string): void {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // best effort; the caller rethrows the original failure
  }
}

/**
 * Create a verified, transactionally consistent SQLite snapshot at `target`
 * from an already-open connection.
 *
 * Safety contract:
 * - operates on the provided DatabaseSync connection
 * - requires a filesystem-backed main database (PRAGMA database_list)
 * - refuses to overwrite an existing target (pre-existing files are preserved)
 * - uses VACUUM INTO so committed-but-uncheckpointed WAL state is included
 * - verifies the result before reporting success
 * - removes only output created by THIS attempt when verification fails
 */
export function createVerifiedSqliteSnapshot(
  database: DatabaseSync,
  target: string,
): void {
  // Source identity: the live connection is authoritative. Enforce that the
  // main database is filesystem-backed before any snapshot work.
  resolveMainDatabaseFile(database);

  // A pre-existing destination would make VACUUM INTO fail — and the failure
  // path below removes files created by THIS attempt. Collide loudly instead:
  // a valid backup that predates this attempt must be preserved byte-for-byte,
  // never verified, and never removed as this attempt's partial output.
  if (fs.existsSync(target)) {
    throw new Error(`Backup destination already exists: ${target}`);
  }

  try {
    // Consistent snapshot: includes committed-but-uncheckpointed WAL state.
    // VACUUM INTO must run outside any transaction.
    database.prepare("VACUUM INTO ?").run(target);
    verifySqliteBackup(target);
  } catch (err) {
    removeInvalidBackupOutput(target);
    throw err;
  }
}
