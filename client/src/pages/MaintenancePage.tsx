import { useCallback, useEffect, useState } from "react";
import type {
  BackupDto,
  BackupType,
  RestoreStateDto,
} from "@shared/api-types";
import { ApiError, client } from "../api";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { SourceHealthPanel } from "../components/SourceHealthPanel";
import { formatBytes, formatDateTime, relativeTime } from "../format";
import { waitForRestartRecovery } from "../lib/restartPolling";

/**
 * V1.3 Maintenance: application backups + restart-mediated restore.
 * Restore is scheduled only — never applied from the browser.
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
  return <Badge tone="neutral">Invalid</Badge>;
}

function restoreConfirmMessage(backup: BackupDto): string {
  return (
    `Restore Personal Dev Hub application data from this backup?\n\n` +
    `${backup.filename}\n\n` +
    `• Application data will be reverted to this backup.\n` +
    `• A safety backup of the current application data will be created first.\n` +
    `• Tracked Git repositories will NOT be changed.\n` +
    `• Restore applies only after restarting Personal Dev Hub.`
  );
}

export function MaintenancePage() {
  const [backups, setBackups] = useState<BackupDto[] | null>(null);
  const [restore, setRestore] = useState<RestoreStateDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const reload = useCallback(async () => {
    const [list, restoreResult] = await Promise.all([
      client.listBackups(),
      client.restoreState(),
    ]);
    setBackups(list.backups);
    setRestore(restoreResult.restore);
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
    if (busy || restarting) return;
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

  async function restartApp(purpose: "restore" | "runtime") {
    if (restarting || busy) return;
    const confirmed = window.confirm(
      purpose === "restore"
        ? "Restart Personal Dev Hub now to apply the scheduled restore?\n\n" +
            "The local app server will stop and start again. " +
            "Tracked Git repositories are not changed."
        : "Restart Personal Dev Hub?\n\n" +
            "The local app server will stop and start again. " +
            "Tracked Git repositories are not changed.",
    );
    if (!confirmed) return;

    setRestarting(true);
    setError(null);
    setNotice(
      purpose === "restore"
        ? "Restarting Personal Dev Hub to apply the scheduled restore..."
        : "Restarting Personal Dev Hub...",
    );
    try {
      await client.restartApp();
      // Must observe health DOWN, then healthy again — not a still-up server.
      const outcome = await waitForRestartRecovery();
      if (outcome === "recovered") {
        window.location.reload();
        return;
      }
      // Failure: clear BOTH restarting and the green restarting notice.
      setRestarting(false);
      setNotice(null);
      if (outcome === "never-went-down") {
        setError(
          "Restart was accepted, but the server did not appear to stop. " +
            "Nothing else was started. Try again only if needed, or use the " +
            "Desktop Personal Dev Hub shortcut if the app is not running.",
        );
      } else {
        setError(
          "Personal Dev Hub did not become healthy again in time. " +
            "Use the Desktop Personal Dev Hub shortcut if the app is not running.",
        );
      }
    } catch (err: unknown) {
      setRestarting(false);
      setNotice(null);
      setError(
        err instanceof ApiError
          ? err.message
          : "Restart could not be started. Use the Desktop Personal Dev Hub shortcut if needed.",
      );
    }
  }

  const restorePending = restore?.status === "PENDING";

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

      {restore?.status === "PENDING" ? (
        <div className="notice restore-pending" role="status">
          <strong>Restore scheduled.</strong> A restart is required to apply
          this backup.
          <div className="restore-detail">
            <span>
              Selected backup:{" "}
              <span className="mono">{restore.backupId}</span>
            </span>
            <span>
              Requested: {formatDateTime(restore.requestedAt)}
            </span>
          </div>
          <div className="backup-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || restarting}
              onClick={() => void restartApp("restore")}
            >
              {restarting ? "Restarting..." : "Restart to Apply Restore"}
            </button>
            <button
              type="button"
              disabled={busy || restarting}
              onClick={() =>
                void run(async () => {
                  await client.clearRestoreState();
                  await reload();
                  setNotice("Scheduled restore cancelled.");
                })
              }
            >
              Cancel Scheduled Restore
            </button>
          </div>
        </div>
      ) : null}

      {restore?.status === "SUCCEEDED" ? (
        <div className="notice restore-terminal" role="status">
          <strong>Restore completed.</strong>
          <div className="restore-detail">
            <span>
              Restored backup: <span className="mono">{restore.backupId}</span>
            </span>
            {restore.preRestoreBackupId ? (
              <span>
                Safety backup:{" "}
                <span className="mono">{restore.preRestoreBackupId}</span>
              </span>
            ) : null}
            {restore.completedAt ? (
              <span>Completed: {formatDateTime(restore.completedAt)}</span>
            ) : null}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await client.clearRestoreState();
                await reload();
                setNotice("Restore result dismissed.");
              })
            }
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {restore?.status === "FAILED" ? (
        <div className="error restore-terminal" role="alert">
          <strong>Restore did not complete.</strong>
          {restore.message ? <div>{restore.message}</div> : null}
          <div className="restore-detail">
            <span>
              Selected backup: <span className="mono">{restore.backupId}</span>
            </span>
            {restore.preRestoreBackupId ? (
              <span>
                Safety backup:{" "}
                <span className="mono">{restore.preRestoreBackupId}</span>
              </span>
            ) : null}
            {restore.completedAt ? (
              <span>Finished: {formatDateTime(restore.completedAt)}</span>
            ) : null}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await client.clearRestoreState();
                await reload();
                setNotice("Restore result dismissed.");
              })
            }
          >
            Dismiss
          </button>
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
                  {backup.verification === "VALID" ? (
                    <button
                      type="button"
                      className="btn subtle restore-action"
                      disabled={busy || restorePending}
                      title={
                        restorePending
                          ? "A restore is already scheduled"
                          : "Restore this backup after restart"
                      }
                      onClick={() => {
                        const confirmed = window.confirm(
                          restoreConfirmMessage(backup),
                        );
                        if (!confirmed) return;
                        void run(async () => {
                          await client.scheduleRestore(backup.id);
                          await reload();
                          setNotice(
                            "Restore scheduled. Restart Personal Dev Hub to apply it.",
                          );
                        });
                      }}
                    >
                      Restore
                    </button>
                  ) : null}
                  {backup.type === "MANUAL" ? (
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => {
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
          kept automatically. Restore reverts application data only, after a
          restart, and never changes tracked Git repositories.
        </p>
      </section>

      <SourceHealthPanel />

      <section className="panel">
        <div className="panel-head-row">
          <h2>
            <span className="h2-mark" aria-hidden="true" />
            Runtime
          </h2>
        </div>
        <p className="backup-scope-note">
          Personal Dev Hub is running locally. Restart stops and starts the
          local application server only — tracked Git repositories are
          unaffected.
        </p>
        <button
          type="button"
          disabled={busy || restarting}
          onClick={() => void restartApp("runtime")}
        >
          {restarting ? "Restarting..." : "Restart Personal Dev Hub"}
        </button>
        {restarting ? (
          <p className="empty" role="status">
            Restarting Personal Dev Hub...
          </p>
        ) : null}
      </section>
    </div>
  );
}
