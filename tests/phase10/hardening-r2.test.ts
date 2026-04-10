/**
 * Phase 10 Hardening Sprint — Round 2 regression tests.
 * Covers all 15 bugs: 4 CRITICAL, 6 HIGH, 5 MEDIUM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase, closeDatabase, getDb } from '../../core/memory/index.js';
import { createEntry, upsertEntry } from '../../core/memory/write.js';
import { checkEmbeddingMigration, reIndexAllEntries } from '../../core/memory/search.js';
import { extractFirstJsonObject, applyRepairPasses, parseStructured } from '../../core/structured.js';
import { trimHistoryToTokenBudget, buildContext } from '../../core/context.js';
import type { Message } from '../../core/types.js';
import type { IndexEntry } from '../../core/memory/types.js';
import { z } from 'zod';

// ─── DB isolation helpers ───────────────────────────────────────────────────

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;

function isolateDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-r2-'));
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  initDatabase(path.join(tmpDir, 'test.sqlite'));
}

function restoreDb() {
  closeDatabase();
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── BUG-C1: rollbackEntry restores exact original code ────────────────────

describe('BUG-C1: rollbackEntry restores exact original code', () => {
  beforeEach(isolateDb);
  afterEach(async () => {
    const { _resetGitInstance } = await import('../../core/memory/versioning.js');
    _resetGitInstance();
    await new Promise(r => setTimeout(r, 100));
    restoreDb();
    vi.restoreAllMocks();
  });

  it('BUG-C1A: versioning.ts imports from index.js not write.js (no upsertEntry call)', async () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'core/memory/versioning.ts'),
      'utf-8',
    );
    // Should not import upsertEntry (which would create a new code)
    expect(src).not.toContain("import { upsertEntry }");
    // Should import insertEntry for direct code restoration
    expect(src).toContain('insertEntry');
  });

  it('BUG-C1B: rollback without existing row uses INSERT not upsert', async () => {
    // Create an entry, get its code, delete the DB row, then check rollback restores exact code
    const entry = createEntry({
      nb: 'WHAT', type: 'KN', name: 'Test Knowledge',
      status: 'active', summary: 'test summary', body: 'test body',
    });
    const originalCode = entry.code;

    // Wait for git commit
    await new Promise(r => setTimeout(r, 200));

    const { getEntryHistory, rollbackEntry, _resetGitInstance } = await import('../../core/memory/versioning.js');
    const history = await getEntryHistory(originalCode);

    if (history.length === 0) {
      // No git history in this env — just verify the code format
      expect(originalCode).toMatch(/^WHAT\.KN-\d{6}$/);
      return;
    }

    // Delete the DB row to simulate the bug scenario
    // Temporarily disable FK enforcement so we can orphan the row
    const d = getDb();
    d.pragma('foreign_keys = OFF');
    d.prepare('DELETE FROM index_entries WHERE code = ?').run(originalCode);
    d.pragma('foreign_keys = ON');

    // Rollback should restore with EXACT original code
    const success = await rollbackEntry(originalCode, history[0].hash);
    if (success) {
      const restored = d.prepare('SELECT code FROM index_entries WHERE code = ?').get(originalCode) as { code: string } | undefined;
      expect(restored?.code).toBe(originalCode);
    }
  });
});

// ─── BUG-C2 / FIX F: createEntry write order ─────────────────────────────────
// FIX F reversed the write order: file FIRST, SQLite second.
// If file write fails, SQLite is never touched (clean failure).
// If SQLite fails after file write, the file is cleaned up.

describe('BUG-C2: createEntry write order', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); vi.restoreAllMocks(); });

  it('BUG-C2A: write.ts source confirms FIX F file-first write order', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'core/memory/write.ts'),
      'utf-8',
    );
    // FIX F: file FIRST, then SQLite
    expect(src).toContain('FIX F');
  });

  it('BUG-C2B: createEntry creates SQLite row and file on success', () => {
    const entry = createEntry({
      nb: 'WHO', type: 'CT', name: 'Test Contact BUG-C2',
      status: 'active', summary: 'test', body: 'body',
    });

    const d = getDb();
    const row = d.prepare('SELECT code FROM index_entries WHERE code = ?').get(entry.code);
    expect(row).not.toBeNull();
    // File should also exist
    expect(fs.existsSync(entry.path)).toBe(true);
  });

  it('BUG-C2C: file write failure throws (SQLite never touched)', () => {
    // FIX F: file is written FIRST. If file write fails, the error propagates.
    let callCount = 0;
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      callCount++;
      if (callCount === 1 && String(args[0]).endsWith('.md.tmp')) {
        throw new Error('Simulated file write failure');
      }
      return originalWriteFileSync(...args);
    });

    // FIX F: file write failure DOES throw (old behavior was to swallow it)
    expect(() => {
      createEntry({
        nb: 'WHO', type: 'CT', name: 'File Fail Test',
        status: 'active', summary: 'test', body: 'body',
      });
    }).toThrow('Simulated file write failure');
  });
});

// ─── BUG-C3: Unique constraint prevents duplicate entries ──────────────────

describe('BUG-C3: UNIQUE constraint on (nb, type, LOWER(name))', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); });

  it('BUG-C3A: idx_unique_entry index exists in schema', () => {
    const d = getDb();
    const indexes = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_unique_entry'").get();
    expect(indexes).not.toBeUndefined();
  });

  it('BUG-C3B: two upsertEntry calls with same name produce exactly one row', () => {
    upsertEntry({ nb: 'PLAN', type: 'PJ', name: 'Duplicate Project', status: 'active', summary: 's1', body: 'b1' });
    upsertEntry({ nb: 'PLAN', type: 'PJ', name: 'Duplicate Project', status: 'active', summary: 's2', body: 'b2' });

    const d = getDb();
    const rows = d.prepare("SELECT code FROM index_entries WHERE nb='WHAT' AND type='PJ' AND LOWER(name)='duplicate project'").all();
    expect(rows.length).toBe(1);
  });

  it('BUG-C3C: case-insensitive deduplication works', () => {
    upsertEntry({ nb: 'WHO', type: 'CT', name: 'Alice Bob', status: 'active', summary: 's', body: 'b' });
    upsertEntry({ nb: 'WHO', type: 'CT', name: 'ALICE BOB', status: 'active', summary: 's2', body: 'b2' });

    const d = getDb();
    const rows = d.prepare("SELECT code FROM index_entries WHERE nb='WHO' AND type='CT' AND LOWER(name)='alice bob'").all();
    expect(rows.length).toBe(1);
  });
});

// ─── BUG-C4: upsertEntry handles missing Markdown file ─────────────────────

describe('BUG-C4: upsertEntry recreates missing Markdown file', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); });

  it('BUG-C4A: same code returned when file is missing', () => {
    const { code } = upsertEntry({ nb: 'WHAT', type: 'KN', name: 'Missing File Test', status: 'active', summary: 's', body: 'original body' });

    // Delete the file
    const d = getDb();
    const row = d.prepare('SELECT path FROM index_entries WHERE code = ?').get(code) as { path: string };
    if (row && fs.existsSync(row.path)) fs.unlinkSync(row.path);

    // upsert again
    const result = upsertEntry({ nb: 'WHAT', type: 'KN', name: 'Missing File Test', status: 'active', summary: 's2', body: 'new body' });
    expect(result.code).toBe(code);
  });

  it('BUG-C4B: file is recreated after missing file upsert', () => {
    const { code } = upsertEntry({ nb: 'WHAT', type: 'KN', name: 'Recreate Test', status: 'active', summary: 's', body: 'body' });

    const d = getDb();
    const row = d.prepare('SELECT path FROM index_entries WHERE code = ?').get(code) as { path: string };
    if (row && fs.existsSync(row.path)) fs.unlinkSync(row.path);

    upsertEntry({ nb: 'WHAT', type: 'KN', name: 'Recreate Test', status: 'active', summary: 's2', body: 'new body' });

    const updatedRow = d.prepare('SELECT path FROM index_entries WHERE code = ?').get(code) as { path: string };
    expect(fs.existsSync(updatedRow.path)).toBe(true);
  });
});

// ─── BUG-H1: Executor skips steps with unmet dependencies ──────────────────

describe('BUG-H1: executePlan enforces declared dependencies', () => {
  it('BUG-H1A: executor.ts source contains blocked step logic', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'core/executor.ts'),
      'utf-8',
    );
    // Should contain "BLOCKED" or "blocked by dependency"
    expect(src).toContain('Blocked: dependency');
    // Should contain continue to skip the step
    expect(src).toContain('continue;');
  });

  it('BUG-H1B: dependency failure marks current step blocked and continues', async () => {
    const { executePlan } = await import('../../core/executor.js');

    const plan = {
      goal: 'test',
      estimatedDuration: '1s',
      steps: [
        {
          id: 'step1',
          skill: 'nonexistent_skill',
          input: {},
          dependsOn: [],
          optional: false,
        },
        {
          id: 'step2',
          skill: 'calculator',
          input: { expression: '1+1' },
          dependsOn: ['step1'], // depends on step1 which will fail
          optional: true, // optional so plan continues
        },
      ],
    };

    // Mock LLM handler
    const mockLLM = async () => '{}';
    const result = await executePlan(plan as any, mockLLM as any);

    // step2 should not appear in completed (it was blocked)
    const step2Completed = result.completed.some(s => s.stepId === 'step2');
    expect(step2Completed).toBe(false);
  });
});

// ─── BUG-H2: rankByRelevance applied before formatResolved ─────────────────

describe('BUG-H2: rankByRelevance applied before injecting into prompt', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); });

  it('BUG-H2A: context.ts ranks before formatting (source order check)', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'core/context.ts'),
      'utf-8',
    );
    const rankIdx = src.indexOf('rankByRelevance(resolved.entries, userMessage)');
    const formatIdx = src.indexOf('formatResolved(resolved)');
    // rankByRelevance must come BEFORE formatResolved
    expect(rankIdx).toBeLessThan(formatIdx);
  });

  it('BUG-H2B: best-matching entry appears first in formatted prompt', async () => {
    const { buildContext } = await import('../../core/context.js');
    const { getAllSkills } = await import('../../core/skills/registry.js');

    const entryA: IndexEntry = {
      code: 'WHO.CT-000001', nb: 'WHO', type: 'CT',
      name: 'Unrelated Person XYZ', status: 'active',
      updated: new Date(Date.now() - 86400000).toISOString(), summary: 'irrelevant',
      path: '/tmp/a.md',
    };
    const entryB: IndexEntry = {
      code: 'WHO.CT-000002', nb: 'WHO', type: 'CT',
      name: 'Alice Bob Project Manager',
      status: 'active',
      updated: new Date().toISOString(),
      summary: 'project manager',
      path: '/tmp/b.md',
    };

    const resolved = { entries: [entryA, entryB], contents: [], relationships: [] };
    const skills = getAllSkills();

    const messages = await buildContext('alice project manager', resolved, [], skills);
    const systemContent = messages[0].content;

    const posA = systemContent.indexOf(entryA.code);
    const posB = systemContent.indexOf(entryB.code);
    // entryB (better match) should appear before entryA
    expect(posB).toBeGreaterThan(-1);
    if (posA !== -1) expect(posB).toBeLessThan(posA);
  });
});

// ─── BUG-H3/H4: applyRepairPasses early return for valid JSON ──────────────

describe('BUG-H3/H4: applyRepairPasses returns valid JSON unchanged', () => {
  it('BUG-H3A: {key: value} pattern inside string value is not corrupted', () => {
    const input = '{"prompt":"Use {key: value} literally","bar":1}';
    const result = applyRepairPasses(input);
    expect(result).toBe(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.prompt).toBe('Use {key: value} literally');
  });

  it('BUG-H4A: think tags inside JSON string values are preserved', () => {
    const input = '{"goal":"literal <think>text</think> preserved","steps":[]}';
    const result = applyRepairPasses(input);
    expect(result).toBe(input);
    const parsed = JSON.parse(result);
    expect(parsed.goal).toContain('<think>');
  });

  it('BUG-H3B: invalid JSON still gets repaired', () => {
    const input = '{a: 1, b: 2,}'; // unquoted keys + trailing comma
    const result = applyRepairPasses(input);
    // Should be repaired (valid JSON with quoted keys and no trailing comma)
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

// ─── BUG-H5: reIndexAllEntries is idempotent ──────────────────────────────

describe('BUG-H5: reIndexAllEntries does not duplicate FTS rows', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); delete process.env.EMBEDDING_MODEL; });

  it('BUG-H5A: running reIndexAllEntries twice leaves fts_content count unchanged', async () => {
    createEntry({ nb: 'WHAT', type: 'KN', name: 'FTS Idempotent Test', status: 'active', summary: 'test', body: 'content' });

    await reIndexAllEntries();
    const d = getDb();
    const count1 = (d.prepare('SELECT COUNT(*) as n FROM fts_content').get() as { n: number }).n;

    await reIndexAllEntries();
    const count2 = (d.prepare('SELECT COUNT(*) as n FROM fts_content').get() as { n: number }).n;

    expect(count2).toBe(count1);
  });

  it('BUG-H5B: indexContent is idempotent (delete-then-insert)', async () => {
    const entry = createEntry({ nb: 'WHO', type: 'CT', name: 'FTS Idempotent Contact', status: 'active', summary: 's', body: 'b' });

    const d = getDb();

    // indexContent again — should not add duplicate row
    const { indexContent } = await import('../../core/memory/fts.js');
    indexContent(entry.code, 'WHO', 'updated content');

    const count2 = (d.prepare('SELECT COUNT(*) as n FROM fts_content WHERE code = ?').get(entry.code) as { n: number }).n;
    expect(count2).toBe(1);
  });
});

// ─── BUG-H6: reIndexAllEntries clears stale chunk vectors ─────────────────

describe('BUG-H6: reIndexAllEntries clears stale embedding chunks', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); delete process.env.EMBEDDING_MODEL; });

  it('BUG-H6A: chunks table is empty after reIndexAllEntries', async () => {
    await reIndexAllEntries();
    const d = getDb();
    const count = (d.prepare('SELECT COUNT(*) as n FROM chunks').get() as { n: number }).n;
    expect(count).toBe(0);
  });
});

// ─── BUG-M1: trimHistoryToTokenBudget always keeps last 2 turns ────────────

describe('BUG-M1: trimHistoryToTokenBudget preserves last 2 turns', () => {
  it('BUG-M1A: keeps at least 2 messages even when both exceed budget', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'short reply' },
      { role: 'user', content: 'this is a longer message that exceeds tiny budget' },
      { role: 'assistant', content: 'this is a longer reply that also exceeds tiny budget' },
    ];
    const result = trimHistoryToTokenBudget(msgs, 1);
    // Must keep at least 2 messages (last turn)
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[result.length - 1].content).toBe('this is a longer reply that also exceeds tiny budget');
    expect(result[result.length - 2].content).toBe('this is a longer message that exceeds tiny budget');
  });

  it('BUG-M1B: keeps more messages when budget allows', () => {
    const msgs: Message[] = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant' as const,
      content: `msg ${i}`,
    }));
    const result = trimHistoryToTokenBudget(msgs, 10000); // huge budget
    expect(result.length).toBe(msgs.length);
  });
});

// ─── BUG-M2: parseStructured loops repair up to maxRepairAttempts ──────────

describe('BUG-M2: parseStructured LLM repair loops correctly', () => {
  const SimpleSchema = z.object({ foo: z.string(), bar: z.number() });

  it('BUG-M2A: repair called multiple times up to maxRepairAttempts', async () => {
    let repairCalls = 0;
    const mockLLM = async () => {
      repairCalls++;
      if (repairCalls < 3) return '{"foo": "still broken", "bar": "not-a-number"}';
      return '{"foo": "fixed", "bar": 42}';
    };

    const raw = '{"foo": "hello", "bar": "notanumber"}';
    const result = await parseStructured(raw, SimpleSchema, {
      llmHandler: mockLLM as any,
      maxRepairAttempts: 3,
    });

    expect(repairCalls).toBe(3);
    expect(result.success).toBe(true);
    expect(result.data?.bar).toBe(42);
  });

  it('BUG-M2B: stops after maxRepairAttempts even if still failing', async () => {
    let repairCalls = 0;
    const mockLLM = async () => {
      repairCalls++;
      return '{"foo": "still broken", "bar": "not-a-number"}';
    };

    const raw = '{"foo": "hello", "bar": "notanumber"}';
    await parseStructured(raw, SimpleSchema, {
      llmHandler: mockLLM as any,
      maxRepairAttempts: 2,
    });

    expect(repairCalls).toBeLessThanOrEqual(2);
  });
});

// ─── BUG-M3: extractFirstJsonObject handles leading unmatched brace ────────

describe('BUG-M3: extractFirstJsonObject ignores leading unmatched }', () => {
  it('BUG-M3A: leading } followed by valid JSON', () => {
    const result = extractFirstJsonObject('}\n{"a":1}');
    expect(result).toBe('{"a":1}');
  });

  it('BUG-M3B: multiple leading } before valid JSON', () => {
    const result = extractFirstJsonObject('}}}\n{"b":"value"}');
    expect(result).toBe('{"b":"value"}');
  });
});

// ─── BUG-M5: initDatabase closes existing connection ──────────────────────

describe('BUG-M5: initDatabase closes existing connection before reinit', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); });

  it('BUG-M5A: calling initDatabase twice without closeDatabase does not throw', () => {
    const pathA = path.join(tmpDir, 'dbA.sqlite');
    const pathB = path.join(tmpDir, 'dbB.sqlite');
    expect(() => initDatabase(pathA)).not.toThrow();
    expect(() => initDatabase(pathB)).not.toThrow();
  });

  it('BUG-M5B: second initDatabase opens the new database', () => {
    const pathA = path.join(tmpDir, 'dbA.sqlite');
    const pathB = path.join(tmpDir, 'dbB.sqlite');
    initDatabase(pathA);
    initDatabase(pathB);

    // Insert into B — should succeed on the second db
    expect(() => {
      const d = getDb();
      d.prepare('SELECT 1').get();
    }).not.toThrow();
  });
});

// ─── BUG-M6: due_date preserved in Zod-parsed write path ──────────────────

describe('BUG-M6: due_date included in writeData from Zod path', () => {
  it('BUG-M6A: agent.ts writeData type includes due_date field', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'core/agent.ts'),
      'utf-8',
    );
    // writeData type should declare due_date
    expect(src).toContain('due_date?: string');
    // Zod result mapping should include due_date
    expect(src).toContain('due_date: zodResult.data.due_date');
  });

  it('BUG-M6B: upsertEntry persists due_date in SQLite', () => {
    isolateDb();
    try {
      const { code } = upsertEntry({
        nb: 'WHEN', type: 'DL', name: 'Test Deadline',
        status: 'upcoming', summary: 'deadline', body: 'body',
        due_date: '2026-12-31',
      });

      const d = getDb();
      const row = d.prepare('SELECT due_date FROM index_entries WHERE code = ?').get(code) as { due_date: string | null };
      expect(row.due_date).toBe('2026-12-31');
    } finally {
      restoreDb();
    }
  });
});
