# Personal Dev Hub — Revised Project Specification

> Working title: **Personal Dev Hub**  
> Repository: `C:\xampp-projects\local-dev-dashboard`  
> Previous working title: Local Developer Dashboard  
> Product direction: personal developer workspace / lightweight project tracker  
> Target: Windows-first, local-first, single-user V1

**Document status:** V1.1 remains a prior **finalized and tagged** owner-accepted historical release (see `docs/RELEASE_V1.1.md`). V1.2 is the latest **finalized and tagged** owner-accepted release (see `docs/RELEASE_V1.2.md`; tag `personal-dev-hub-v1.2-owner-accepted`, canonical accepted application commit `a32c436b29090543b92af6b501d7ddd755087fb8`). **V1.3 is the current feature-complete release candidate** on `feature/v1.3` — release hardening complete, **pending final owner acceptance, merge to main, merged-main verification, and an immutable acceptance tag**. Sections below describe the current V1.3 candidate implementation unless explicitly marked historical; historical V1.1/V1.2 release descriptions are preserved as history.

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

GitHub is an optional first-class binding, not a requirement. Local functionality must work fully without it.

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

Main navigation (actual app order):

**Workspace**

1. **Dashboard**
2. **Projects**
3. **Activity**
4. **Contributions**
5. **Portfolio**

**Manage**

6. **Sources**
7. **Maintenance**
8. **Settings**

Project Detail is accessed from Projects and Dashboard.

**Maintenance is distinct from Settings:**

- **Maintenance** — operational recovery: backups / restore, Source Health attention and repair entry points (Rescan / Relink).
- **Settings** — configuration: Git status, GitHub connection summary, scan depth, app data location, rescan controls.

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

The **Project** is the tracked domain entity. Its source state derives from its bindings:

- **LOCAL ONLY** — one or more local repository bindings, no GitHub binding.
- **LOCAL + GITHUB** — local repository binding(s) plus a GitHub binding.
- **GITHUB ONLY** — a GitHub binding with no local copy. GITHUB ONLY projects are fully valid in V1.1, including for Portfolio.

A Project with zero bindings is an invalid/transient state and exists only as a repair state (see migration `007_repair_zero_binding_ghosts`); it is never presented as GITHUB ONLY.

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

Each Project carries lightweight user-managed metadata. Manual metadata belongs to the **Project entity itself** (`PATCH /api/projects/:projectId/metadata`) — never to a local repository row or a GitHub binding. Local Git state (branch, working tree, commits, remotes) belongs to local repository bindings; GitHub metadata (visibility, default branch, last push) belongs to the GitHub binding.

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

Activity is a global chronological development journal. Activity ownership is **Project-centric**: every event belongs to a Project and is derived from that Project's local repository bindings and/or its GitHub binding. Raw source observations remain distinguishable behind the deduplicated view.

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

The logical Activity read model collapses matching commit observations by **Project + SHA**: the same commit observed both locally and on GitHub appears once (surfaced as LOCAL + GITHUB), while genuine non-commit events and commits with different SHAs remain distinct. Raw per-source observations remain preserved in storage and distinguishable.

---

## 9. Contributions

Contributions is a first-class V1 feature.

### 9.1 Contribution calendar

Contributions is **YEAR-based**: the page renders a full-year view with available-year selection (years listed newest-first), backed by a GitHub-style compact calendar visualization that does not visually clone GitHub or LogBytes exactly.

### 9.2 Activity sources

The implementation provides three lenses, with the selected source always clear in the UI:

- **Local** — local Git commit activity,
- **GitHub** — commits observed from tracked GitHub bindings after a manual refresh,
- **Combined** — both, with overlapping commits collapsed.

### 9.3 Daily detail

Selecting a day should show useful detail such as:

- commit count,
- projects involved,
- commit subjects,
- local vs GitHub source where applicable.

### 9.4 Avoid double-counting

In the Combined view, the same commit SHA observed in both the local and GitHub tracked datasets is counted once, with the overlap reported transparently rather than hidden.

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

### 10.2 Local-first, GitHub-only eligible

The portfolio is a local preview inside the app. No public hosting or publishing service is required. Projects in any valid source state may be included — **LOCAL ONLY**, **LOCAL + GITHUB**, and **GITHUB ONLY** — with GitHub-only items using GitHub's reported primary language as the technology hint.

### 10.3 Explicitly out of scope

Do not build professional experience forms, public account identity, resume builder, team profile, availability status, corporate proof packs, client sharing, public networking, or hosted portfolio publishing.

---

## 11. Sources

