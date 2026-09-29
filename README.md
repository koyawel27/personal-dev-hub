# Personal Dev Hub

A **Windows-first**, **local-first**, **single-user** developer workspace for one machine. It combines your local Git repositories, optional GitHub tracking, lightweight project tracking, recent development activity, contribution history, selected portfolio work, and application-data recovery (backups / restore) into one simple local web app.

Personal Dev Hub is currently distributed as **source code**. There is no desktop installer.

The central question it answers:

> **What have I been building, what am I working on now, and how has my development work evolved over time?**

The dashboard is **read-only** toward tracked repositories. It never runs `git fetch`, `git pull`, `git push`, `git add`, `git commit`, checkout, reset, stash, or any other mutating command. There is no generic "run git" endpoint and no arbitrary command execution.

## Requirements

- Windows
- Node.js 24.19+ (uses the built-in `node:sqlite` module)
- system Git
- optional: GitHub CLI (`gh`) for GitHub metadata and contribution enrichment (local-only usage does not require it)

## Quick start

```bat
git clone https://github.com/koyawel27/personal-dev-hub.git
cd personal-dev-hub
npm install
npm run build
npm start
```

Then open:

- **http://127.0.0.1:8787**

The API binds **only** to `127.0.0.1`. SQLite is created automatically at `data/dashboard.sqlite`.

### Development

```bat
npm install
npm run dev
```

Then open:

- UI: http://127.0.0.1:5173
- Health: http://127.0.0.1:8787/api/health

### Installer status

