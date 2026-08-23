import { useEffect, useState } from "react";
import type { GitHubStatusDto } from "@shared/api-types";
import { EMPTY_STATES } from "@shared/status-terms";
import { ApiError, client } from "../api";

export function SettingsPage() {
  const [status, setStatus] = useState<GitHubStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const data = await client.githubStatus();
    setStatus(data.status);
  }

  useEffect(() => {
    load().catch((err: unknown) => {
      setError(err instanceof ApiError ? err.message : "Failed to load GitHub status.");
    });
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="lede">GitHub CLI is optional enrichment. Local tracking does not depend on it.</p>
        </div>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            load()
              .catch((err: unknown) => {
                setError(err instanceof ApiError ? err.message : "Failed to refresh status.");
              })
              .finally(() => setBusy(false));
          }}
        >
          Refresh Status
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <section className="panel">
        <h2>GitHub CLI</h2>
        {!status ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="detail-grid">
            <div className="muted">Installed</div>
            <div>{status.installed ? "Installed" : "Missing"}</div>
            <div className="muted">Authentication</div>
            <div>{status.authenticated ? "Authenticated" : "Not Authenticated"}</div>
            <div className="muted">Account</div>
            <div>{status.accountName ?? "—"}</div>
          </div>
        )}
        {status && !status.installed ? (
          <p className="empty">{EMPTY_STATES.githubUnavailable}</p>
        ) : null}
      </section>
    </div>
  );
}
