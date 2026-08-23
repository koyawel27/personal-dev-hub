import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));

function tableExists(database: DatabaseSync, name: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row != null;
}

function columnNames(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * Ordered, transactional migrations.
 *
 * - schema.sql stays the idempotent base DDL (CREATE TABLE IF NOT EXISTS);
 *   it runs on every open so fresh databases are complete immediately.
 * - Each .sql file under db/migrations/ is applied at most once, in name
 *   order, inside its own transaction together with its schema_migrations
 *   record.
 */
export function migrate(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON;");

  const schemaPath = path.join(here, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  database.exec(sql);

  if (!tableExists(database, "schema_migrations")) {
    throw new Error("schema_migrations table missing after base schema execution.");
  }

  const isApplied = (name: string): boolean => {
    return (
      database
        .prepare("SELECT name FROM schema_migrations WHERE name = ?")
        .get(name) != null
    );
  };

  // 000_base represents schema.sql itself; legacy databases from the Grok
  // checkpoint era already carry this record under the original name.
  if (!isApplied("001_initial") && !isApplied("000_base")) {
    database
      .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
      .run("001_initial", new Date().toISOString());
  }

  const migrationsDir = path.join(here, "migrations");
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const name = path.basename(file, ".sql");
    if (isApplied(name)) continue;

    // Idempotency guard: a database that already has every column a
    // migration would add (e.g. created by an ad-hoc script) must not
    // re-run that migration. Partially-applied databases are not detected
    // here; SQLite cannot transact non-transactional ALTERs safely enough
    // to make partial states recoverable automatically.
    const migrationSql = fs.readFileSync(path.join(migrationsDir, file), "utf8");

    if (name === "002_project_metadata") {
      const existing = columnNames(database, "local_repositories");
      if (["project_status", "project_type", "include_in_portfolio"].every((c) => existing.has(c))) {
        database
          .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
          .run(name, new Date().toISOString());
        continue;
      }
    }

    database.exec("BEGIN IMMEDIATE;");
    try {
      database.exec(migrationSql);
      database
        .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(name, new Date().toISOString());
      database.exec("COMMIT;");
    } catch (err) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        // ignore rollback failures on already-closed transactions
      }
      throw err;
    }
  }
}
