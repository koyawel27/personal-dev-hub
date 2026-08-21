# Local Developer Dashboard — V1 Experimental Build Specification

## 1. Purpose

Build a **Windows-first, local-first personal developer dashboard** for one developer on one computer.

The application should answer:

> **What software projects have I been working on, and what state did I leave them in?**

This is also an evaluation project for Grok Build with a limited usage budget. Prefer simple, correct, testable solutions over speculative features or framework complexity.

---

## 2. Core V1 Scope

The app tracks **local Git repositories only**.

It must support:

- multiple configured scan locations, e.g.
  - `C:\xampp-projects`
  - `C:\xampp\htdocs`
- individually added Git repositories outside those locations
- recursive repository discovery with configurable scan depth
- read-only Git inspection
- recent local commits
- current branch and working-tree state
- modified, staged, and untracked file counts
- changed-file list
- configured Git remotes
- locally known ahead/behind state
- activity timeline derived from meaningful state changes
- optional GitHub metadata for local repositories whose remotes point to GitHub
- convenience actions:
  - Open Folder
  - Open Terminal
  - Open in VS Code
  - Open GitHub when applicable

GitHub is **optional enrichment**, not a dependency.

---

## 3. Hard Safety Boundary

The dashboard is **strictly read-only toward tracked repositories**.

It must never perform normal application operations equivalent to:

- `git fetch`
- `git pull`
- `git push`
- `git add`
- `git commit`
- `git checkout`
- `git switch`
- `git reset`
- `git restore`
- `git merge`
- `git rebase`
- `git cherry-pick`
- `git stash`
- `git clean`

It must not modify:

- source files
- working trees
- staging areas
- branches
- Git history
- remotes

Do not build Stage, Commit, Discard, Checkout, Fetch, Pull, Push, Reset, Merge, or similar controls.

The app may use Git normally while developing **this dashboard repository itself**. The restriction applies to repositories tracked by the running dashboard.

---

## 4. Project Discovery

Support:

1. **Scan locations**
   - path
   - configurable maximum scan depth
   - enabled state
   - last scanned time

2. **Individual repositories**
   - manually added Git repositories outside scan locations

Default scan depth: `3`.

The scanner must:

- check the scan-source directory itself as a possible Git repository
- recursively discover repositories up to the configured depth
- detect repositories through `.git`
- normalize Windows paths
- prevent duplicate local repository records
- tolerate inaccessible directories without failing the whole scan
- never automatically scan the entire computer

Skip at least:

- `.git`
- `node_modules`
- `vendor`
- `dist`
- `build`
- `coverage`
- `.cache`
- `.venv`
- `venv`

Equivalent Windows path forms must not create duplicates.

---

## 5. Local Git Information

For each tracked repository, determine at least:

- repository name
- local path
- current branch
- HEAD commit
- clean / uncommitted state
- modified file count
- staged file count
- untracked file count
- changed-file list
- recent commits
- configured remotes
- upstream reference when available
- ahead count
- behind count
- last scanned time
- latest meaningful activity

Ahead/behind state is based only on **locally known remote-tracking references**.

The UI must communicate this clearly, e.g.:

> Based on locally known remote state.

Do not automatically run `git fetch`.

Use the system Git executable.

Use argument-based process execution such as `execFile` or `spawn` with separate argument arrays. Do not construct shell command strings by concatenating user-controlled paths.

---

## 6. GitHub Integration

Use the installed **GitHub CLI (`gh`)** for V1.

Do not build app-owned GitHub OAuth or token storage.

The application must not store:

- GitHub passwords
- PATs
- OAuth tokens
- SSH private keys

Create a small `GitHubService` that can at least:

- detect whether `gh` exists
- determine authentication status
- optionally determine the authenticated account
- retrieve metadata for GitHub repositories linked to tracked local repositories

GitHub failure, missing `gh`, or unauthenticated `gh` must never break local repository scanning or local dashboard functionality.

Recognize at least:

- `https://github.com/owner/repo.git`
- `git@github.com:owner/repo.git`

Normalize to:

- host
- owner
- repository

Non-GitHub remotes remain valid Git remotes but must not be labeled GitHub-connected.

---

## 7. V2 Compatibility — Do Not Implement V2

V2 may later synchronize **all repositories from the connected GitHub account** and distinguish:

- Local + GitHub
- GitHub only
- Local only

Therefore, local repositories and GitHub repositories must be modeled separately.

A GitHub repository may eventually have:

- zero local copies
- one local copy
- multiple local copies

Do not implement full GitHub-account synchronization now.

