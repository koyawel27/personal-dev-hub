import { useCallback, useEffect, useState } from "react";
import type { BackupDto, BackupType } from "@shared/api-types";
import { ApiError, client } from "../api";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { formatBytes, formatDateTime, relativeTime } from "../format";

/**
 * V1.3 M2 Maintenance: application backup inventory and manual create/delete.
 * Restore is intentionally absent (restart-mediated, M3).
 */

const TYPE_LABELS: Record<BackupType, string> = {
  MANUAL: "Manual",
  MIGRATION: "Migration",
  RESTORE_SAFETY: "Restore safety",
};

function verificationBadge(verification: BackupDto["verification"]) {
  if (verification === "VALID") {
    return <Badge tone="clean">Valid</Badge>;
  }
  // Invalid is a fact, not an alarm: muted/neutral, never danger styling.
  return <Badge tone="neutral">Invalid</Badge>;
}

export function MaintenancePage() {
  const [backups, setBackups] = useState<BackupDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await client.listBackups();
    setBackups(result.backups);
    setListError(null);
  }, []);

  useEffect(() => {
    reload().catch((err: unknown) => {
      setBackups([]);
      setListError(
        err instanceof ApiError ? err.message : "Failed to load backups.",
      );
    });
  }, [reload]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="maintenance-page">
      <div className="page-header">
        <div>
          <h1>Maintenance</h1>
          <p className="lede">
            Local application maintenance and recovery for Personal Dev Hub data.
          </p>
        </div>
      </div>

      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="notice" role="status">
          {notice}
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-head-row">
          <h2>
            <span className="h2-mark" aria-hidden="true" />
            Application Backups
          </h2>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await client.createBackup();
                await reload();
                setNotice("Backup created and verified.");
              })
            }
          >
            {busy ? "Working…" : "Create Backup Now"}
          </button>
        </div>

        <p className="backup-scope-note">
          Backups cover Personal Dev Hub application data stored in SQLite. They
          do <strong>not</strong> back up, clone, copy, modify, or delete tracked
          Git repositories.
        </p>

        {listError ? (
          <div className="error" role="alert">
            {listError}
          </div>
        ) : null}

        {backups == null ? (
          <p className="empty">Loading backups…</p>
        ) : backups.length === 0 ? (
          <EmptyState
            message="No application backups yet."
            hint="Create a backup to capture the current Personal Dev Hub database."
          />
        ) : (
          <ul className="backup-list" aria-label="Application backups">
            {backups.map((backup) => (
              <li key={backup.id} className="backup-row">
                <div className="backup-main">
                  <div className="backup-title-line">
                    <Badge tone="neutral">{TYPE_LABELS[backup.type]}</Badge>
                    {verificationBadge(backup.verification)}
                    <span
                      className="mono backup-filename"
                      title={backup.filename}
                    >
                      {backup.filename}
                    </span>
                  </div>
                  <div className="binding-meta">
                    <span title={formatDateTime(backup.createdAt)}>
                      {relativeTime(backup.createdAt)}
                    </span>
                    <span className="mono">{formatBytes(backup.sizeBytes)}</span>
                    {backup.verification === "INVALID" ? (
                      <span className="muted">
                        Unverified or corrupt backup file
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="backup-actions">
                  {backup.type === "MANUAL" ? (
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => {
                        // Owner confirmation before any mutation. Cancel leaves
                        // the page completely unchanged (no busy state, no
                        // DELETE, no reload, no notice).
                        const confirmed = window.confirm(
                          `Delete this manual backup permanently?\n\n` +
                            `${backup.filename}\n\n` +
                            `This removes only this Personal Dev Hub backup file. ` +
                            `Tracked Git repositories are never deleted.`,
                        );
                        if (!confirmed) return;
                        void run(async () => {
                          await client.deleteBackup(backup.id);
                          await reload();
                          setNotice("Backup deleted.");
                        });
                      }}
                    >
                      Delete
                    </button>
                  ) : (
                    <span className="muted mono backup-keep-tag">Kept</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="settings-tool-note">
          Manual backups can be deleted. Migration and restore-safety backups are
          kept automatically. Restore is not available yet.
        </p>
      </section>
    </div>
  );
}
