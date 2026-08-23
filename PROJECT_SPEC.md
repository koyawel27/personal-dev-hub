# Personal Dev Hub — Revised Project Specification

> Working title: **Personal Dev Hub**  
> Repository: `C:\xampp-projects\local-dev-dashboard`  
> Previous working title: Local Developer Dashboard  
> Product direction: personal developer workspace / lightweight project tracker  
> Target: Windows-first, local-first, single-user V1

---

## 1. Product vision

Personal Dev Hub is a **single-user, local-first developer workspace** that brings together a developer's local Git repositories and optional GitHub activity into one simple place.

Its purpose is to answer, at a glance:

- What projects am I actively working on?
- What changed recently?
- Which repositories have uncommitted or unsynced work?
- What has my development activity looked like over time?
- Which projects have I completed, paused, archived, or kept as experiments?
- Which projects do I want to present as part of a simple personal portfolio?

The product is inspired by the **developer activity / repository tracking** side of tools such as LogBytes, but it is **not** a clone and must not copy LogBytes' broader professional, corporate, team, proof-pack, or reporting product direction.

The product should feel like a **personal project tracker + development activity journal**, not a corporate productivity platform.

---

## 2. Core product principles

### 2.1 Personal first

The application is for one developer on one machine.

No teams, accounts, permissions, organizations, client spaces, public network, or collaboration model are required in V1.

### 2.2 Local-first

Local Git repositories are first-class citizens.

A project must be useful even when it has:

- no GitHub repository,
- no remote,
- no internet connection,
- no cloud account.

GitHub is optional enrichment, not a requirement.

### 2.3 Repository state supports the product; it is not the product

Git details such as current branch, clean/dirty state, staged/untracked files, ahead/behind, latest commit, and remotes are useful context, but the app's identity is broader:

> **What have I been building, what am I working on now, and what does my development history look like?**

### 2.4 Low-maintenance project tracking

The app should automatically infer as much as possible from Git and GitHub. Manual project metadata should stay lightweight.

### 2.5 Honest activity semantics

The application must never claim to know exact coding time from commits. Terms such as activity, recent activity, active days, commit count, and repository changes are acceptable. Exact hours worked, productivity score, and efficiency score are out of scope.

---

## 3. Primary user

A developer or student developer who maintains multiple projects across local folders and GitHub and wants a simple personal view of current projects, development activity, repository state, contribution history, project notes, and selected portfolio work.

V1 is explicitly **single-user**.

---

## 4. V1 information architecture

Main navigation:

1. **Dashboard**
2. **Projects**
3. **Activity**
4. **Contributions**
5. **Portfolio**
6. **Sources**
7. **Settings**

Project Detail is accessed from Projects and Dashboard.

---

## 5. Dashboard

The Dashboard should answer:

> **What have I been working on lately?**

It should prioritize recent development activity rather than repository warnings alone.

### 5.1 Summary metrics

Show compact, real values such as:

- Tracked Projects
- Active Projects
- Commits This Week
- Active Days This Week
- Repositories With Uncommitted Changes

Do not use fake metrics or productivity scores.

### 5.2 Recently Active Projects

Show the projects with the most recent meaningful development activity. Each item should include, where available:

- project name,
- manual project status,
- project type,
- current branch,
- last meaningful activity time,
- latest commit subject,
- clean / uncommitted indicator,
- GitHub-connected / local-only indicator.

Recent activity must be derived from meaningful developer events, not `last_scanned_at`.

### 5.3 Recent Activity

Show a compact chronological feed across tracked projects. Examples:

- commit observed,
- working tree became dirty,
- working tree became clean,
- branch changed,
- ahead / behind state changed,
- repository discovered,
- project status manually changed,
- project note updated.

Avoid duplicate events on unchanged rescans.

### 5.4 Needs Attention

A secondary section, not the main identity of the Dashboard.

Potential reasons:

- uncommitted changes,
- ahead of upstream,
- behind upstream,
- ahead and behind,
- missing upstream,
- repository path unavailable,
- GitHub enrichment unavailable.

### 5.5 Contribution preview

Include a compact contribution/activity calendar preview or summary linking to the full Contributions page.

---

## 6. Projects

Projects is the main project tracker and repository explorer.

### 6.1 Project sources

A project may be:

- **Local + GitHub**
- **Local Only**

GitHub-only projects are **not required for V1** and may be considered for V2.

