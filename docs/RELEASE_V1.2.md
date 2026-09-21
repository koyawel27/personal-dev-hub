# Personal Dev Hub — Release V1.2

**Status:** Owner accepted. Feature branch owner acceptance completed; final main merge and acceptance tag pending.

**Feature milestone checkpoint:** `11aafd881514810abc10ee06d9786f749d53a579` (feature/v1.2)

**V1.2 branch base / V1.1 docs-aligned main baseline:** `ff00e6413c0db1f0c65711af3914b0d66ffb8fe6`

**Final accepted main commit:** PENDING (main merge not yet performed)

**Final accepted tree:** PENDING

**Acceptance tag:** `personal-dev-hub-v1.2-owner-accepted` — PENDING until main is merged and verified. It must never overwrite or reuse `personal-dev-hub-v1.1-owner-accepted`.

---

## Release theme

**Source Resilience & Multi-Local Project Support.**

V1.1 made the Project the tracked domain entity with optional local bindings and an optional GitHub binding. V1.2 completes that model: a Project can carry multiple local Git copies with per-binding identity, health, and lifecycle workflows, an owner-selectable display primary, safe recovery when a tracked folder moves, and hardened, verified automatic backups around schema-rebuilding migrations.

## V1.2 highlights

**M1 — Primary Local Binding Foundation** (migration `008`)
At most one explicit display primary per Project (partial unique index); the owner can change it at any time. The display primary is a presentation preference only — no Git scan and no activity event. Defensive read-time fallback and the permanent fingerprint/activity anchor both remain the oldest binding (`MIN(id)`), so primary changes can never re-key history. If malformed or legacy data has no explicit primary, the display primary falls back to `MIN(id)`.

**M2 — Multi-Binding Read Model + Per-Binding Health** (migration `009`)
Project Detail lists all local bindings, each with its own snapshot/state and health. Top-level Project localPath/snapshot derive only from the display primary. Project commit history unions local bindings and deduplicates by Project + SHA. Health states: `OK` and `NOT_A_GIT_REPO` are cached from the last explicit inspection; `PATH_MISSING` and `UNSCANNED` are derived at read time. Ordinary rendering spawns no Git process.

**M3 — Add Local Copy**
An existing Project can receive another existing local Git copy as a new local binding. No cloning. The candidate is inspected read-only; recognized remote identity or one known shared commit SHA is positive evidence; ambiguous evidence requires owner confirmation; a strong recognized identity conflict is rejected. The first local binding of a GITHUB ONLY Project becomes primary; later copies join as non-primary. Per-binding actions: Open Folder, Terminal, VS Code, Rescan, Make primary, Remove.

**M4 — Safe Relink / Moved-Path Recovery**
Points the SAME binding at a moved/renamed folder: binding id, Project, history, and stored primary state are preserved — it is not Remove+Add. Canonical path collisions are rejected; an invalid candidate never mutates the old binding's health; new inspection is atomic with the path update; no `repository_discovered` event. Evidence rules: recognized remote identity match or one SHA overlap is positive; absence of SHA overlap alone is never a mismatch; a strong recognized identity conflict with zero known SHA overlap is a hard rejection; uncertain cases require owner confirmation. Git remains read-only.

**M5 — WAL-Safe SQLite Rebuild Backups**
Declared rebuild migrations snapshot the database before any DDL using `VACUUM INTO` on the live connection (source path from `PRAGMA database_list`), so committed write-ahead-log state is included. The artifact is verified (exists, non-empty, read-only open, `PRAGMA integrity_check == "ok"`, schema present) before the rebuild continues; invalid/partial output is removed; a pre-existing exact destination is never overwritten or deleted; `.failed`-marked backups are exempt from pruning; retention keeps the newest 3 older ordinary backups. This is migration-safety infrastructure — not a user-facing backup/restore feature.

## Safety properties

