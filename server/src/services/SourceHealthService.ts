import type {
  LocalBindingHealthDto,
  SourceHealthItemDto,
  SourceHealthResponse,
} from "@shared/api-types";
import { deriveLocalBindingHealth } from "./BindingHealthService.js";
import { getDb } from "../db/client.js";

/**
 * V1.3 M4 Maintenance Source Health read model.
 *
 * Aggregates local bindings that need attention (PATH_MISSING, NOT_A_GIT_REPO,
 * UNSCANNED) using the locked V1.2 deriveLocalBindingHealth precedence.
 *
 * READ HONESTY: no Git process, no repository refresh, no health-cache
 * mutation, no Activity write. Health rendering uses stored columns plus one
 * cheap filesystem existence check inside deriveLocalBindingHealth.
 */

const ATTENTION_STATES = new Set(["PATH_MISSING", "NOT_A_GIT_REPO", "UNSCANNED"]);

export function listSourceHealth(): SourceHealthResponse {
  const db = getDb();

  // Every local binding with its Project name. Effective display primary
  // matches ProjectService: is_primary DESC, id ASC per project.
  const rows = db
    .prepare(
      `SELECT lr.id AS binding_id,
              lr.name AS binding_name,
              lr.local_path,
              lr.is_primary,
              lr.last_health_state,
              lr.last_health_checked_at,
              lr.project_id,
              COALESCE(p.name, lr.name) AS project_name
       FROM local_repositories lr
       LEFT JOIN projects p ON p.id = lr.project_id
       ORDER BY lr.project_id ASC, lr.is_primary DESC, lr.id ASC`,
    )
    .all() as Array<{
    binding_id: number;
    binding_name: string;
    local_path: string;
    is_primary: number;
    last_health_state: string | null;
    last_health_checked_at: string | null;
    project_id: number | null;
    project_name: string;
  }>;

  // Effective primary per project (same rule as Project Detail).
  const effectivePrimary = new Map<number, number>();
  for (const row of rows) {
    if (row.project_id == null) continue;
    if (!effectivePrimary.has(row.project_id)) {
      effectivePrimary.set(row.project_id, row.binding_id);
    }
  }

  let pathMissingCount = 0;
  let notGitRepoCount = 0;
  let unscannedCount = 0;
  const items: SourceHealthItemDto[] = [];

  for (const row of rows) {
    const health: LocalBindingHealthDto = deriveLocalBindingHealth({
      local_path: row.local_path,
      last_health_state: row.last_health_state,
      last_health_checked_at: row.last_health_checked_at,
    });

    if (health.state === "PATH_MISSING") pathMissingCount += 1;
    else if (health.state === "NOT_A_GIT_REPO") notGitRepoCount += 1;
    else if (health.state === "UNSCANNED") unscannedCount += 1;

    if (!ATTENTION_STATES.has(health.state)) continue;

    items.push({
      projectId: row.project_id ?? 0,
      projectName: row.project_name,
      bindingId: row.binding_id,
      bindingName: row.binding_name,
      localPath: row.local_path,
      isPrimary:
        row.project_id != null
          ? effectivePrimary.get(row.project_id) === row.binding_id
          : row.is_primary === 1,
      health,
    });
  }

  return {
    totalLocalBindings: rows.length,
    attentionCount: items.length,
    pathMissingCount,
    notGitRepoCount,
    unscannedCount,
    items,
  };
}