### 6.2 Project list

Use a dense, scannable list/table rather than giant cards. Each project should show:

- name,
- local path,
- project status,
- project type,
- current branch,
- clean / uncommitted state,
- latest activity,
- latest commit,
- ahead / behind state,
- GitHub-connected / local-only state.

### 6.3 Search and filters

Support:

- text search,
- project status,
- project type,
- clean / uncommitted,
- ahead,
- behind,
- GitHub connected,
- local only.

### 6.4 Manual project metadata

Each tracked project may have lightweight user-managed metadata.

**Status:** Active, Paused, Finished, Archived, Experiment.

**Type:** Personal, School, OJT, Client, Experiment, Other.

**Notes:** optional short project note, such as “Waiting for adviser feedback” or “Stage 6 blur resize bug remains.”

**Portfolio inclusion:** Include in Portfolio / Do not include.

---

## 7. Project Detail

Recommended sections or tabs:

1. **Overview**
2. **Commits**
3. **Activity**

### 7.1 Overview

Show:

- project name,
- local path,
- manual status,
- project type,
- manual note,
- current branch,
- working tree state,
- changed-file counts,
- upstream state,
- ahead / behind,
- primary remote,
- GitHub URL if recognized,
- latest commit,
- recent activity,
- portfolio inclusion toggle.

### 7.2 Changed files

Read-only display of current changed files.

V1 must not edit, stage, commit, discard, checkout, merge, pull, push, reset, stash, or otherwise mutate repositories.

### 7.3 Commits

Show bounded recent commit history with SHA abbreviation, subject, author, and committed time.

### 7.4 Activity

Show project-specific chronological activity events.

### 7.5 Launcher actions

Allowed actions:

- Open Folder
- Open Terminal
- Open in VS Code
- Open GitHub

Launcher APIs must use a registered project/repository ID and resolve the trusted local path server-side. Do not expose arbitrary path or arbitrary command execution endpoints.

---

## 8. Activity

Activity is a global chronological development journal.

### 8.1 Local activity event types

Recommended V1 events:

- `repository_discovered`
- `commit_observed`
- `working_tree_dirty`
- `working_tree_clean`
- `branch_changed`
- `ahead_changed`
- `behind_changed`
- `project_status_changed`
- `project_note_updated`

### 8.2 Event timestamps

- Commit activity uses actual `committed_at`.
- State transitions use observation time.
- Discovery uses discovery time.
- `last_scanned_at` is operational metadata and must never be treated as development activity.

### 8.3 Deduplication

Rescanning an unchanged repository must not create duplicate activity events. Use stable fingerprints or deterministic transition detection.

---

## 9. Contributions

Contributions is a first-class V1 feature.

### 9.1 Contribution calendar

Provide a GitHub-style year/activity heatmap or similar compact calendar visualization, but do not visually clone GitHub or LogBytes exactly.

### 9.2 Activity sources

V1 should support at least:

- Local Git commit activity
- GitHub commit/contribution enrichment when available
- Combined view where technically reliable

The UI should make the selected source clear.

### 9.3 Daily detail

Selecting a day should show useful detail such as:

- commit count,
- projects involved,
- commit subjects,
- local vs GitHub source where applicable.

### 9.4 Avoid double-counting

If a local commit and GitHub enrichment refer to the same commit SHA, do not count it twice in combined activity.

### 9.5 No exact time claims

The calendar represents activity and contributions, not hours worked.

---

## 10. Portfolio

Portfolio is intentionally lightweight. It is not a full professional portfolio builder and must not become a second product.

Its purpose is to reuse the project data already tracked by the app to present selected work clearly.

### 10.1 V1 portfolio view

Show projects marked `Include in Portfolio`. Each selected project may display:

- project name,
- description or note,
- project type,
- status,
- technology/language hints when available,
- GitHub URL if connected,
- development activity summary,
- first / latest known commit dates.

### 10.2 Local-only first

V1 portfolio can remain a local preview inside the app. No public hosting or publishing service is required.

### 10.3 Explicitly out of scope

Do not build professional experience forms, public account identity, resume builder, team profile, availability status, corporate proof packs, client sharing, public networking, or hosted portfolio publishing.

---

## 11. Sources

### 11.1 Scan roots

Support multiple user-configured scan roots. Examples:

- `C:\xampp-projects`
- `C:\xampp\htdocs`
- `E:\Projects`

Do not automatically scan the entire system drive.