---

## 8. Architecture

Use:

### Frontend
- React
- TypeScript
- Vite

### Backend
- Node.js
- TypeScript
- Express

### Persistence
- SQLite

### Git
- system Git executable

### GitHub
- `gh`

### Testing
- Vitest

Keep dependencies modest.

Do not introduce unless a genuine blocker requires it:

- Next.js
- Electron
- Tauri
- Redux
- large component frameworks
- large ORMs

V1 officially targets **Windows**.

Backend must bind only to:

`127.0.0.1`

Do not expose it on `0.0.0.0`.

---

## 9. Backend Service Boundaries

Use small, clear services:

### `ProjectDiscoveryService`
Responsible for:

- scan-source management
- directory traversal
- `.git` detection
- depth limits
- exclusions
- canonical path normalization
- deduplication

### `GitService`
Responsible for structured, read-only Git inspection.

Possible operations:

- `isRepository`
- `getBranch`
- `getWorkingTreeStatus`
- `getHeadCommit`
- `getRecentCommits`
- `getRemotes`
- `getUpstream`
- `getAheadBehind`

### `RepositoryService`
Coordinates application-level repository refresh and persistence.

### `GitHubService`
Handles optional `gh`-based enrichment only.

### `ActivityService`
Compares previous/current state and creates meaningful, deduplicated events.

### `SystemLauncher`
Explicit actions for registered repositories:

- open folder
- open terminal
- open VS Code
- open GitHub

Launcher actions must use stored repository IDs and backend-resolved paths. Do not accept arbitrary execution paths from the browser.

---

## 10. No Arbitrary Execution API

Do not expose general-purpose routes such as:

- `/api/exec`
- `/api/shell`
- `/api/command`
- `/api/git-command`

The frontend requests defined actions. The backend decides what command is executed.

---

## 11. Database Model

Keep V1 small. Target approximately these seven tables:

### `project_sources`
Suggested fields:

- id
- path
- canonical_path
- scan_depth
- enabled
- created_at
- last_scanned_at

### `local_repositories`
Suggested fields:

- id
- source_id nullable
- name
- local_path
- canonical_path
- discovery_type (`scanned` / `manual`)
- created_at
- last_scanned_at

`canonical_path` must be unique.

For V1, one displayed project equals one local Git repository.

### `repository_snapshots`
Suggested fields:

- id
- local_repository_id
- branch
- head_commit_sha
- is_dirty
- modified_count
- staged_count
- untracked_count
- upstream_ref
- ahead_count
- behind_count
- captured_at

### `git_remotes`
Suggested fields:

- id
- local_repository_id
- name
- url
- host
- owner
- repository_name
- github_repository_id nullable
- is_primary
- last_seen_at

### `github_repositories`
Suggested fields:

- id
- owner
- name
- full_name
- visibility
- default_branch
- html_url
- last_pushed_at
- last_refreshed_at

### `commits`
Suggested fields:

- id
- local_repository_id
- commit_sha
- subject
- author_name
- committed_at
- first_seen_at

Unique key: local repository + commit SHA.

Use bounded recent history rather than unlimited history.

### `activity_events`
Suggested fields:

- id
- local_repository_id
- event_type
- summary
- occurred_at
- source
- fingerprint
- metadata_json

Useful event types:

- `repository_discovered`
- `commit`
- `working_tree_dirty`
- `working_tree_clean`
- `branch_changed`
- `ahead_changed`
- `behind_changed`

Do not create duplicate activity for unchanged repeated rescans.

The database must not store source-code contents, full diffs, secrets, or terminal history.

---

## 12. API Shape

Keep the API small.

Suggested routes:

### Health
- `GET /api/health`

### Sources
- `GET /api/sources`
- `POST /api/sources`
- `DELETE /api/sources/:id`
- `POST /api/sources/:id/scan`

### Repositories
- `POST /api/repositories/manual`
- `GET /api/repositories`
- `GET /api/repositories/:id`
- `POST /api/repositories/:id/refresh`

### Global Scan
- `POST /api/scans`

Use synchronous scanning initially unless real performance proves a background-job model is necessary.

### Activity
- `GET /api/activity`

Support basic repository/date filtering.

### Dashboard
- `GET /api/dashboard`

Return:

- tracked projects
- uncommitted projects
- active this week
- commits this week
- needs attention
- recent projects
- recent activity

### GitHub
- `GET /api/github/status`

