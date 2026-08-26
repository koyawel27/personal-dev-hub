import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RepositoryListItem, SourceDto } from "@shared/api-types";
import { EMPTY_STATES } from "@shared/status-terms";
import { ApiError, client } from "../api";
import { formatDateTime } from "../format";
import { GithubPickerSection } from "../components/GithubPicker";
import { removeLocalBinding } from "../lib/removeLocalBinding";
import { useInvalidate } from "../useApi";
import { notifyMutations } from "../lib/mutations";

export function SourcesPage() {
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [repos, setRepos] = useState<RepositoryListItem[]>([]);
  const [path, setPath] = useState("");
  const [depth, setDepth] = useState("3");
  const [manualPath, setManualPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Native folder-picker request state (shared by both Browse buttons so
  // rapid clicks can never stack two OS dialogs).
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  /**
   * Open the backend's native folder dialog and pour the chosen absolute
   * path into the given field. Cancel is silent and changes nothing;
   * failures leave the field value intact with a restrained message.
   * Never auto-submits — the owner reviews the path, then clicks Add.
   */
  async function browseFolder(apply: (value: string) => void) {
    if (pickerBusy) return;
    setPickerBusy(true);
    setPickerError(null);
    try {
      const outcome = await client.selectFolder();
      if (outcome.selected && outcome.path != null) {
        apply(outcome.path);
      }
    } catch (err: unknown) {
      setPickerError(
        err instanceof ApiError
          ? `Folder browser unavailable: ${err.message}`
          : "Folder browser unavailable.",
      );
    } finally {
      setPickerBusy(false);
    }
  }

  async function reload() {
    const [sourceData, repoData] = await Promise.all([client.sources(), client.repositories()]);
    setSources(sourceData.sources);
    setRepos(repoData.repositories);
  }

  useEffect(() => {
    reload().catch((err: unknown) => {
      setError(err instanceof ApiError ? err.message : "Failed to load sources.");
    });
  }, []);

  useInvalidate(["sources", "projects"], async () => {
    try {
      await reload();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "Failed to refresh sources.");
    }
  });

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      // Local-source mutations (add/scan/remove) affect projects and every
      // derived view; reconcile app-wide, then this page.
      notifyMutations("projects", "sources", "dashboard", "activity", "contributions", "portfolio", "picker");
      await reload();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  const manualRepos = repos.filter((repo) => repo.discoveryType === "manual");

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Sources</h1>
          <p className="lede">Scan locations and individually added repositories.</p>
        </div>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const result = await client.scanAll();
              setNotice(
                `Scanned ${result.summary.sourcesScanned} location(s). Discovered ${result.summary.repositoriesDiscovered}, refreshed ${result.summary.repositoriesRefreshed}.`,
              );
            })
          }
        >
          Rescan All
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
      {pickerError ? (
        <p className="hint-text danger" role="status">
          {pickerError} You can still type or paste a path manually.
        </p>
      ) : null}

      <section className="panel">
        <h2>Scan Locations</h2>
        <form
          className="form-row"
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              await client.addSource(path, Number(depth) || 3);
              setPath("");
              setDepth("3");
            });
          }}
        >
          <label className="form-field">
            <span>Scan path</span>
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="C:\xampp-projects"
              required
            />
          </label>
          <button
            type="button"
            disabled={pickerBusy}
            title="Choose a folder on this computer"
            onClick={() => browseFolder(setPath)}
          >
            {pickerBusy ? "Browsing…" : "Browse…"}
          </button>
          <label className="form-field">
            <span>Scan depth</span>
            <input
              className="depth"
              type="number"
              min={0}
              max={8}
              value={depth}
              onChange={(event) => setDepth(event.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            Add Scan Location
          </button>
        </form>
        {sources.length === 0 ? (
          <p className="empty">No scan locations configured yet.</p>
        ) : (
          <table className="table sources-table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Depth</th>
                <th>Last scan</th>
                <th>Repositories</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td className="mono cell-path">{source.path}</td>
                  <td>{source.scanDepth}</td>
                  <td className="cell-last-scan">{formatDateTime(source.lastScannedAt)}</td>
                  <td>{source.repositoryCount}</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const result = await client.scanSource(source.id);
                          setNotice(
                            `Discovered ${result.summary.repositoriesDiscovered}, refreshed ${result.summary.repositoriesRefreshed}.`,
                          );
                        })
                      }
                    >
                      Scan
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await client.deleteSource(source.id);
                        })
                      }
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Individual Repositories</h2>
        <form
          className="form-row"
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              await client.addManual(manualPath);
              setManualPath("");
            });
          }}
        >
          <label className="form-field">
            <span>Repository path</span>
            <input
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              placeholder="C:\path\to\git-repo"
              required
            />
          </label>
          <button
            type="button"
            disabled={pickerBusy}
            title="Choose a folder on this computer (must be a Git repository)"
            onClick={() => browseFolder(setManualPath)}
          >
            {pickerBusy ? "Browsing…" : "Browse…"}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Add Individual Repository
          </button>
        </form>
        {manualRepos.length === 0 && repos.length === 0 ? (
          <p className="empty">{EMPTY_STATES.noProjects}</p>
        ) : (
          <table className="table sources-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Path</th>
                <th>Added as</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => (
                <tr key={repo.id}>
                  <td className="cell-name">
                    {/* PROJECT route identity: the Project link carries the
                        owning PROJECT id; repo.id stays local-binding-only
                        (Rescan / Remove / open actions below). */}
                    <Link className="list-link" to={`/projects/${repo.projectId}`}>
                      {repo.name}
                    </Link>
                  </td>
                  <td className="mono cell-path" title={repo.localPath}>{repo.localPath}</td>
                  <td className="cell-added">{repo.discoveryType}</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(async () => { await client.refresh(repo.id); })}
                    >
                      Rescan
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const result = await removeLocalBinding(repo.id);
                          if (result.projectDeleted) {
                            setNotice(
                              "Removed from dashboard. The project had no other sources and no meaningful state, so its record was cleaned up.",
                            );
                          }
                        })
                      }
                    >
                      Remove from dashboard
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <GithubPickerSection />
    </div>
  );
}
