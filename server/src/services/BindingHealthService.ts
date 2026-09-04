import fs from "node:fs";
import type { LocalBindingHealthDto, LocalBindingHealthState } from "../../../shared/api-types.js";

/**
 * V1.2 M2 local-binding health derivation (M2-E).
 *
 * Pure read-time derivation over one binding's stored columns plus ONE cheap
 * filesystem existence check. Rendering/list paths may call this freely:
 * there is NO Git process here — the cached Git verdict is trusted until the
 * user explicitly refreshes, which is the intended honesty contract.
 *
 * Precedence (locked):
 *   1. stored local_path does not currently exist -> PATH_MISSING
 *      (current truth; overrides any cached Git health; never persisted
 *      merely because a render discovered it)
 *   2. path exists + no cached check              -> UNSCANNED (checkedAt null)
 *   3. path exists + cached OK                    -> OK (checkedAt cached)
 *   4. path exists + cached NOT_A_GIT_REPO        -> NOT_A_GIT_REPO (checkedAt cached)
 */
export type LocalBindingHealthColumns = {
  local_path: string;
  last_health_state: string | null;
  last_health_checked_at: string | null;
};

export function deriveLocalBindingHealth(
  row: LocalBindingHealthColumns,
): LocalBindingHealthDto {
  // 1. Live path existence — current truth, overrides cached Git health.
  if (!fs.existsSync(row.local_path)) {
    return { state: "PATH_MISSING", checkedAt: null };
  }
  // 2. Path exists but no explicit inspection has ever succeeded.
  if (row.last_health_state == null) {
    return { state: "UNSCANNED", checkedAt: null };
  }
  // 3/4. Cached verdict as of the last explicit scan/refresh.
  return {
    state: row.last_health_state as LocalBindingHealthState,
    checkedAt: row.last_health_checked_at,
  };
}
