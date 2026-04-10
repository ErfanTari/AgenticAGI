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
import { localDateString } from '../utils/date.js';
import { sessionCache } from './session-cache.js';
import { upsertPointerEntry } from './pointer-index.js';
import { computeNameSimilarity } from './similarity.js';
import { enforceGateA } from './write-gate.js';
import { deriveHandle } from './handle.js';

// --- Phase 15: Identity Fingerprint Extraction ---

interface IdentityFingerprint {
  email?: string;
  phone?: string;
  handle?: string; // social handle / username
}

function extractFingerprint(text: string): IdentityFingerprint {
  const fp: IdentityFingerprint = {};

  const emailMatch = text.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
  if (emailMatch) fp.email = emailMatch[1].toLowerCase();

  const phoneMatch = text.match(/\b(\+?[\d\s\-().]{7,15})\b/);
  if (phoneMatch) {
    const cleaned = phoneMatch[1].replace(/\D/g, '');
    if (cleaned.length >= 7) fp.phone = cleaned;
  }

  const handleMatch = text.match(/@([a-zA-Z0-9_]{3,})\b/);
  if (handleMatch) fp.handle = handleMatch[1].toLowerCase();

  return fp;
}

function fingerprintKey(fp: IdentityFingerprint): string | null {
  if (fp.email) return `email:${fp.email}`;
  if (fp.phone) return `phone:${fp.phone}`;
  if (fp.handle) return `handle:${fp.handle}`;
  return null;
}

/**
 * Stage 1 — Fingerprint-based deduplication for WHO entries.
 * Matches on email, phone, or social handle.
 * Returns the existing code if found, null otherwise.
 */
function findByFingerprint(body: string, summary: string, nb: string, type: string): string | null {
  const fp = extractFingerprint(`${body}\n${summary}`);
  const key = fingerprintKey(fp);
  if (!key) return null;

  try {
    const d = getDb();
    const rows = d.prepare(`
      SELECT code, fingerprint FROM index_entries
      WHERE nb = ? AND type = ? AND status != 'archived' AND fingerprint IS NOT NULL
    `).all(nb, type) as Array<{ code: string; fingerprint: string }>;

    for (const row of rows) {
      try {
        const storedFp = JSON.parse(row.fingerprint) as IdentityFingerprint;
        if (fp.email && storedFp.email === fp.email) return row.code;
        if (fp.phone && storedFp.phone === fp.phone) return row.code;
        if (fp.handle && storedFp.handle === fp.handle) return row.code;
      } catch { /* skip malformed fingerprint */ }
    }
  } catch { /* best-effort */ }

  return null;
}

// FIX 3: Append-only types that must NEVER trigger near-duplicate suppression.
// These are time-series / event logs — each entry is intentionally a new record.
const APPEND_ONLY_TYPES = new Set(['NOW.LOG', 'WHEN.EV', 'WHEN.RF', 'PLAN.EX', 'WHEN.HX', 'NOW.RP']);

// FIX 3: Types where near-duplicate prevention should fire.
// WHO.CT is intentionally excluded — it already has fingerprint + fuzzy-name dedup (Stages 1+2).
// Adding a third similarity layer there causes cross-test contamination when many CT entries exist.
const DEDUP_SIMILARITY_TYPES = new Set(['WHAT.KN']);

/**
 * Stage 2 — Fuzzy name match for WHO.CT and WHO.ORG.
 * Matches: exact, substring, or initials match.
 * Returns the existing code if found, null otherwise.
 */
