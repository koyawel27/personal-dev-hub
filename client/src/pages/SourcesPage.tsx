import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RepositoryListItem, SourceDto } from "@shared/api-types";
import { EMPTY_STATES } from "@shared/status-terms";
import { ApiError, client } from "../api";
import { formatDateTime } from "../format";

export function SourcesPage() {
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [repos, setRepos] = useState<RepositoryListItem[]>([]);
  const [path, setPath] = useState("");
  const [depth, setDepth] = useState("3");
  const [manualPath, setManualPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
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
      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

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
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="C:\xampp-projects"
            required
          />
          <input
            className="depth"
            type="number"
            min={0}
            max={8}
            value={depth}
            onChange={(event) => setDepth(event.target.value)}
          />
          <button type="submit" className="primary" disabled={busy}>
            Add Scan Location
          </button>
        </form>
        {sources.length === 0 ? (
          <p className="empty">No scan locations configured yet.</p>
        ) : (
          <table className="table">
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
                  <td className="mono">{source.path}</td>
                  <td>{source.scanDepth}</td>
                  <td>{formatDateTime(source.lastScannedAt)}</td>
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
          <input
            value={manualPath}
            onChange={(event) => setManualPath(event.target.value)}
            placeholder="C:\path\to\git-repo"
            required
          />
          <button type="submit" className="primary" disabled={busy}>
            Add Individual Repository
          </button>
        </form>
        {manualRepos.length === 0 && repos.length === 0 ? (
          <p className="empty">{EMPTY_STATES.noProjects}</p>
        ) : (
          <table className="table">
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
                  <td>
                    <Link className="list-link" to={`/projects/${repo.id}`}>
                      {repo.name}
                    </Link>
                  </td>
                  <td className="mono">{repo.localPath}</td>
                  <td>{repo.discoveryType}</td>
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
                          await client.deleteRepository(repo.id);
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
    </div>
  );
}
