import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPlan } from '../../core/schemas.js';
import type { LLMHandler } from '../../core/types.js';

const sequence: string[] = [];
const mocks = vi.hoisted(() => ({
  runSkill: vi.fn(async (_name: string, input: Record<string, unknown>) => {
    sequence.push(`step:${String(input.expression ?? input.command ?? 'unknown')}`);
    return { success: true, output: String(input.expression ?? input.command ?? 'ok'), retries: 0 };
  }),
  createPlanEX: vi.fn(() => 'PLAN.EX-000001'),
  loadActivePlanEX: vi.fn(() => null),
  savePlanEX: vi.fn((entry: { next_milestone_id?: string }) => {
    sequence.push(`planex:${entry.next_milestone_id ?? 'done'}`);
  }),
  writeEpisodicEvent: vi.fn(async (input: { task_name: string }) => {
    sequence.push(`ev:${input.task_name}`);
    return `WHEN.EV-${String(sequence.length).padStart(6, '0')}`;
  }),
  upsertEntry: vi.fn(() => ({ code: 'HOW.PR-000001', created: true })),
  addRelationship: vi.fn((input: { from_code: string; to_code: string }) => {
    sequence.push(`rel:${input.from_code}->${input.to_code}`);
  }),
  getRelationshipsFrom: vi.fn(() => []),
  logExecution: vi.fn(() => undefined),
}));

vi.mock('../../core/skills/runner.js', () => ({
  runSkill: mocks.runSkill,
}));

vi.mock('../../core/memory/plan-ex.js', () => ({
  createPlanEX: mocks.createPlanEX,
  loadActivePlanEX: mocks.loadActivePlanEX,
  savePlanEX: mocks.savePlanEX,
}));

vi.mock('../../core/memory/episodic.js', () => ({
  writeEpisodicEvent: mocks.writeEpisodicEvent,
}));

vi.mock('../../core/memory/write.js', () => ({
  upsertEntry: mocks.upsertEntry,
}));

vi.mock('../../core/memory/relationships.js', () => ({
  addRelationship: mocks.addRelationship,
  getRelationshipsFrom: mocks.getRelationshipsFrom,
}));

vi.mock('../../core/memory/execution-log.js', () => ({
  logExecution: mocks.logExecution,
}));

import { executePlan } from '../../core/executor.js';

const mockLLM: LLMHandler = async () => '{}';

function makePlan(): TaskPlan {
  const step1 = { id: 'step1', description: 'First', skill: 'calculator', input: { expression: '1+1' }, dependsOn: [], optional: false };
  const step2 = { id: 'step2', description: 'Second', skill: 'calculator', input: { expression: '2+2' }, dependsOn: [], optional: false };
  return {
    goal: 'Milestone write order',
    steps: [step1, step2],
    goals: [{ id: 'goal_1', sourceUnitIds: ['unit_1'], description: 'write order' }],
    milestones: [
      { id: 'm1', goalIds: ['goal_1'], title: 'First milestone', description: 'First done', completionCriteria: '1+1 executed', steps: [step1] },
      { id: 'm2', goalIds: ['goal_1'], title: 'Second milestone', description: 'Second done', completionCriteria: '2+2 executed', steps: [step2] },
    ],
    complexity: 'MEDIUM',
    needsConfirmation: false,
    createdAt: '2026-03-06T00:00:00.000Z',
  };
}

describe('Phase 13: milestone memory write cycle', () => {
  beforeEach(() => {
    sequence.length = 0;
    vi.clearAllMocks();
  });

  it('writes WHEN.EV and updates PLAN.EX after milestone 1 before milestone 2 starts', async () => {
    await executePlan(makePlan(), mockLLM);

    expect(sequence.indexOf('step:1+1')).toBeGreaterThanOrEqual(0);
    expect(sequence.indexOf('ev:Milestone write order — First milestone')).toBeGreaterThan(sequence.indexOf('step:1+1'));
    expect(sequence.indexOf('planex:m2')).toBeGreaterThan(sequence.indexOf('ev:Milestone write order — First milestone'));
    expect(sequence.indexOf('step:2+2')).toBeGreaterThan(sequence.indexOf('planex:m2'));
    expect(mocks.addRelationship).not.toHaveBeenCalled();
    expect(mocks.writeEpisodicEvent).toHaveBeenCalledTimes(2);
  });
});