function findByFuzzyName(name: string, nb: string, type: string): string | null {
  if (nb !== 'WHO') return null;

  try {
    const d = getDb();
    const lower = name.toLowerCase();
    const rows = d.prepare(`
      SELECT code, name FROM index_entries
      WHERE nb = ? AND type = ? AND status != 'archived'
    `).all(nb, type) as Array<{ code: string; name: string }>;

    for (const row of rows) {
      const rowLower = row.name.toLowerCase();

      // Exact match
      if (rowLower === lower) return row.code;

      // Only match multi-word names where one is a prefix of another
      // e.g. "Sara" matches "Sara Ahmadi" but NOT "Sara123" or "BatchPerson1" vs "BatchPerson10"
      const rowParts = rowLower.split(/\s+/);
      const nameParts = lower.split(/\s+/);

      // Single name vs multi-word full name — only match 2-word full names (e.g. "Sara" → "Sara Ahmadi")
      // Reject 3+ word names to avoid "Alice" matching "Alice Codex 110031"
      if (nameParts.length === 1 && rowParts.length > 1) {
        if (rowParts.length <= 2 && rowParts.includes(lower)) return row.code;
      }

      // Multi-word vs single — only match when incoming name is 2 words
      if (rowParts.length === 1 && nameParts.length > 1) {
        if (nameParts.length <= 2 && nameParts.includes(rowLower)) return row.code;
      }
    }
  } catch { /* best-effort */ }

  return null;
}

/**
 * Saves fingerprint data to SQLite row.
 */
function saveFingerprint(code: string, body: string, summary: string): void {
  try {
    const fp = extractFingerprint(`${body}\n${summary}`);
    const key = fingerprintKey(fp);
    if (!key) return;

    const d = getDb();
    d.prepare('UPDATE index_entries SET fingerprint = ? WHERE code = ?')
      .run(JSON.stringify(fp), code);
  } catch { /* best-effort */ }
}

/**
 * Logs a transparency merge event to stderr.
 */
function logMergeEvent(newName: string, existingName: string, existingCode: string): void {
  console.log(`[memory] Merged "${newName}" into existing "${existingName}" (${existingCode})`);
}

/**
 * Phase 15 FIX 8: Invalidate project brain cache for any PLAN.PJ entries
 * that are related to this entry via relationships.
 */
function invalidateRelatedProjectBrains(code: string): void {
  try {
    const d = getDb();
    const rows = d.prepare(
      `SELECT to_code AS brain_code FROM relationships WHERE from_code = ? AND to_code LIKE 'PLAN.PJ%'
       UNION
       SELECT from_code AS brain_code FROM relationships WHERE to_code = ? AND from_code LIKE 'PLAN.PJ%'`
    ).all(code, code) as Array<{ brain_code: string }>;
    if (rows.length === 0) return;

    // Lazy import to avoid circular deps (project.ts imports write.ts via createEntry)
    import('./project.js').then(({ invalidateProjectBrain }) => {
      for (const row of rows) {
        invalidateProjectBrain(row.brain_code, d);
      }
    }).catch(() => { /* best-effort */ });
  } catch { /* best-effort */ }
}

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
  const today = entry.updated ?? localDateString();
  const lines = [
    '---',
    `code: ${entry.code}`,
    `nb: ${entry.nb}`,
    `type: ${entry.type}`,
    `name: ${entry.name}`,
    `handle: ${entry.handle ?? deriveHandle(entry.nb, entry.type, entry.name, { code: entry.code })}`,
    `status: ${entry.status ?? 'active'}`,
    `updated: ${today}`,
    `summary: ${(entry.summary ?? '').replace(/\n/g, ' ')}`,
  ];
  if (entry.project_code) {
    lines.push(`project_code: ${entry.project_code}`);
  }
  if (entry.purpose) {
    lines.push(`purpose: ${entry.purpose}`);
  }
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

function inferDefaultPurpose(input: Pick<CreateEntryInput, 'nb' | 'type' | 'name'>): NonNullable<IndexEntry['purpose']> {
  if (input.nb === 'NOW' && input.type === 'LOG' && /^Heartbeat\b/i.test(input.name)) {
    return 'pointer';
  }
  return 'anchor';
}