Personal Dev Hub does not currently ship with a Windows installer. The current public release is source-based.

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
| Project Detail | All local bindings of the project, each with its own local path, snapshot/state, and health (`OK`, `NOT_A_GIT_REPO`, `PATH_MISSING`, `UNSCANNED`), plus per-binding actions — Open Folder, Terminal, VS Code, Rescan, Relink, Make primary, Remove; Add Local Copy attaches another existing local Git copy to the project; project top-level localPath/snapshot follow the display primary; GitHub identity, visibility, default branch, last push for linked repositories; bounded commit history tagged by source; per-project activity journal |
| Activity | Global development journal built from fingerprinted events across both origins (commit observed, working-tree transitions, branch changes, GitHub repo tracked/untracked); unchanged rescans and no-op refreshes add nothing |
| Contributions | Original activity calendar with three honest views — Local, GitHub (tracked repositories), Combined (a commit SHA present in both the local and GitHub tracked datasets is counted once, with the overlap reported transparently); counts are commits, never hours; not a full GitHub profile graph |
| Portfolio | Selected-work view over projects: notes, type/status, technology hints (manifest probes, or GitHub's reported primary language for GitHub-only items), first/latest known commit dates, simple ordering. GitHub-only projects are eligible without a local clone |
| Sources | Multiple scan locations with depth control; manual add of a standalone local repository (creates a Project's initial local binding); native folder browsing; GitHub repository picker. Project metadata lives on the Project itself (`PATCH /api/projects/:projectId/metadata`), never on a repository row. Add Local Copy and Relink belong to Project Detail, not the global Sources workflow |
| Maintenance | Operational recovery for the app database: create and inspect manual backups, browse the backup inventory (with verification state), schedule a restart-mediated restore, and review Source Health attention items (local copies that need a manual Rescan or Relink). Distinct from Settings — Maintenance is recovery/repair, Settings is configuration |
| Settings | Git executable status, GitHub connection summary (CLI installed / account connected via your existing `gh` login), default scan depth, app data location, rescan controls |

### Multiple local copies, primary, and per-binding health

A Project can track several local Git copies (0..many). One binding is the **display primary** and drives the Project's top-level local path/snapshot; you can change it from Project Detail (**Make primary**). If legacy or malformed data has no explicit primary, the oldest binding (lowest id) is used as a defensive fallback. Permanent activity anchoring also uses the oldest binding, so changing the display primary never re-keys history and performs no Git scan.

**Add Local Copy** attaches another existing local Git copy to the same Project. It never clones: the candidate folder is inspected read-only; a recognized remote identity match or a known shared commit SHA verifies the attachment; ambiguous evidence asks for your confirmation; a conflicting identity is rejected. The first local binding of a GITHUB ONLY project becomes primary; later copies join as non-primary.

**Relink** points an existing binding at a moved/renamed folder: same binding id, Project, history, and stored primary state — the app never moves your files. Unrelated repositories are rejected; uncertain identity may ask for confirmation. Git stays read-only throughout.

Health is per binding: `OK` (verified as a Git worktree at the last explicit scan/refresh), `NOT_A_GIT_REPO` (path exists but was not a Git worktree at the last check), `PATH_MISSING` (the stored path no longer exists), `UNSCANNED` (never inspected). Relink is the recovery path for `PATH_MISSING`.

### Source Health (Maintenance)

Maintenance surfaces local copies that need attention: `PATH_MISSING`, `NOT_A_GIT_REPO`, and `UNSCANNED`. Normal health rendering does **not** run Git. `OK` and `NOT_A_GIT_REPO` are based on the last explicit scan/refresh; path existence is checked at read time. Repair is manual via **Rescan** / **Relink**. There is no watcher, daemon, or automatic repair.

## Privacy behavior

- Only metadata is stored: paths, branches, file counts, commit subjects/authors/timestamps, remotes, activity events, cached GitHub repository facts, and your own notes.
- No source code, diffs, secrets, or terminal history are copied into the app database.
- GitHub personal access tokens are never stored; listing and refresh use your existing `gh` authentication through a fixed allow-list of read-only operations.
- Removing a repository from the app never touches the files on disk; untracking a GitHub repository never touches GitHub.

## Data location

Everything persists in `data/dashboard.sqlite` inside the project folder (override with the `DASHBOARD_DB_PATH` environment variable). Delete that file to reset the app; your repositories are untouched.

### Backups and restore

**What backups cover:** Personal Dev Hub's SQLite application data and metadata (projects, bindings, settings, activity, history).

**What backups do not cover:** tracked Git repositories or the source code/files inside them. Tracked repositories remain untouched.

The app manages three backup categories under `<database-directory>/backups/`:

| Category | Created by | Deletable from Maintenance? |
| --- | --- | --- |
| **Manual** | You, from Maintenance ("Create backup now") | Yes |
| **Migration** | Automatic safety snapshot before a declared rebuild migration; existing retention policy keeps the newest ordinary snapshots | No (migration retention only) |
| **Restore safety** | Automatic snapshot taken immediately before an applied restore | No — preserved for recovery |

Every backup is produced with consistent SQLite semantics (committed write-ahead-log state included) and verified before use.

### Restore semantics

- Restore is **restart-mediated**: scheduled from Maintenance and applied only after you restart Personal Dev Hub.
- It does **not** hot-swap the running database.
- At startup the selected backup is verified again, the current app database is snapshotted first (restore safety), and the restore is validated before it is marked successful.
- Tracked Git repositories and project source files are unaffected.

If interrupted recovery cannot prove application data is safe, startup may refuse to continue rather than initialize a fresh database. Do not casually delete internal recovery state files; investigate before clearing them.

## Limitations

- Single user, single machine, desktop-first layout.
- Ahead/behind is computed from remote-tracking refs already on disk — the app never fetches, so sync state is only as fresh as your own git usage.
- GitHub-side commits are stored for tracked repositories after a manual refresh (bounded to the most recent ~100 per repository); the GitHub view of Contributions covers exactly that data.
- Contributions is year-based, with available-year selection (years listed newest-first); it is not a replication of GitHub's full profile contribution graph.
- A project has at most one GitHub binding; local copies are 0..many, with one explicit display primary per project (owner-selectable; oldest-binding fallback for legacy/malformed data).
- Manual Git/GitHub refresh semantics only: ahead/behind and GitHub enrichment update when you rescan or refresh — there is no daemon or background sync.
- Backups are app-managed only: no cloud backup, no scheduled backups, no arbitrary filesystem restore/import.
- Restore replaces the application database at the next restart; it does not repair or rewrite tracked Git repositories.
- No automatic repository repair — Source Health flags attention items; Rescan/Relink stay manual.
- No notifications, OAuth, cloning, AI features, or team/corporate anything — by design. Advanced mobile polish remains deferred.

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

Add that folder under **Sources → Local Repositories**, then change it *outside* the hub:

1. Clean — should show `Clean`
2. Edit `README.md` — should show `Uncommitted` and a modified file
3. Create `loose.txt` — untracked count increases
4. `git add loose.txt` — staged count increases
5. `git commit -m "fixture change"` — new commit appears; working tree returns to `Clean`
6. `git checkout -b feature` — branch updates after Rescan

The dashboard must observe these states without modifying the fixture.

`fixtures/disposable-repo/` is gitignored if you keep a local copy inside this project.

## License

Personal Dev Hub is released under the MIT License.
See [`LICENSE`](LICENSE).
