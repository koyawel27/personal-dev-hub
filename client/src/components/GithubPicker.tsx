import { useMemo, useState } from "react";
import type { PickerEntryDto } from "@shared/api-types";
import { ApiError, client } from "../api";
import { IconProjects } from "../components/icons";
import { useApi } from "../useApi";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "owned", label: "Owned" },
  { key: "collaborator", label: "Collaborator" },
  { key: "org", label: "Organization" },
  { key: "public", label: "Public" },
  { key: "private", label: "Private" },
  { key: "archived", label: "Archived" },
  { key: "forks", label: "Forks" },
  { key: "tracked", label: "Tracked" },
  { key: "untracked", label: "Untracked" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function matches(entry: PickerEntryDto, filter: FilterKey): boolean {
  switch (filter) {
    case "all":
      return true;
    case "owned":
      return entry.affiliation === "owner";
    case "collaborator":
      return entry.affiliation === "collaborator";
    case "org":
      return entry.affiliation === "organization_member";
    case "public":
      return entry.visibility === "public";
    case "private":
      return entry.visibility === "private";
    case "archived":
      return entry.archived;
    case "forks":
      return entry.fork;
    case "tracked":
      return entry.tracked;
    case "untracked":
      return !entry.tracked;
  }
}

/**
 * GitHub repository picker (V1.1, Sources page section).
 * Curated selection only: nothing is tracked without an explicit action,
 * and tracking never clones.
 */
export function GithubPickerSection() {
  const { data, error, loading, refetch: reload } = useApi(
    () => client.githubPicker(),
    [],
  );
  const [filter, setFilter] = useState<FilterKey>("owned");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const entries = data?.entries ?? [];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .filter((entry) => matches(entry, filter))
      .filter((entry) =>
        q
          ? `${entry.fullName} ${entry.language ?? ""}`
              .toLowerCase()
              .includes(q)
          : true,
      );
  }, [entries, filter, query]);

  const toggle = (fullName: string): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  };

  async function trackSelected(): Promise<void> {
    if (selected.size === 0) return;
    setBusy(true);
    setNotice(null);
    let linked = 0;
    let created = 0;
    for (const fullName of selected) {
      try {
        const result = await client.trackGithub(fullName);
        if (result.state === "LOCAL + GITHUB") linked += 1;
        else created += 1;
      } catch (err) {
        if (err instanceof ApiError && err.code === "ALREADY_TRACKED") continue;
        setNotice(
          err instanceof Error ? `Tracking failed: ${err.message}` : "Tracking failed.",
        );
        setBusy(false);
        await reload();
        return;
      }
    }
    setBusy(false);
    setSelected(new Set());
    const parts: string[] = [];
    if (linked > 0) parts.push(`${linked} linked to existing local project${linked > 1 ? "s" : ""}`);
    if (created > 0) parts.push(`${created} tracked as GitHub-only`);
    setNotice(parts.length > 0 ? `Done: ${parts.join(" · ")}.` : "Nothing new to track.");
    await reload();
  }

  return (
    <section className="panel">
      <div className="picker-head">
        <h2 className="h-mark">
          <IconProjects /> Browse GitHub Repositories
        </h2>
        <button className="btn subtle" onClick={() => void reload()} disabled={loading}>
          Refresh list
        </button>
      </div>

      {error != null ? (
        <p className="empty-line">GitHub is unavailable right now ({error}).</p>
      ) : loading ? (
        <p className="empty-line">Loading repositories…</p>
      ) : data != null && !data.available ? (
        <p className="empty-line">
          Could not list repositories from GitHub. Check that the GitHub CLI is
          installed and authenticated, then refresh.
        </p>
      ) : (
        <>
          <div className="picker-controls">
            <input
              className="input picker-search"
              placeholder="Search name or language…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="chip-row">
              {FILTERS.map((option) => (
                <button
                  key={option.key}
                  className={`chip ${filter === option.key ? "active" : ""}`}
                  onClick={() => setFilter(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <p className="empty-line">No repositories match.</p>
          ) : (
            <ul className="picker-list">
              {visible.map((entry) => {
                const isSelected = selected.has(entry.fullName);
                return (
                  <li
                    key={entry.fullName}
                    className={`picker-row ${isSelected ? "selected" : ""}`}
                  >
                    <label className="picker-main">
                      <input
                        type="checkbox"
                        checked={isSelected || entry.tracked}
                        disabled={entry.tracked || busy}
                        onChange={() => toggle(entry.fullName)}
                      />
                      <span className="picker-name mono">{entry.fullName}</span>
                      <span className="picker-meta">
                        {[entry.language, entry.visibility]
                          .filter(Boolean)
                          .map((piece) => piece)
                          .join(" · ")}
                        {entry.archived ? " · archived" : ""}
                        {entry.fork ? " · fork" : ""}
                      </span>
                    </label>
                    <span className={`picker-state ${entry.tracked ? "on" : ""}`}>
                      {entry.tracked
                        ? entry.localCopyPath
                          ? "Tracked · local copy"
                          : "Tracked"
                        : entry.localCopyPath
                          ? "Local copy detected"
                          : "GitHub only"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="picker-foot">
            <span className="hint-text">
              Tracking never clones anything — local copies stay where they are.
            </span>
            <button
              className="btn primary"
              onClick={() => void trackSelected()}
              disabled={selected.size === 0 || busy}
            >
              {busy
                ? "Tracking…"
                : `Track selected${selected.size > 0 ? ` (${selected.size})` : ""}`}
            </button>
          </div>
          {notice != null ? <p className="empty-line">{notice}</p> : null}
        </>
      )}
    </section>
  );
}