function extractBodyFromMarkdown(markdown: string): string {
  const frontmatterEnd = markdown.indexOf('\n---\n');
  if (frontmatterEnd < 0) return markdown.trimEnd();

  const afterFrontmatter = markdown.slice(frontmatterEnd + 5);
  const headingMatch = afterFrontmatter.match(/^\n?# [^\n]*\n\n/);
  if (!headingMatch) return afterFrontmatter.trimEnd();
  return afterFrontmatter.slice(headingMatch[0].length).trimEnd();
}

// FIX 2: Default body templates for entry types that commonly arrive empty.
// Only applied when the caller provides an empty/short body (< 10 chars).
function defaultBodyFor(nb: string, type: string): string | null {
  if (nb === 'WHO' && type === 'CT') {
    return '## Role / Relationship\n_Not specified_\n\n## Background\n_Not specified_\n\n## Notes\n_No notes yet_';
  }
  if (nb === 'PLAN' && type === 'PJ') {
    return '## Initial Request\n_Not specified_\n\n## Goal\n_Not specified_\n\n## Phase\n_Not specified_\n\n## Key Decisions\n_None recorded yet_\n\n## Progress Notes\n_Updated as milestones complete_\n\n## Conclusions\n_Project ongoing_';
  }
  return null;
}

export function createEntry(input: CreateEntryInput): IndexEntry {
  const d = getDb();

  // Phase 23 Stage 1: Gate A — deterministic write quality gate.
  // Throws WriteGateError on reject when MEMORY_GATE_A_ENFORCE=1.
  // Optional WHAT.KN duplicate warnings via the supplied db handle.
  enforceGateA(input, d);

  // Step 1: Generate code (atomic counter increment in its own implicit transaction)
  const code = generateCode(input.nb, input.type);
  const updated = localDateString();
  const handle = deriveHandle(input.nb, input.type, input.name, { code });
  const projectCode = input.project_code ?? (input.nb === 'PLAN' && input.type === 'PJ' ? code : null);
  const purpose = input.purpose ?? inferDefaultPurpose(input);

  // FIX 5: NOW.LOG defaults to status 'logged', not 'active'
  const resolvedStatus = (input.nb === 'NOW' && input.type === 'LOG' && (!input.status || input.status === 'active'))
    ? 'logged'
    : input.status;

  // FIX 2: Apply body template fallback when body is empty or too short
  const resolvedBody = (!input.body || input.body.trim().length < 10)
    ? (defaultBodyFor(input.nb, input.type) ?? input.body)
    : input.body;

  const entryData: Omit<IndexEntry, 'path'> = {
    code,
    nb: input.nb,
    type: input.type,
    name: input.name,
    handle,
    project_code: projectCode,
    purpose,
    status: resolvedStatus,
    updated,
    summary: input.summary,
    due_date: input.due_date ?? null,
  };

  const filePath = resolveEntryPath(input.nb, input.type, code, input.name);
  const markdown = buildMarkdown(entryData, resolvedBody);

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
    indexContent(code, input.nb, `${input.name} ${input.summary} ${resolvedBody}`);
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

  // Phase 15: update session cache
  sessionCache.set(entry.code, entry);

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

  // Phase 15 Stage 1: Fingerprint-based dedup for WHO entries
  if (input.nb === 'WHO') {
    const fpCode = findByFingerprint(input.body, input.summary, input.nb, input.type);
    if (fpCode) {
      const fpEntry = getEntryByCode(fpCode);
      if (fpEntry && fpEntry.name !== input.name) {
        logMergeEvent(input.name, fpEntry.name, fpCode);
      }
      // Fall through to normal upsert with the found code's name
      // We update the body by appending new info
      if (fpEntry && fs.existsSync(fpEntry.path)) {
        const existingContent = fs.readFileSync(fpEntry.path, 'utf-8');
        const appendedBody = existingContent.trimEnd() + '\n\n## Additional Info\n' + input.body;
        atomicWriteFile(fpEntry.path, appendedBody);
      }
      saveFingerprint(fpCode, input.body, input.summary);
      upsertPointerEntry({ code: fpCode, name: fpEntry?.name ?? input.name, summary: input.summary ?? '', lastActive: localDateString() });
      return { code: fpCode, created: false };
    }
  }

  // Phase 15 Stage 2: Fuzzy name match for WHO entries
  if (input.nb === 'WHO' && (input.type === 'CT' || input.type === 'ORG')) {
    const fuzzyCode = findByFuzzyName(input.name, input.nb, input.type);
    if (fuzzyCode) {
      const fuzzyEntry = getEntryByCode(fuzzyCode);
      if (fuzzyEntry && fuzzyEntry.name !== input.name) {
        logMergeEvent(input.name, fuzzyEntry.name, fuzzyCode);
        // Update the existing entry with new info appended
        if (fs.existsSync(fuzzyEntry.path)) {
          const existingContent = fs.readFileSync(fuzzyEntry.path, 'utf-8');
          const appendedBody = existingContent.trimEnd() + '\n\n## Additional Info\n' + input.body;
          atomicWriteFile(fuzzyEntry.path, appendedBody);
        }
        saveFingerprint(fuzzyCode, input.body, input.summary);
        upsertPointerEntry({ code: fuzzyCode, name: fuzzyEntry?.name ?? input.name, summary: input.summary ?? '', lastActive: localDateString() });
        return { code: fuzzyCode, created: false };
      }
    }
  }

  const existing = d.prepare(`
    SELECT code FROM index_entries
    WHERE nb = ? AND type = ? AND LOWER(name) = LOWER(?)
    AND status != 'archived'
    LIMIT 1
  `).get(input.nb, input.type, input.name) as { code: string } | undefined;

  if (existing) {
    const entry = getEntryByCode(existing.code);
    const updated = localDateString();

    // BUG-C4 fix: if the Markdown file is missing, treat as a create operation —
    // write the new file and update the SQLite row with the new path/content.
    if (entry && !fs.existsSync(entry.path)) {
      const handle = deriveHandle(input.nb, input.type, input.name, { code: existing.code });
      const newFilePath = resolveEntryPath(input.nb, input.type, existing.code, input.name);
      const entryMeta: Omit<IndexEntry, 'path'> = {
        code: existing.code,
        nb: input.nb,
        type: input.type,
        name: input.name,
        handle,
        project_code: input.project_code ?? entry.project_code ?? null,
        purpose: input.purpose ?? entry.purpose ?? inferDefaultPurpose(input),
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
          'UPDATE index_entries SET name = ?, handle = ?, project_code = ?, purpose = ?, summary = ?, status = ?, updated = ?, path = ?, due_date = ? WHERE code = ?'
        ).run(
          input.name,
          handle,
          entryMeta.project_code ?? null,
          entryMeta.purpose ?? null,
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
      upsertPointerEntry({ code: existing.code, name: input.name, summary: input.summary ?? '', lastActive: localDateString() });
      return { code: existing.code, created: false };
    }

    // FIX F: upsertEntry existing-row branch: regenerate full frontmatter from current data.
    // Build new frontmatter + old body. File write first, then SQLite.
    const handle = deriveHandle(input.nb, input.type, input.name, { code: existing.code });
    const newEntryMeta: Omit<IndexEntry, 'path'> = {
      code: existing.code,
      nb: input.nb,
      type: input.type,
      name: input.name,
      handle,
      project_code: input.project_code ?? entry?.project_code ?? null,
      purpose: input.purpose ?? entry?.purpose ?? inferDefaultPurpose(input),
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
        'UPDATE index_entries SET name = ?, handle = ?, project_code = ?, purpose = ?, summary = ?, status = ?, updated = ?, path = ?, due_date = ? WHERE code = ?'
      ).run(
        input.name,
        handle,
        newEntryMeta.project_code ?? null,
        newEntryMeta.purpose ?? null,
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

    // Phase 15 FIX 8: invalidate project brain cache for related PLAN.PJ entries
    invalidateRelatedProjectBrains(existing.code);

    // Phase 16: update pointer index
    upsertPointerEntry({ code: existing.code, name: input.name, summary: input.summary ?? '', lastActive: localDateString() });

    return { code: existing.code, created: false };
  }

  // FIX 3: Near-duplicate prevention for WHAT.KN and WHO.CT/ORG.
  // Applied only to non-append-only types. No LLM needed — purely name similarity.
  const typeKey = `${input.nb}.${input.type}`;
  if (DEDUP_SIMILARITY_TYPES.has(typeKey) && !APPEND_ONLY_TYPES.has(typeKey)) {
    try {
      const candidates = d.prepare(`
        SELECT code, name FROM index_entries
        WHERE nb = ? AND type = ? AND status != 'archived'
      `).all(input.nb, input.type) as Array<{ code: string; name: string }>;
      for (const candidate of candidates) {
        if (computeNameSimilarity(candidate.name, input.name) > 0.6) {
          console.log(`[memory] Near-duplicate suppressed: "${input.name}" ~ "${candidate.name}" (${candidate.code})`);
          upsertPointerEntry({ code: candidate.code, name: candidate.name, summary: input.summary ?? '', lastActive: localDateString() });
          return { code: candidate.code, created: false };
        }
      }
    } catch { /* best-effort — if check fails, fall through to normal create */ }
  }

  const created = createEntry(input);
  // Phase 15: save fingerprint for WHO entries
  if (input.nb === 'WHO') {
    saveFingerprint(created.code, input.body, input.summary);
  }
  // Phase 15 FIX 8: invalidate project brain cache for related PLAN.PJ entries
  invalidateRelatedProjectBrains(created.code);
  // Phase 16: update pointer index
  upsertPointerEntry({ code: created.code, name: input.name, summary: input.summary ?? '', lastActive: localDateString() });
  return { code: created.code, created: true };
}

/**
 * Phase 16 — upsertEntryWithRetry
 * Wraps upsertEntry with up to 3 attempts. On UNIQUE constraint violation (concurrent write),
 * waits 50ms before retry. Other errors are rethrown after max attempts.
 */
export async function upsertEntryWithRetry(
  input: CreateEntryInput,
  maxAttempts = 3,
): Promise<{ code: string; created: boolean }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return upsertEntry(input);
    } catch (err: unknown) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint')) {
        // Concurrent write — wait briefly then retry
        await new Promise(r => setTimeout(r, 50));
      } else {
        throw err; // non-retryable
      }
    }
  }
  throw lastErr;
}

