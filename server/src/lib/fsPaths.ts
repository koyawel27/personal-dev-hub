import fs from "node:fs";
import path from "node:path";
import { canonicalizePath, pathIdentity, stripPathQuotes } from "../../../shared/paths.js";
import { AppError, ErrorCodes } from "./errors.js";

const MAX_SCAN_DEPTH = 8;

export function parseScanDepth(value: unknown, fallback = 3): number {
  if (value == null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SCAN_DEPTH) {
    throw new AppError(
      ErrorCodes.INVALID_PATH,
      `Scan depth must be an integer between 0 and ${MAX_SCAN_DEPTH}.`,
    );
  }
  return n;
}

export { MAX_SCAN_DEPTH };

export function resolveExistingDirectory(input: unknown): {
  readable: string;
  identity: string;
} {
  if (typeof input !== "string") {
    throw new AppError(ErrorCodes.INVALID_PATH, "Path must be a string.");
  }
  const stripped = stripPathQuotes(input);
  if (!stripped) {
    throw new AppError(ErrorCodes.INVALID_PATH, "Path is empty.");
  }
  if (stripped.includes("\0")) {
    throw new AppError(ErrorCodes.INVALID_PATH, "Path is invalid.");
  }
  if (!path.win32.isAbsolute(stripped) && !path.isAbsolute(stripped)) {
    throw new AppError(
      ErrorCodes.INVALID_PATH,
      "Path must be an absolute path.",
    );
  }

  let readable: string;
  try {
    readable = canonicalizePath(stripped);
  } catch {
    throw new AppError(ErrorCodes.INVALID_PATH, "Path is invalid.");
  }

  if (/^[A-Z]:\\?$/i.test(readable)) {
    throw new AppError(
      ErrorCodes.INVALID_PATH,
      "Refusing to scan a drive root. Add a more specific folder.",
    );
  }

  try {
    if (!fs.existsSync(readable)) {
      throw new AppError(
        ErrorCodes.PATH_NOT_FOUND,
        "The selected path was not found.",
      );
    }
    const stat = fs.statSync(readable);
    if (!stat.isDirectory()) {
      throw new AppError(
        ErrorCodes.INVALID_PATH,
        "The selected path is not a directory.",
      );
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      ErrorCodes.PATH_NOT_FOUND,
      "The selected path was not found.",
    );
  }

  return { readable, identity: pathIdentity(readable) };
}

export function parseNumericId(value: string | undefined): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