### 11.2 Discovery rules

Default maximum depth: 3.

Skip common heavy/generated folders such as `node_modules`, `vendor`, `.git`, `dist`, `build`, `coverage`, `.cache`, `.venv`, and `venv`.

Stop descending once a valid Git worktree is identified. Avoid following symlink/junction cycles.

### 11.3 Manual repository add

Allow the user to paste/type a repository path. Validate that it is a Git worktree and reject non-Git folders clearly.

### 11.4 Dedupe

Canonicalize Windows paths and deduplicate case/path variants. The same GitHub repository may legitimately have multiple local copies; local identity remains path-based.

### 11.5 Source removal

Removing a scan root removes only the source configuration. Previously discovered repositories remain registered with `source_id = NULL` until explicitly removed.

Removing a repository from the app must not delete or modify the real filesystem repository.

---

## 12. Settings

Keep Settings minimal. Recommended V1 settings:

- Git executable status
- GitHub CLI / authentication status when available
- default scan depth
- app data location
- contribution display preferences
- refresh/rescan controls

---

## 13. Git behavior

The application is **read-only toward tracked Git repositories in V1**.

### 13.1 Exact allowed Git operations

Use safe process execution with argument arrays, never shell-concatenated user input.

The V1 Git adapter may use explicitly implemented read-only operations such as:

- `git rev-parse --is-inside-work-tree`
- `git rev-parse --abbrev-ref HEAD`
- `git rev-parse HEAD`
- `git status --porcelain=v1 -uall`
- bounded `git log`
- `git remote -v`
- `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`
- `git rev-list --left-right --count @{upstream}...HEAD`

Do not expose a generic “run git command” endpoint.

### 13.2 No automatic fetch

Ahead/behind is computed from local remote-tracking refs already present. The app must not automatically fetch, pull, push, commit, reset, checkout, merge, rebase, stash, stage, discard, or mutate repository state.

---

## 14. GitHub integration

GitHub is optional enrichment. The app must fully work without GitHub authentication.

### 14.1 Remote recognition

Recognize common GitHub HTTPS and SSH remotes. Parse host, owner, repository name, and normalized GitHub URL.

Open GitHub should work from a recognized remote even when GitHub CLI enrichment is unavailable.

### 14.2 Authentication

Prefer existing `gh` authentication if available. Do not store GitHub personal access tokens inside the application's own database.

### 14.3 Enrichment

When available, GitHub enrichment may provide repository metadata, default branch, visibility, pushed-at timestamps, and contribution information needed by the Contributions page.

GitHub outages or missing authentication must not break local functionality.

---

## 15. Data model direction

The existing partial implementation may already contain some of these concepts. Reuse compatible work rather than rewriting blindly.

### 15.1 `project_sources`

- id
- path
- canonical_path
- scan_depth
- enabled
- created_at
- last_scanned_at

### 15.2 `local_repositories`

- id
- source_id nullable
- name
- local_path
- canonical_path unique
- discovery_type
- project_status
- project_type
- project_note
- include_in_portfolio
- portfolio_order nullable
- created_at
- last_scanned_at

### 15.3 `repository_snapshots`

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

### 15.4 `git_remotes`

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

### 15.5 `github_repositories`

- id
- owner
- name
- full_name
- visibility
- default_branch
- html_url
- last_pushed_at
- last_refreshed_at

### 15.6 `commits`

- id
- local_repository_id
- commit_sha
- subject
- author_name
- committed_at
- first_seen_at

Unique: `(local_repository_id, commit_sha)`.

Commit history should be bounded.

### 15.7 `activity_events`

- id
- local_repository_id
- event_type
- summary
- occurred_at
- source
- fingerprint
- metadata_json

### 15.8 Contribution data

Prefer deriving contribution views from commits/activity where practical. If GitHub enrichment requires cached contribution-day aggregates, add a dedicated cache table only when justified.

---

## 16. Refresh / rescan correctness

Recommended order:

1. Load previous snapshot and known commits.
2. Inspect repository using safe read-only Git operations.
3. Parse remotes and GitHub identity.
4. Determine newly observed commits and state transitions.
5. Derive activity events.
6. Persist snapshot, remotes, commits, and activity events atomically where appropriate.
7. Perform optional GitHub enrichment separately so GitHub failure does not roll back valid local state.

SQLite foreign keys must be enabled.

---

## 17. Technology baseline

