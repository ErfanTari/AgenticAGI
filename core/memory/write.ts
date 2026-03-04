import fs from 'node:fs';
import path from 'node:path';
import { PATHS, TYPE_MAP, resolveTypeKey, EMBEDDING_CONFIG } from '../../config/agent.config.js';
import type { IndexEntry, CreateEntryInput } from './types.js';
import { generateCode } from './codegen.js';
import { getDb, insertEntry, getEntryByCode } from './index.js';
import { indexContent } from './fts.js';
import { chunkMarkdown } from './chunks.js';
import { storeChunks, fetchEmbeddings } from './embeddings.js';

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

function buildFrontmatter(entry: Omit<IndexEntry, 'path'>): string {
  return [
    '---',
    `code: ${entry.code}`,
    `nb: ${entry.nb}`,
    `type: ${entry.type}`,
    `name: ${entry.name}`,
    `status: ${entry.status}`,
    `updated: ${entry.updated}`,
    `summary: ${entry.summary}`,
    '---',
  ].join('\n');
}

function buildMarkdown(entry: Omit<IndexEntry, 'path'>, body: string): string {
  const frontmatter = buildFrontmatter(entry);
  return frontmatter + '\n\n# ' + entry.name + '\n\n' + body + '\n';
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

  // Step 2: Write file to disk BEFORE transaction
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, markdown, 'utf-8');

  // Step 3: Run SQLite transaction (insertEntry + FTS + chunks)
  const entry: IndexEntry = { ...entryData, path: filePath };
  try {
    const run = d.transaction(() => {
      insertEntry(entry);
      indexContent(code, input.nb, `${input.name} ${input.summary} ${input.body}`);
      const chunks = chunkMarkdown(code, markdown);
      if (chunks.length > 0) {
        storeChunks(chunks);
      }
    });
    run();
  } catch (err) {
    // Step 4: If transaction fails, clean up the file
    try { fs.unlinkSync(filePath); } catch { /* ignore cleanup errors */ }
    throw err;
  }

  // Schedule embedding computation — fire-and-forget, best-effort
  scheduleEmbedding(entry.code);

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
    // Update summary and body content of the existing entry
    updateEntry(existing.code, {
      status: input.status ?? undefined,
      summary: input.summary,
    });
    // Also rewrite the markdown body on disk if content changed
    const entry = getEntryByCode(existing.code);
    if (entry && fs.existsSync(entry.path)) {
      const md = fs.readFileSync(entry.path, 'utf-8');
      // Replace body (everything after the closing ---)
      const headerEnd = md.indexOf('\n---\n');
      if (headerEnd >= 0) {
        const header = md.slice(0, headerEnd + 5);
        const newMd = header + '\n# ' + entry.name + '\n\n' + (input.body ?? '') + '\n';
        fs.writeFileSync(entry.path, newMd, 'utf-8');
        // Re-index FTS so search reflects updated content
        indexContent(existing.code, input.nb, `${input.name} ${input.summary} ${input.body ?? ''}`);
      }
    }
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
    fs.writeFileSync(entry.path, newContent, 'utf-8');
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
