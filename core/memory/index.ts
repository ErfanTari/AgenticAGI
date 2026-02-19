import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import type { IndexEntry, QueryFilter } from './types.js';

let db: Database.Database | null = null;

export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? PATHS.db;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS index_entries (
      code      TEXT PRIMARY KEY,
      nb        TEXT NOT NULL,
      type      TEXT NOT NULL,
      name      TEXT NOT NULL,
      status    TEXT NOT NULL,
      updated   TEXT NOT NULL,
      summary   TEXT,
      path      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nb     ON index_entries(nb);
    CREATE INDEX IF NOT EXISTS idx_type   ON index_entries(type);
    CREATE INDEX IF NOT EXISTS idx_status ON index_entries(status);

    CREATE TABLE IF NOT EXISTS relationships (
      from_code  TEXT NOT NULL,
      relation   TEXT NOT NULL,
      to_code    TEXT NOT NULL,
      note       TEXT,
      created    TEXT NOT NULL,
      FOREIGN KEY (from_code) REFERENCES index_entries(code),
      FOREIGN KEY (to_code)   REFERENCES index_entries(code)
    );

    CREATE INDEX IF NOT EXISTS idx_from ON relationships(from_code);
    CREATE INDEX IF NOT EXISTS idx_to   ON relationships(to_code);
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export function insertEntry(entry: IndexEntry): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path)
    VALUES (@code, @nb, @type, @name, @status, @updated, @summary, @path)
  `).run(entry);
}

export function getEntryByCode(code: string): IndexEntry | undefined {
  const d = getDb();
  return d.prepare('SELECT * FROM index_entries WHERE code = ?').get(code) as IndexEntry | undefined;
}

export function queryEntries(filter: QueryFilter): IndexEntry[] {
  const d = getDb();
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (filter.nb) {
    conditions.push('nb = @nb');
    params.nb = filter.nb;
  }
  if (filter.type) {
    conditions.push('type = @type');
    params.type = filter.type;
  }
  if (filter.status) {
    conditions.push('status = @status');
    params.status = filter.status;
  }
  if (filter.name) {
    conditions.push('name LIKE @name');
    params.name = `%${filter.name}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return d.prepare(`SELECT * FROM index_entries ${where}`).all(params) as IndexEntry[];
}

export function getMaxNumber(nb: string, type: string): number {
  const d = getDb();
  const row = d.prepare(
    'SELECT code FROM index_entries WHERE nb = @nb AND type = @type ORDER BY code DESC LIMIT 1'
  ).get({ nb, type }) as { code: string } | undefined;

  if (!row) return 0;
  const match = row.code.match(/-(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

export function getNotebookCounts(): Array<{ nb: string; count: number }> {
  const d = getDb();
  return d.prepare(
    'SELECT nb, COUNT(*) as count FROM index_entries GROUP BY nb ORDER BY nb'
  ).all() as Array<{ nb: string; count: number }>;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
