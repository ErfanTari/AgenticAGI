import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import type { IndexEntry, QueryFilter } from './types.js';
import { initFTS, indexContent } from './fts.js';
import { initChunksTable, storeChunks } from './embeddings.js';
import { chunkMarkdown } from './chunks.js';
import { upsertPointerEntry } from './pointer-index.js';

let db: Database.Database | null = null;

interface ParsedDiskEntry {
  entry: IndexEntry;
  operationalMeta: {
    importance_score: number;
    utility_score: number;
    usage_count: number;
    decay_rate: number;
    active_page: number;
    confidence: number;
    last_accessed: string;
    pinned: number;
    source: string;
  };
  markdown: string;
  searchableText: string;
  counterKey: string;
  counterValue: number;
}

function collectMarkdownFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];

  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop()!;
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

function parseFrontmatter(markdown: string): Record<string, string> | null {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;

  const metadata: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key.length > 0) metadata[key] = value;
  }

  const required = ['code', 'nb', 'type', 'name', 'status', 'updated', 'summary'];
  if (required.some(key => !(key in metadata))) return null;

  return metadata;
}

function parseDiskEntry(filePath: string): ParsedDiskEntry | null {
  const markdown = fs.readFileSync(filePath, 'utf-8');
  const meta = parseFrontmatter(markdown);
  if (!meta) return null;

  const codeMatch = meta.code.match(/^([A-Z]+\.[A-Z]+)-(\d{6,})$/);
  if (!codeMatch) return null;

  const frontmatterEnd = markdown.indexOf('\n---', 4);
  const bodyStart = frontmatterEnd >= 0 ? markdown.indexOf('\n', frontmatterEnd + 4) : -1;
  const body = bodyStart >= 0 ? markdown.slice(bodyStart).trim() : markdown;

  // C5: parse operational metadata for DB-rebuild resilience
  const parseNum = (v: string | undefined, def: number) => {
    const n = parseFloat(v ?? '');
    return isNaN(n) ? def : n;
  };
  const operationalMeta = {
    importance_score: parseNum(meta.importance_score, 0),
    utility_score: parseNum(meta.utility_score, 0),
    usage_count: Math.floor(parseNum(meta.usage_count, 0)),
    decay_rate: parseNum(meta.decay_rate, 0.1),
    active_page: Math.floor(parseNum(meta.active_page, 1)),
    confidence: parseNum(meta.confidence, 1.0),
    last_accessed: meta.last_accessed ?? meta.updated ?? '',
    pinned: Math.floor(parseNum(meta.pinned, 0)),
    source: meta.source ?? 'agent',
  };

  const entry: IndexEntry = {
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
    operationalMeta,
    markdown,
    searchableText: `${entry.name} ${entry.summary} ${body}`,
    counterKey: `${entry.nb}.${entry.type}`,
    counterValue: Number(codeMatch[2]),
  };
}

