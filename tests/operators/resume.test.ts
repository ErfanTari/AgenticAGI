/**
 * Tests for /resume operator
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findResumablePlans,
  selectResumablePlan,
  formatResumePrompt,
  type ResumablePlan,
  type ResumeResult,
} from '../../core/operators/resume.js';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase, savePendingPlan, loadPendingPlan, clearPendingPlan } from '../../core/memory/mod.js';
import { getDb } from '../../core/memory/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(__dirname, `tmp-resume-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'index'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });

  // Override PATHS for this test
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'index', 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
  (PATHS as Record<string, string>).index = path.join(tmpDir, 'index');

  // Initialize database for tests
  initDatabase();
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('Resume operator', () => {

  it('T1: findResumablePlans returns array', () => {
    const plans = findResumablePlans();
    expect(Array.isArray(plans)).toBe(true);
  });

  it('T2: empty database returns empty array', () => {
    const plans = findResumablePlans();
    expect(plans.length).toBe(0);
  });

  it('T3: adds plan to database and finds it', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PLAN.EX-000001',
      'PLAN',
      'EX',
      'Build API',
      'in_progress',
      new Date().toISOString().split('T')[0],
      'Step 1: Create database schema',
      '/tmp/plan.md'
    );

    const plans = findResumablePlans();
    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0].code).toBe('PLAN.EX-000001');
    expect(plans[0].name).toBe('Build API');
    expect(plans[0].status).toBe('in_progress');
  });

  it('T4: selectResumablePlan returns not found when empty', () => {
    const result = selectResumablePlan();
    expect(result.found).toBe(false);
    expect(result.count).toBe(0);
    expect(result.error).toBeDefined();
  });

  it('T5: selectResumablePlan returns most recent plan', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PLAN.EX-000001',
      'PLAN',
      'EX',
      'Old Plan',
      'paused',
      '2026-03-01',
      'Summary 1',
      '/tmp/old.md'
    );
    db.prepare(
      `INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PLAN.EX-000002',
      'PLAN',
      'EX',
      'New Plan',
      'in_progress',
      '2026-04-08',
      'Summary 2',
      '/tmp/new.md'
    );

    const result = selectResumablePlan();
    expect(result.found).toBe(true);
    expect(result.plan?.code).toBe('PLAN.EX-000002');
    expect(result.count).toBe(2);
  });

  it('T6: selectResumablePlan finds plan by code', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PLAN.EX-000099',
      'PLAN',
      'EX',
      'Target Plan',
      'paused',
      '2026-04-08',
      'Summary 99',
      '/tmp/target.md'
    );

    const result = selectResumablePlan('PLAN.EX-000099');
    expect(result.found).toBe(true);
    expect(result.plan?.code).toBe('PLAN.EX-000099');
  });

  it('T7: selectResumablePlan finds plan by name substring', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PLAN.EX-000050',
      'PLAN',
      'EX',
      'Website Redesign Project',
      'in_progress',
      '2026-04-08',
      'Redesign summary',
      '/tmp/website.md'
    );

    const result = selectResumablePlan('Redesign');
    expect(result.found).toBe(true);
    expect(result.plan?.name).toContain('Redesign');
  });

  it('T8: selectResumablePlan returns error for not found', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PLAN.EX-000001',
      'PLAN',
      'EX',
      'Test Plan',
      'active',
      '2026-04-08',
      'Summary',
      '/tmp/test.md'
    );

    const result = selectResumablePlan('NonExistent');
    expect(result.found).toBe(false);
    expect(result.error).toContain('No plan matching');
  });

  it('T9: formatResumePrompt shows plan details', () => {
    const result: ResumeResult = {
      found: true,
      plan: {
        code: 'PLAN.EX-000001',
        name: 'Build API',
        status: 'paused',
        next_action: 'Set up database',
        abort_reason: 'Waiting for approval',
      },
      count: 1,
    };

    const formatted = formatResumePrompt(result);
    expect(formatted).toContain('Resume Execution Plan');
    expect(formatted).toContain('PLAN.EX-000001');
    expect(formatted).toContain('Build API');
    expect(formatted).toContain('paused');
    expect(formatted).toContain('Set up database');
    expect(formatted).toContain('Waiting for approval');
  });

  it('T10: formatResumePrompt handles not found', () => {
    const result: ResumeResult = {
      found: false,
      count: 0,
      error: 'No plans found',
    };

    const formatted = formatResumePrompt(result);
    expect(formatted).toContain('No plans found');
  });

  it('T11: skips completed/failed plans', () => {
    const db = getDb();
    // Insert a completed plan
    db.prepare(
      `INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PLAN.EX-000001',
      'PLAN',
      'EX',
      'Completed Plan',
      'complete',
      '2026-04-08',
      'Done',
      '/tmp/done.md'
    );
    // Insert a failed plan
    db.prepare(
      `INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PLAN.EX-000002',
      'PLAN',
      'EX',
      'Failed Plan',
      'failed',
      '2026-04-08',
      'Failed',
      '/tmp/failed.md'
    );
    // Insert an active plan
    db.prepare(
      `INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PLAN.EX-000003',
      'PLAN',
      'EX',
      'Active Plan',
      'active',
      '2026-04-08',
      'In progress',
      '/tmp/active.md'
    );

    const plans = findResumablePlans();
    // Should only find the active plan, not completed or failed
    expect(plans.length).toBe(1);
    expect(plans[0].code).toBe('PLAN.EX-000003');
  });

  // Task B — Pending Plans Persistence
  it('T12: savePendingPlan persists to SQLite', () => {
    const mockPlan = { goal: 'Build API', steps: [{ title: 'Step 1' }] };
    savePendingPlan(mockPlan);

    const loaded = loadPendingPlan();
    expect(loaded).toBeDefined();
    expect((loaded as any).goal).toBe('Build API');
  });

  it('T13: loadPendingPlan returns null when empty', () => {
    clearPendingPlan();
    const loaded = loadPendingPlan();
    expect(loaded).toBeNull();
  });

  it('T14: clearPendingPlan removes from SQLite', () => {
    const mockPlan = { goal: 'Test', steps: [] };
    savePendingPlan(mockPlan);
    expect(loadPendingPlan()).toBeDefined();

    clearPendingPlan();
    expect(loadPendingPlan()).toBeNull();
  });

  it('T15: pending plan survives and is restored', () => {
    const mockPlan = { goal: 'Persist test', steps: [{ title: 'S1' }, { title: 'S2' }] };
    savePendingPlan(mockPlan);

    // Simulate clearing module state and reloading
    const restored = loadPendingPlan();
    expect(restored).toBeDefined();
    expect((restored as any).goal).toBe('Persist test');
    expect((restored as any).steps.length).toBe(2);
  });

  it('T16: /resume prioritizes pending confirmation', () => {
    const mockPlan = { goal: 'Pending', steps: [] };
    savePendingPlan(mockPlan);

    // Also add a PLAN.EX entry
    const db = getDb();
    db.prepare(
      `INSERT INTO index_entries (code, nb, type, name, status, updated, summary, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PLAN.EX-000099',
      'PLAN',
      'EX',
      'Resume Test',
      'active',
      '2026-04-08',
      'Summary',
      '/tmp/test.md'
    );

    const result = selectResumablePlan();
    expect(result.found).toBe(true);
    expect(result.plan?.code).toBe('PENDING');
    expect(result.plan?.status).toBe('paused');
  });

});
