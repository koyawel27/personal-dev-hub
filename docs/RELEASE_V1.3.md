# Personal Dev Hub — Release V1.3

**Status:** Release candidate — feature-complete, pending final owner acceptance.

**Branch:** `feature/v1.3`

**Release theme:** Recovery & Maintenance

> V1.2 (`personal-dev-hub-v1.2-owner-accepted`) remains the latest finalized / tagged owner-accepted release until V1.3 completes final owner acceptance, merge to main, merged-main verification, and an immutable acceptance tag. This document describes the V1.3 release **candidate** on `feature/v1.3`. It does not claim that V1.3 is merged, tagged, or owner-accepted.

**Planned acceptance tag name (not yet created):** `personal-dev-hub-v1.3-owner-accepted`

---

## Release theme

**Recovery & Maintenance.**

V1.2 made local copies resilient (multi-binding, health, Relink). V1.3 adds the missing operational layer around the **application database**: owner-managed backups, a safe restart-mediated restore path with crash recovery, and a Maintenance surface that surfaces source-health attention items and repair entry points. Tracked Git repositories remain untouched and read-only.

---

## Highlights

### M1 — Verified SQLite backup foundation

Reusable verified snapshot primitive (`VACUUM INTO` on the live connection + verification: exists, non-empty, read-only open, `PRAGMA integrity_check == "ok"`, schema present). Source path derives from `PRAGMA database_list`. Committed write-ahead-log state is included. Shared by manual backups, migration backups, and restore safety snapshots.

### M2 — Manual backup + backup history

Maintenance exposes a filesystem-backed backup inventory under `<database-directory>/backups/`, classified into three app-managed categories:

| Type | Origin | Owner-deletable? |
| --- | --- | --- |
| `MANUAL` | Owner-created from Maintenance | Yes |
| `MIGRATION` | Automatic pre-rebuild safety snapshot (existing retention policy) | No |
| `RESTORE_SAFETY` | Automatic snapshot immediately before an applied restore | No — preserved for recovery |

Verification state is shown per backup. One corrupt file is reported `INVALID` and never fails the whole list.

### M3 — Safe restart-mediated restore

- Restore is **scheduled** from Maintenance — it does **not** hot-swap the running database.
- **Restart** Personal Dev Hub to apply it.
- At startup: selected backup is verified again → current app database is snapshotted (`RESTORE_SAFETY`) → restore is applied and validated before success.
- Tracked Git repositories are unaffected.

Owner evidence (disposable restart workflow, prior phase): manual backup captured state 2; live state advanced to 7; restart restored state 2; pre-restore safety snapshot preserved state 7; restore reported `SUCCEEDED`; a second restart did not re-execute.

### M4 — Source Health Center

Maintenance lists local copies needing attention: `PATH_MISSING`, `NOT_A_GIT_REPO`, `UNSCANNED`. Normal health rendering remains **Git-process-free**. `OK` / `NOT_A_GIT_REPO` come from the last explicit scan/refresh; path existence is checked at read time. Repair is manual via existing **Rescan** / **Relink**. No watcher, daemon, or auto-repair.

### M5 — Release hardening

- **M5-A** — release hardening audit.
- **M5-B1** — crash-safe restore attempt recovery: versioned restore-state journal; interrupted startups recover deterministically; fail-closed persistent startup blocking when application data safety cannot be proven (startup refuses to continue rather than initialize a fresh database).

---

## Safety properties

- Tracked Git repositories remain **read-only** throughout backup, restore, and health workflows.
- Backups cover **Personal Dev Hub application data/metadata only** (projects, bindings, settings, activity, history) — not tracked repositories or source files inside them.
- Every snapshot is verified before it is trusted (creation, restore selection at startup, migration pre-DDL).
- Restore always snapshots the current database first.
- Fail-closed recovery: if interrupted state cannot be proven safe, startup blocks rather than fabricating a fresh database.
- V1.3 introduces **zero new SQLite migrations** and **zero `schema.sql` changes** relative to accepted V1.2.

---

## Database / upgrade notes