Keep the existing V1 architecture unless the continuation audit finds a real incompatibility.

### Frontend

- React
- TypeScript
- Vite
- normal CSS

### Backend

- Node.js
- TypeScript
- Express

### Persistence

- SQLite

### Runtime model

- local web application
- backend bound only to `127.0.0.1`
- no XAMPP dependency required

Avoid introducing Redux, Next.js, Electron, Tauri, Docker, or a large framework unless a concrete requirement proves necessary.

---

## 18. Visual direction

The visual design should **not copy LogBytes**.

Desired qualities:

- personal developer-tool feel,
- calm and focused,
- compact but readable,
- information-dense without clutter,
- strong project/activity hierarchy,
- clear state badges,
- excellent dark mode or a carefully chosen primary theme,
- responsive desktop-first layout,
- subtle use of cards/panels where they clarify structure,
- no giant marketing UI,
- no glassmorphism-heavy design,
- no decorative gradients unless restrained,
- no fake terminal aesthetic everywhere.

The app should feel like a useful personal workspace, not a SaaS landing page or enterprise analytics product.

---

## 19. Empty / loading / error states

Every major page must have real empty/loading/error states.

Examples:

- Dashboard: “No repositories tracked yet.” → Add a source
- Projects: “No projects discovered yet.”
- Contributions: “No development activity recorded yet.”
- Portfolio: “No projects selected for your portfolio.”
- GitHub unavailable: local data remains usable; optional enrichment failure must not block the page.

---

## 20. Security and privacy

### 20.1 Local binding

Bind backend to `127.0.0.1`, not all interfaces by default.

### 20.2 Process execution

Use `execFile` / `spawn` with argument arrays. Never concatenate untrusted paths into shell command strings.

### 20.3 Launcher safety

Launcher endpoints accept only registered repository/project IDs. The backend resolves the trusted path.

No arbitrary path launch endpoint. No arbitrary command execution endpoint.

### 20.4 Repository privacy

Do not store repository source code, full diffs, secrets, or terminal history. Store only metadata needed for the product.

### 20.5 GitHub secrets

Do not persist GitHub PATs in the application database. Use existing authenticated tooling where available.

---

## 21. Explicitly out of scope for V1

Do not add:

- user accounts,
- teams,
- organizations,
- collaboration,
- cloud sync,
- SaaS backend,
- mobile native app,
- client proof packs,
- corporate reporting,
- resume builder,
- professional experience builder,
- public social network,
- hosted portfolio publishing,
- GitHub issue / PR management,
- task board,
- kanban,
- project ticketing,
- exact coding-time tracking,
- productivity scores,
- employee monitoring,
- AI summaries,
- AI chatbot,
- code editor,
- terminal emulator,
- repository mutation,
- automatic Git fetch/pull/push,
- notifications,
- background filesystem watcher in V1.

Manual rescan is sufficient for V1.

---

## 22. V1 acceptance criteria

### 22.1 Startup / persistence

- Fresh install works from documented steps.
- SQLite schema initializes/migrates correctly.
- App data survives restart.
- Backend binds only to `127.0.0.1`.

### 22.2 Sources / discovery

- Multiple scan roots can be added.
- Scan depth and skip directories work.
- Discovery stops after a valid worktree.
- Symlink/junction recursion is safe.
- Duplicate Windows path variants do not create duplicates.
- Manually adding a valid Git repo works.
- Non-Git folders are rejected clearly.
- Source removal does not delete repositories from disk.

### 22.3 Repository state

- Current branch is correct.
- Clean/uncommitted state is correct.
- Staged/modified/untracked counts are correct.
- Changed files are shown read-only.
- Upstream state is handled.
- Ahead/behind uses local tracking refs only.
- No automatic fetch occurs.
- Recent commits are bounded and deduplicated.

### 22.4 Manual project tracking

- Status can be changed.
- Type can be changed.
- Short project note can be saved.
- Portfolio inclusion can be toggled.
- Manual changes produce appropriate activity where specified.

### 22.5 Dashboard

- Summary metrics are real.
- Recently active projects use meaningful activity.
- Recent activity is chronological.
- Needs Attention identifies relevant repository conditions.
- Contribution preview reflects real activity.

### 22.6 Activity

- Initial scan does not fabricate recent activity from old commits.
- Old commits keep historical `committed_at`.
- State transitions use observation time.
- Unchanged rescans do not duplicate events.
- Global and project-specific activity views work.

