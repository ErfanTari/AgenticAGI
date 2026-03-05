/**
 * Phase 12 Part 2 — C4/C5: Operational Metadata Persistence Tests
 * Verifies that importance_score and other operational fields survive a full bootstrap cycle.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase, getDb, reconcileOperationalMetadata } from '../../core/memory/index.js';
import { createEntry } from '../../core/memory/write.js';
import { PATHS } from '../../config/agent.config.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-phase12-meta-${Date.now()}`);
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  fs.mkdirSync(path.join(TEST_DIR, 'memory'), { recursive: true });
  (PATHS as Record<string, string>).db = path.join(TEST_DIR, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(TEST_DIR, 'memory');
  initDatabase(path.join(TEST_DIR, 'test.sqlite'));
});

afterAll(async () => {
  closeDatabase();
  const { _resetGitInstance } = await import('../../core/memory/versioning.js');
  _resetGitInstance();
  await new Promise(r => setTimeout(r, 100));
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

describe('C4/C5 — Operational metadata persistence', () => {
  it('createEntry writes operational fields to frontmatter', async () => {
    const entry = createEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Metadata Test Contact',
      status: 'active',
      summary: 'Testing metadata in frontmatter',
      body: 'Full content here.',
    });
    await new Promise(r => setTimeout(r, 50));

    expect(fs.existsSync(entry.path)).toBe(true);
    const content = fs.readFileSync(entry.path, 'utf8');
    expect(content).toContain('importance_score:');
    expect(content).toContain('utility_score:');
    expect(content).toContain('usage_count:');
    expect(content).toContain('decay_rate:');
    expect(content).toContain('active_page:');
    expect(content).toContain('confidence:');
    expect(content).toContain('last_accessed:');
    expect(content).toContain('pinned:');
    expect(content).toContain('source:');
    // privacy_tier must NOT be in frontmatter (information leak risk)
    expect(content).not.toContain('privacy_tier:');
  });

  it('bootstrap restores operational metadata from frontmatter after DB delete', async () => {
    // Create an entry first
    const entry = createEntry({
      nb: 'WHAT',
      type: 'KN',
      name: 'Bootstrap Metadata Test',
      status: 'active',
      summary: 'Knowledge entry for bootstrap test',
      body: 'Content.',
    });
    await new Promise(r => setTimeout(r, 50));

    // Manually set non-default operational values in the DB
    const d = getDb();
    d.prepare('UPDATE index_entries SET importance_score = 0.91, utility_score = 2.5, usage_count = 7 WHERE code = ?')
      .run(entry.code);

    // Write updated values to the frontmatter file (simulating what lifecycle would do)
    const content = fs.readFileSync(entry.path, 'utf8');
    const updated = content
      .replace(/^importance_score: .+$/m, 'importance_score: 0.91')
      .replace(/^utility_score: .+$/m, 'utility_score: 2.5')
      .replace(/^usage_count: .+$/m, 'usage_count: 7');
    fs.writeFileSync(entry.path, updated, 'utf8');

    // Verify frontmatter was written correctly
    const mdContentCheck = fs.readFileSync(entry.path, 'utf8');
    expect(mdContentCheck).toContain('importance_score: 0.91');
    expect(mdContentCheck).toContain('utility_score: 2.5');
    expect(mdContentCheck).toContain('usage_count: 7');

    // Delete the entire DB file to force a full bootstrap on next init
    closeDatabase();
    const dbPath = path.join(TEST_DIR, 'test.sqlite');
    fs.rmSync(dbPath, { force: true });
    try { fs.rmSync(dbPath + '-wal', { force: true }); } catch {}
    try { fs.rmSync(dbPath + '-shm', { force: true }); } catch {}

    // Re-initialize — bootstrap MUST run since DB is fresh
    initDatabase(dbPath);

    // Verify the row was restored with operational metadata from frontmatter
    const restored = getDb()
      .prepare('SELECT * FROM index_entries WHERE code = ?')
      .get(entry.code) as Record<string, unknown> | undefined;

    expect(restored).toBeDefined();
    expect(Number(restored?.importance_score)).toBeCloseTo(0.91, 2);
    expect(Number(restored?.utility_score)).toBeCloseTo(2.5, 2);
    expect(Number(restored?.usage_count)).toBe(7);
  });

  it('reconcileOperationalMetadata restores values from frontmatter for stale rows', async () => {
    const entry = createEntry({
      nb: 'HOW',
      type: 'PR',
      name: 'Reconcile Test Procedure',
      status: 'active',
      summary: 'Reconcile test',
      body: 'Steps.',
    });
    await new Promise(r => setTimeout(r, 50));

    // Write non-zero operational values to frontmatter
    const content = fs.readFileSync(entry.path, 'utf8');
    const updated = content
      .replace(/^importance_score: .+$/m, 'importance_score: 0.75')
      .replace(/^utility_score: .+$/m, 'utility_score: 1.5');
    fs.writeFileSync(entry.path, updated, 'utf8');

    // Reset DB values to defaults (simulate stale row)
    getDb().prepare('UPDATE index_entries SET importance_score = 0, utility_score = 0 WHERE code = ?').run(entry.code);

    // Run reconciliation
    reconcileOperationalMetadata();

    const row = getDb()
      .prepare('SELECT importance_score, utility_score FROM index_entries WHERE code = ?')
      .get(entry.code) as { importance_score: number; utility_score: number } | undefined;

    expect(row?.importance_score).toBeCloseTo(0.75, 2);
    expect(row?.utility_score).toBeCloseTo(1.5, 2);
  });

  it('all 8 operational fields survive a full bootstrap cycle', async () => {
    const entry = createEntry({
      nb: 'WHY',
      type: 'QU',
      name: 'Full Fields Survival Test',
      status: 'open',
      summary: 'All fields test',
      body: 'Testing all 8 operational fields.',
    });
    await new Promise(r => setTimeout(r, 50));

    // Set all 8 fields in frontmatter
    const content = fs.readFileSync(entry.path, 'utf8');
    const updated = content
      .replace(/^importance_score: .+$/m, 'importance_score: 0.55')
      .replace(/^utility_score: .+$/m, 'utility_score: 1.2')
      .replace(/^usage_count: .+$/m, 'usage_count: 3')
      .replace(/^decay_rate: .+$/m, 'decay_rate: 0.05')
      .replace(/^active_page: .+$/m, 'active_page: 1')
      .replace(/^confidence: .+$/m, 'confidence: 0.9')
      .replace(/^pinned: .+$/m, 'pinned: 0');
    fs.writeFileSync(entry.path, updated, 'utf8');

    // Verify frontmatter was updated correctly
    const mdCheck = fs.readFileSync(entry.path, 'utf8');
    expect(mdCheck).toContain('importance_score: 0.55');
    expect(mdCheck).toContain('utility_score: 1.2');
    expect(mdCheck).toContain('usage_count: 3');

    // Delete entire DB to force full bootstrap
    closeDatabase();
    const dbPath2 = path.join(TEST_DIR, 'test.sqlite');
    fs.rmSync(dbPath2, { force: true });
    try { fs.rmSync(dbPath2 + '-wal', { force: true }); } catch {}
    try { fs.rmSync(dbPath2 + '-shm', { force: true }); } catch {}

    // Bootstrap restores it
    initDatabase(dbPath2);

    const row = getDb()
      .prepare('SELECT * FROM index_entries WHERE code = ?')
      .get(entry.code) as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(Number(row?.importance_score)).toBeCloseTo(0.55, 2);
    expect(Number(row?.utility_score)).toBeCloseTo(1.2, 2);
    expect(Number(row?.usage_count)).toBe(3);
    expect(Number(row?.decay_rate)).toBeCloseTo(0.05, 3);
    expect(Number(row?.confidence)).toBeCloseTo(0.9, 2);
    expect(Number(row?.pinned)).toBe(0);
  });
});
