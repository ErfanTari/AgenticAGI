import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { _resetGitInstance } from '../../core/memory/versioning.js';

const mockLLM = async () => '{"facts": ["fact1", "fact2"], "confidence": 0.9}';

describe('Phase 11 P4: Memory Lifecycle', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-lifecycle-'));
    origDb = PATHS.db;
    origMemory = PATHS.memory;
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
    (PATHS as Record<string, string>).logs = path.join(tmpDir, 'workspace', 'logs');
    (PATHS as Record<string, string>).projects = path.join(tmpDir, 'workspace', 'projects');
    fs.mkdirSync(PATHS.memory, { recursive: true });
  });

  afterEach(async () => {
    (PATHS as Record<string, string>).db = origDb;
    (PATHS as Record<string, string>).memory = origMemory;
    _resetGitInstance();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P4A: NOTEBOOK_DECAY_RATES has all 7 notebooks', async () => {
    const { NOTEBOOK_DECAY_RATES } = await import('../../core/memory/lifecycle.js');
    const notebooks = ['NOW', 'WHEN', 'WHAT', 'WHO', 'WHY', 'HOW', 'PLAN'];
    for (const nb of notebooks) {
      expect(NOTEBOOK_DECAY_RATES).toHaveProperty(nb);
    }
  });

  it('P4B: NOW has highest decay rate', async () => {
    const { NOTEBOOK_DECAY_RATES } = await import('../../core/memory/lifecycle.js');
    expect(NOTEBOOK_DECAY_RATES['NOW']).toBeGreaterThan(NOTEBOOK_DECAY_RATES['WHY']!);
  });

  it('P4C: computeDecayScore returns 0..1+ for fresh entry', async () => {
    const { computeDecayScore } = await import('../../core/memory/lifecycle.js');
    const entry = {
      code: 'NOW.TD-000001',
      nb: 'NOW',
      importance_score: 0.8,
      utility_score: 1.0,
      usage_count: 5,
      updated: new Date().toISOString().slice(0, 10),
      decay_rate: 0.3,
      active_page: 1,
      pinned: 0,
    };
    const score = computeDecayScore(entry, new Date());
    expect(score).toBeGreaterThan(0);
  });

  it('P4D: computeDecayScore is lower for old entries', async () => {
    const { computeDecayScore } = await import('../../core/memory/lifecycle.js');
    const now = new Date();
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

    const freshEntry = { code: 'A', nb: 'NOW', importance_score: 0.8, utility_score: 1.0, usage_count: 0, updated: now.toISOString().slice(0, 10), decay_rate: 0.3, active_page: 1, pinned: 0 };
    const oldEntry = { code: 'B', nb: 'NOW', importance_score: 0.8, utility_score: 1.0, usage_count: 0, updated: old.toISOString().slice(0, 10), decay_rate: 0.3, active_page: 1, pinned: 0 };

    const freshScore = computeDecayScore(freshEntry, now);
    const oldScore = computeDecayScore(oldEntry, now);
    expect(freshScore).toBeGreaterThan(oldScore);
  });

  it('P4E: runDecayCycle runs without throwing', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { runDecayCycle } = await import('../../core/memory/lifecycle.js');
    expect(() => runDecayCycle()).not.toThrow();
  });

  it('P4F: updateUtilityScore increases usage_count', async () => {
    const { initDatabase, getDb } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createEntry } = await import('../../core/memory/write.js');
    const { updateUtilityScore } = await import('../../core/memory/lifecycle.js');

    const entry = createEntry({
      nb: 'WHAT', type: 'KN', name: 'Test Entry',
      status: 'active', summary: 'test', body: 'body',
    });

    updateUtilityScore(entry.code, 0.5);

    const db = getDb();
    const row = db.prepare('SELECT usage_count, utility_score FROM index_entries WHERE code = ?').get(entry.code) as { usage_count: number; utility_score: number };
    expect(row.usage_count).toBe(1);
    expect(row.utility_score).toBeCloseTo(1.5, 1);
  });

  it('P4G: updateUtilityScore clamps to max 10.0', async () => {
    const { initDatabase, getDb } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createEntry } = await import('../../core/memory/write.js');
    const { updateUtilityScore } = await import('../../core/memory/lifecycle.js');

    const entry = createEntry({
      nb: 'WHAT', type: 'KN', name: 'MaxScore',
      status: 'active', summary: 'test', body: 'body',
    });

    updateUtilityScore(entry.code, 100); // way above max
    const db = getDb();
    const row = db.prepare('SELECT utility_score FROM index_entries WHERE code = ?').get(entry.code) as { utility_score: number };
    expect(row.utility_score).toBeLessThanOrEqual(10.0);
  });

  it('P4H: updateUtilityScore clamps to min 0.1', async () => {
    const { initDatabase, getDb } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createEntry } = await import('../../core/memory/write.js');
    const { updateUtilityScore } = await import('../../core/memory/lifecycle.js');

    const entry = createEntry({
      nb: 'WHAT', type: 'KN', name: 'MinScore',
      status: 'active', summary: 'test', body: 'body',
    });

    updateUtilityScore(entry.code, -100); // way below min
    const db = getDb();
    const row = db.prepare('SELECT utility_score FROM index_entries WHERE code = ?').get(entry.code) as { utility_score: number };
    expect(row.utility_score).toBeGreaterThanOrEqual(0.1);
  });

  it('P4I: updateUtilityScore sets last_accessed timestamp', async () => {
    const { initDatabase, getDb } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createEntry } = await import('../../core/memory/write.js');
    const { updateUtilityScore } = await import('../../core/memory/lifecycle.js');

    const entry = createEntry({
      nb: 'WHAT', type: 'KN', name: 'Accessed',
      status: 'active', summary: 'test', body: 'body',
    });

    updateUtilityScore(entry.code, 0.1);
    const db = getDb();
    const row = db.prepare('SELECT last_accessed FROM index_entries WHERE code = ?').get(entry.code) as { last_accessed: string };
    expect(row.last_accessed).toBeTruthy();
  });

  it('P4J: extractMemoryMetadata does not throw', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createEntry } = await import('../../core/memory/write.js');
    const { extractMemoryMetadata } = await import('../../core/memory/lifecycle.js');

    const entry = createEntry({
      nb: 'WHAT', type: 'KN', name: 'Metadata Test',
      status: 'active', summary: 'test entry', body: 'This entry is about testing.',
    });

    await expect(extractMemoryMetadata(entry.code, 'This entry is about testing.', 'test entry', mockLLM as any)).resolves.toBeUndefined();
  });

  it('P4K: resolveConflict returns APPEND_NEW for low similarity', async () => {
    const { resolveConflict } = await import('../../core/memory/lifecycle.js');
    const result = await resolveConflict(
      { name: 'Alpha Beta', body: 'content A', summary: 'summary A' },
      { name: 'Totally Different', body: 'content B', summary: 'summary B' },
      async () => 'MERGE_FACTS',
    );
    expect(result).toBe('APPEND_NEW');
  });

  it('P4L: resolveConflict calls LLM for high similarity', async () => {
    const { resolveConflict } = await import('../../core/memory/lifecycle.js');
    let called = false;
    const llm = async () => { called = true; return 'SUPERSEDE_OLD'; };

    await resolveConflict(
      { name: 'Project Alpha', body: 'content A', summary: 'summary A' },
      { name: 'Project Alpha Updated', body: 'content B', summary: 'summary B' },
      llm as any,
    );
    expect(called).toBe(true);
  });

  it('P4M: Phase 11 DB columns exist after initDatabase', async () => {
    const { initDatabase, getDb } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const db = getDb();
    const row = db.prepare('PRAGMA table_info(index_entries)').all() as Array<{ name: string }>;
    const columns = row.map(r => r.name);
    expect(columns).toContain('importance_score');
    expect(columns).toContain('utility_score');
    expect(columns).toContain('usage_count');
    expect(columns).toContain('last_accessed');
    expect(columns).toContain('active_page');
    expect(columns).toContain('pinned');
  });

  it('P4N: runDecayCycle marks low-score entries as inactive page', async () => {
    const { initDatabase, getDb } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createEntry } = await import('../../core/memory/write.js');

    // Create an entry and manually set it to very old
    const entry = createEntry({
      nb: 'NOW', type: 'TD', name: 'Old Todo',
      status: 'active', summary: 'old task', body: 'details',
    });

    const db = getDb();
    db.prepare("UPDATE index_entries SET updated = '2020-01-01', importance_score = 0.001 WHERE code = ?").run(entry.code);

    const { runDecayCycle } = await import('../../core/memory/lifecycle.js');
    runDecayCycle();

    const row = db.prepare('SELECT active_page FROM index_entries WHERE code = ?').get(entry.code) as { active_page: number };
    expect(row.active_page).toBe(0);
  });

  it('P4O: updateUtilityScore is no-op for missing code', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { updateUtilityScore } = await import('../../core/memory/lifecycle.js');

    // Should not throw for non-existent code
    expect(() => updateUtilityScore('WHAT.KN-999999', 0.5)).not.toThrow();
  });
});
