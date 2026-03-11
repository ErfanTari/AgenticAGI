import fs from 'node:fs';
import path from 'node:path';
import { PATHS, TYPE_MAP, resolveTypeKey, EMBEDDING_CONFIG } from '../../config/agent.config.js';
import type { IndexEntry, CreateEntryInput } from './types.js';
import { generateCode } from './codegen.js';
import { getDb, insertEntry, getEntryByCode } from './index.js';
import { indexContent } from './fts.js';
import { chunkMarkdown } from './chunks.js';
import { storeChunks, fetchEmbeddings } from './embeddings.js';
import { scheduleMemoryCommit } from './versioning.js';

/**
 * FIX 3 — Atomic file write using a .tmp intermediate file.
 * Writes to filePath.tmp first, then atomically renames to filePath.
 * On the same filesystem, rename() is atomic — no partial file is ever visible.
 * If rename fails, the .tmp file is cleaned up before throwing.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (cleanupErr) {
      console.warn(`[memory] Failed to clean up temp file ${tmpPath}:`, cleanupErr);
    }
    throw err;
  }
}

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function resolveEntryPath(nb: string, type: string, code: string, name: string): string {
  const key = resolveTypeKey(nb, type);
  if (!key) throw new Error(`Invalid notebook+type: ${nb}.${type}`);
  const subfolder = TYPE_MAP[key].subfolder;
  const sanitized = sanitizeName(name);
  const filename = `${code}_${sanitized}.md`;
  return path.join(PATHS.memory, subfolder, filename);
}

// C4: Operational metadata included in frontmatter for DB-rebuild resilience.
// privacy_tier is intentionally excluded (information leak risk).
interface OperationalMeta {
  importance_score?: number;
  utility_score?: number;
  usage_count?: number;
  decay_rate?: number;
  active_page?: number;
  confidence?: number;
  last_accessed?: string;
  pinned?: number;
  source?: string;
}

function buildFrontmatter(entry: Omit<IndexEntry, 'path'> & OperationalMeta): string {
  const today = entry.updated ?? new Date().toISOString().slice(0, 10);
  const lines = [
    '---',
    `code: ${entry.code}`,
    `nb: ${entry.nb}`,
    `type: ${entry.type}`,
    `name: ${entry.name}`,
    `status: ${entry.status ?? 'active'}`,
    `updated: ${today}`,
    `summary: ${(entry.summary ?? '').replace(/\n/g, ' ')}`,
  ];
  if (entry.due_date) {
    lines.push(`due_date: ${entry.due_date}`);
  }
  lines.push(
    `importance_score: ${entry.importance_score ?? 0}`,
    `utility_score: ${entry.utility_score ?? 0}`,
    `usage_count: ${entry.usage_count ?? 0}`,
    `decay_rate: ${entry.decay_rate ?? 0.1}`,
    `active_page: ${entry.active_page ?? 1}`,
    `confidence: ${entry.confidence ?? 1.0}`,
    `last_accessed: ${entry.last_accessed ?? today}`,
    `pinned: ${entry.pinned ?? 0}`,
    `source: ${entry.source ?? 'agent'}`,
    '---',
  );
  return lines.join('\n');
}

function buildMarkdown(entry: Omit<IndexEntry, 'path'>, body: string): string {
  const frontmatter = buildFrontmatter(entry);
  return frontmatter + '\n\n# ' + entry.name + '\n\n' + body + '\n';
}

function extractBodyFromMarkdown(markdown: string): string {
  const frontmatterEnd = markdown.indexOf('\n---\n');
  if (frontmatterEnd < 0) return markdown.trimEnd();

  const afterFrontmatter = markdown.slice(frontmatterEnd + 5);
  const headingMatch = afterFrontmatter.match(/^\n?# [^\n]*\n\n/);
  if (!headingMatch) return afterFrontmatter.trimEnd();
  return afterFrontmatter.slice(headingMatch[0].length).trimEnd();
}

export function createEntry(input: CreateEntryInput): IndexEntry {
  const d = getDb();

  // Step 1: Generate code (atomic counter increment in its own implicit transaction)
  const code = generateCode(input.nb, input.type);
  const updated = new Date().toISOString().slice(0, 10);

  const entryData: Omit<IndexEntry, 'path'> = {
    code,
    nb: input.nb,
    type: input.type,
    name: input.name,
    status: input.status,
    updated,
    summary: input.summary,
    due_date: input.due_date ?? null,
  };

  const filePath = resolveEntryPath(input.nb, input.type, code, input.name);
  const markdown = buildMarkdown(entryData, input.body);

  // FIX F: Write markdown file FIRST, then SQLite.
  // If file write throws, SQLite is never touched (no partial commit).
  // If SQLite fails after file write, clean up the file.
  const entry: IndexEntry = { ...entryData, path: filePath };

  // Step 2: Write file to disk first
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFile(filePath, markdown); // throws on failure — SQLite never touched

  // Step 3: Run SQLite transaction (insertEntry + FTS + chunks) after file write
  const run = d.transaction(() => {
    insertEntry(entry);
    indexContent(code, input.nb, `${input.name} ${input.summary} ${input.body}`);
    const chunks = chunkMarkdown(code, markdown);
    if (chunks.length > 0) {
      storeChunks(chunks);
    }
  });
  try {
    run();
  } catch (err) {
    // SQLite failed after file write — clean up the file to avoid orphan
    try {
      fs.unlinkSync(filePath);
    } catch {
      console.warn(`[memory-write] Could not clean up orphaned file ${filePath} after SQLite failure`);
    }
    throw err;
  }

  // Schedule embedding computation — fire-and-forget, best-effort
  scheduleEmbedding(entry.code);

  // Git version commit — fire-and-forget, never blocks write
  // BUG-2 fix: log errors to stderr so git commit failures are visible but non-blocking
  scheduleMemoryCommit(`${code}: ${input.name} [agent]`);

  return entry;
}

/**
 * upsertEntry — create or update based on exact nb+type+name match.
 *
 * If an active entry with the same (nb, type, name) already exists,
 * updates its summary and body content instead of creating a duplicate.
 *
 * Returns: { code, created: true } on new creation, { code, created: false } on update.
 */