- **Zero new migrations.** V1.3 contains no migration files and no `schema.sql` edits versus `personal-dev-hub-v1.2-owner-accepted`.
- Opening an accepted V1.2 database under V1.3 applies nothing new: `schema_migrations` remains exactly `001_initial` … `009_local_binding_health`.
- Proven by read-only Git inspection (byte-identical migration/schema blobs) and by `server/tests/v13-compatibility.test.ts` (deterministic V1.2-final fixture open + fresh-database QA).
- The database path is unchanged: `data/dashboard.sqlite` (override via `DASHBOARD_DB_PATH`).
- Restore processing includes a crash-safe attempt journal (transient operational state, version 2). This is **not** SQLite schema and requires no migration.
- No owner action is expected for the upgrade.

---

## Source Health semantics (summary)

| State | Meaning | How determined |
| --- | --- | --- |
| `OK` | Path existed and was a Git worktree at the last explicit scan/refresh | Cached |
| `NOT_A_GIT_REPO` | Checked path exists but is not a Git worktree | Cached |
| `PATH_MISSING` | Stored path no longer exists | Derived at read time |
| `UNSCANNED` | Never inspected | Derived at read time |

Normal rendering never spawns Git merely to show health.

---

## QA evidence available so far

### Schema compatibility (M5-B2)

- Git read-only inspection: `schema.sql` and migrations `002`–`009` are **byte-identical** to `personal-dev-hub-v1.2-owner-accepted`. Zero new migration files.
- Automated lock in `server/tests/v13-compatibility.test.ts` (names + content hashes).

### V1.2 → V1.3 compatibility (M5-B2)

Deterministic disposable fixture (never the owner database): full V1.2-final chain + representative Project / multi-binding / primary / health-cache / metadata / app-setting / activity data.

Opened through the real `openDatabase()` path:

1. Open succeeds
2. `schema_migrations` EXACTLY unchanged (9 rows, names identical)
3. No new migration row
4. Project data remains
5. Local binding identity remains
6. Display-primary state remains
7. Health cache remains
8. Owner metadata remains
9. Activity/history remains
10. `PRAGMA foreign_key_check` → zero rows
11. `PRAGMA integrity_check` → `ok`

### Fresh database (M5-B2)

Pristine DB through the real open path: file created, complete migration set applied once, core schema present, V1.2 binding shape present, FK/integrity clean.

### Focused regressions (M5-B2)

`restore-service`, `restore-api`, `db-backup`, `backup-service`, `backup-api`, `source-health`, `source-health-ui`, `maintenance-ui`, `migration-backup`, `migration-runner-fk` — **10 files / 81 tests PASS**.

### Full suite (M5-B2 actual run)

- **56 test files / 380 tests — all passed**
- typecheck PASS
- production build PASS
- `git diff --check` clean for whitespace errors on changed docs

M3 happy-path manual restore QA is **not** re-run here; prior owner evidence and M5-B1 crash-state coverage remain authoritative.

---

## Remaining release-finalization steps

1. Final owner live acceptance (browser) on `feature/v1.3`
2. Merge `feature/v1.3` → `main`
3. Merged-main verification (typecheck, full suite, build, content parity with the feature branch)
4. Create immutable acceptance tag — intended name `personal-dev-hub-v1.3-owner-accepted` (**planned; not yet created**)
5. Docs-only commit on main recording the canonical accepted application commit / tree / tag (must not redefine the application checkpoint)

The final accepted V1.3 application commit/tree/tag are **not known yet** and are not invented in this document.

---

## Historical feature milestone SHAs (feature/v1.3)

| Milestone | Commit |
| --- | --- |
| M1 — backup foundation | `7257ddc` |
| M2 — manual backup + history | `131effd` |
| M3 — restart-mediated restore | `d7b5af3` |
| M4 — Source Health Center | `32040d2` |
| M5-B1 — crash-safe restore hardening | `ec338558` |

The M5-B2 commit SHA is intentionally omitted from the commit that contains this document; it will appear in history after the owner commits.
