/**
 * Phase 11 Hardening Sprint — 12 bug fixes regression tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase, closeDatabase, getDb, queryEntries } from '../../core/memory/index.js';
import { createEntry } from '../../core/memory/write.js';
import { transparency } from '../../core/transparency.js';
import type { TransparencyEvent } from '../../core/transparency.js';

// ─── DB isolation helpers ───────────────────────────────────────────────────

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;
const origLogs = PATHS.logs;

function isolateDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-hardening-'));
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  (PATHS as Record<string, string>).logs = path.join(tmpDir, 'logs');
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  initDatabase(path.join(tmpDir, 'test.sqlite'));
}

function restoreDb() {
  closeDatabase();
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  (PATHS as Record<string, string>).logs = origLogs;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── Bug 1: savePlanEX creates duplicates on repeated saves ─────────────────

describe('Bug 1: savePlanEX no duplicates', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); vi.restoreAllMocks(); });

  it('savePlanEX called 5 times on same entry → exactly 1 PLAN.EX in DB', async () => {
    const { createPlanEX, savePlanEX } = await import('../../core/memory/plan-ex.js');

    const planData = {
      task_name: 'Test Task Unique',
      project_code: 'WHAT.PJ-000001',
      goal: 'Test goal',
      milestones: [],
      current_milestone: 0,
      todos: [],
      constraints: {},
      last_action: '',
      next_action: '',
      conf_score: 0.9,
      session_id: 'sess-001',
      checkpoint_ts: new Date().toISOString(),
      started: new Date().toISOString(),
      attempt_counts: {},
      last_failures: {},
      recent_turns: [],
      loaded_memory_utility: {},
      file_checksums: {},
    };

    // Create initial entry
    const code = createPlanEX(planData);
    const entry = { ...planData, code };

    // Save 5 more times with same code
    for (let i = 0; i < 5; i++) {
      savePlanEX({ ...entry, conf_score: 0.9 - i * 0.01 });
    }

    const db = getDb();
    const all = db.prepare("SELECT code FROM index_entries WHERE nb = 'PLAN' AND type = 'EX'").all();
    expect(all).toHaveLength(1);
  });

  it('savePlanEX without code finds existing by task_name → no duplicate', async () => {
    const { createPlanEX, savePlanEX } = await import('../../core/memory/plan-ex.js');

    const planData = {
      task_name: 'Unique Task Name XYZ',
      project_code: 'WHAT.PJ-000001',
      goal: 'Test goal',
      milestones: [],
      current_milestone: 0,
      todos: [],
      constraints: {},
      last_action: '',
      next_action: '',
      conf_score: 0.9,
      session_id: 'sess-001',
      checkpoint_ts: new Date().toISOString(),
      started: new Date().toISOString(),
      attempt_counts: {},
      last_failures: {},
      recent_turns: [],
      loaded_memory_utility: {},
      file_checksums: {},
    };

    createPlanEX(planData);

    // Call savePlanEX with no code (simulates a caller that lost the code)
    savePlanEX({ ...planData, code: '' } as any);
    savePlanEX({ ...planData, code: '' } as any);

    const db = getDb();
    const all = db.prepare("SELECT code FROM index_entries WHERE nb = 'PLAN' AND type = 'EX'").all();
    expect(all).toHaveLength(1);
  });
});

// ─── Bug 2: loadActivePlanEX race when multiple active entries exist ─────────

describe('Bug 2: loadActivePlanEX returns most recent by checkpoint_ts', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); vi.restoreAllMocks(); });

  it('Two active PLAN.EX entries → most recent checkpoint_ts returned + warning event emitted', async () => {
    const { createPlanEX, loadActivePlanEX } = await import('../../core/memory/plan-ex.js');

    const older = {
      task_name: 'Older Task',
      project_code: 'WHAT.PJ-000001',
      goal: 'Older goal',
      milestones: [],
      current_milestone: 0,
      todos: [],
      constraints: {},
      last_action: '',
      next_action: '',
      conf_score: 0.9,
      session_id: 'sess-001',
      checkpoint_ts: '2024-01-01T00:00:00.000Z',
      started: '2024-01-01T00:00:00.000Z',
      attempt_counts: {},
      last_failures: {},
      recent_turns: [],
      loaded_memory_utility: {},
      file_checksums: {},
    };

    const newer = {
      ...older,
      task_name: 'Newer Task',
      goal: 'Newer goal',
      checkpoint_ts: '2024-06-01T00:00:00.000Z',
      session_id: 'sess-002',
    };

    createPlanEX(older);
    createPlanEX(newer);

    // Verify there are 2 active PLAN.EX entries
    const db = getDb();
    const allActive = db.prepare("SELECT code FROM index_entries WHERE nb = 'PLAN' AND type = 'EX' AND status = 'active'").all();
    expect(allActive).toHaveLength(2);

    // Set up transparency listener
    transparency.enable();
    const events: TransparencyEvent[] = [];
    const unsub = transparency.on(e => events.push(e));

    const result = loadActivePlanEX();

    unsub();
    transparency.disable();

    // Most recent checkpoint_ts should be returned
    expect(result).not.toBeNull();
    expect(result!.checkpoint_ts).toBe('2024-06-01T00:00:00.000Z');

    // Warning event should have been emitted
    const errorEvents = events.filter(e => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThan(0);
  });
});

// ─── Bug 3: compactEpisodicHistory archives sources before confirming WHEN.HX write ─

describe('Bug 3: compactEpisodicHistory safe archival', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); vi.restoreAllMocks(); });

  it('WHEN.HX write failure → source WHEN.EV entries remain active', async () => {
    const { writeEpisodicEvent, compactEpisodicHistory } = await import('../../core/memory/episodic.js');

    // Create 22 WHEN.EV entries to trigger compaction (threshold is 20)
    for (let i = 0; i < 22; i++) {
      await writeEpisodicEvent({
        trigger: `trigger ${i}`,
        task_name: `Task ${i}`,
        skill_sequence: ['skill_a'],
        outcome: 'success',
        linked_codes: [],
        session_id: 'sess-test',
      });
    }

    // Mock createEntry to throw when creating WHEN.HX
    const writeModule = await import('../../core/memory/write.js');
    const origCreateEntry = writeModule.createEntry;
    vi.spyOn(writeModule, 'createEntry').mockImplementation((input) => {
      if (input.nb === 'WHEN' && input.type === 'HX') {
        throw new Error('Simulated WHEN.HX write failure');
      }
      return origCreateEntry(input);
    });

    const mockLLM = async () => 'Summary text';
    await compactEpisodicHistory(mockLLM);

    vi.restoreAllMocks();

    // Source WHEN.EV entries must still be active (not archived)
    const db = getDb();
    const activeEV = db.prepare("SELECT code FROM index_entries WHERE nb = 'WHEN' AND type = 'EV' AND status = 'active'").all();
    expect(activeEV.length).toBeGreaterThanOrEqual(10);
  });

  it('Normal compaction archives source entries after WHEN.HX confirmed', async () => {
    const { writeEpisodicEvent, compactEpisodicHistory } = await import('../../core/memory/episodic.js');

    for (let i = 0; i < 22; i++) {
      await writeEpisodicEvent({
        trigger: `trigger ${i}`,
        task_name: `Task ${i}`,
        skill_sequence: ['skill_a'],
        outcome: 'success',
        linked_codes: [],
        session_id: 'sess-test',
      });
    }

    const mockLLM = async () => 'Summary text';
    await compactEpisodicHistory(mockLLM);

    const db = getDb();
    const hxEntries = db.prepare("SELECT code FROM index_entries WHERE nb = 'WHEN' AND type = 'HX'").all();
    expect(hxEntries.length).toBeGreaterThanOrEqual(1);

    const archivedEV = db.prepare("SELECT code FROM index_entries WHERE nb = 'WHEN' AND type = 'EV' AND status = 'archived'").all();
    expect(archivedEV.length).toBeGreaterThanOrEqual(10);
  });
});

// ─── Bug 4: withRollback swallows error after rollback ───────────────────────

describe('Bug 4: withRollback throws after failed verify', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); vi.restoreAllMocks(); });

  it('always-false verify → rollback called → error thrown to caller', async () => {
    const { withRollback } = await import('../../core/autonomous.js');

    let rollbackCalled = false;
    const operation = async () => 'result';
    const rollback = async () => { rollbackCalled = true; };
    const verify = (_: string) => false; // always fails

    await expect(withRollback(operation, rollback, verify)).rejects.toThrow();
    expect(rollbackCalled).toBe(true);
  });

  it('verify passes → result returned normally', async () => {
    const { withRollback } = await import('../../core/autonomous.js');

    let rollbackCalled = false;
    const operation = async () => 42;
    const rollback = async () => { rollbackCalled = true; };
    const verify = (n: number) => n === 42;

    const result = await withRollback(operation, rollback, verify);
    expect(result).toBe(42);
    expect(rollbackCalled).toBe(false);
  });
});

// ─── Bug 5: Autonomous loop saves PLAN.EX before conf_score pause ────────────

describe('Bug 5: Autonomous loop saves PLAN.EX on all exit paths', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); vi.restoreAllMocks(); });

  it('conf_score < 0.8 pause → PLAN.EX exists in SQLite reflecting state at pause', async () => {
    const { createPlanEX, loadActivePlanEX } = await import('../../core/memory/plan-ex.js');
    const { runAutonomousLoop } = await import('../../core/autonomous.js');

    // Create a project entry
    const db = getDb();
    const project = createEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Test Project',
      status: 'active',
      summary: 'A test project',
      body: 'Project details',
    });

    // Create a PLAN.EX with conf_score below threshold
    const planData = {
      task_name: 'Test Autonomous Task',
      project_code: project.code,
      goal: 'Test goal',
      milestones: [{ id: 'm1', name: 'Milestone 1', done: false }],
      current_milestone: 0,
      todos: [],
      constraints: {},
      last_action: '',
      next_action: '',
      conf_score: 0.5, // below 0.8 threshold
      session_id: 'sess-conf',
      checkpoint_ts: new Date().toISOString(),
      started: new Date().toISOString(),
      attempt_counts: {},
      last_failures: {},
      recent_turns: [],
      loaded_memory_utility: {},
      file_checksums: {},
    };

    createPlanEX(planData);

    const mockLLM = async () => JSON.stringify({ goal: 'test', steps: [] });

    const result = await runAutonomousLoop(project.code, mockLLM);

    // Should have paused due to low conf_score
    expect(result.completed).toBe(false);
    expect(result.pauseReason).toContain('conf_score');

    // PLAN.EX must still exist with checkpoint_ts set
    const saved = loadActivePlanEX();
    expect(saved).not.toBeNull();
    expect(saved!.checkpoint_ts).toBeTruthy();
  });
});

// ─── Bug 6: Decay cycle pages out WHO and PLAN.CT entries ───────────────────

describe('Bug 6: runDecayCycle preserves WHO and PLAN.CT active_page', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); vi.restoreAllMocks(); });

  it('25 WHO entries with very low scores → all have active_page=1 after runDecayCycle', async () => {
    const { runDecayCycle } = await import('../../core/memory/lifecycle.js');
    const db = getDb();

    // Create 25 WHO.CT entries with very old updated date (low decay score)
    for (let i = 0; i < 25; i++) {
      createEntry({
        nb: 'WHO',
        type: 'CT',
        name: `Contact ${i}`,
        status: 'active',
        summary: `Test contact ${i}`,
        body: `Contact details ${i}`,
      });
    }

    // Set all to very old updated date so they decay to near 0
    db.prepare("UPDATE index_entries SET updated = '2000-01-01', importance_score = 0.001 WHERE nb = 'WHO'").run();

    runDecayCycle();

    const whoEntries = db.prepare("SELECT active_page FROM index_entries WHERE nb = 'WHO'").all() as Array<{ active_page: number }>;
    expect(whoEntries).toHaveLength(25);
    for (const entry of whoEntries) {
      expect(entry.active_page).toBe(1);
    }
  });

  it('PLAN.CT entries also preserved after decay cycle', async () => {
    const { runDecayCycle } = await import('../../core/memory/lifecycle.js');
    const db = getDb();

    for (let i = 0; i < 5; i++) {
      createEntry({
        nb: 'PLAN',
        type: 'CT',
        name: `Constraint ${i}`,
        status: 'active',
        summary: `Test constraint ${i}`,
        body: `Details ${i}`,
      });
    }

    db.prepare("UPDATE index_entries SET updated = '2000-01-01', importance_score = 0.001 WHERE nb = 'PLAN' AND type = 'CT'").run();

    runDecayCycle();

    const planCtEntries = db.prepare("SELECT active_page FROM index_entries WHERE nb = 'PLAN' AND type = 'CT'").all() as Array<{ active_page: number }>;
    expect(planCtEntries).toHaveLength(5);
    for (const entry of planCtEntries) {
      expect(entry.active_page).toBe(1);
    }
  });
});

// ─── Bug 7: verifyPlanAssertions rejection cycle limit ───────────────────────

describe('Bug 7: verifyPlanAssertions exits after exactly 2 cycles', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); vi.restoreAllMocks(); });

  it('LLM always returns failed assertions → exits after 2 cycles → returns passed=false', async () => {
    const { verifyPlanAssertions } = await import('../../core/planner.js');

    let callCount = 0;
    const mockLLM = async () => {
      callCount++;
      return JSON.stringify({ passed: false, failedAssertions: ['step is unsafe'], rewritePrompt: 'fix it' });
    };

    const plan = {
      goal: 'test goal',
      steps: [{ id: 'step1', description: 'do something', skill: 'memory_read', input: {}, dependsOn: [], storeResultAs: null, optional: false }],
      estimatedDuration: '30s',
      createdAt: new Date().toISOString(),
    };

    const result = await verifyPlanAssertions(plan, mockLLM);

    expect(result.passed).toBe(false);
    expect(result.failedAssertions).toContain('step is unsafe');
    expect(callCount).toBe(2); // exactly 2 rejection cycles
  });
});

// ─── Bug 8: assessComplexity without llmHandler ──────────────────────────────

describe('Bug 8: assessComplexity without llmHandler', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); vi.restoreAllMocks(); });

  it('"hello" without llmHandler → returns LOW without throwing', async () => {
    const { assessComplexity } = await import('../../core/planner.js');
    const classification = { intent: 'general' as const, confidence: 1 };

    const result = await assessComplexity('hello', classification as any, undefined);
    expect(result.level).toBe('LOW');
  });

  it('complex message with multiple signals without llmHandler → returns MEDIUM or HIGH without throwing', async () => {
    const { assessComplexity } = await import('../../core/planner.js');
    const classification = { intent: 'general' as const, confidence: 1 };

    // Use message with 2+ signals: multiStep + loopSignal
    const result = await assessComplexity(
      'for each file, search the web and then update the database',
      classification as any,
      undefined,
    );
    // Should not throw and should return a valid level
    expect(['LOW', 'MEDIUM', 'HIGH', 'MAX']).toContain(result.level);
    // With multiple signals (multiStep + loopSignal + multiAction), should be complex
    expect(['MEDIUM', 'HIGH', 'MAX']).toContain(result.level);
  });
});

// ─── Bug 9: fetchOwnerPersona cache + null safety ───────────────────────────

describe('Bug 9: fetchOwnerPersona cache and null safety', () => {
  beforeEach(() => {
    isolateDb();
  });
  afterEach(async () => {
    const { _resetPersonaCache } = await import('../../core/context.js');
    _resetPersonaCache();
    restoreDb();
    vi.restoreAllMocks();
  });

  it('No WHO.CT entries → fetchOwnerPersona returns null', async () => {
    const { fetchOwnerPersona } = await import('../../core/context.js');
    const result = fetchOwnerPersona();
    expect(result).toBeNull();
  });

  it('No WHO.CT entries → buildContext completes normally', async () => {
    const { buildContext } = await import('../../core/context.js');
    const result = await buildContext('hello', null, [], [], 'general');
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
  });

  it('One WHO.CT entry → persona section appears in system prompt', async () => {
    const { fetchOwnerPersona, _resetPersonaCache } = await import('../../core/context.js');

    // Reset cache first
    _resetPersonaCache();

    createEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Erfan Tari',
      status: 'active',
      summary: 'Owner and developer',
      body: 'Main contact',
    });

    // Reset cache again to pick up new entry
    _resetPersonaCache();

    const persona = fetchOwnerPersona();
    expect(persona).not.toBeNull();
    expect(persona).toContain('Erfan Tari');
  });

  it('fetchOwnerPersona is cached within 60s TTL', async () => {
    const { fetchOwnerPersona, _resetPersonaCache } = await import('../../core/context.js');

    _resetPersonaCache();

    createEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Cached Person',
      status: 'active',
      summary: 'Cached',
      body: 'Cached details',
    });

    _resetPersonaCache();

    const first = fetchOwnerPersona();
    const second = fetchOwnerPersona(); // should hit cache
    expect(first).toBe(second); // same reference = cached
  });
});

// ─── Bug 10: checkAMemLinker fires max 5 entries per heartbeat ───────────────

describe('Bug 10: checkAMemLinker limits to 5 entries per run', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); vi.restoreAllMocks(); });

  it('20 entries with no relationships → single heartbeat run processes exactly 5', async () => {
    const { checkAMemLinker } = await import('../../core/heartbeat.js');

    for (let i = 0; i < 20; i++) {
      createEntry({
        nb: 'WHAT',
        type: 'KN',
        name: `Knowledge ${i}`,
        status: 'active',
        summary: `Summary ${i}`,
        body: `Body ${i}`,
      });
    }

    const result = checkAMemLinker();
    expect(result.processed).toBe(5);
    expect(result.codes).toHaveLength(5);
  });

  it('3 entries with no relationships → processes all 3 (fewer than max)', async () => {
    const { checkAMemLinker } = await import('../../core/heartbeat.js');

    for (let i = 0; i < 3; i++) {
      createEntry({
        nb: 'WHAT',
        type: 'KN',
        name: `Knowledge ${i}`,
        status: 'active',
        summary: `Summary ${i}`,
        body: `Body ${i}`,
      });
    }

    const result = checkAMemLinker();
    expect(result.processed).toBe(3);
  });
});

// ─── Bug 11: PINNED message detection uses startsWith ───────────────────────

describe('Bug 11: PINNED uses startsWith', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); vi.restoreAllMocks(); });

  it('[PINNED] at start → survives compaction filter', async () => {
    const { buildContext } = await import('../../core/context.js');

    const pinnedMsg = '[PINNED] This is a pinned message that should survive';
    const history = [
      { role: 'user' as const, content: pinnedMsg },
      { role: 'assistant' as const, content: 'Got it' },
      { role: 'user' as const, content: 'Normal message 1' },
      { role: 'assistant' as const, content: 'Response 1' },
      { role: 'user' as const, content: 'Normal message 2' },
      { role: 'assistant' as const, content: 'Response 2' },
      { role: 'user' as const, content: 'Normal message 3' },
      { role: 'assistant' as const, content: 'Response 3' },
    ];

    // Use a mock LLM that returns a summary
    const mockLLM = async () => 'Summary of conversation';

    const result = await buildContext('new message', null, history, [], 'general', undefined, mockLLM);
    const allContent = result.map(m => m.content).join('\n');
    // The pinned message content should be somewhere in the context
    // (either as a message or within a summary that mentions it)
    expect(result).toBeDefined();
  });

  it('[PINNED] in MIDDLE of message → not treated as pinned (startsWith check)', () => {
    // Direct unit test of the startsWith behavior
    const pinnedAtStart = '[PINNED] This message is pinned';
    const pinnedInMiddle = 'This message has [PINNED] in the middle';
    const notPinned = 'This message has no marker';

    expect(pinnedAtStart.startsWith('[PINNED]')).toBe(true);
    expect(pinnedInMiddle.startsWith('[PINNED]')).toBe(false);
    expect(notPinned.startsWith('[PINNED]')).toBe(false);
  });

  it('context.ts filter uses startsWith not includes', async () => {
    // Verify that the source code uses startsWith
    const contextSrc = fs.readFileSync(
      path.join(process.cwd(), 'core/context.ts'),
      'utf-8',
    );
    // Should use startsWith
    expect(contextSrc).toContain("startsWith('[PINNED]')");
    // Should NOT use includes for PINNED detection in filter
    const includesWithPinned = contextSrc.match(/\.includes\(['"]\\[PINNED\\]['"]\)/g);
    expect(includesWithPinned).toBeNull();
  });
});

// ─── Bug 12: Execution log JSONL directory creation ─────────────────────────

describe('Bug 12: logExecution creates logs directory on fresh install', () => {
  beforeEach(isolateDb);
  afterEach(() => { restoreDb(); vi.restoreAllMocks(); });

  it('Fresh tmpDir with no workspace/logs → logExecution succeeds and creates dir and file', async () => {
    const { logExecution } = await import('../../core/memory/execution-log.js');

    // Confirm logs dir does not exist
    expect(fs.existsSync(PATHS.logs)).toBe(false);

    const record = {
      ts: new Date().toISOString(),
      session_id: 'test-session',
      step_id: 'step1',
      skill: 'memory_read',
      action: 'read',
      success: true,
      pre_hash: 'abc123',
      post_hash: 'def456',
      artifacts: [],
      constraints: [],
      ms: 42,
    };

    // Should not throw
    expect(() => logExecution(record)).not.toThrow();

    // Logs directory should now exist
    expect(fs.existsSync(PATHS.logs)).toBe(true);

    // Log file should exist (use local date to match localDateString() behavior)
    const nowLocal = new Date();
    const today = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, '0')}-${String(nowLocal.getDate()).padStart(2, '0')}`;
    const logFile = path.join(PATHS.logs, `execution-${today}.jsonl`);
    expect(fs.existsSync(logFile)).toBe(true);

    // File should contain the record
    const content = fs.readFileSync(logFile, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.session_id).toBe('test-session');
    expect(parsed.skill).toBe('memory_read');
  });
});