export function upsertEntry(
  input: CreateEntryInput,
): { code: string; created: boolean } {
  const d = getDb();

  const existing = d.prepare(`
    SELECT code FROM index_entries
    WHERE nb = ? AND type = ? AND LOWER(name) = LOWER(?)
    AND status != 'archived'
    LIMIT 1
  `).get(input.nb, input.type, input.name) as { code: string } | undefined;

  if (existing) {
    const entry = getEntryByCode(existing.code);
    const updated = new Date().toISOString().slice(0, 10);

    // BUG-C4 fix: if the Markdown file is missing, treat as a create operation —
    // write the new file and update the SQLite row with the new path/content.
    if (entry && !fs.existsSync(entry.path)) {
      const newFilePath = resolveEntryPath(input.nb, input.type, existing.code, input.name);
      const entryMeta: Omit<IndexEntry, 'path'> = {
        code: existing.code,
        nb: input.nb,
        type: input.type,
        name: input.name,
        status: input.status ?? 'active',
        updated,
        summary: input.summary ?? '',
        due_date: input.due_date ?? null,
      };
      const markdown = buildMarkdown(entryMeta, input.body ?? '');
      try {
        fs.mkdirSync(path.dirname(newFilePath), { recursive: true });
        atomicWriteFile(newFilePath, markdown);
      } catch (err) {
        console.warn(`[memory-write] File recreate failed for ${existing.code}:`, err);
        throw err;
      }
      try {
        d.prepare(
          'UPDATE index_entries SET name = ?, summary = ?, status = ?, updated = ?, path = ?, due_date = ? WHERE code = ?'
        ).run(
          input.name,
          input.summary ?? '',
          input.status ?? 'active',
          updated,
          newFilePath,
          input.due_date ?? null,
          existing.code,
        );
      } catch (err) {
        try {
          fs.unlinkSync(newFilePath);
        } catch {
          console.warn(`[memory-write] Could not clean up recreated file ${newFilePath} after SQLite failure`);
        }
        throw err;
      }
      try {
        indexContent(existing.code, input.nb, `${input.name} ${input.summary ?? ''} ${input.body ?? ''}`);
      } catch { /* non-fatal */ }
      scheduleMemoryCommit(`${existing.code}: ${input.name} [agent]`);
      return { code: existing.code, created: false };
    }

    // FIX F: upsertEntry existing-row branch: regenerate full frontmatter from current data.
    // Build new frontmatter + old body. File write first, then SQLite.
    const newEntryMeta: Omit<IndexEntry, 'path'> = {
      code: existing.code,
      nb: input.nb,
      type: input.type,
      name: input.name,
      status: input.status ?? 'active',
      updated,
      summary: input.summary ?? '',
      due_date: input.due_date ?? null,
    };
    const newFrontmatter = buildFrontmatter(newEntryMeta);

    // Get existing file body (content below frontmatter separator)
    let bodyContent = input.body ?? '';
    const targetPath = entry?.path ?? resolveEntryPath(input.nb, input.type, existing.code, input.name);
    const previousFileExists = fs.existsSync(targetPath);
    const previousContent = previousFileExists ? fs.readFileSync(targetPath, 'utf-8') : null;
    if (!input.body && previousContent) {
      bodyContent = extractBodyFromMarkdown(previousContent);
    }

    const newMd = newFrontmatter + '\n\n# ' + input.name + '\n\n' + bodyContent + '\n';

    // Write file first, then SQLite (FIX F)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    atomicWriteFile(targetPath, newMd);

    try {
      // SQLite update after file write
      d.prepare(
        'UPDATE index_entries SET name = ?, summary = ?, status = ?, updated = ?, path = ?, due_date = ? WHERE code = ?'
      ).run(
        input.name,
        input.summary ?? '',
        input.status ?? 'active',
        updated,
        targetPath,
        input.due_date ?? null,
        existing.code,
      );
    } catch (err) {
      if (previousContent !== null) {
        atomicWriteFile(targetPath, previousContent);
      } else {
        try {
          fs.unlinkSync(targetPath);
        } catch {
          console.warn(`[memory-write] Could not clean up ${targetPath} after SQLite failure`);
        }
      }
      throw err;
    }

    // Re-index FTS after transaction — non-fatal if it fails (data safe, search may lag)
    try {
      indexContent(existing.code, input.nb, `${input.name} ${input.summary ?? ''} ${bodyContent}`);
    } catch (err) {
      console.warn(`[memory] FTS reindex failed for ${existing.code}:`, err);
    }

    // Git version commit for update — fire-and-forget
    scheduleMemoryCommit(`${existing.code}: ${input.name} [agent]`);

    return { code: existing.code, created: false };
  }

  const created = createEntry(input);
  return { code: created.code, created: true };
}