The Sources page is organized into three sections, matching the implemented UI:

1. **Scan Locations** — multiple user-configured scan roots,
2. **Local Repositories** — individual local repository bindings (including manual add),
3. **Browse GitHub Repositories** — the curated GitHub picker.

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

Keep Settings minimal. Settings is **configuration only** — operational recovery (backups, restore, Source Health repair entry points) lives in **Maintenance**, not here. Recommended V1 settings:

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

GitHub is optional. The app must fully work without GitHub authentication, and local functionality never depends on it.

### 14.1 Remote recognition

Recognize common GitHub HTTPS and SSH remotes. Parse host, owner, repository name, and normalized GitHub URL.

Open GitHub should work from a recognized remote even when GitHub CLI enrichment is unavailable.

### 14.2 Authentication

Prefer existing `gh` authentication if available. Do not store GitHub personal access tokens inside the application's own database. There is no OAuth flow and no PAT storage.

### 14.3 Tracking — an optional first-class binding

GitHub repository tracking is an optional **first-class binding of a Project**, not merely enrichment:

- Repositories are selected explicitly through the curated picker (**Sources → Browse GitHub Repositories**) with search and Owned/Collaborator/Organization/Public/Private/Archived/Forks/Tracked/Untracked filters.
- Tracking never clones; it records the binding and fetches metadata plus bounded commit history only.
- A picked repository whose remote matches a local clone's remote links into the same Project instead of duplicating it.
- Refresh is **manual** only — no daemon, no background sync.
- V1.1 cardinality: at most **one GitHub binding per Project** (0..1), enforced by schema.
- GitHub outages or missing authentication must not break local functionality.

---

## 15. Data model (V1.1, as implemented)

The V1.1 model is Project-centric, established by migrations `004_projects_core`, `005_github_bindings`, and `006_project_activity`, with `007_repair_zero_binding_ghosts` as a repair migration.

### 15.1 `projects` — the core entity

Owns all manual metadata: project status, type, note, include-in-portfolio flag, and portfolio order. Manual metadata never lives on repository rows.

### 15.2 `local_repositories` — local bindings of a Project

Each row carries `project_id` referencing `projects`. There is deliberately **no uniqueness constraint** on `project_id`: the model fully supports **0..many local bindings per Project**. Local Git state belongs to these bindings and their satellite tables (`repository_snapshots`, `git_remotes`, `commits` — the latter unique per `(local_repository_id, commit_sha)` with bounded history).

V1.2 (migration `008_primary_local_binding`) adds `is_primary` (0/1, CHECK-constrained) with a **partial unique index** permitting at most **one explicit display primary per Project**; the migration backfills `MIN(id)` per project with local bindings. The display primary is a presentation preference the owner can change — no Git scan and no activity event are involved. When malformed/legacy data has no explicit primary, the read-time defensive fallback is `MIN(id)`. The **permanent fingerprint/activity anchor** (`fingerprintAnchorLocalBindingId`) also remains `MIN(id)`, independent of the display primary, so changing the primary can never re-key historical events. Per-binding health (migration `009`) is covered in 15.8.

### 15.3 `github_repositories` — the optional GitHub binding

`project_id` references `projects` under a **partial unique index** (`WHERE project_id IS NOT NULL`), enforcing **0..1 GitHub binding per Project** in V1.1. Untracked cache rows keep `project_id IS NULL`.

### 15.4 `github_commits` — GitHub-observed commits for tracked bindings

`UNIQUE (github_repository_id, commit_sha)`, bounded history, day-indexed for the Contributions year view.

### 15.5 `activity_events` — Project-centric

Rebuilt by migration `006` around `project_id`; events derive from a Project's local bindings and/or GitHub binding, with stable fingerprints preventing rescan noise and raw per-source observations remaining distinguishable.

### 15.6 Zero-binding repair

Migration `007_repair_zero_binding_ghosts` repairs zero-source Projects. A zero-binding Project is an invalid/transient repair state and is never treated as GITHUB ONLY.

### 15.7 Contribution data

Contribution views derive from local `commits` and `github_commits`. The Combined view collapses overlapping SHAs across the local and GitHub tracked datasets and reports deduplication transparently; aggregation is year-based with available-year selection.

### 15.8 Local-binding health (V1.2, migration `009_local_binding_health`)

`local_repositories` carries `last_health_state` / `last_health_checked_at`, caching the outcome of the last **explicit** inspection:

