import type { RelinkLocalBindingResponse } from "@shared/api-types";
import { ApiError, client } from "../api";

/**
 * V1.2 M4 D8 confirmation ladder for Safe Relink (pointing an EXISTING local
 * binding at a moved/renamed folder).
 *
 * The owner picks the candidate folder with the native picker; the first
 * attempt may be answered with LOCAL_BINDING_RELINK_CONFIRM_REQUIRED when the
 * server has insufficient evidence that the folder is the same repository.
 * The server's evidence summary is shown verbatim and the relink retries with
 * confirmUnverified=true only after the owner explicitly accepts.
 *
 * A declined confirmation leaves EVERYTHING unchanged: the backend runs all
 * candidate validation before any DB write, so a refusal mutates nothing. A
 * strong identity conflict (LOCAL_BINDING_RELINK_IDENTITY_CONFLICT) is a hard
 * rejection and is never offered an override. Files on disk are never moved.
 */
export async function relinkLocalBinding(
  bindingId: number,
  path: string,
): Promise<RelinkLocalBindingResponse | null> {
  try {
    return await client.relinkLocalBinding(bindingId, path);
  } catch (err) {
    if (
      !(err instanceof ApiError) ||
      err.code !== "LOCAL_BINDING_RELINK_CONFIRM_REQUIRED"
    ) {
      // Strong conflict / validation failures propagate; no override exists.
      throw err;
    }
    const confirmed = window.confirm(
      `${err.message}\n\n` +
        "Point this existing local copy at the selected folder anyway? " +
        "Its identity and history are preserved; files on disk are not moved.\n\n" +
        "Cancel keeps the current tracked path unchanged.",
    );
    if (!confirmed) {
      // Owner declined; nothing was mutated (validation runs before any write).
      return null;
    }
    return client.relinkLocalBinding(bindingId, path, true);
  }
}
