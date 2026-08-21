import fs from "node:fs";
import path from "node:path";

const WIN32 = path.win32;

export function stripPathQuotes(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function normalizeDriveLetter(p: string): string {
  if (/^[a-zA-Z]:/.test(p)) {
    return p[0].toUpperCase() + p.slice(1);
  }
  return p;
}

/**
 * Canonical Windows path identity used for deduplication.
 * Equivalent forms (slash style, trailing separators, drive-letter case)
 * collapse to one value. Uses realpath when the path exists.
 */
export function canonicalizePath(input: string): string {
  let p = stripPathQuotes(input);
  if (!p) {
    throw new Error("Path is empty.");
  }

  p = p.replace(/\//g, "\\");
  p = WIN32.normalize(p);
  p = normalizeDriveLetter(p);

  if (p.length > 3) {
    p = p.replace(/\\+$/, "");
  }

  try {
    if (fs.existsSync(p)) {
      p = fs.realpathSync.native(p);
      p = normalizeDriveLetter(p);
      if (p.length > 3) {
        p = p.replace(/\\+$/, "");
      }
    }
  } catch {
    // Keep the normalized form when realpath is unavailable.
  }

  return p;
}

export function repositoryNameFromPath(canonicalPath: string): string {
  const base = WIN32.basename(canonicalPath);
  return base || canonicalPath;
}

export function isPathInside(parent: string, child: string): boolean {
  const p = canonicalizePath(parent).toLowerCase();
  const c = canonicalizePath(child).toLowerCase();
  if (p === c) return true;
  const prefix = p.endsWith("\\") ? p : `${p}\\`;
  return c.startsWith(prefix);
}