- **Stored** (CHECK-constrained): `OK` — the path existed and was a Git worktree at the last scan/refresh — and `NOT_A_GIT_REPO` — the checked path exists but is not a Git worktree. Backfill: bindings with `last_scanned_at` set became `OK` with `checked_at = last_scanned_at`; never-scanned bindings stay `NULL`.
- **Derived at read time, never stored:** `PATH_MISSING` (the stored path no longer exists) and `UNSCANNED` (no cached check).

Normal UI reads determine health from the cache plus a filesystem existence check only — they never spawn Git processes merely to render health.

### 15.9 V1.2 local-binding workflows: Add Local Copy and Relink

**Add Local Copy** (Project Detail): an existing Project receives another existing local Git copy as a new local binding. No cloning. The candidate is inspected read-only; a recognized remote identity match or one known shared commit SHA is positive evidence and attaches without confirmation; ambiguous/insufficient evidence requires owner confirmation; a strong recognized identity conflict is rejected. The first local binding of a GITHUB ONLY Project becomes primary; subsequent copies join as non-primary.

**Relink** points the SAME binding at a moved/renamed folder: binding id, Project ownership, history, and stored primary state are preserved; it is not Remove+Add; files are never moved; canonical path collisions are rejected; Git is read-only. Evidence rules match Add Local Copy: one known SHA overlap is positive evidence; absence of SHA overlap alone is never a mismatch; a strong recognized identity conflict with zero known SHA overlap is a hard rejection; uncertain cases require owner confirmation. Relink emits no `repository_discovered` event, and an invalid candidate leaves the old binding's cached health unmutated.

### 15.10 Migration backup hardening (V1.2 M5)

Declared rebuild migrations automatically snapshot the database before any DDL:

- snapshot produced with `VACUUM INTO` on the live `DatabaseSync` connection; the source path derives from `PRAGMA database_list` (main database) — not from configuration
- includes committed write-ahead-log state (a plain main-file copy would not)
- the artifact is verified before the rebuild continues: exists, non-empty, opens read-only, `PRAGMA integrity_check == "ok"`, schema objects present
- failed/unverifiable output is removed; a pre-existing exact destination is protected — never overwritten or deleted
- `.failed`-marked backups are exempt from pruning and do not consume ordinary retention; retention keeps the newest 3 older ordinary backups (`BACKUP_RETENTION = 3`)

This remains the automatic **MIGRATION** backup category (see the V1.3 Recovery & Maintenance section). V1.3 additionally provides owner-facing **MANUAL** backups and restart-mediated restore under Maintenance.

---

## 15.11 V1.3 Recovery & Maintenance (bounded)

V1.3 does **not** rewrite the V1.1/V1.2 architecture. It adds one operational surface: a top-level **Maintenance** page for application-data recovery and source-health attention.

### Locked V1.3 decisions

- **Top-level Maintenance page** — distinct from Settings (recovery vs configuration).
- **Filesystem-backed backup inventory** — `<database-directory>/backups/` is the source of truth; listing classifies recognized app-managed artifacts.
- **Zero new SQLite migrations** — V1.3 adds no migration files and no `schema.sql` changes relative to accepted V1.2.
- **Reusable verified snapshot primitive** — `VACUUM INTO` + verification (exists, non-empty, read-only open, `PRAGMA integrity_check == "ok"`, schema present). Used by manual backups, migration backups, and restore safety snapshots.
- **Three backup types:** `MANUAL` (owner-created from Maintenance; owner-deletable), `MIGRATION` (automatic pre-rebuild safety; existing retention policy), `RESTORE_SAFETY` (automatic snapshot immediately before an applied restore; preserved for recovery; not deletable through the normal manual-delete workflow).
- **Manual backup workflow** — owner can create and inspect verified backups of the application database.
- **Restart-mediated restore** — restore is scheduled from Maintenance; it does **not** hot-swap the running DB. Restart applies it: selected backup verified again, current DB snapshotted first, restore validated before success.
- **App-managed backups only** — backups cover Personal Dev Hub's SQLite application data/metadata. They do **not** cover tracked Git repositories or source files inside them. Tracked repositories remain untouched.
- **Crash-safe restore attempt journal** — V1.3 restore processing includes a versioned attempt journal so interrupted restores can be recovered deterministically (internal transient operational state; not SQLite schema).
- **Fail-closed persistent startup blocking** — if interrupted recovery cannot prove application data is safe, startup refuses to continue rather than initialize a fresh database.
- **Source Health reuses V1.2 health states** — `PATH_MISSING`, `NOT_A_GIT_REPO`, `UNSCANNED` are the attention view; normal health rendering remains Git-process-free (`OK` / `NOT_A_GIT_REPO` from last explicit scan/refresh; path existence checked at read time).
- **Relink / Rescan reused** — repair stays manual; no watcher, daemon, or auto-repair.
- **Tracked Git repositories remain read-only.**

