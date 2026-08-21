import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));

export function migrate(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON;");
  const schemaPath = path.join(here, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  database.exec(sql);

  const applied = database
    .prepare("SELECT name FROM schema_migrations WHERE name = ?")
    .get("001_initial") as { name: string } | undefined;

  if (!applied) {
    database
      .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
      .run("001_initial", new Date().toISOString());
  }
}
