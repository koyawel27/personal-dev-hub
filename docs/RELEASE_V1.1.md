# Personal Dev Hub — Release V1.1

**Status:** complete and owner-accepted.
**Accepted application checkpoint tag:** `personal-dev-hub-v1.1-owner-accepted`
**Canonical accepted application commit (after email sanitation):** `330c182ebdf528a503568b16bc3831cec8e85589`
**Accepted application tree:** `5ea1769871afceb4b1518f86dd18ef1f92fe9366`

> The repository history was intentionally rewritten before first GitHub publication to replace a private email address with the owner's GitHub noreply identity. SHAs in older documents may be stale; the references above are canonical.

## Product summary

Personal Dev Hub is a single-user, local-first developer workspace for one machine: a personal project tracker and development activity journal that combines local Git repositories, optional GitHub tracking, recent activity, contribution history, and selected portfolio work in one simple local web app. The dashboard is read-only toward tracked repositories.

## Project-centric architecture

The **Project** is the tracked domain entity (V1.1 migrations `004_projects_core`, `005_github_bindings`, `006_project_activity`; `007_repair_zero_binding_ghosts` is a repair migration):

- Manual metadata (status, type, note, portfolio flag/order) belongs to the Project.
- Local Git state (branch, working tree, commits, remotes) belongs to local repository bindings.
- GitHub metadata (visibility, default branch, last push) belongs to the GitHub binding.
- Repository-as-project compatibility APIs were retired; the final API surface has exactly one Project abstraction.

### Source states

- **LOCAL ONLY** — local binding(s), no GitHub binding.
- **LOCAL + GITHUB** — local binding(s) plus a GitHub binding.
- **GITHUB ONLY** — a GitHub binding with no local copy; fully valid, including for Portfolio.

A zero-source Project is an invalid/transient repair state, never GITHUB ONLY.

### GitHub tracking model

- Optional first-class binding; cardinality **0..1 GitHub binding per Project**; long-term model supports **0..many local bindings per Project** (V1.1 treats the first registered copy as primary).
- Curated picker (Sources → Browse GitHub Repositories) with search and Owned/Collaborator/Organization/Public/Private/Archived/Forks/Tracked/Untracked filters; explicit selection only; picking a repository that matches a local clone's remote links them into one Project.
- Tracking never clones. Refresh is manual only; no daemon or background sync.
- Uses existing `gh` authentication; no OAuth and no PAT storage. Local functionality works fully without GitHub.

## Highlights

- **Activity** — global, Project-centric journal with honest dedup: the same commit observed locally and on GitHub appears once (LOCAL + GITHUB), keyed by Project + SHA; raw source observations remain preserved in storage and distinguishable; unchanged rescans and no-op refreshes add nothing.
- **Contributions** — year-based view with available-year selection (newest-first) and three lenses: Local, GitHub, Combined. Combined collapses overlapping commit SHAs across the local and GitHub tracked datasets transparently; counts are commits, never hours.
- **Portfolio** — selected-work view over Projects; GITHUB ONLY projects are eligible (technology hint from GitHub's reported primary language).
- **Sources** — Scan Locations / Local Repositories / Browse GitHub Repositories; multiple scan roots with depth control, native folder browsing, and manual add.

## Privacy and safety model

- Metadata only — no source code, diffs, secrets, or terminal history are stored.
- Read-only Git surface: a frozen allow-list of read-only operations via `execFile` with argument arrays; never fetch/pull/push/add/commit/checkout/reset/stash; no generic "run git" endpoint.
- Launcher actions resolve registered ids server-side; no arbitrary path or command execution.
- API binds only to `127.0.0.1`; removing a repository never touches files on disk; untracking never touches GitHub.

## Deterministic QA

- **37 test files / 211 tests passed**
- **Typecheck passed**
- **Production build passed**

## Owner live acceptance

Dashboard, Projects, Project Detail, Activity, Contributions, Portfolio, Sources, Settings, and a console sanity check — all passed.

## Deliberate deferrals

- Advanced Contributions keyboard navigation (the roving calendar navigation experiment was reverted and deferred).
- First-class mobile polish (desktop-first; narrow widths are containment only).
- Background sync / watchers (manual refresh and rescan only).
- Multiple GitHub bindings (V1.1 supports 0..1 per Project).

## Post-acceptance audit

An independent Codex audit is **post-acceptance verification, not a blocker**. Any valid fixes it produces would be **V1.1.1 candidates**, applied through the normal review and QA gates.
