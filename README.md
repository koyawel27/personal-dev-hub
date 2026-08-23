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
| Dashboard | Real summary metrics (tracked/active projects, commits this week, active days, uncommitted repositories), recently active projects derived from meaningful activity, contribution preview, recent activity journal, needs-attention list |
| Projects | Dense workspace of tracked repositories with manual status (Active/Paused/Finished/Archived/Experiment), type (Personal/School/OJT/Client/Experiment/Other), short note, portfolio flag; filters for uncommitted/ahead/behind/GitHub/local/portfolio |
| Project Detail | Logbook-style overview with metadata editor, repository state, changed files (read-only), remotes, GitHub metadata, bounded commit history, per-project activity |
| Activity | Global development journal built from fingerprinted events; unchanged rescans add nothing |
| Contributions | Original activity calendar from locally observed commits with day drill-down; optional GitHub-only commits merged by SHA so nothing counts twice; counts are commits, never hours |
| Portfolio | Selected-work view generated from tracked data: notes, type/status, technology hints (from manifest files), first/latest known commit dates, simple ordering |
| Sources | Multiple scan roots with depth control and heavy-folder skipping, plus manual add of individual repositories |
| Settings | Git executable status, GitHub CLI status, default scan depth, app data location, rescan controls |

## Privacy behavior

- Only metadata is stored: paths, branches, file counts, commit subjects/authors/timestamps, remotes, activity events, and your own notes.
- No source code, diffs, secrets, or terminal history are copied into the app database.
- GitHub personal access tokens are never stored; enrichment uses your existing `gh` authentication.
- Removing a repository from the app never touches the files on disk.

## Data location

Everything persists in `data/dashboard.sqlite` inside the project folder (override with the `DASHBOARD_DB_PATH` environment variable). Delete that file to reset the app; your repositories are untouched.

## Limitations

- Single user, single machine, desktop-first layout.
- Ahead/behind is computed from remote-tracking refs already on disk — the app never fetches, so sync state is only as fresh as your own git usage.
- Contribution calendar shows the current month; ranges beyond the most recent ~100 commits per GitHub repository require the local scan to have seen them.
- No notifications, background watching, AI features, or team/corporate anything — by design.

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