### 22.7 Contributions

- Calendar/heatmap renders from real activity.
- Local commit activity is visible.
- GitHub contribution enrichment is optional.
- Combined mode avoids double-counting same commit SHAs.
- Daily detail can identify projects/commits.
- No exact-time claims are made.

### 22.8 Portfolio

- User can select projects for portfolio.
- Portfolio view reuses tracked project data.
- GitHub URL works when available.
- Local-only projects can still appear.
- Empty state works.
- No public hosting is required.

### 22.9 GitHub

- HTTPS and SSH remotes normalize correctly.
- Open GitHub works from parsed remote without requiring `gh`.
- Missing `gh` does not break local features.
- GitHub enrichment failure is surfaced non-destructively.
- No GitHub secrets are stored in app DB.

### 22.10 Launcher safety

- Open Folder works from registered repo ID.
- Open Terminal works from registered repo ID.
- Open VS Code works from registered repo ID when available.
- Open GitHub works for recognized GitHub repos.
- No arbitrary path or arbitrary command endpoint exists.

### 22.11 Tests

Prioritize automated tests for:

- Windows path normalization,
- GitHub remote parsing,
- Git output parsers,
- repository validation,
- activity transition derivation,
- activity deduplication,
- contribution aggregation,
- no contribution double-counting,
- project metadata validation,
- source removal behavior,
- safe launcher resolution,
- API validation.

Use disposable Git repository fixtures where appropriate.

---

## 23. Continuation context for the existing Grok implementation

This repository already contains a **partial implementation produced by Grok Build**.

The original Grok-only endpoint is preserved in Git history at:

- commit: `9711ebb`
- checkpoint message: `checkpoint: preserve partial Grok implementation after free limit`

Treat that checkpoint as historical evidence and do not rewrite history.

The partial implementation includes backend/shared infrastructure such as SQLite setup/migrations, Git process execution, Git parsers, Git service, activity service, and shared path/GitHub/status utilities.

The previous run did **not** complete the app. Known state at the checkpoint included:

- no completed frontend,
- no test suite,
- build could not run because the client was absent,
- TypeScript config required correction,
- implementation had progressed beyond clean milestone boundaries.

---

## 24. Required continuation workflow for the next coding agent

Before modifying code:

1. Read this revised `PROJECT_SPEC.md` completely.
2. Inspect the full repository and Git history.
3. Inspect the existing partial Grok implementation.
4. Determine which existing code is reusable as-is, reusable with fixes, obsolete under the revised direction, or missing.
5. Do **not** restart the project from scratch unless the audit proves a component is unsalvageable.
6. Produce a continuation plan before implementation.
7. Map every proposed milestone to this revised specification.
8. Identify migrations required from the old data model/code to the revised product model.
9. Preserve the read-only Git safety model.
10. Wait for explicit approval before implementation.

The continuation agent should be judged partly on its ability to inherit and improve another agent's unfinished work rather than simply replacing it.

---

## 25. Definition of done

V1 is done only when:

1. The app discovers and tracks multiple real local Git repositories.
2. Dashboard accurately reflects current/recent personal development activity.
3. Projects can be lightly categorized and annotated.
4. Project Detail accurately exposes Git state and recent history without mutating repos.
5. Global Activity works without duplicate scan noise.
6. Contributions visualize real development activity and avoid obvious double-counting.
7. GitHub enrichment is useful but optional.
8. Portfolio presents selected projects using existing tracked data.
9. Sources and manual repository management are safe and understandable.
10. Launcher actions are constrained to registered repositories.
11. Local repository files are never mutated by the application.
12. Tests cover critical parsing, activity, contributions, validation, and safety behavior.
13. Production build passes.
14. Type checking passes.
15. Test suite passes.
16. Live manual acceptance confirms the main workflows.
17. README documents installation, startup, data location, limitations, and privacy behavior.
18. Git working tree is clean at the final accepted checkpoint.

---

## 26. Product identity summary

Personal Dev Hub is not a corporate developer analytics platform.

It is not a Git client.

It is not a project-management suite.

It is not a portfolio builder with repository features attached.

It is:

> **A personal developer workspace that combines local repositories, GitHub activity, lightweight project tracking, development history, and selected portfolio work into one simple local-first application.**

The central question the product should always answer is:

> **What have I been building, what am I working on now, and how has my development work evolved over time?**
