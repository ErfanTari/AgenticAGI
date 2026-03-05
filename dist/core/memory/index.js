import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { initFTS, indexContent } from './fts.js';
import { initChunksTable, storeChunks } from './embeddings.js';
import { chunkMarkdown } from './chunks.js';
let db = null;
function collectMarkdownFiles(rootDir) {
    if (!fs.existsSync(rootDir))
        return [];
    const files = [];
    const stack = [rootDir];
    while (stack.length > 0) {
        const current = stack.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (entry.isFile() && fullPath.endsWith('.md')) {
                files.push(fullPath);
            }
        }
    }
    return files;
}
function parseFrontmatter(markdown) {
    const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!match)
        return null;
    const metadata = {};
    for (const line of match[1].split('\n')) {
        const sep = line.indexOf(':');
        if (sep === -1)
            continue;
        const key = line.slice(0, sep).trim();
        const value = line.slice(sep + 1).trim();
        if (key.length > 0)
            metadata[key] = value;
    }
    const required = ['code', 'nb', 'type', 'name', 'status', 'updated', 'summary'];
    if (required.some(key => !(key in metadata)))
        return null;
    return metadata;
}
function parseDiskEntry(filePath) {
    const markdown = fs.readFileSync(filePath, 'utf-8');
    const meta = parseFrontmatter(markdown);
    if (!meta)
        return null;
    const codeMatch = meta.code.match(/^([A-Z]+\.[A-Z]+)-(\d{6,})$/);
    if (!codeMatch)
        return null;
    const frontmatterEnd = markdown.indexOf('\n---', 4);
    const bodyStart = frontmatterEnd >= 0 ? markdown.indexOf('\n', frontmatterEnd + 4) : -1;
    const body = bodyStart >= 0 ? markdown.slice(bodyStart).trim() : markdown;
    const entry = {
        code: meta.code,
        nb: meta.nb,
        type: meta.type,
        name: meta.name,
        status: meta.status,
        updated: meta.updated,
        summary: meta.summary,
        path: filePath,
        due_date: meta.due_date ?? null,
    };
    return {
        entry,
        markdown,
        searchableText: `${entry.name} ${entry.summary} ${body}`,
        counterKey: `${entry.nb}.${entry.type}`,
        counterValue: Number(codeMatch[2]),
    };
}
function bootstrapIndexFromMemoryFiles() {
    const d = getDb();
    const countRow = d.prepare('SELECT COUNT(*) as count FROM index_entries').get();
    if (countRow.count > 0)
        return;
    const files = collectMarkdownFiles(PATHS.memory);
    if (files.length === 0)
        return;
    const parsed = files
        .map(filePath => parseDiskEntry(filePath))
        .filter((entry) => entry !== null);
    if (parsed.length === 0)
        return;
    const maxCounters = new Map();
    for (const item of parsed) {
        const current = maxCounters.get(item.counterKey) ?? 0;
        if (item.counterValue > current) {
            maxCounters.set(item.counterKey, item.counterValue);
        }
    }
    const insertEntryStmt = d.prepare(`
    INSERT OR IGNORE INTO index_entries (code, nb, type, name, status, updated, summary, path, due_date)
    VALUES (@code, @nb, @type, @name, @status, @updated, @summary, @path, @due_date)
  `);
    const upsertCounterStmt = d.prepare(`
    INSERT INTO counters (type, current) VALUES (?, ?)
    ON CONFLICT(type) DO UPDATE SET current = CASE
      WHEN excluded.current > counters.current THEN excluded.current
      ELSE counters.current
    END
  `);
    const runBootstrap = d.transaction(() => {
        for (const item of parsed) {
            insertEntryStmt.run({
                ...item.entry,
                due_date: item.entry.due_date ?? null,
            });
        }
        for (const [type, current] of maxCounters.entries()) {
            upsertCounterStmt.run(type, current);
        }
    });
    runBootstrap();
    // Rebuild text indexes from the canonical markdown files.
    // Safe to clear when index_entries was empty at startup.
    try {
        d.prepare('DELETE FROM fts_content').run();
    }
    catch { /* table may be absent */ }
    try {
        d.prepare('DELETE FROM chunks').run();
    }
    catch { /* table may be absent */ }
    for (const item of parsed) {
        indexContent(item.entry.code, item.entry.nb, item.searchableText);
        const chunks = chunkMarkdown(item.entry.code, item.markdown);
        if (chunks.length > 0) {
            storeChunks(chunks);
        }
    }
}
export function initDatabase(dbPath) {
    const resolvedPath = dbPath ?? PATHS.db;
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    // BUG-M5 fix: close any existing connection before opening a new one
    if (db) {
        try {
            db.close();
        }
        catch { /* ignore */ }
        db = null;
    }
    db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    // FK enforcement is enabled after the dedup + orphan cleanup block below.
    // (1) Create all tables first (FK constraints not yet enforced).
    db.exec(`
    CREATE TABLE IF NOT EXISTS index_entries (
      code      TEXT PRIMARY KEY,
      nb        TEXT NOT NULL,
      type      TEXT NOT NULL,
      name      TEXT NOT NULL,
      status    TEXT NOT NULL,
      updated   TEXT NOT NULL,
      summary   TEXT,
      path      TEXT NOT NULL,
      due_date  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_nb     ON index_entries(nb);
    CREATE INDEX IF NOT EXISTS idx_type   ON index_entries(type);
    CREATE INDEX IF NOT EXISTS idx_status ON index_entries(status);

  `);
    db.exec(`

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

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS heartbeat_queue (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      code     TEXT NOT NULL,
      message  TEXT NOT NULL,
      seen     INTEGER DEFAULT 0,
      created  TEXT NOT NULL
    );
  `);
    // Phase 5 migration: add due_date column for existing databases
    try {
        db.exec('ALTER TABLE index_entries ADD COLUMN due_date TEXT');
    }
    catch {
        // Column already exists — ignore
    }
    // Phase 11 migrations: add new columns for lifecycle, importance, etc.
    const NEW_COLUMNS = [
        "ALTER TABLE index_entries ADD COLUMN importance_score REAL DEFAULT 0.5",
        "ALTER TABLE index_entries ADD COLUMN utility_score REAL DEFAULT 1.0",
        "ALTER TABLE index_entries ADD COLUMN usage_count INTEGER DEFAULT 0",
        "ALTER TABLE index_entries ADD COLUMN last_accessed TEXT",
        "ALTER TABLE index_entries ADD COLUMN decay_rate REAL DEFAULT 0.1",
        "ALTER TABLE index_entries ADD COLUMN active_page INTEGER DEFAULT 1",
        "ALTER TABLE index_entries ADD COLUMN pinned INTEGER DEFAULT 0",
        "ALTER TABLE index_entries ADD COLUMN privacy_tier TEXT DEFAULT 'MIXED'",
        "ALTER TABLE index_entries ADD COLUMN source TEXT DEFAULT 'user'",
        "ALTER TABLE index_entries ADD COLUMN confidence REAL DEFAULT 1.0",
        "ALTER TABLE index_entries ADD COLUMN atomic_facts TEXT",
        "ALTER TABLE index_entries ADD COLUMN embedding BLOB",
    ];
    for (const sql of NEW_COLUMNS) {
        try {
            db.exec(sql);
        }
        catch { /* column already exists */ }
    }
    // Phase 11 indexes
    try {
        db.exec(`
      CREATE INDEX IF NOT EXISTS idx_importance ON index_entries(importance_score);
      CREATE INDEX IF NOT EXISTS idx_active_page ON index_entries(active_page);
      CREATE INDEX IF NOT EXISTS idx_privacy ON index_entries(privacy_tier);
    `);
    }
    catch { /* indexes may already exist */ }
    // Phase 4: Initialize FTS5 and chunks tables (must exist before orphan cleanup)
    initFTS();
    initChunksTable();
    // (2) Dedup — remap child rows to the kept code, then delete duplicates.
    // Must run before FK enforcement so deletes don't violate constraints.
    const dupGroups = db.prepare(`
    SELECT nb, type, LOWER(name) as lname
    FROM index_entries
    GROUP BY nb, type, LOWER(name)
    HAVING COUNT(*) > 1
  `).all();
    for (const g of dupGroups) {
        const rows = db.prepare(`
      SELECT rowid, code FROM index_entries
      WHERE nb=? AND type=? AND LOWER(name)=?
      ORDER BY rowid DESC
    `).all(g.nb, g.type, g.lname);
        const keepCode = rows[0].code;
        const deleteCodes = rows.slice(1).map(r => r.code);
        if (deleteCodes.length === 0)
            continue;
        const ph = deleteCodes.map(() => '?').join(',');
        // Remap child rows to the kept code before removing duplicates
        db.prepare(`UPDATE relationships SET from_code=? WHERE from_code IN (${ph})`).run(keepCode, ...deleteCodes);
        db.prepare(`UPDATE relationships SET to_code=?   WHERE to_code   IN (${ph})`).run(keepCode, ...deleteCodes);
        db.prepare(`UPDATE chunks         SET code=?     WHERE code       IN (${ph})`).run(keepCode, ...deleteCodes);
        // Delete the duplicate parent rows (child rows now all point to keepCode)
        db.prepare(`DELETE FROM index_entries WHERE code IN (${ph})`).run(...deleteCodes);
    }
    // (3) Enforce unique entries per (nb, type, name) — safe now that dupes are gone
    try {
        db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_entry
      ON index_entries(nb, type, LOWER(name))
      WHERE status != 'archived'
    `);
    }
    catch { /* index already exists */ }
    // (4) Enable FK enforcement — no orphans or duplicates remain
    db.pragma('foreign_keys = ON');
    bootstrapIndexFromMemoryFiles();
    // Phase 10: Ensure embedding_model_hash counter row exists
    db.prepare("INSERT OR IGNORE INTO counters (type, current) VALUES ('embedding_model_hash', 0)").run();
    // Phase 10: Run embedding migration check async — never blocks init
    import('./search.js').then(s => s.checkEmbeddingMigration().catch(() => { })).catch(() => { });
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
    INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path, due_date)
    VALUES (@code, @nb, @type, @name, @status, @updated, @summary, @path, @due_date)
  `).run({ ...entry, due_date: entry.due_date ?? null });
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
        // BUG 5 Fix: WHEN notebook deadlines use status='upcoming', not 'active'.
        // When filtering WHEN entries by status, include 'upcoming' and 'open' alongside 'active'
        // so deadline entries are never silently excluded.
        if (filter.nb === 'WHEN' && filter.status === 'active') {
            conditions.push("status IN ('active', 'upcoming', 'open')");
        }
        else {
            conditions.push('status = @status');
            params.status = filter.status;
        }
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
