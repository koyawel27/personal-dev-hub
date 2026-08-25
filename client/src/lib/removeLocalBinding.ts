import { ApiError, client } from "../api";

/**
 * Q1 confirmation ladder for removing a LOCAL binding ("Remove from
 * dashboard"). First attempt lets the owning Project auto-delete when it
 * is provably empty; a meaningful Project refuses server-side with
 * PROJECT_HAS_NO_SOURCES and this helper surfaces an explicit keep-or-
 * delete decision instead of retrying destructively.
 *
 * A declined confirmation leaves EVERYTHING unchanged: the backend runs
 * binding removal + project evaluation in one transaction, so a refusal
 * rolls back the binding deletion too. Files on disk are never touched.
 */
export async function removeLocalBinding(
  id: number,
): Promise<{ ok: true; projectDeleted: boolean }> {
  try {
    return await client.deleteRepository(id);
  } catch (err) {
    if (
      !(err instanceof ApiError) ||
      (err.code !== "PROJECT_HAS_NO_SOURCES" && err.status !== 409)
    ) {
      throw err;
    }
    const confirmed = window.confirm(
      "This project still carries notes, status, portfolio membership, or history.\n\n" +
        "Delete the project record together with this dashboard entry?\n\n" +
        "Cancel keeps everything as is. Files on disk are never deleted.",
    );
    if (!confirmed) {
      // Owner chose retention; nothing was mutated (refusal rolled back).
      return { ok: true, projectDeleted: false };
    }
    return client.deleteRepository(id, true);
  }
}
