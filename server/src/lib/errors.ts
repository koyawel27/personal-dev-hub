export class AppError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export const ErrorCodes = {
  INVALID_PATH: "INVALID_PATH",
  PATH_NOT_FOUND: "PATH_NOT_FOUND",
  NOT_GIT_REPOSITORY: "NOT_GIT_REPOSITORY",
  SOURCE_ALREADY_EXISTS: "SOURCE_ALREADY_EXISTS",
  REPOSITORY_ALREADY_TRACKED: "REPOSITORY_ALREADY_TRACKED",
  REPOSITORY_NOT_FOUND: "REPOSITORY_NOT_FOUND",
  SOURCE_NOT_FOUND: "SOURCE_NOT_FOUND",
  GIT_UNAVAILABLE: "GIT_UNAVAILABLE",
  INVALID_METADATA: "INVALID_METADATA",
  GITHUB_UNAVAILABLE: "GITHUB_UNAVAILABLE",
  GITHUB_NOT_AUTHENTICATED: "GITHUB_NOT_AUTHENTICATED",
  SCAN_IN_PROGRESS: "SCAN_IN_PROGRESS",
  INVALID_REQUEST: "INVALID_REQUEST",
  PROJECT_HAS_NO_SOURCES: "PROJECT_HAS_NO_SOURCES",
  GITHUB_REPO_NOT_FOUND: "GITHUB_REPO_NOT_FOUND",
  GITHUB_REPO_CONFLICT: "GITHUB_REPO_CONFLICT",
  ALREADY_TRACKED: "ALREADY_TRACKED",
  LAUNCHER_FAILED: "LAUNCHER_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export function toErrorBody(err: unknown): {
  status: number;
  body: { error: { code: string; message: string } };
} {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  // Express JSON body-parser syntax errors are client mistakes, not server faults.
  if (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    (err as { type?: unknown }).type === "entity.parse.failed"
  ) {
    return {
      status: 400,
      body: {
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: "Request body is not valid JSON.",
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: "An internal error occurred.",
      },
    },
  };
}
