import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';
import {
  createWorkingMemory,
  appendStepLog,
  updatePlan,
  addToActiveContext,
  archiveWorkingMemory,
  loadWorkingMemory,
  type WorkingMemory,
  type StepLogEntry,
} from '../../core/memory/working-memory.js';
import type { IntakeResult } from '../../core/intake.js';
import type { LLMHandler } from '../../core/types.js';
import type { TaskMilestone } from '../../core/schemas.js';

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;

function makeMilestone(id: string, title: string): TaskMilestone {
  return {
    id,
    goalIds: [],
    title,
    description: `Description for ${title}`,
    completionCriteria: `${title} completed`,
    steps: [{
      id: `step-${id}`,
      description: 'A step',
      skill: 'run_bash',
      input: { command: 'echo done' },
      dependsOn: [],
      storeResultAs: null,
      optional: false,
      confidence_score: 0.9,
      risk_level: 'LOW',
    }],
  };
}

function makeIntakeResult(projectCode: string | null = null): IntakeResult {
  return {
    summary: 'Test task summary',
    signals: {
      summary: 'Test task summary',
      personSignal: null,
      projectSignal: null,
      timeSignal: null,
      agenticSignal: true,
      procedureSignal: false,
      querySignal: false,
    },
    resolvedContext: projectCode
      ? [{ code: projectCode, summary: 'Test project', nb: 'PLAN', name: 'Test Project' }]
      : [],
    projectCode,
  };
}

function makeLLM(response = 'Archived successfully.'): LLMHandler {
  return async () => response;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-test-'));
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  initDatabase(path.join(tmpDir, 'test.sqlite'));
});

afterEach(() => {
  closeDatabase();
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Phase 15: Working Memory', () => {
  it('createWorkingMemory creates a file with correct structure', async () => {
    const db = initDatabase(PATHS.db);
    const intake = makeIntakeResult();
    const wm = await createWorkingMemory('Build a web scraper', intake, db);

    expect(wm.taskId).toMatch(/^wm-\d+$/);
    expect(wm.goal).toBe('Build a web scraper');
    expect(wm.status).toBe('active');
    expect(fs.existsSync(wm.filePath)).toBe(true);

    const content = fs.readFileSync(wm.filePath, 'utf-8');
    expect(content).toContain('type: working_memory');
    expect(content).toContain('Build a web scraper');
    expect(content).toContain('## Goal');
    expect(content).toContain('## Plan — Current Best Path');
    expect(content).toContain('## Step Log');
  });

  it('appendStepLog appends entries to the file', async () => {
    const db = initDatabase(PATHS.db);
    const intake = makeIntakeResult();
    const wm = await createWorkingMemory('Test goal', intake, db);

    const entry: StepLogEntry = {
      stepId: 'step-1',
      skill: 'run_bash',
      outcome: 'success',
      summary: 'Ran echo command successfully',
      ts: new Date().toISOString(),
    };

    await appendStepLog(wm, entry);

    expect(wm.stepLog).toHaveLength(1);
    expect(wm.stepLog[0].stepId).toBe('step-1');
    expect(wm.stepLog[0].outcome).toBe('success');

    const content = fs.readFileSync(wm.filePath, 'utf-8');
    expect(content).toContain('step-1');
    expect(content).toContain('run_bash');
  });

  it('updatePlan rewrites the plan section', async () => {
    const db = initDatabase(PATHS.db);
    const intake = makeIntakeResult();
    const wm = await createWorkingMemory('Test goal', intake, db);

    const milestones = [
      makeMilestone('m1', 'Setup environment'),
      makeMilestone('m2', 'Implement core logic'),
    ];

    await updatePlan(wm, milestones);

    expect(wm.milestones).toHaveLength(2);
    const content = fs.readFileSync(wm.filePath, 'utf-8');
    expect(content).toContain('Setup environment');
    expect(content).toContain('Implement core logic');
  });

  it('addToActiveContext adds codes and deduplicates', async () => {
    const db = initDatabase(PATHS.db);
    const intake = makeIntakeResult();
    const wm = await createWorkingMemory('Test goal', intake, db);

    await addToActiveContext(wm, 'WHO.CT-000001', 'Alice Smith — contact');
    await addToActiveContext(wm, 'WHAT.PJ-000002', 'Alpha project');
    await addToActiveContext(wm, 'WHO.CT-000001', 'Alice Smith — contact'); // duplicate

    expect(wm.activeContext).toHaveLength(2);

    const content = fs.readFileSync(wm.filePath, 'utf-8');
    expect(content).toContain('WHO.CT-000001');
    expect(content).toContain('WHAT.PJ-000002');
  });

  it('archiveWorkingMemory sets status to archived', async () => {
    const db = initDatabase(PATHS.db);
    const intake = makeIntakeResult();
    const wm = await createWorkingMemory('Test goal', intake, db);

    await archiveWorkingMemory(wm, db, makeLLM('Task completed successfully.'));

    expect(wm.status).toBe('archived');
    // File is deleted after archiving (FIX 7)
    expect(fs.existsSync(wm.filePath)).toBe(false);
  });

  it('loadWorkingMemory finds a file by taskId', async () => {
    const db = initDatabase(PATHS.db);
    const intake = makeIntakeResult();
    const wm = await createWorkingMemory('Load test goal', intake, db);

    // Step log to make it non-trivial
    await appendStepLog(wm, {
      stepId: 'step-a',
      skill: 'calculator',
      outcome: 'success',
      summary: 'Computed 2+2=4',
      ts: new Date().toISOString(),
    });

    const loaded = await loadWorkingMemory(wm.taskId);
    expect(loaded).not.toBeNull();
    expect(loaded!.goal).toBe('Load test goal');
    expect(loaded!.taskId).toBe(wm.taskId);
  });

  it('loadWorkingMemory returns null for unknown taskId', async () => {
    const result = await loadWorkingMemory('wm-99999999');
    expect(result).toBeNull();
  });

  it('goal is immutable — appendStepLog does not change it', async () => {
    const db = initDatabase(PATHS.db);
    const intake = makeIntakeResult();
    const wm = await createWorkingMemory('The immutable goal', intake, db);
    const originalGoal = wm.goal;

    await appendStepLog(wm, {
      stepId: 'step-x',
      skill: 'web_search',
      outcome: 'failure',
      summary: 'Search failed',
      ts: new Date().toISOString(),
    });

    expect(wm.goal).toBe(originalGoal);
    const content = fs.readFileSync(wm.filePath, 'utf-8');
    expect(content).toContain('The immutable goal');
  });

  it('projectCode is stored in frontmatter', async () => {
    const db = initDatabase(PATHS.db);
    const intake = makeIntakeResult('PLAN.PJ-000001');
    const wm = await createWorkingMemory('Project task', intake, db);

    expect(wm.projectCode).toBe('PLAN.PJ-000001');
    const content = fs.readFileSync(wm.filePath, 'utf-8');
    expect(content).toContain('project_code: PLAN.PJ-000001');
  });
});
