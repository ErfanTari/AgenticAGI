import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';
import { createProjectEntry, getProjectBrain, invalidateProjectBrain } from '../../core/memory/project.js';

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrain-test-'));
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'memory', 'PLAN', 'planning'), { recursive: true });
  (PATHS as Record<string, string>).projects = path.join(tmpDir, 'memory', 'PLAN', 'planning');
  initDatabase(path.join(tmpDir, 'test.sqlite'));
});

afterEach(() => {
  closeDatabase();
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Phase 15: Project Brain', () => {
  it('getProjectBrain returns a string for a known project', async () => {
    const db = initDatabase(PATHS.db);

    const entry = createProjectEntry({
      name: 'Alpha Project',
      priority: 1,
      vision: 'Build the best agent',
      status: 'active',
      current: 'Phase 1 implementation',
      next_action: 'Write tests',
      blocked_by: [],
      phase: 'Phase 1',
      last_worked: '2026-03-15',
      notes: 'On track',
    });

    const brain = await getProjectBrain(entry.code, db);
    expect(brain).toBeTruthy();
    expect(brain).toContain('Alpha Project');
  });

  it('getProjectBrain returns "not found" for unknown code', async () => {
    const db = initDatabase(PATHS.db);
    const brain = await getProjectBrain('PLAN.PJ-999999', db);
    expect(brain).toContain('not found');
  });

  it('getProjectBrain caches the result on second call', async () => {
    const db = initDatabase(PATHS.db);

    const entry = createProjectEntry({
      name: 'Beta Project',
      priority: 2,
      vision: 'Fast agent',
      status: 'active',
      current: 'Setup',
      next_action: 'Next step',
      blocked_by: [],
      phase: 'Phase 0',
      last_worked: '2026-03-15',
      notes: '',
    });

    const brain1 = await getProjectBrain(entry.code, db);
    const brain2 = await getProjectBrain(entry.code, db);
    expect(brain1).toBe(brain2); // same content from cache
  });

  it('invalidateProjectBrain clears the cache', async () => {
    const db = initDatabase(PATHS.db);

    const entry = createProjectEntry({
      name: 'Gamma Project',
      priority: 3,
      vision: 'Smart agent',
      status: 'active',
      current: 'Working',
      next_action: 'Continue',
      blocked_by: [],
      phase: 'Phase 1',
      last_worked: '2026-03-15',
      notes: '',
    });

    // Cache it
    await getProjectBrain(entry.code, db);

    // Verify it's cached
    const row = db.prepare(
      'SELECT project_brain_cache FROM index_entries WHERE code = ?'
    ).get(entry.code) as { project_brain_cache: string | null } | undefined;

    // Invalidate
    invalidateProjectBrain(entry.code, db);

    const rowAfter = db.prepare(
      'SELECT project_brain_cache FROM index_entries WHERE code = ?'
    ).get(entry.code) as { project_brain_cache: string | null } | undefined;

    expect(rowAfter?.project_brain_cache).toBeNull();
  });

  it('getProjectBrain output fits within ~6000 characters', async () => {
    const db = initDatabase(PATHS.db);

    const entry = createProjectEntry({
      name: 'Large Project',
      priority: 1,
      vision: 'X'.repeat(2000),
      status: 'active',
      current: 'Y'.repeat(2000),
      next_action: 'Z'.repeat(1000),
      blocked_by: [],
      phase: 'Phase 99',
      last_worked: '2026-03-15',
      notes: 'N'.repeat(500),
    });

    const brain = await getProjectBrain(entry.code, db);
    expect(brain.length).toBeLessThanOrEqual(6500); // 1500 tokens ≈ 6000 chars
  });
});
