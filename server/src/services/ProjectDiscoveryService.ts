import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SourceDto } from "../../../shared/api-types.js";
import { canonicalizePath, pathIdentity } from "../../../shared/paths.js";
import { getDb, nowIso } from "../db/client.js";
import { AppError, ErrorCodes } from "../lib/errors.js";
import { parseScanDepth, resolveExistingDirectory } from "../lib/fsPaths.js";

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".venv",
  "venv",
]);

type SourceRow = {
  id: number;
  path: string;
  canonical_path: string;
  scan_depth: number;
  enabled: number;
  created_at: string;
  last_scanned_at: string | null;
  repository_count: number;
};

function hasGitMarker(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

function shouldSkipDirName(name: string): boolean {
  return SKIP_DIR_NAMES.has(name.toLowerCase());
}

/**
 * Discover Git repositories under root, up to maxDepth levels below the root.
 * The root itself is depth 0. Inaccessible directories are skipped.
 */
export function findGitRepositories(root: string, maxDepth: number): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    let readable: string;
    try {
      readable = canonicalizePath(dir);
    } catch {
      return;
    }

    try {
      if (hasGitMarker(readable)) {
        const identity = pathIdentity(readable);
        if (!seen.has(identity)) {
          seen.add(identity);
          found.push(readable);
        }
        return;
      }
    } catch {
      return;
    }

    if (depth >= maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(readable, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (shouldSkipDirName(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      walk(path.join(readable, entry.name), depth + 1);
    }
  };

  walk(root, 0);
  return found;
}

function mapSource(row: SourceRow): SourceDto {
  return {
    id: row.id,
    path: row.path,
    canonicalPath: row.canonical_path,
    scanDepth: row.scan_depth,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastScannedAt: row.last_scanned_at,
    repositoryCount: row.repository_count,
  };
}

const SOURCE_SELECT = `
  SELECT
    s.id,
    s.path,
    s.canonical_path,
    s.scan_depth,
    s.enabled,
    s.created_at,
    s.last_scanned_at,
    (
      SELECT COUNT(*)
      FROM local_repositories lr
      WHERE lr.source_id = s.id
    ) AS repository_count
  FROM project_sources s
`;

export function listSources(): SourceDto[] {
  const db = getDb();
  const rows = db.prepare(`${SOURCE_SELECT} ORDER BY s.id ASC`).all() as SourceRow[];
  return rows.map(mapSource);
}

export function getSource(id: number): SourceDto {
  const db = getDb();
  const row = db.prepare(`${SOURCE_SELECT} WHERE s.id = ?`).get(id) as
    | SourceRow
    | undefined;
  if (!row) {
    throw new AppError(
      ErrorCodes.SOURCE_NOT_FOUND,
      "Scan location was not found.",
      404,
    );
  }
  return mapSource(row);
}

export function addSource(input: { path: unknown; scanDepth?: unknown }): SourceDto {
  const { readable, identity } = resolveExistingDirectory(input.path);
  const scanDepth = parseScanDepth(input.scanDepth, 3);
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM project_sources WHERE canonical_path = ?")
    .get(identity) as { id: number } | undefined;
  if (existing) {
    throw new AppError(
      ErrorCodes.SOURCE_ALREADY_EXISTS,
      "That scan location is already configured.",
    );
  }

  const createdAt = nowIso();
  const result = db
    .prepare(
      `INSERT INTO project_sources (path, canonical_path, scan_depth, enabled, created_at, last_scanned_at)
       VALUES (?, ?, ?, 1, ?, NULL)`,
    )
    .run(readable, identity, scanDepth, createdAt);

  return getSource(Number(result.lastInsertRowid));
}

export function deleteSource(id: number): void {
  getSource(id);
  const db = getDb();
  db.prepare("DELETE FROM project_sources WHERE id = ?").run(id);
}

export function listEnabledSources(): SourceDto[] {
  return listSources().filter((source) => source.enabled);
}

export function markSourceScanned(id: number, scannedAt: string): void {
  getDb()
    .prepare("UPDATE project_sources SET last_scanned_at = ? WHERE id = ?")
    .run(scannedAt, id);
}

export function getDbHandle(): DatabaseSync {
  return getDb();
}