function bootstrapIndexFromMemoryFiles(): void {
  // FIX 3: Clean up any orphaned .tmp files left by a crashed atomic write.
  if (fs.existsSync(PATHS.memory)) {
    const cleanTmpFiles = (dir: string): void => {
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            cleanTmpFiles(full);
          } else if (entry.endsWith('.md.tmp')) {
            try { fs.unlinkSync(full); } catch { /* ignore */ }
          }
        } catch { /* ignore stat errors */ }
      }
    };
    cleanTmpFiles(PATHS.memory);
  }

  const d = getDb();
  const countRow = d.prepare('SELECT COUNT(*) as count FROM index_entries').get() as { count: number };
  if (countRow.count > 0) return;

  const files = collectMarkdownFiles(PATHS.memory);
  if (files.length === 0) return;

  const parsed = files
    .map(filePath => parseDiskEntry(filePath))
    .filter((entry): entry is ParsedDiskEntry => entry !== null);

  if (parsed.length === 0) return;

  const maxCounters = new Map<string, number>();
  for (const item of parsed) {
    const current = maxCounters.get(item.counterKey) ?? 0;
    if (item.counterValue > current) {
      maxCounters.set(item.counterKey, item.counterValue);
    }
  }

  const insertEntryStmt = d.prepare(`
    INSERT OR IGNORE INTO index_entries (
      code, nb, type, name, status, updated, summary, path, due_date,
      importance_score, utility_score, usage_count, decay_rate, active_page,
      confidence, last_accessed, pinned, source
    )
    VALUES (
      @code, @nb, @type, @name, @status, @updated, @summary, @path, @due_date,
      @importance_score, @utility_score, @usage_count, @decay_rate, @active_page,
      @confidence, @last_accessed, @pinned, @source
    )
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
        ...item.operationalMeta,
      });
    }

    for (const [type, current] of maxCounters.entries()) {
      upsertCounterStmt.run(type, current);
    }
  });
  runBootstrap();

  // Rebuild text indexes from the canonical markdown files.
  // Safe to clear when index_entries was empty at startup.
  try { d.prepare('DELETE FROM fts_content').run(); } catch { /* table may be absent */ }
  try { d.prepare('DELETE FROM chunks').run(); } catch { /* table may be absent */ }

  for (const item of parsed) {
    indexContent(item.entry.code, item.entry.nb, item.searchableText);
    const chunks = chunkMarkdown(item.entry.code, item.markdown);
    if (chunks.length > 0) {
      storeChunks(chunks);
    }
    // FIX 2c: Keep MEMORY.md in sync after bootstrap
    try {
      upsertPointerEntry({
        code: item.entry.code,
        name: item.entry.name,
        summary: item.entry.summary ?? '',
        lastActive: item.entry.updated ?? '',
      });
    } catch { /* pointer index is best-effort */ }
  }
}

/**
 * Scan all .md files under memory/ and index any that are missing from SQLite
 * or whose file mtime is newer than their `updated` field in index_entries.
 *
 * Safe to call at every startup regardless of DB state.
 * Catches files added outside the agent's own write path (git pull, manual edits).
 */
export function syncMemoryFilesToIndex(): { added: number; updated: number; errors: number } {
  let added = 0; let updated = 0; let errors = 0;

  const files = collectMarkdownFiles(PATHS.memory);

  for (const filePath of files) {
    try {
      const parsed = parseDiskEntry(filePath);
      if (!parsed) continue; // no code in frontmatter — not a memory entry

      const { entry, operationalMeta, searchableText, markdown } = parsed;
      const d = getDb();
      const existing = d.prepare('SELECT * FROM index_entries WHERE code = ?').get(entry.code) as IndexEntry | undefined;

      let shouldIndex = false;

      if (!existing) {
        // File exists on disk but not in SQLite — insert it
        d.prepare(`
          INSERT OR IGNORE INTO index_entries (
            code, nb, type, name, status, updated, summary, path, due_date,
            importance_score, utility_score, usage_count, decay_rate, active_page,
            confidence, last_accessed, pinned, source
          ) VALUES (
            @code, @nb, @type, @name, @status, @updated, @summary, @path, @due_date,
            @importance_score, @utility_score, @usage_count, @decay_rate, @active_page,
            @confidence, @last_accessed, @pinned, @source
          )
        `).run({ ...entry, due_date: entry.due_date ?? null, ...operationalMeta });
        shouldIndex = true;
        added++;
      } else {
        // Check if file is newer than the indexed updated date (compare calendar days)
        const mtimeDate = new Date(fs.statSync(filePath).mtimeMs).toISOString().split('T')[0];
        const updatedDate = existing.updated ?? '1970-01-01';
        if (mtimeDate > updatedDate) {
          d.prepare(`
            UPDATE index_entries SET
              name = @name, status = @status, updated = @updated,
              summary = @summary, path = @path, due_date = @due_date
            WHERE code = @code
          `).run({ code: entry.code, name: entry.name, status: entry.status, updated: entry.updated, summary: entry.summary ?? null, path: filePath, due_date: entry.due_date ?? null });
          shouldIndex = true;
          updated++;
        }
      }

      if (shouldIndex) {
        indexContent(entry.code, entry.nb, searchableText);
        const chunks = chunkMarkdown(entry.code, markdown);
        if (chunks.length > 0) storeChunks(chunks);
        // Keep MEMORY.md in sync
        try {
          upsertPointerEntry({ code: entry.code, name: entry.name, summary: entry.summary ?? '', lastActive: entry.updated ?? '' });
        } catch (err) {
          console.warn(`[memory] Failed to update pointer index for ${entry.code}:`, err);
        }
      }
    } catch (err) {
      console.warn(`[memory] syncMemoryFilesToIndex error for ${filePath}:`, err);
      errors++;
    }
  }

  return { added, updated, errors };
}

export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? PATHS.db;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  // BUG-M5 fix: close any existing connection before opening a new one
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }

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
      path      TEXT NOT NULL,
      due_date  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_nb     ON index_entries(nb);
    CREATE INDEX IF NOT EXISTS idx_type   ON index_entries(type);
    CREATE INDEX IF NOT EXISTS idx_status ON index_entries(status);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_entry
    ON index_entries(nb, type, LOWER(name))
    WHERE status != 'archived';

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

    CREATE TABLE IF NOT EXISTS pending_plans (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      plan_json  TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_user_inputs (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      question   TEXT NOT NULL,
      context    TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_permission_requests (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      skill        TEXT NOT NULL,
      required     TEXT NOT NULL,
      reason       TEXT NOT NULL,
      goal         TEXT,
      created_at   TEXT NOT NULL
    );
  `);

  // Phase 5 migration: add due_date column for existing databases
  try {
    db.exec('ALTER TABLE index_entries ADD COLUMN due_date TEXT');
  } catch {
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
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // Phase 11 indexes
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_importance ON index_entries(importance_score);
      CREATE INDEX IF NOT EXISTS idx_active_page ON index_entries(active_page);
      CREATE INDEX IF NOT EXISTS idx_privacy ON index_entries(privacy_tier);
    `);
  } catch { /* indexes may already exist */ }

  // Phase 15 migrations: add new columns (idempotent — catches "column already exists")
  const PHASE15_COLUMNS = [
    'ALTER TABLE index_entries ADD COLUMN ttl_days INTEGER',
    'ALTER TABLE index_entries ADD COLUMN fingerprint TEXT',
    'ALTER TABLE index_entries ADD COLUMN project_brain_cache TEXT',
    'ALTER TABLE relationships ADD COLUMN strength REAL DEFAULT 1.0',
    'ALTER TABLE relationships ADD COLUMN last_active TEXT',
  ];
  for (const sql of PHASE15_COLUMNS) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // Permission escalation goal resumption: add goal column for auto-resume on grant
  try {
    db.exec('ALTER TABLE pending_permission_requests ADD COLUMN goal TEXT');
  } catch {
    /* column already exists */
  }

  // Phase 4: Initialize FTS5 and chunks tables
  initFTS();
  initChunksTable();
  bootstrapIndexFromMemoryFiles();
  const syncResult = syncMemoryFilesToIndex();
  if (syncResult.added > 0 || syncResult.updated > 0) {
    console.log(`[memory] Sync: ${syncResult.added} added, ${syncResult.updated} updated, ${syncResult.errors} errors`);
  }

  // H2: Reconcile operational metadata from frontmatter for existing rows
  try { reconcileOperationalMetadata(); } catch { /* non-fatal */ }

  // Phase 10: Ensure embedding_model_hash counter row exists
  db.prepare("INSERT OR IGNORE INTO counters (type, current) VALUES ('embedding_model_hash', 0)").run();

  // Phase 10: Run embedding migration check async — never blocks init
  import('./search.js').then(s => s.checkEmbeddingMigration().catch(() => {})).catch(() => {});

  // Phase 18G FIX 5: Migrate existing NOW.LOG entries from status='active' to 'logged'
  try {
    db.prepare(
      "UPDATE index_entries SET status = 'logged' WHERE nb = 'NOW' AND type = 'LOG' AND status = 'active'"
    ).run();
  } catch { /* migration is best-effort */ }

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export function getSettingValue(d: Database.Database, key: string): string | null {
  const row = d.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSettingValue(d: Database.Database, key: string, value: string): void {
  d.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/**
 * H2 — Reconcile operational metadata from frontmatter into SQLite rows.
 * Runs at startup: if a row has all-zero operational scores but the .md file
 * has non-zero values (written by C4), restore them into SQLite.
 */
export function reconcileOperationalMetadata(): void {
  const d = getDb();
  const staleRows = d.prepare(`
    SELECT code, path FROM index_entries
    WHERE importance_score = 0 AND utility_score = 0 AND usage_count = 0
    LIMIT 500
  `).all() as Array<{ code: string; path: string }>;

  let reconciled = 0;
  for (const row of staleRows) {
    try {
      const content = fs.readFileSync(row.path, 'utf8');
      const meta = parseFrontmatter(content);
      if (!meta) continue;
      const parseNum = (v: string | undefined, def: number) => {
        const n = parseFloat(v ?? '');
        return isNaN(n) ? def : n;
      };
      const importance = parseNum(meta.importance_score, 0);
      const utility = parseNum(meta.utility_score, 0);
      const usage = parseNum(meta.usage_count, 0);
      if (importance > 0 || utility > 0 || usage > 0) {
        d.prepare(`
          UPDATE index_entries SET
            importance_score = ?, utility_score = ?, usage_count = ?,
            decay_rate = ?, active_page = ?, confidence = ?,
            last_accessed = ?, pinned = ?
          WHERE code = ?
        `).run(
          importance, utility, Math.floor(usage),
          parseNum(meta.decay_rate, 0.1),
          Math.floor(parseNum(meta.active_page, 1)),
          parseNum(meta.confidence, 1.0),
          meta.last_accessed ?? '',
          Math.floor(parseNum(meta.pinned, 0)),
          row.code,
        );
        reconciled++;
      }
    } catch { /* file missing or unreadable — skip */ }
  }
  if (reconciled > 0) {
    console.log(`[startup] reconciled operational metadata for ${reconciled} entries`);
  }
}

export function insertEntry(entry: IndexEntry): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path, due_date)
    VALUES (@code, @nb, @type, @name, @status, @updated, @summary, @path, @due_date)
  `).run({ ...entry, due_date: entry.due_date ?? null });
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
    // BUG 5 Fix: WHEN notebook deadlines use status='upcoming', not 'active'.
    // When filtering WHEN entries by status, include 'upcoming' and 'open' alongside 'active'
    // so deadline entries are never silently excluded.
    if (filter.nb === 'WHEN' && filter.status === 'active') {
      conditions.push("status IN ('active', 'upcoming', 'open')");
    } else {
      conditions.push('status = @status');
      params.status = filter.status;
    }
  }
  if (filter.name) {
    conditions.push('name LIKE @name');
    params.name = `%${filter.name}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return d.prepare(`SELECT * FROM index_entries ${where}`).all(params) as IndexEntry[];
}

/**
 * Atomically increment and return the next counter value for a given type key.
 * Uses a single SQLite transaction to prevent race conditions and avoids
 * the lexicographic sort bug that getMaxNumber() had.
 */
export function nextCounter(typeKey: string): number {
  const d = getDb();
  const run = d.transaction(() => {
    d.prepare(
      `INSERT INTO counters (type, current) VALUES (@type, 1)
       ON CONFLICT(type) DO UPDATE SET current = current + 1`
    ).run({ type: typeKey });
    const row = d.prepare(
      'SELECT current FROM counters WHERE type = @type'
    ).get({ type: typeKey }) as { current: number };
    return row.current;
  });
  return run();
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

// === Pending Plans Management (Task B) ===

/**
 * savePendingPlan — persist a pending plan to SQLite (singleton row id=1)
 */
export function savePendingPlan(plan: unknown): void {
  const d = getDb();
  const planJson = JSON.stringify(plan);
  const now = new Date().toISOString();
  d.prepare(
    'INSERT OR REPLACE INTO pending_plans (id, plan_json, created_at) VALUES (1, ?, ?)'
  ).run(planJson, now);
}

/**
 * loadPendingPlan — retrieve pending plan from SQLite, returns null if none
 */
export function loadPendingPlan(): unknown | null {
  try {
    const d = getDb();
    const row = d.prepare('SELECT plan_json FROM pending_plans WHERE id = 1').get() as { plan_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.plan_json);
  } catch {
    return null;
  }
}

/**
 * clearPendingPlan — delete pending plan from SQLite
 */
export function clearPendingPlan(): void {
  const d = getDb();
  d.prepare('DELETE FROM pending_plans WHERE id = 1').run();
}

// === Pending User Inputs Management ===

export interface PendingUserInput {
  question: string;
  context?: string;
  createdAt: string;
}

export function savePendingUserInput(question: string, context?: string): void {
  const d = getDb();
  d.prepare(
    'INSERT OR REPLACE INTO pending_user_inputs (id, question, context, created_at) VALUES (1, ?, ?, ?)'
  ).run(question, context ?? null, new Date().toISOString());
}

export function loadPendingUserInput(): PendingUserInput | null {
  try {
    const d = getDb();
    const row = d.prepare('SELECT question, context, created_at FROM pending_user_inputs WHERE id = 1').get() as
      { question: string; context: string | null; created_at: string } | undefined;
    if (!row) return null;
    return { question: row.question, context: row.context ?? undefined, createdAt: row.created_at };
  } catch {
    return null;
  }
}

export function clearPendingUserInput(): void {
  const d = getDb();
  d.prepare('DELETE FROM pending_user_inputs WHERE id = 1').run();
}

// ── Permission escalation requests ───────────────────────────────────────────

export interface PendingPermissionRequest {
  skill: string;
  required: string;
  reason: string;
  createdAt: string;
  goal?: string;
}

export function savePendingPermissionRequest(skill: string, required: string, reason: string, goal?: string): void {
  const d = getDb();
  d.prepare(
    'INSERT OR REPLACE INTO pending_permission_requests (id, skill, required, reason, goal, created_at) VALUES (1, ?, ?, ?, ?, ?)'
  ).run(skill, required, reason, goal ?? null, new Date().toISOString());
}

export function loadPendingPermissionRequest(): PendingPermissionRequest | null {
  try {
    const d = getDb();
    const row = d.prepare('SELECT skill, required, reason, goal, created_at FROM pending_permission_requests WHERE id = 1').get() as
      { skill: string; required: string; reason: string; goal?: string | null; created_at: string } | undefined;
    if (!row) return null;
    return { skill: row.skill, required: row.required, reason: row.reason, createdAt: row.created_at, goal: row.goal ?? undefined };
  } catch {
    return null;
  }
}

export function clearPendingPermissionRequest(): void {
  const d = getDb();
  d.prepare('DELETE FROM pending_permission_requests WHERE id = 1').run();
}