### Launcher Actions
- `POST /api/repositories/:id/open/folder`
- `POST /api/repositories/:id/open/terminal`
- `POST /api/repositories/:id/open/vscode`
- `POST /api/repositories/:id/open/github`

Expected errors should use a consistent shape such as:

```json
{
  "error": {
    "code": "NOT_GIT_REPOSITORY",
    "message": "The selected folder is not a Git repository."
  }
}
```

Useful error codes include:

- `INVALID_PATH`
- `PATH_NOT_FOUND`
- `NOT_GIT_REPOSITORY`
- `SOURCE_ALREADY_EXISTS`
- `REPOSITORY_ALREADY_TRACKED`
- `REPOSITORY_NOT_FOUND`
- `GIT_UNAVAILABLE`
- `GITHUB_UNAVAILABLE`
- `GITHUB_NOT_AUTHENTICATED`
- `INTERNAL_ERROR`

---

## 13. UI Information Architecture

Use a **left sidebar** with five main destinations:

- Dashboard
- Projects
- Activity
- Sources
- Settings

Project Detail is a drill-down from Projects.

### Visual Direction

Build a clean developer utility:

- desktop-first
- light mode only for experimental V1
- neutral background
- restrained borders
- high information density
- normal sans-serif for UI
- monospace for branches, paths, and SHAs
- clear status indicators
- modest corner radii
- minimal motion

Avoid:

- marketing hero sections
- gradients
- glassmorphism
- giant cards
- fake analytics
- charts
- contribution heatmaps
- coding streaks
- productivity scores

---

## 14. Dashboard

Show:

- Tracked Projects
- Uncommitted Projects
- Active This Week
- Commits This Week

Then:

- Needs Attention
- Recent Projects
- Recent Activity

A repository belongs in Needs Attention when applicable because it is:

- Uncommitted
- Ahead
- Behind

Do not invent numerical risk/productivity scores.

---

## 15. Projects Screen

Use a dense list/table hybrid.

Show at least:

- project name
- path
- branch
- working-tree state
- ahead/behind
- GitHub state
- last activity

Filters:

- All
- Uncommitted
- Ahead
- Behind
- GitHub
- Local Only

Also support text search.

---

## 16. Project Detail

Header actions:

- Open Folder
- Open Terminal
- Open VS Code
- Open GitHub when available
- Rescan

Tabs:

- Overview
- Commits
- Activity

Overview should show:

- path
- branch
- working-tree state
- modified/staged/untracked counts
- ahead/behind
- last scan
- changed files
- remotes
- optional GitHub metadata

Changed files are read-only.

Commits should show at least:

- short SHA
- subject
- date/time

About 20 visible entries is enough initially.

---

## 17. Activity Screen

Combine events across repositories.

Support:

- project filter
- basic date range

Show:

- time
- project
- event type
- summary

No charts required.

---

## 18. Sources Screen

Manage:

### Scan Locations
Show:

- path
- depth
- last scan
- repositories discovered

Actions:

- Scan
- Remove
- Add Scan Location
- Rescan All

### Individual Repositories
Actions:

- Add Individual Repository
- Rescan
- Remove from dashboard

Removing from the dashboard must never delete files or repositories from disk.

For V1, text/pasted paths are acceptable. Backend validates them.

---

## 19. Settings Screen

Keep minimal.

Show GitHub CLI status:

- Installed / Missing
- Authenticated / Not Authenticated
- account name if safely available

Provide Refresh Status.

GitHub remains optional.

---

## 20. Consistent User-Facing Status Terms

Working tree:

- `Clean`
- `Uncommitted`

Sync:

- `Synced`
- `Ahead N`
- `Behind N`
- `Ahead N · Behind N`
- `No upstream`

GitHub:

- `GitHub Connected`
- `Local Only`
- `GitHub Unavailable`

---

## 21. Empty States

Handle zero-data states cleanly.

Examples:

- `No projects tracked yet.`
- `No activity recorded yet.`
- `No projects need attention.`
- `No projects match your search.`
- `GitHub enrichment is unavailable. Local repository tracking continues normally.`

Do not ship fake demo data.

---

## 22. Acceptance Criteria

The MVP is not complete unless all core behaviors below work.

### Startup
A fresh clone can:

1. `npm install`
2. run one documented development command
3. load the dashboard
4. reach the health endpoint

SQLite initializes automatically.

### Multiple Sources
At least two independent source locations can be saved, scanned, and persisted.

### Scanner
Must:

- discover Git repositories
- respect depth
- skip excluded directories
- survive inaccessible directories
- avoid duplicates