export function updateEntry(code: string, updates: { status?: string; summary?: string }): IndexEntry {
  const entry = getEntryByCode(code);
  if (!entry) throw new Error(`Entry not found: ${code}`);

  const updated = new Date().toISOString().slice(0, 10);
  const newStatus = updates.status ?? entry.status;
  const newSummary = updates.summary ?? entry.summary;

  const d = getDb();
  d.prepare(
    'UPDATE index_entries SET status = ?, summary = ?, updated = ? WHERE code = ?'
  ).run(newStatus, newSummary, updated, code);

  // Update markdown frontmatter on disk
  if (fs.existsSync(entry.path)) {
    const content = fs.readFileSync(entry.path, 'utf-8');
    const newContent = content
      .replace(/^status: .+$/m, `status: ${newStatus}`)
      .replace(/^summary: .+$/m, `summary: ${newSummary}`)
      .replace(/^updated: .+$/m, `updated: ${updated}`);
    atomicWriteFile(entry.path, newContent);
  }

  return { ...entry, status: newStatus, summary: newSummary, updated };
}

/**
 * Fire-and-forget embedding computation for stored chunks.
 * Only runs when EMBEDDING_CONFIG is set. Failures are silently ignored.
 */
function scheduleEmbedding(code: string): void {
  if (!EMBEDDING_CONFIG) return;

  // Use queueMicrotask to avoid blocking the sync return
  queueMicrotask(async () => {
    try {
      const { getDb: getDatabase } = await import('./index.js');
      const d = getDatabase();
      const rows = d.prepare(
        'SELECT id, text FROM chunks WHERE code = ? AND embedding IS NULL'
      ).all(code) as Array<{ id: number; text: string }>;

      if (rows.length === 0) return;

      const texts = rows.map(r => r.text);
      const embeddings = await fetchEmbeddings(texts, EMBEDDING_CONFIG!);

      const stmt = d.prepare('UPDATE chunks SET embedding = ? WHERE id = ?');
      const updateAll = d.transaction(() => {
        for (let i = 0; i < rows.length; i++) {
          const buf = Buffer.from(
            embeddings[i].buffer,
            embeddings[i].byteOffset,
            embeddings[i].byteLength,
          );
          stmt.run(buf, rows[i].id);
        }
      });
      updateAll();
    } catch {
      console.log('[embed] Embedding server unreachable — using BM25 only');
    }
  });
}
