import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { migrate } from "./migrate.js";

let db: DatabaseSync | null = null;
let openedPath: string | null = null;

export function getDb(): DatabaseSync {
  const dbPath = config.dbPath;
  if (db && openedPath === dbPath) return db;
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    db = null;
  }
  db = openDatabase(dbPath);
  openedPath = dbPath;
  return db;
}

export function openDatabase(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = WAL;");
  migrate(database);
  return database;
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    db = null;
    openedPath = null;
  }
}

export function withTransaction<T>(fn: () => T): T {
  const database = getDb();
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    database.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // ignore
    }
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