Restore concerns Personal Dev Hub **application data** (projects, bindings, settings, activity, history) — not the tracked repositories themselves.

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

## 18. Visual direction (owner-accepted V1.1)

The accepted direction is a **"Warm Developer Workbench with subtle retro-computing character"**:

- warm paper/sand surfaces (`--bg`/`--surface` family) with a restrained clay accent,
- faint grid/pixel texture, tactile borders, and restrained offset shadows,
- Segoe UI / system sans for normal UI; Cascadia Mono / Consolas for technical metadata,
- information-dense without clutter, strong project/activity hierarchy, clear state badges,
- not terminal cosplay, not a generic SaaS look, not a GitHub clone, and not an 8-bit game UI.

**Desktop-first:** narrow widths are a containment requirement only (internal scrolling is acceptable); first-class mobile polish is deliberately deferred.

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
- LOCAL ONLY, LOCAL + GITHUB, and GITHUB ONLY projects can all appear.
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

## 23. Historical context: the pre-V1.1 Grok checkpoint (historical)

> **This section is historical.** V1.1 is complete and owner-accepted; nothing here describes pending work.

This repository's earliest working state was a **partial implementation produced by a Grok build run**. That checkpoint is preserved in Git history at:

- commit: `20fe6ff`
- checkpoint message: `checkpoint: preserve partial Grok implementation after free limit`

> **Note on SHAs:** the repository history was intentionally rewritten before its first GitHub publication to replace a private email address with the owner's GitHub noreply identity. Older documents that reference SHA `9711ebb` for this checkpoint are stale; `20fe6ff` is the corresponding commit in the current history. Do not resurrect old SHAs.

The partial implementation included backend/shared infrastructure such as SQLite setup/migrations, Git process execution, Git parsers, a Git service, an activity service, and shared path/GitHub/status utilities.

Known state at that checkpoint: no completed frontend, no test suite, a build that could not run because the client was absent, and a TypeScript config requiring correction. All of that has since been superseded by the completed V1.1 implementation.

---

## 24. Continuation outcome (historical)

> **This section is historical.** The continuation workflow that was previously addressed to a "next coding agent" was executed to completion and required no further continuation.

The continuation proceeded through audit, an approved plan, and implementation milestones that produced the V1.1 product: the Project-centric data model (migrations 004–006 with 007 as repair), retirement of the repository-as-project compatibility APIs, first-class GitHub tracking with GITHUB ONLY projects, Project-centric activity with honest commit dedup, year-based Contributions with Local/GitHub/Combined lenses, the warm developer workbench UI, and the full deterministic test suite. The result was accepted by the owner and is recorded in `docs/RELEASE_V1.1.md`.

---

## 25. Definition of done — V1.1 (met)

V1.1 is done, and was accepted by the owner, against the following criteria:

1. The **Project** is the tracked domain entity, with optional local repository bindings (0..many structurally; V1.1 UX treats the first registered copy as primary) and an optional GitHub binding (0..1).
2. All three source states are valid and implemented: LOCAL ONLY, LOCAL + GITHUB, GITHUB ONLY. A zero-source Project is an invalid/transient repair state, never GITHUB ONLY.
3. GitHub tracking is a first-class optional binding: curated picker, explicit selection, never clones, manual refresh only, no daemon/background sync, no OAuth or PAT storage; local functionality works fully without GitHub.
4. Manual metadata belongs to the Project; local Git state belongs to local bindings; GitHub metadata belongs to the GitHub binding. Retired repository-as-project APIs are gone (one Project abstraction).
5. Dashboard accurately reflects current/recent development activity derived from meaningful events.
6. Activity is Project-centric with honest dedup (Project + SHA); raw source observations remain preserved in storage and distinguishable; unchanged rescans add nothing.
7. Contributions are year-based with available-year selection, offering Local / GitHub / Combined lenses; Combined collapses overlapping commits transparently; counts are commits, never hours.
8. Portfolio presents selected projects — including GITHUB ONLY projects — using existing tracked data.
9. Sources are organized as Scan Locations / Local Repositories / Browse GitHub Repositories, and repository management is safe and understandable.
10. Launcher actions are constrained to registered ids; no arbitrary path or command execution exists.
11. Local repository files are never mutated by the application; the read-only Git safety model holds.
12. Tests cover critical parsing, migration, activity, contributions, validation, and safety behavior: **37 test files / 211 tests passed**; typecheck passed; production build passed.
13. Owner live acceptance passed: Dashboard, Projects, Project Detail, Activity, Contributions, Portfolio, Sources, Settings, and a console sanity check.
14. README documents installation, startup, data location, limitations, and privacy behavior; the release record exists at `docs/RELEASE_V1.1.md`.
15. Git working tree is clean at the accepted checkpoint (`330c182ebdf528a503568b16bc3831cec8e85589`, tree `5ea1769871afceb4b1518f86dd18ef1f92fe9366`, tag `personal-dev-hub-v1.1-owner-accepted`).

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

