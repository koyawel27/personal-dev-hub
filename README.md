# Personal Dev Hub

A personal, local-first developer workspace for one machine. It combines your local Git repositories, optional GitHub enrichment, lightweight project tracking, recent development activity, contribution history, and selected portfolio work into one simple local web app.

The central question it answers:

> **What have I been building, what am I working on now, and how has my development work evolved over time?**

The dashboard is **read-only** toward tracked repositories. It never runs `git fetch`, `git pull`, `git push`, `git add`, `git commit`, checkout, reset, stash, or any other mutating command. There is no generic "run git" endpoint and no arbitrary command execution.

## Requirements

- Node.js 24.19+ (uses the built-in `node:sqlite` module)
- system Git
- optional: GitHub CLI (`gh`) for GitHub metadata and contribution enrichment

## Start

```bat
npm install
npm run dev
```

Then open:

- UI: http://127.0.0.1:5173
- Health: http://127.0.0.1:8787/api/health

The API binds **only** to `127.0.0.1`. SQLite is created automatically at `data/dashboard.sqlite`.

### Production

```bat
npm run build
npm start
```

Then open http://127.0.0.1:8787

## Checks

```bat
npm run typecheck
npm test
npm run build
```

## What it does

| Area | Behavior |
| --- | --- |
| Dashboard | Real summary metrics (tracked/active projects, commits this week from local + tracked GitHub sources, active days, uncommitted repositories), recently active projects derived from meaningful activity (local or GitHub), contribution preview, recent activity journal, needs-attention list (local conditions only) |
| Projects | Project-centric workspace where each project carries an explicit source badge — LOCAL + GITHUB, LOCAL ONLY, or GITHUB ONLY — with manual status/type/note/portfolio metadata owned by the project; dense table with search and filters |
| GitHub tracking | Curated picker under Sources → Browse GitHub Repositories: search plus Owned/Collaborator/Organization/Public/Private/Archived/Forks/Tracked/Untracked filters; explicit selection only; picking a repository that matches a local clone's remote links them into one project instead of duplicating it; tracking never clones |
| Project Detail | Source-aware logbook: local state (branch, working tree, changed files) when a local copy exists; GitHub identity, visibility, default branch, last push for linked repositories; bounded commit history tagged by source; per-project activity journal |
| Activity | Global development journal built from fingerprinted events across both origins (commit observed, working-tree transitions, branch changes, GitHub repo tracked/untracked); unchanged rescans and no-op refreshes add nothing |
| Contributions | Original activity calendar with three honest views — Local, GitHub (tracked repositories), Combined (duplicates collapsed by repository identity + SHA); counts are commits, never hours; not a full GitHub profile graph |
| Portfolio | Selected-work view over projects: notes, type/status, technology hints (manifest probes, or GitHub's reported primary language for GitHub-only items), first/latest known commit dates, simple ordering. GitHub-only projects are eligible without a local clone |
| Sources | Multiple scan roots with depth control, native folder browsing, manual add of individual repositories (each a local binding of a Project), and the GitHub repository picker. Project metadata lives on the Project itself (`PATCH /api/projects/:projectId/metadata`), never on a repository row |
| Settings | Git executable status, GitHub connection summary (CLI installed / account connected via your existing `gh` login), default scan depth, app data location, rescan controls |

## Privacy behavior

- Only metadata is stored: paths, branches, file counts, commit subjects/authors/timestamps, remotes, activity events, cached GitHub repository facts, and your own notes.
- No source code, diffs, secrets, or terminal history are copied into the app database.
- GitHub personal access tokens are never stored; listing and refresh use your existing `gh` authentication through a fixed allow-list of read-only operations.
- Removing a repository from the app never touches the files on disk; untracking a GitHub repository never touches GitHub.

## Data location

Everything persists in `data/dashboard.sqlite` inside the project folder (override with the `DASHBOARD_DB_PATH` environment variable). Delete that file to reset the app; your repositories are untouched.

## Limitations

- Single user, single machine, desktop-first layout.
- Ahead/behind is computed from remote-tracking refs already on disk — the app never fetches, so sync state is only as fresh as your own git usage.
- GitHub-side commits are stored for tracked repositories after a manual refresh (bounded to the most recent ~100 per repository); the GitHub view of Contributions covers exactly that data.
- Contributions shows the current month; it is not a replication of GitHub's full profile contribution graph.
- A project has at most one GitHub binding in V1.1; multiple local copies per project are supported structurally (the first registered copy is treated as primary).
- No notifications, background watching/sync daemon, OAuth, cloning, AI features, or team/corporate anything — by design.

## Disposable test repository

Do not use an important project as your first fixture. Create a throwaway repo:

```bat
mkdir C:\temp\hub-fixture
cd C:\temp\hub-fixture
git init -b main
git config user.email "dev@example.com"
git config user.name "Dev"
echo hello> README.md
git add README.md
git commit -m "initial"
```

Add that folder under **Sources → Individual Repositories**, then change it *outside* the hub:

1. Clean — should show `Clean`
2. Edit `README.md` — should show `Uncommitted` and a modified file
3. Create `loose.txt` — untracked count increases
4. `git add loose.txt` — staged count increases
5. `git commit -m "fixture change"` — new commit appears; working tree returns to `Clean`
6. `git checkout -b feature` — branch updates after Rescan

The dashboard must observe these states without modifying the fixture.

`fixtures/disposable-repo/` is gitignored if you keep a local copy inside this project.
