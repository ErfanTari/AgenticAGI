import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { _resetGitInstance } from '../../core/memory/versioning.js';

describe('Phase 11 P8: Autonomous Execution Loop', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-autonomous-'));
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
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P8A: runAutonomousLoop returns AutonomousResult for missing project', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { runAutonomousLoop } = await import('../../core/autonomous.js');

    const result = await runAutonomousLoop('PLAN.PJ-999999', async () => '{}');
    expect(result).toHaveProperty('completed');
    expect(result).toHaveProperty('pauseReason');
    expect(result.completed).toBe(false);
  });

  it('P8B: withRollback calls operation and returns result', async () => {
    const { withRollback } = await import('../../core/autonomous.js');

    const result = await withRollback(
      async () => 'success',
      async () => {},
      (r) => r === 'success',
    );

    expect(result).toBe('success');
  });

  it('P8C: withRollback calls rollback on operation failure', async () => {
    const { withRollback } = await import('../../core/autonomous.js');
    let rollbackCalled = false;

    await expect(withRollback(
      async () => { throw new Error('operation failed'); },
      async () => { rollbackCalled = true; },
      (r) => Boolean(r),
    )).rejects.toThrow('operation failed');

    expect(rollbackCalled).toBe(true);
  });

  it('P8D: withRollback calls rollback when verify fails', async () => {
    const { withRollback } = await import('../../core/autonomous.js');
    let rollbackCalled = false;

    await expect(withRollback(
      async () => 'bad result',
      async () => { rollbackCalled = true; },
      (r) => r === 'expected result', // always fails
    )).rejects.toThrow('verification failed');

    expect(rollbackCalled).toBe(true);
  });

  it('P8E: commitCheckpoint does not throw', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createPlanEX } = await import('../../core/memory/plan-ex.js');
    const { commitCheckpoint } = await import('../../core/autonomous.js');

    const code = createPlanEX({
      task_name: 'Checkpoint Test',
      project_code: '',
      goal: 'Test checkpoint',
      milestones: [],
      current_milestone: 0,
      todos: [],
      constraints: {},
      last_action: '',
      next_action: '',
      conf_score: 0.9,
      session_id: '',
      checkpoint_ts: '',
      started: '',
      attempt_counts: {},
      last_failures: {},
      recent_turns: [],
      loaded_memory_utility: {},
      file_checksums: {},
    });

    const planEx = { code, task_name: 'Checkpoint Test' } as any;
    await expect(commitCheckpoint(planEx)).resolves.toBeUndefined();
  });

  it('P8F: verify_state skill is registered', async () => {
    const { getSkill } = await import('../../core/skills/registry.js');
    const skill = getSkill('verify_state');
    expect(skill).toBeDefined();
    expect(skill?.name).toBe('verify_state');
  });

  it('P8G: verify_state validates existing file', async () => {
    const { getSkill } = await import('../../core/skills/registry.js');
    const skill = getSkill('verify_state');

    const testFile = path.join(tmpDir, 'verify_test.txt');
    fs.writeFileSync(testFile, 'hello world', 'utf-8');

    const result = await skill!.execute({
      operation: 'file_write',
      target: testFile,
    });

    expect(result.success).toBe(true);
  });

  it('P8H: verify_state fails for missing file', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { getSkill } = await import('../../core/skills/registry.js');
    const skill = getSkill('verify_state');

    const result = await skill!.execute({
      operation: 'file_write',
      target: path.join(tmpDir, 'missing.txt'),
    });

    expect(result.success).toBe(false);
  });

  it('P8I: verify_state checks file content when expected is provided', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { getSkill } = await import('../../core/skills/registry.js');
    const skill = getSkill('verify_state');

    const testFile = path.join(tmpDir, 'content_test.txt');
    fs.writeFileSync(testFile, 'expected content here', 'utf-8');

    const result = await skill!.execute({
      operation: 'file_write',
      target: testFile,
      expected: 'expected content',
    });

    expect(result.success).toBe(true);
  });

  it('P8J: verify_state fails when expected content is missing', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { getSkill } = await import('../../core/skills/registry.js');
    const skill = getSkill('verify_state');

    const testFile = path.join(tmpDir, 'wrong_content.txt');
    fs.writeFileSync(testFile, 'actual content', 'utf-8');

    const result = await skill!.execute({
      operation: 'file_write',
      target: testFile,
      expected: 'wrong expected',
    });

    expect(result.success).toBe(false);
  });

  it('P8K: verify_state validates memory entry', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createEntry } = await import('../../core/memory/write.js');
    const { getSkill } = await import('../../core/skills/registry.js');
    const skill = getSkill('verify_state');

    const entry = createEntry({
      nb: 'WHAT', type: 'KN', name: 'VerifyEntry',
      status: 'active', summary: 'test', body: 'body',
    });

    const result = await skill!.execute({
      operation: 'memory_write',
      target: entry.code,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain(entry.code);
  });

  it('P8L: saga_rollback transparency event is valid', async () => {
    const { transparency } = await import('../../core/transparency.js');
    let emitted = false;
    const off = transparency.on((event) => {
      if (event.type === 'saga_rollback') emitted = true;
    });
    transparency.enable();
    transparency.emit({ type: 'saga_rollback', data: { step: 'step1', reason: 'test failure' } });
    transparency.disable();
    off();
    expect(emitted).toBe(true);
  });

  it('P8M: linker_pass transparency event is valid', async () => {
    const { transparency } = await import('../../core/transparency.js');
    let emitted = false;
    const off = transparency.on((event) => {
      if (event.type === 'linker_pass') emitted = true;
    });
    transparency.enable();
    transparency.emit({ type: 'linker_pass', data: { linked: 5 } });
    transparency.disable();
    off();
    expect(emitted).toBe(true);
  });

  it('P8N: project_transition transparency event is valid', async () => {
    const { transparency } = await import('../../core/transparency.js');
    let emitted = false;
    const off = transparency.on((event) => {
      if (event.type === 'project_transition') emitted = true;
    });
    transparency.enable();
    transparency.emit({ type: 'project_transition', data: { code: 'PLAN.PJ-000001', from: 'active', to: 'review' } });
    transparency.disable();
    off();
    expect(emitted).toBe(true);
  });

  it('P8O: withRollback does not call rollback on success', async () => {
    const { withRollback } = await import('../../core/autonomous.js');
    let rollbackCalled = false;

    const result = await withRollback(
      async () => 42,
      async () => { rollbackCalled = true; },
      (r) => r === 42,
    );

    expect(result).toBe(42);
    expect(rollbackCalled).toBe(false);
  });
});