---

## 27. V1.2 definition of done / release status

V1.2 is complete and owner-accepted (feature checkpoint `1e330501e8c4e25aca0e2eaff5029f3955756b69` on `feature/v1.2`; merged to main and tagged `personal-dev-hub-v1.2-owner-accepted`). Release status:

**Complete:**

- [x] M1–M5 feature work: primary local binding foundation (008), multi-binding read model + per-binding health (009), Add Local Copy, Safe Relink / moved-path recovery, WAL-safe SQLite rebuild backups
- [x] Pre-M6 deterministic QA baseline: 45 test files / 299 tests; typecheck pass; production build pass
- [x] M6-B1 tiny polish: stage-aware rebuild failure reporting (rollback vs committed-but-verification-failure); EOF cleanup in `local-binding-relink.test.ts`
- [x] Fresh-database release QA (pristine DB via the real app path)
- [x] V1.1 → V1.2 upgrade QA (deterministic automated fixture; owner database snapshot compatibility sanity PASS)
- [x] Final full test suite after M6 changes: 47 test files / 303 tests
- [x] Final production build after M6 changes
- [x] Owner live acceptance — all items PASS, no console errors, no issues
- [x] Merge `feature/v1.2` to main
- [x] Verify merged main (typecheck; 47 / 47 test files; 303 / 303 tests; production build; `git diff --check`; no content difference between `feature/v1.2` and the merge result)
- [x] Annotated acceptance tag `personal-dev-hub-v1.2-owner-accepted` → canonical accepted application commit `a32c436b29090543b92af6b501d7ddd755087fb8`, tree `27e770114d078af368ad97da75ce091d727eb0d3` (immutable; `personal-dev-hub-v1.1-owner-accepted` remains immutable, and later documentation-only commits on main do not redefine or move the accepted application checkpoint)

No V1.2 release-finalization item remains pending.

---

## 28. V1.3 definition of done / release status

V1.3 is a **feature-complete release candidate** on `feature/v1.3` (head `ec338558f7c07602ab6e698ab75a675916175280` at M5-B1). Release hardening is complete. **Final owner acceptance, merge to main, merged-main verification, and an immutable acceptance tag are still pending.**

Theme: **Recovery & Maintenance.**

**Complete:**

- [x] M1 — verified SQLite backup foundation (reusable `VACUUM INTO` + verification primitive)
- [x] M2 — manual backup + backup history (Maintenance; `MANUAL` / `MIGRATION` / `RESTORE_SAFETY` inventory)
- [x] M3 — safe restart-mediated restore (no hot-swap; pre-restore safety snapshot; validated apply)
- [x] M4 — Source Health Center (attention view reusing V1.2 health states; Rescan/Relink repair)
- [x] M5-A — release hardening audit
- [x] M5-B1 — crash-safe restore attempt recovery (version 2 restore-state journal; fail-closed startup blocking)
- [x] M5-B2 — deterministic V1.2 → V1.3 compatibility QA (zero schema/migration delta proven; fixture open preserves data) and fresh-database release QA
- [x] Automated suite / typecheck / production build available from actual M5-B2 run: **56 test files / 380 tests passed**; typecheck PASS; production build PASS

**Pending (owner / release finalization — not pre-checked):**

- [ ] Final owner live acceptance
- [ ] Merge `feature/v1.3` → `main`
- [ ] Merged-main verification
- [ ] Immutable acceptance tag (intended name `personal-dev-hub-v1.3-owner-accepted` — **planned; not yet created**)
- [ ] Final release-record canonical checkpoint update (docs-only commit on main recording accepted application commit/tree/tag — must not redefine the application checkpoint)

Historical feature milestone SHAs on `feature/v1.3` (for reference only): M1 `7257ddc`, M2 `131effd`, M3 `d7b5af3`, M4 `32040d2`, M5-B1 `ec338558`. The future M5-B2 commit SHA is intentionally not embedded in the commit that contains this document.