- Tracked Git repositories remain **read-only**: no clone, fetch, pull, push, add, commit, checkout, reset, stash, or any mutating Git surface; a frozen allow-list of read-only operations only.
- Add Local Copy and Relink guard every path change with identity evidence (recognized remote match, SHA overlap, confirmation ladder, hard conflict rejection); files are never moved or deleted by the app.
- Project manual metadata remains Project-owned; local Git state belongs to bindings; GitHub metadata belongs to the GitHub binding.
- GitHub stays optional (0..1 binding per Project); local functionality works fully without it; refresh is manual only.
- Migration backups are created and verified before any rebuild DDL runs; a backup failure aborts the migration before pre-flight.

## Database / upgrade notes

- Migrations `008_primary_local_binding` and `009_local_binding_health` are **additive** (new columns/index; not declared rebuilds). The first app open upgrades an existing database automatically.
- The database path is unchanged: `data/dashboard.sqlite` (override via `DASHBOARD_DB_PATH`).
- No owner action is expected for the upgrade; Projects, bindings, GitHub links, activity, and history are preserved.
- **Done:** fresh-database and V1.1 → V1.2 upgrade release QA completed PASS (see QA status below).

## QA status

### Pre-M6 verified baseline

- 45 test files
- 299 tests
- typecheck PASS
- production build PASS

### Final release verification

- 47 test files
- 303 tests
- typecheck PASS
- production build PASS
- git diff --check PASS
- browser console acceptance: no errors

### Release database QA

- Pristine V1.2 database (fresh disposable DB opened through the real app path): PASS
- Deterministic V1.1-final → V1.2 automated upgrade fixture: PASS
- Owner database snapshot compatibility check: PASS

Note on wording: the manual owner-data check ran against a consistent snapshot/copy of the current owner database — it is compatibility sanity, not proof of a live in-place V1.1 → V1.2 upgrade. The deterministic automated fixture is the upgrade-boundary proof.

### Release QA defect found and fixed

During fresh-DB QA, Settings "App data" displayed the hardcoded default path while the backend was actually using a `DASHBOARD_DB_PATH` override. Database routing was always correct — the defect was display/reporting only. Fix: `/api/settings` now reports the actual resolved `config.dbPath`, the Settings UI renders it, regression tests were added (`settings.test.ts`, `settings-ui.test.tsx`), and the manual re-test passed.

## Owner acceptance

PASS — all items (disposable repositories used for destructive-looking workflows; no console errors; no issues found):

- [x] Dashboard sanity
- [x] Projects list / source states
- [x] Project Detail with multiple local copies; per-binding health
- [x] Make primary (display-only change; history unaffected)
- [x] Add Local Copy (disposable repositories)
- [x] Relink a disposable repository copy (moved-folder recovery)
- [x] Activity dedup sanity
- [x] Contributions (Local / GitHub / Combined)
- [x] Portfolio
- [x] Sources (scan locations, manual add, GitHub picker)
- [x] Settings (including the actual database path display — defect found and fixed during QA)
- [x] No Git mutation of tracked repositories

Covered by automated regression tests rather than separate manual execution
during this acceptance pass: GitHub optional/degraded behavior and the M5
rebuild-backup safety (WAL snapshots, verification, retention). No live
restore over owner data was performed during owner acceptance.

## Deliberate deferrals

- User-facing manual backup / restore UI (candidate for V1.2.x / V1.3; automatic rebuild backups already exist)
- Multiple GitHub bindings per Project (still 0..1)
- Background daemon / watchers (manual refresh and rescan only)
- First-class mobile polish (desktop-first; narrow widths are containment only)
- EOL normalization / `.gitattributes` (current `core.autocrlf` warning noise is accepted)
- AI features and team/corporate features (out of scope by design)

## Historical continuity

V1.1 is the last **finalized and tagged** owner-accepted historical release: see `docs/RELEASE_V1.1.md`, tag `personal-dev-hub-v1.1-owner-accepted` (canonical accepted application commit `330c182ebdf528a503568b16bc3831cec8e85589`). **That tag is historical and immutable** — it is never moved, reused, or re-pointed. V1.2 feature-branch owner acceptance is **complete**; the new, distinct `personal-dev-hub-v1.2-owner-accepted` tag will be created only after the main merge is performed and verified.
