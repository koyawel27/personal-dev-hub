import { getDb } from "../db/client.js";
import { AppError, ErrorCodes } from "../lib/errors.js";
import { MAX_SCAN_DEPTH } from "../lib/fsPaths.js";

export const DEFAULT_SCAN_DEPTH_KEY = "default_scan_depth";

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function getDefaultScanDepth(): number {
  const raw = getSetting(DEFAULT_SCAN_DEPTH_KEY);
  if (raw == null) return 3;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_SCAN_DEPTH) return 3;
  return parsed;
}

export function setDefaultScanDepth(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_SCAN_DEPTH) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      `Default scan depth must be an integer between 0 and ${MAX_SCAN_DEPTH}.`,
    );
  }
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(DEFAULT_SCAN_DEPTH_KEY, String(parsed));
  return parsed;
}
