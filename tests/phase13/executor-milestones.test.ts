import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transparency } from '../../core/transparency.js';
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
  addRelationship: vi.fn(() => undefined),
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
    goal: 'Two milestone plan',
    steps: [step1, step2],
    goals: [{ id: 'goal_1', sourceUnitIds: ['unit_1'], description: 'two milestone plan' }],
    milestones: [
      { id: 'm1', goalIds: ['goal_1'], title: 'First milestone', description: 'First done', completionCriteria: '1+1 executed', steps: [step1] },
      { id: 'm2', goalIds: ['goal_1'], title: 'Second milestone', description: 'Second done', completionCriteria: '2+2 executed', steps: [step2] },
    ],
    complexity: 'MEDIUM',
    needsConfirmation: false,
    createdAt: '2026-03-06T00:00:00.000Z',
  };
}

describe('Phase 13: executor milestones', () => {
  beforeEach(() => {
    sequence.length = 0;
    vi.clearAllMocks();
  });

  it('pauses at each milestone boundary and re-enters on the next milestone only after the prior result', async () => {
    const events: string[] = [];
    transparency.enable();
    const off = transparency.on(event => {
      if (event.type === 'milestone_start') events.push(`start:${event.data.id}`);
      if (event.type === 'milestone_result') events.push(`result:${event.data.id}`);
    });

    const result = await executePlan(makePlan(), mockLLM);

    off();
    transparency.disable();

    expect(result.success).toBe(true);
    expect(result.completedMilestones).toEqual(['m1', 'm2']);
    expect(events).toEqual(['start:m1', 'result:m1', 'start:m2', 'result:m2']);
    expect(events.filter(event => event === 'start:m1')).toHaveLength(1);
  });

  it('revises the remaining milestone tail without dropping executable steps when ids change', async () => {
    const revisedEvents: Array<{ milestoneId: string; revisedCount: number }> = [];
    transparency.enable();
    const off = transparency.on(event => {
      if (event.type === 'milestone_revised') {
        revisedEvents.push(event.data as { milestoneId: string; revisedCount: number });
      }
    });

    const revisingLLM: LLMHandler = async () => JSON.stringify({
      revised: true,
      milestones: [{
        id: 'm2-revised',
        title: 'Revised second milestone',
        description: 'Updated tail',
        completionCriteria: '2+2 still executed',
      }],
      reason: 'Adjust wording after milestone 1',
    });

    const result = await executePlan(makePlan(), revisingLLM);

    off();
    transparency.disable();

    // FIX 5: Reactive revision — revision is skipped on happy path (no failures).
    // The revisingLLM is never called, so m2 stays as m2 (not m2-revised).
    expect(result.success).toBe(true);
    expect(result.completedMilestones).toEqual(['m1', 'm2']);
    expect(result.completed.map(step => step.stepId)).toEqual(['step1', 'step2']);
    // No revision events fired — revision was skipped
    expect(revisedEvents).toEqual([]);
  });
});
