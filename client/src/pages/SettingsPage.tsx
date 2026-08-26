import { useEffect, useState } from "react";
import type { GitHubStatusDto } from "@shared/api-types";
import { ApiError, client } from "../api";
import { EMPTY_STATES } from "@shared/status-terms";

/**
 * Minimal Settings per spec section 12: Git status, GitHub CLI status,
 * default scan depth, app data location, rescan controls. GitHub stays
 * optional; nothing here can mutate repositories.
 */
export function SettingsPage() {
  const [status, setStatus] = useState<GitHubStatusDto | null>(null);
  const [settings, setSettings] = useState<{
    defaultScanDepth: number;
    gitExecutable: string;
  } | null>(null);
  const [depthDraft, setDepthDraft] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [github, appSettings] = await Promise.all([
      client.githubStatus(),
      client.settings(),
    ]);
    setStatus(github.status);
    setSettings(appSettings.settings);
    setDepthDraft(String(appSettings.settings.defaultScanDepth));
  }

  useEffect(() => {
    load().catch((err: unknown) => {
      setError(err instanceof ApiError ? err.message : "Failed to load settings.");
    });
  }, []);

  async function run(action: () => Promise<void>) {
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
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="lede">
            GitHub CLI is optional enrichment. Local tracking does not depend on it.
          </p>
        </div>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => run(load)}
        >
          Refresh Status
        </button>
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
        <h2>
          <span className="h2-mark" aria-hidden="true" />
          GitHub connection
        </h2>
        <div className="detail-grid">
          <div className="muted">GitHub CLI</div>
          <div>
            <span className={`pill ${status?.installed ? "clean" : "neutral"}`}>
              {status == null ? "…" : status.installed ? "Installed" : "Missing"}
            </span>
          </div>
          <div className="muted">GitHub account</div>
          <div>
            {status == null ? (
              "…"
            ) : status.authenticated ? (
              <>
                <span className="pill clean">Connected</span>
                {status.accountName ? (
                  <span className="mono"> {status.accountName}</span>
                ) : null}
              </>
            ) : (
              <span className="pill neutral">Not connected</span>
            )}
          </div>
        </div>
        <p className="empty-state-hint" style={{ marginTop: 8 }}>
          Connection is read from the existing GitHub CLI login — Personal Dev Hub
          never stores a token. Repository selection lives under{" "}
          <a href="/sources">Sources → Browse GitHub Repositories</a>.
        </p>
      </section>

      <section className="panel">
        <h2>
          <span className="h2-mark" aria-hidden="true" />
          Tooling
        </h2>
        <div className="detail-grid">
          <div className="muted">Git executable</div>
          <div className="mono">{settings?.gitExecutable ?? "—"}</div>
          <div className="muted">App data</div>
          <div className="mono">data/dashboard.sqlite (project folder)</div>
        </div>
        {status && !status.installed ? (
          <p className="empty">{EMPTY_STATES.githubUnavailable}</p>
        ) : null}
      </section>

      <section className="panel">
        <h2>
          <span className="h2-mark" aria-hidden="true" />
          Scanning
        </h2>
        <form
          className="form-row"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const parsed = Number(depthDraft);
              const result = await client.updateSettings({ defaultScanDepth: parsed });
              setSettings(result.settings);
              setNotice(`Default scan depth set to ${result.settings.defaultScanDepth}.`);
            });
          }}
        >
          <label className="form-field">
            <span>Default scan depth</span>
            <input
              className="depth"
              type="number"
              min={0}
              max={8}
              value={depthDraft}
              onChange={(event) => setDepthDraft(event.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        </form>
        <div className="row-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const result = await client.scanAll();
                setNotice(
                  `Scanned ${result.summary.sourcesScanned} source(s): ${result.summary.repositoriesDiscovered} discovered, ${result.summary.repositoriesRefreshed} refreshed.`,
                );
              })
            }
          >
            Rescan all sources
          </button>
        </div>
      </section>
    </div>
  );
}
