import { useEffect, useState } from "react";
import type {
  ProjectStatus,
  ProjectType,
  RepositoryDetail,
  UpdateMetadataRequest,
} from "@shared/api-types";
import { PROJECT_STATUSES, PROJECT_TYPES } from "@shared/api-types";
import { ApiError, client } from "../api";

/**
 * Lightweight manual metadata editor on the Project Detail Overview tab.
 * Partial PATCH: only fields the user touched are sent; the backend emits
 * project_status_changed / project_note_updated activity events for real
 * changes only.
 */
export function MetadataEditor({
  repository,
  onSaved,
  onError,
}: {
  repository: RepositoryDetail;
  onSaved: (updated: unknown) => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<string>(repository.projectStatus ?? "");
  const [type, setType] = useState<string>(repository.projectType ?? "");
  const [note, setNote] = useState<string>(repository.projectNote ?? "");
  const [include, setInclude] = useState<boolean>(repository.includeInPortfolio);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  /**
   * Dirty affordance: the save() diff (unchanged semantics) drives a quiet
   * "Unsaved changes" hint and keeps Save enabled-looking while real edits
   * are pending; the button itself stays always-clickable so the
   * no-op-when-clean shortcut below is preserved exactly.
   */
  const dirty =
    status !== (repository.projectStatus ?? "") ||
    type !== (repository.projectType ?? "") ||
    note.trim() !== (repository.projectNote ?? "") ||
    include !== repository.includeInPortfolio;

  useEffect(() => {
    setStatus(repository.projectStatus ?? "");
    setType(repository.projectType ?? "");
    setNote(repository.projectNote ?? "");
    setInclude(repository.includeInPortfolio);
  }, [repository]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const body: UpdateMetadataRequest = {};
    if ((repository.projectStatus ?? "") !== status) {
      body.projectStatus = status === "" ? null : (status as ProjectStatus);
    }
    if ((repository.projectType ?? "") !== type) {
      body.projectType = type === "" ? null : (type as ProjectType);
    }
    if ((repository.projectNote ?? "") !== note.trim()) {
      body.projectNote = note.trim() === "" ? null : note.trim();
    }
    if (repository.includeInPortfolio !== include) {
      body.includeInPortfolio = include;
    }

    if (Object.keys(body).length === 0) return;
    setSaving(true);
    try {
      const result = await client.updateProjectMetadata(repository.id, body);
      onSaved(result.project);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (err: unknown) {
      onError(err instanceof ApiError ? err.message : "Could not save metadata.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} className="metadata-editor">
      <div className="metadata-grid">
        <label className="form-field">
          <span>Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">—</option>
            {PROJECT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>Type</span>
          <select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">—</option>
            {PROJECT_TYPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>Include in Portfolio</span>
          <select
            value={include ? "yes" : "no"}
            onChange={(event) => setInclude(event.target.value === "yes")}
          >
            <option value="no">Do not include</option>
            <option value="yes">Include in Portfolio</option>
          </select>
        </label>
      </div>
      <label className="form-field">
        <span>Note</span>
        <textarea
          rows={2}
          maxLength={500}
          placeholder="e.g. Waiting for adviser feedback"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <div className="row-actions" style={{ marginTop: 10 }}>
        <button type="submit" className={`primary${dirty ? " dirty-glow" : ""}`} disabled={saving}>
          {saving ? "Saving…" : "Save Metadata"}
        </button>
        {dirty && !savedFlash ? (
          <span className="hint-text" role="status">
            Unsaved changes
          </span>
        ) : null}
        {savedFlash ? (
          <span className="notice-inline" role="status">
            Saved.
          </span>
        ) : null}
      </div>
    </form>
  );
}
