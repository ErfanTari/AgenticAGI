import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { processMessage, _getPendingConfirmationPlan, _setPendingConfirmationPlan } from '../../core/agent.js';
import { getDb, initDatabase, closeDatabase } from '../../core/memory/index.js';
import { getPendingConfirmationPlan } from '../../core/skills/tools/confirm_plan.js';
import { executeConfirmedPlan } from '../../core/router.js';
import { runMeetingMode } from '../../core/meeting.js';
import type { TaskPlan } from '../../core/schemas.js';

vi.mock('../../core/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/router.js')>();
  return {
    ...actual,
    executeConfirmedPlan: vi.fn(async () => ({
      reply: 'Executed mocked plan.',
      execution: { success: true, completed: [], failed: [], milestoneResults: [], completedMilestones: [], taskCompleteEnqueued: true } as any,
      verification: { verified: true, confidence: 1, issues: [] } as any,
    })),
  };
});

vi.mock('../../core/meeting.js', () => ({
  runMeetingMode: vi.fn(async () => ({ prompt: 'Meeting prompt' })),
}));

describe('plan confirmation interceptor', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;
  let origWorkspace: string;
  let origLogs: string;
  let origProjects: string;
  let origIndex: string;

  function makePlan(): TaskPlan {
    return {
      goal: 'Ship confirmation changes',
      needsConfirmation: true,
      complexity: 'LOW',
      estimatedDuration: '5m',
      steps: [],
      milestones: [
        {
          id: 'ms1',
          title: 'Audit the first milestone',
          successCriteria: ['Done'],
          steps: [],
        },
      ],
    } as TaskPlan;
  }

  function queueFinding(message = 'Queued finding'): void {
    getDb()
      .prepare('INSERT INTO heartbeat_queue (code, message, seen, created) VALUES (?, ?, 0, ?)')
      .run('WHY.MT-000001', message, new Date().toISOString());
  }

  function unseenFindings(): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) as count FROM heartbeat_queue WHERE seen = 0')
      .get() as { count: number };
    return row.count;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-confirmation-'));
    origDb = PATHS.db;
    origMemory = PATHS.memory;
    origWorkspace = PATHS.workspace;
    origLogs = PATHS.logs;
    origProjects = PATHS.projects;
    origIndex = PATHS.index;

    (PATHS as Record<string, string>).db = path.join(tmpDir, 'index', 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
    (PATHS as Record<string, string>).logs = path.join(tmpDir, 'workspace', 'logs');
    (PATHS as Record<string, string>).projects = path.join(tmpDir, 'workspace', 'projects');
    (PATHS as Record<string, string>).index = path.join(tmpDir, 'index');

    fs.mkdirSync(PATHS.memory, { recursive: true });
    fs.mkdirSync(PATHS.workspace, { recursive: true });
    fs.mkdirSync(PATHS.logs, { recursive: true });
    fs.mkdirSync(PATHS.projects, { recursive: true });
    fs.mkdirSync(PATHS.index, { recursive: true });

    initDatabase(PATHS.db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    _setPendingConfirmationPlan(null);
    closeDatabase();

    (PATHS as Record<string, string>).db = origDb;
    (PATHS as Record<string, string>).memory = origMemory;
    (PATHS as Record<string, string>).workspace = origWorkspace;
    (PATHS as Record<string, string>).logs = origLogs;
    (PATHS as Record<string, string>).projects = origProjects;
    (PATHS as Record<string, string>).index = origIndex;

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('executes a pending plan on "yes"', async () => {
    const plan = makePlan();
    _setPendingConfirmationPlan(plan);

    const result = await processMessage('yes', [], { llmHandler: vi.fn() });

    expect(result.intent).toBe('planned_workflow');
    expect(result.reply).toContain('Executed mocked plan.');
    expect(executeConfirmedPlan).toHaveBeenCalledOnce();
    expect(executeConfirmedPlan).toHaveBeenCalledWith(plan, expect.any(Function));
    expect(_getPendingConfirmationPlan()).toBeNull();
    expect(getPendingConfirmationPlan()).toBeNull();
  });

  it('cancels a pending plan on "no"', async () => {
    _setPendingConfirmationPlan(makePlan());

    const result = await processMessage('no', [], { llmHandler: vi.fn() });

    expect(result.intent).toBe('general');
    expect(result.reply).toContain('Plan cancelled');
    expect(executeConfirmedPlan).not.toHaveBeenCalled();
    expect(_getPendingConfirmationPlan()).toBeNull();
    expect(getPendingConfirmationPlan()).toBeNull();
  });

  it('re-prompts ambiguous pending replies with the first milestone title', async () => {
    queueFinding('Need your approval');
    _setPendingConfirmationPlan(makePlan());

    const result = await processMessage('what do you mean?', [], { llmHandler: vi.fn() });

    expect(result.intent).toBe('general');
    expect(result.reply).toContain('While you were away');
    expect(result.reply).toContain('Audit the first milestone');
    expect(executeConfirmedPlan).not.toHaveBeenCalled();
    expect(_getPendingConfirmationPlan()).not.toBeNull();
    expect(getPendingConfirmationPlan()).not.toBeNull();
    expect(unseenFindings()).toBe(0);
  });

  it('treats qualified approvals like "yes but change step 2 first" as ambiguous', async () => {
    _setPendingConfirmationPlan(makePlan());

    const result = await processMessage('yes but change step 2 first', [], { llmHandler: vi.fn() });

    expect(result.intent).toBe('general');
    expect(result.reply).toContain('Audit the first milestone');
    expect(executeConfirmedPlan).not.toHaveBeenCalled();
    expect(_getPendingConfirmationPlan()).not.toBeNull();
    expect(getPendingConfirmationPlan()).not.toBeNull();
  });

  it('still shows findings on the /log fast path', async () => {
    queueFinding('Log-path finding');

    const result = await processMessage('/log wrote a checkpoint', [], { llmHandler: vi.fn() });

    expect(result.intent).toBe('memory_write');
    expect(result.reply).toContain('While you were away');
    expect(result.reply).toContain('Logged.');
    expect(unseenFindings()).toBe(0);
  });

  it('still shows findings on the /meeting fast path', async () => {
    queueFinding('Meeting-path finding');

    const result = await processMessage('/meeting', [], { llmHandler: vi.fn() });

    expect(result.intent).toBe('meeting');
    expect(result.reply).toContain('While you were away');
    expect(result.reply).toContain('Meeting prompt');
    expect(runMeetingMode).toHaveBeenCalledOnce();
    expect(unseenFindings()).toBe(0);
  });

  it('shows findings once on the normal path after fast paths are skipped', async () => {
    queueFinding('Normal-path finding');
    const llm = vi.fn(async () => JSON.stringify({
      summary: 'hello',
      person: null,
      project: null,
      time: null,
      agentic: false,
      procedure: false,
      query: false,
    }));

    const result = await processMessage('hello', [], { llmHandler: llm });

    expect(result.reply).toContain('While you were away');
    expect(unseenFindings()).toBe(0);
  });
});
