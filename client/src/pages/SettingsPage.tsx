import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { GitHubStatusDto } from "@shared/api-types";
import { ApiError, client } from "../api";

/**
 * Minimal Settings per spec section 12: Git status, GitHub CLI status,
 * default scan depth, app data location, rescan controls. GitHub stays
 * optional; nothing here can mutate repositories.
 */
export function SettingsPage() {
  const [status, setStatus] = useState<GitHubStatusDto | null>(null);
  const [gitAvailable, setGitAvailable] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<{
    defaultScanDepth: number;
    gitExecutable: string;
    dataPath: string;
  } | null>(null);
  const [depthDraft, setDepthDraft] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [health, github, appSettings] = await Promise.all([
      client.health(),
      client.githubStatus(),
      client.settings(),
    ]);
    setGitAvailable(health.git === "available");
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
    <div className="settings-page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="lede">
            GitHub CLI is optional enrichment. Local tracking does not depend on it.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(load)}
        >
          Recheck tools
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
          Tool Status
        </h2>
        <div className="settings-tool-list" aria-live="polite">
          <div className="settings-tool-row">
            <div className="settings-tool-name">
              <strong>Git</strong>
              <span>Local repository tracking</span>
            </div>
            <div className="settings-tool-status">
              <span className={`pill ${gitAvailable ? "clean" : "neutral"}`}>
                {gitAvailable == null ? "…" : gitAvailable ? "Available" : "Unavailable"}
              </span>
              <span className="mono muted">{settings?.gitExecutable ?? "—"}</span>
            </div>
          </div>
          <div className="settings-tool-row">
            <div className="settings-tool-name">
              <strong>GitHub CLI</strong>
              <span>Optional remote enrichment</span>
            </div>
            <div className="settings-tool-status">
              <span className={`pill ${status?.authenticated ? "clean" : "neutral"}`}>
                {status == null
                  ? "…"
                  : !status.installed
                    ? "Not available"
                    : status.authenticated
                      ? "Connected"
                      : "Installed · not connected"}
              </span>
              {status?.accountName ? (
                <span className="mono muted">{status.accountName}</span>
              ) : null}
            </div>
          </div>
        </div>
        <p className="settings-tool-note">
          Personal Dev Hub reads the existing GitHub CLI login and never stores a token.
          Local tracking continues without GitHub. Manage remote repositories under{" "}
          <Link to="/sources">Sources → GitHub Repositories</Link>.
        </p>
      </section>

      <section className="panel">
        <h2>
          <span className="h2-mark" aria-hidden="true" />
          Local Settings
        </h2>
        <div className="detail-grid settings-local-grid">
          <div className="muted">App data</div>
          {/* The backend's actual resolved database path (config.dbPath);
              honest when DASHBOARD_DB_PATH overrides the default. */}
          <div className="mono">{settings?.dataPath ?? "—"}</div>
        </div>
        <h3 className="settings-subheading">Scanning</h3>
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