### Manual Repository Addition
- valid Git repo → accepted
- already tracked repo → clear duplicate response
- normal folder → `NOT_GIT_REPOSITORY`
- missing path → `PATH_NOT_FOUND`

Never initialize Git automatically.

### Branch Tracking
If the branch changes externally and the repo is rescanned, the dashboard must reflect the new branch.

### Working Tree
Must accurately distinguish clean/uncommitted and count modified, staged, and untracked files.

### Changed Files
Must be visible read-only.

### Commits
Recent commits display correctly and repeated rescans do not duplicate stored commits.

### Remote Parsing
HTTPS and SSH GitHub remotes normalize correctly. Non-GitHub remotes are not misclassified.

### Ahead/Behind
Display locally known upstream state without running `git fetch`.

### GitHub Optionality
Missing/unauthenticated/failing `gh` must not break local functionality.

### Dashboard
Statistics come from real data, not hardcoded placeholders.

### Activity
At minimum support meaningful events for:

- repository discovered
- commit
- clean → dirty
- dirty → clean
- branch change

Repeated unchanged rescans must not spam duplicate events.

### Persistence
Sources, repositories, commits, activity, and relevant cached data survive restart.

### Safety
Removing a source/repository from the dashboard never deletes files from disk.

Scanning must not change:

- branch
- working tree
- staging area
- history
- remotes

---

## 23. Automated Testing Expectations

Prioritize useful logic tests rather than large quantities of superficial UI snapshots.

At minimum test:

### Windows Path Normalization / Deduplication
Equivalent path forms must resolve to one repository.

### GitHub Remote Parsing
Test:

- HTTPS GitHub
- SSH GitHub
- non-GitHub
- malformed remote

### Activity Transitions
Test:

- clean → dirty
- dirty → dirty
- dirty → clean
- branch A → B
- duplicate commit

### Git Output Parsing
Known command output should produce correct structured state.

### Validation
Test:

- missing path
- non-Git repository
- duplicate source/repository
- unknown repository ID

Aim for a compact but meaningful suite.

---

## 24. Manual Disposable Test Repository

Do not use an important project as the first behavioral test fixture.

Create/document a disposable repository and manually test:

- clean
- modify tracked file
- create untracked file
- stage externally
- commit externally
- change branch externally

Verify the dashboard tracks these states without modifying the fixture itself.

---

## 25. Explicit V1 Non-Goals

Do not implement:

- multi-user support
- app login/authentication
- cloud backend
- mobile app
- team collaboration
- Jira/Trello features
- code editor
- Git client mutation features
- background filesystem watchers
- exact coding-time tracking
- productivity scoring
- AI summaries
- AI code review
- issue management
- pull request management
- repository cloning
- repository creation
- automatic fetch/pull/push
- full GitHub-account synchronization
- multi-repository project grouping
- notifications
- Electron
- Tauri
- SaaS/deployment infrastructure
- complex charting
- dark mode unless all required work is complete with substantial budget remaining

---

## 26. Implementation Discipline

This project has limited Grok usage.

Optimize for finishing the MVP correctly and efficiently.

Avoid:

- unnecessary dependencies
- speculative abstractions
- repeated framework changes
- rewriting stable code for style alone
- implementing future features
- repeatedly retrying the same failed strategy without reassessment

Prefer the simplest implementation satisfying the specification.

Use sensible Git commits at meaningful milestones while developing this dashboard repository.

---

## 27. Definition of Done

V1 is successful when:

> A Windows user can start the application, register multiple project locations and individual Git repositories, safely scan them, view accurate read-only Git state and recent activity, optionally enrich GitHub-connected repositories through `gh`, inspect repository details, and launch useful local actions without the dashboard modifying Git or project source files.

Correctness, safety, clarity, and specification adherence matter more than production polish.

---

## 28. Immediate Task — Planning Only

**Do not implement application code yet.**

First:

1. Read this specification completely.
2. Inspect the current repository and development environment.
3. Confirm what currently exists in the repository.
4. Check relevant prerequisites such as Node, npm, Git, and optionally `gh`.
5. Identify any genuine technical contradictions or blockers.
6. Propose the simplest folder structure and implementation architecture satisfying the specification.
7. Propose the SQLite schema and migration approach.
8. Map the services and API routes.
9. Break implementation into small milestones.
10. For each milestone, specify:
    - what will be built
    - how it will be tested
    - what constitutes completion
11. Identify the highest-risk areas.
12. Explicitly list tempting features that will **not** be implemented because they are outside V1.

Remain in Plan mode.

End with a concise implementation plan ready for owner approval.