export function updateEntry(
  code: string,
  updates: {
    status?: string;
    summary?: string;
    project_code?: string | null;
    purpose?: IndexEntry['purpose'];
  },
): IndexEntry {
  const entry = getEntryByCode(code);
  if (!entry) throw new Error(`Entry not found: ${code}`);

  const updated = localDateString();
  const newStatus = updates.status ?? entry.status;
  const newSummary = updates.summary ?? entry.summary;
  const newProjectCode = updates.project_code !== undefined ? updates.project_code : (entry.project_code ?? null);
  const newPurpose = updates.purpose !== undefined ? updates.purpose : (entry.purpose ?? null);

  const d = getDb();
  d.prepare(
    'UPDATE index_entries SET status = ?, summary = ?, project_code = ?, purpose = ?, updated = ? WHERE code = ?'
  ).run(newStatus, newSummary, newProjectCode, newPurpose, updated, code);

  // Update markdown frontmatter on disk
  if (fs.existsSync(entry.path)) {
    const content = fs.readFileSync(entry.path, 'utf-8');
    const body = extractBodyFromMarkdown(content);
    const rebuilt = buildMarkdown({
      ...entry,
      project_code: newProjectCode,
      purpose: newPurpose,
      status: newStatus,
      summary: newSummary,
      updated,
    }, body);
    atomicWriteFile(entry.path, rebuilt);
  }

  const updatedEntry = {
    ...entry,
    project_code: newProjectCode,
    purpose: newPurpose,
    status: newStatus,
    summary: newSummary,
    updated,
  };
  // Phase 15: update session cache
  sessionCache.set(code, updatedEntry);
  return updatedEntry;
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
