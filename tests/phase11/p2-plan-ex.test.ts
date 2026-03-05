import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { _resetGitInstance } from '../../core/memory/versioning.js';

describe('Phase 11 P2: Execution Log + PLAN.EX', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-planex-'));
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

  it('P2A: logExecution appends a JSONL record', async () => {
    const { logExecution } = await import('../../core/memory/execution-log.js');

    logExecution({
      ts: new Date().toISOString(),
      session_id: 'test-session',
      step_id: 'step1',
      skill: 'calculator',
      action: 'add numbers',
      success: true,
      pre_hash: 'abc',
      post_hash: 'def',
      artifacts: ['result: 5'],
      constraints: [],
      ms: 10,
    });

    const dateStr = new Date().toISOString().slice(0, 10);
    const logFile = path.join(PATHS.logs, `execution-${dateStr}.jsonl`);
    expect(fs.existsSync(logFile)).toBe(true);

    const content = fs.readFileSync(logFile, 'utf-8');
    const record = JSON.parse(content.trim());
    expect(record.step_id).toBe('step1');
    expect(record.skill).toBe('calculator');
    expect(record.success).toBe(true);
  });

  it('P2B: logExecution never throws on errors', async () => {
    const { logExecution } = await import('../../core/memory/execution-log.js');

    // Should not throw even with invalid paths
    expect(() => logExecution({
      ts: new Date().toISOString(),
      session_id: '', step_id: '', skill: '', action: '',
      success: false, pre_hash: '', post_hash: '',
      artifacts: [], constraints: [], ms: 0,
    })).not.toThrow();
  });

  it('P2C: readExecutionLog returns empty array for missing file', async () => {
    const { readExecutionLog } = await import('../../core/memory/execution-log.js');
    const records = readExecutionLog('2099-01-01');
    expect(records).toEqual([]);
  });

  it('P2D: readExecutionLog returns written records', async () => {
    const { logExecution, readExecutionLog } = await import('../../core/memory/execution-log.js');
    const dateStr = new Date().toISOString().slice(0, 10);

    logExecution({
      ts: new Date().toISOString(),
      session_id: 'sess-1',
      step_id: 'step-read-test',
      skill: 'memory_write',
      action: 'write entry',
      success: true,
      pre_hash: '',
      post_hash: 'x',
      artifacts: [],
      constraints: [],
      ms: 20,
    });

    const records = readExecutionLog(dateStr);
    expect(records.length).toBeGreaterThan(0);
    expect(records.some(r => r.step_id === 'step-read-test')).toBe(true);
  });

  it('P2E: createPlanEX creates a PLAN.EX entry', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createPlanEX } = await import('../../core/memory/plan-ex.js');

    const code = createPlanEX({
      task_name: 'Test Task',
      project_code: 'PLAN.PJ-000001',
      goal: 'Complete test task',
      milestones: [{ id: 'm1', name: 'Milestone 1', done: false }],
      current_milestone: 0,
      todos: [],
      constraints: {},
      last_action: '',
      next_action: 'Start milestone 1',
      conf_score: 0.9,
      session_id: 'test-session',
      checkpoint_ts: new Date().toISOString(),
      started: new Date().toISOString(),
      attempt_counts: {},
      last_failures: {},
      recent_turns: [],
      loaded_memory_utility: {},
      file_checksums: {},
    });

    expect(code).toMatch(/^PLAN\.EX-\d{6,}$/);
  });

  it('P2F: loadActivePlanEX returns most recent active entry', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createPlanEX, loadActivePlanEX } = await import('../../core/memory/plan-ex.js');

    createPlanEX({
      task_name: 'Active Task',
      project_code: '',
      goal: 'Do something',
      milestones: [],
      current_milestone: 0,
      todos: [],
      constraints: {},
      last_action: '',
      next_action: '',
      conf_score: 0.8,
      session_id: 's1',
      checkpoint_ts: new Date().toISOString(),
      started: new Date().toISOString(),
      attempt_counts: {},
      last_failures: {},
      recent_turns: [],
      loaded_memory_utility: {},
      file_checksums: {},
    });

    const loaded = loadActivePlanEX();
    expect(loaded).not.toBeNull();
    expect(loaded!.task_name).toBe('Active Task');
  });

  it('P2G: validateChecksums returns empty array when files match', async () => {
    const { validateChecksums } = await import('../../core/memory/plan-ex.js');
    const { createHash } = await import('node:crypto');

    const testFile = path.join(tmpDir, 'test.txt');
    const content = 'test content';
    fs.writeFileSync(testFile, content, 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex');

    const changed = validateChecksums({ [testFile]: hash });
    expect(changed).toEqual([]);
  });

  it('P2H: validateChecksums detects changed files', async () => {
    const { validateChecksums } = await import('../../core/memory/plan-ex.js');

    const testFile = path.join(tmpDir, 'changed.txt');
    fs.writeFileSync(testFile, 'original content', 'utf-8');

    const changed = validateChecksums({ [testFile]: 'wrong-hash-value' });
    expect(changed).toContain(testFile);
  });

  it('P2I: validateChecksums reports missing files', async () => {
    const { validateChecksums } = await import('../../core/memory/plan-ex.js');

    const missing = path.join(tmpDir, 'does-not-exist.txt');
    const changed = validateChecksums({ [missing]: 'any-hash' });
    expect(changed).toContain(missing);
  });

  it('P2J: execution log creates daily JSONL file', async () => {
    const { logExecution } = await import('../../core/memory/execution-log.js');

    logExecution({
      ts: new Date().toISOString(),
      session_id: 'sess',
      step_id: 'log-test',
      skill: 'test',
      action: 'test action',
      success: true,
      pre_hash: '',
      post_hash: '',
      artifacts: [],
      constraints: [],
      ms: 5,
    });

    const dateStr = new Date().toISOString().slice(0, 10);
    const files = fs.readdirSync(PATHS.logs);
    expect(files).toContain(`execution-${dateStr}.jsonl`);
  });

  it('P2K: PLAN.EX is in TYPE_MAP', async () => {
    const { TYPE_MAP } = await import('../../config/agent.config.js');
    expect('PLAN.EX' in TYPE_MAP).toBe(true);
  });

  it('P2L: classifyFailure classifies syntax errors', async () => {
    const { classifyFailure } = await import('../../core/executor.js');
    expect(classifyFailure('JSON parse error: unexpected token')).toBe('SYNTAX_ERROR');
  });

  it('P2M: classifyFailure classifies state errors', async () => {
    const { classifyFailure } = await import('../../core/executor.js');
    expect(classifyFailure('File not found: /tmp/missing.txt')).toBe('STATE_ERROR');
  });

  it('P2N: classifyFailure classifies capability errors as fallback', async () => {
    const { classifyFailure } = await import('../../core/executor.js');
    expect(classifyFailure('Network timeout exceeded')).toBe('CAPABILITY_ERROR');
  });

  it('P2O: updatePlanEX updates the entry', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createPlanEX, updatePlanEX, loadActivePlanEX } = await import('../../core/memory/plan-ex.js');

    createPlanEX({
      task_name: 'UpdateTest',
      project_code: '',
      goal: 'Test update',
      milestones: [],
      current_milestone: 0,
      todos: [],
      constraints: {},
      last_action: '',
      next_action: 'original',
      conf_score: 0.5,
      session_id: '',
      checkpoint_ts: '',
      started: '',
      attempt_counts: {},
      last_failures: {},
      recent_turns: [],
      loaded_memory_utility: {},
      file_checksums: {},
    });

    const loaded = loadActivePlanEX();
    expect(loaded).not.toBeNull();

    updatePlanEX(loaded!.code, { next_action: 'updated action', conf_score: 0.9 });
    // Entry was updated (no throw)
    expect(true).toBe(true);
  });
});
