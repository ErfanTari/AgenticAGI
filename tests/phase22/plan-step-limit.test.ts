import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATHS } from '../../config/agent.config.js';
import { closeDatabase, initDatabase } from '../../core/memory/index.js';
import { _resetMemoryMode } from '../../core/memory-mode.js';
import { applyPlanIntegrityPolicy, decomposeTask } from '../../core/planner.js';
import { transparency } from '../../core/transparency.js';
import type { LLMHandler } from '../../core/types.js';
import type { PlanIntegrityResult, TaskPlan, TaskStep } from '../../core/schemas.js';

const origDb = PATHS.db;
const origMemory = PATHS.memory;
let tmpDir: string;

function makeStep(index: number): TaskStep {
  return {
    id: `step${index}`,
    description: `Run step ${index}`,
    skill: 'calculator',
    input: { expression: `${index}+1` },
    dependsOn: index === 1 ? [] : [`step${index - 1}`],
    storeResultAs: `step${index}_result`,
    optional: false,
    confidence_score: 0.8,
    risk_level: 'LOW',
  };
}

function makePlan(stepCount: number, complexity: TaskPlan['complexity'] = 'MEDIUM'): TaskPlan {
  const steps = Array.from({ length: stepCount }, (_value, index) => makeStep(index + 1));
  return {
    goal: 'Test multi-step plan',
    goals: [{ id: 'goal_1', sourceUnitIds: ['unit_1'], description: 'Test multi-step plan' }],
    milestones: [{
      id: 'milestone_1',
      goalIds: ['goal_1'],
      title: 'Complete steps',
      description: 'Run every step',
      completionCriteria: 'All steps completed',
      steps,
    }],
    steps,
    complexity,
    needsConfirmation: false,
    estimatedDuration: '2m',
    createdAt: '2026-04-28T00:00:00.000Z',
  };
}

function makeMissingIntegrity(missingSteps: string[]): PlanIntegrityResult {
  return {
    valid: false,
    orphanedSteps: [],
    missingSteps,
    brokenDependencies: [],
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-step-limit-'));
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  fs.mkdirSync(PATHS.memory, { recursive: true });
  initDatabase(PATHS.db);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  transparency.disable();
  vi.restoreAllMocks();
  closeDatabase();
  _resetMemoryMode();
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Phase 22 - plan step limit', () => {
  it('planner accepts plans with up to 30 steps without truncation', async () => {
    const mockPlan = makePlan(20);
    const llmHandler: LLMHandler = vi.fn(async () => JSON.stringify(mockPlan));

    const plan = await decomposeTask('Run a twenty step plan', {
      skills: 'calculator: evaluate arithmetic expressions',
    }, llmHandler);

    expect(plan.steps).toHaveLength(20);
    expect(plan.steps.map(step => step.id)).toEqual(
      Array.from({ length: 20 }, (_value, index) => `step${index + 1}`),
    );
  });

  it('plan_integrity_warning with >=3 missing steps escalates complexity to HIGH', () => {
    const events: Array<{ type: string; data: unknown }> = [];
    transparency.enable();
    const off = transparency.on(event => events.push(event));
    const plan = makePlan(8, 'MEDIUM');

    applyPlanIntegrityPolicy(plan, makeMissingIntegrity(['step9', 'step10', 'step11']));
    off();

    expect(plan.complexity).toBe('HIGH');
    expect(events.some(event => event.type === 'plan_integrity_warning')).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'complexity_escalation',
      data: { reason: 'plan_integrity_missing_steps', missing: 3 },
    }));
  });

  it('plan_integrity_warning with <3 missing steps does NOT escalate', () => {
    const events: Array<{ type: string; data: unknown }> = [];
    transparency.enable();
    const off = transparency.on(event => events.push(event));
    const plan = makePlan(8, 'MEDIUM');

    applyPlanIntegrityPolicy(plan, makeMissingIntegrity(['step9', 'step10']));
    off();

    expect(plan.complexity).toBe('MEDIUM');
    expect(events.some(event => event.type === 'plan_integrity_warning')).toBe(true);
    expect(events.some(event => event.type === 'complexity_escalation')).toBe(false);
  });
});
