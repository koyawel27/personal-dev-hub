# Personal Dev Hub — Release V1.3

**Status:** complete and owner-accepted.

**Accepted application checkpoint tag:** `personal-dev-hub-v1.3-owner-accepted` (immutable)

**Canonical accepted application commit:** `fae98e44a611c76881b1b302d6105aeb2987be88`

**Accepted application tree:** `9d320205a050967c0b214f32d3001909040fe1e0`

**Feature branch final release-candidate checkpoint (historical):** `0191e570021d51ec6145df4d689d05d156eb1a9b`

**Feature branch historical base:** `d24727a2923e04293133b08dab0f8c6cb557a797`

> Following the V1.1/V1.2 release-record pattern: the canonical application commit, tree, and tag above are the release anchor. Later documentation-only commits on main (including this one) do not redefine or move the accepted application checkpoint.

**Release theme:** Recovery & Maintenance

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

Owner evidence (disposable restart workflow; **not** performed on the owner's real database): manual backup captured state 2; live state advanced to 7; scheduled restore did not hot-swap; restart restored state 2; pre-restore safety snapshot preserved state 7; restore reported `SUCCEEDED`; a second restart did not re-execute.

### M4 — Source Health Center

Maintenance lists local copies needing attention: `PATH_MISSING`, `NOT_A_GIT_REPO`, `UNSCANNED`. Normal health rendering remains **Git-process-free**. `OK` / `NOT_A_GIT_REPO` come from the last explicit scan/refresh; path existence is checked at read time. Repair is manual via existing **Rescan** / **Relink**. No watcher, daemon, or auto-repair.

### M5 — Release hardening

- **M5-A** — release hardening audit.
- **M5-B1** — crash-safe restore attempt recovery: versioned restore-state journal; interrupted startups recover deterministically; fail-closed persistent startup blocking when application data safety cannot be proven (startup refuses to continue rather than initialize a fresh database).
- **M5-B2** — V1.2 → V1.3 compatibility lock (zero schema/migration delta) and documentation alignment.

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

## QA status

### Schema compatibility

- Git read-only inspection: `schema.sql` and migrations `002`–`009` are **byte-identical** to `personal-dev-hub-v1.2-owner-accepted`. Zero new migration files.
- Automated lock in `server/tests/v13-compatibility.test.ts` (names + content hashes).

### V1.2 → V1.3 compatibility

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

### Fresh database

Pristine DB through the real open path: file created, complete migration set applied once, core schema present, V1.2 binding shape present, FK/integrity clean.

### Final owner live acceptance

PASS (browser on the accepted application tree; **no live restore on the owner's real database**):

- Dashboard
- Projects
- Project Detail
- Activity
- Contributions
- Portfolio
- Sources
- Maintenance
- Settings
- Manual backup creation
- Restore confirmation/cancel flow
- Source Health
- Rescan
- Browser console sanity

Disposable restore evidence is preserved from the earlier restart workflow (see M3 highlights). A live restore was **not** performed against the owner's real database.

### Merged-main verification

Verified on main after merging `feature/v1.3` (no content difference between `feature/v1.3` and merged main):

- **56 / 56 test files PASS**
- **380 / 380 tests PASS**
- typecheck PASS
- production build PASS
- `git diff --check` PASS
- merged application commit: `fae98e44a611c76881b1b302d6105aeb2987be88`
- accepted tree: `9d320205a050967c0b214f32d3001909040fe1e0`

---

## Release finalization

All release-finalization items are complete:

- [x] Owner live acceptance PASS
- [x] `feature/v1.3` merged to `main`
- [x] Merged-main verification PASS
- [x] Immutable acceptance tag `personal-dev-hub-v1.3-owner-accepted` created
- [x] Canonical accepted application commit / tree / tag recorded
- [x] Final docs-only release record (this document)

No release-finalization item remains pending after this docs commit.

This docs-only commit is **not** the accepted application checkpoint. The accepted application checkpoint remains commit `fae98e44a611c76881b1b302d6105aeb2987be88`, tree `9d320205a050967c0b214f32d3001909040fe1e0`, tag `personal-dev-hub-v1.3-owner-accepted`.

---

## Historical feature milestone SHAs (feature/v1.3)

| Milestone | Commit |
| --- | --- |
| M1 — backup foundation | `7257ddc` |
| M2 — manual backup + history | `131effd` |
| M3 — restart-mediated restore | `d7b5af3` |
| M4 — Source Health Center | `32040d2` |
| M5-B1 — crash-safe restore hardening | `ec338558` |
| M5-B2 / release-candidate docs+compatibility checkpoint | `0191e570021d51ec6145df4d689d05d156eb1a9b` |

The docs-only commit that contains this final release record is intentionally omitted from the table above.
