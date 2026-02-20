import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { initFTS } from './fts.js';
import { initChunksTable } from './embeddings.js';
let db = null;
export function initDatabase(dbPath) {
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

    CREATE TABLE IF NOT EXISTS counters (
      type    TEXT PRIMARY KEY,
      current INTEGER NOT NULL DEFAULT 0
    );
  `);
    // Phase 4: Initialize FTS5 and chunks tables
    initFTS();
    initChunksTable();
    return db;
}
export function getDb() {
    if (!db)
        throw new Error('Database not initialized. Call initDatabase() first.');
    return db;
}
export function insertEntry(entry) {
    const d = getDb();
    d.prepare(`
    INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path)
    VALUES (@code, @nb, @type, @name, @status, @updated, @summary, @path)
  `).run(entry);
}
export function getEntryByCode(code) {
    const d = getDb();
    return d.prepare('SELECT * FROM index_entries WHERE code = ?').get(code);
}
export function queryEntries(filter) {
    const d = getDb();
    const conditions = [];
    const params = {};
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
    return d.prepare(`SELECT * FROM index_entries ${where}`).all(params);
}
/**
 * Atomically increment and return the next counter value for a given type key.
 * Uses a single SQLite transaction to prevent race conditions and avoids
 * the lexicographic sort bug that getMaxNumber() had.
 */
export function nextCounter(typeKey) {
    const d = getDb();
    const run = d.transaction(() => {
        d.prepare(`INSERT INTO counters (type, current) VALUES (@type, 1)
       ON CONFLICT(type) DO UPDATE SET current = current + 1`).run({ type: typeKey });
        const row = d.prepare('SELECT current FROM counters WHERE type = @type').get({ type: typeKey });
        return row.current;
    });
    return run();
}
export function getNotebookCounts() {
    const d = getDb();
    return d.prepare('SELECT nb, COUNT(*) as count FROM index_entries GROUP BY nb ORDER BY nb').all();
}
export function closeDatabase() {
    if (db) {
        db.close();
        db = null;
    }
}
