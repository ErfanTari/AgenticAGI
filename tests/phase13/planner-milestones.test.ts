import { describe, expect, it, vi } from 'vitest';
import { decomposeTask } from '../../core/planner.js';
import type { LLMHandler, Message } from '../../core/types.js';

describe('Phase 13: planner milestones', () => {
  it('injects goals and memory context into the planning prompt', async () => {
    const captured: Message[][] = [];
    const llm: LLMHandler = async (messages) => {
      captured.push(messages);
      return JSON.stringify({
        goal: 'Build app',
        steps: [
          { id: 'step1', description: 'Write file', skill: 'file_writer', input: { path: 'app.ts' }, dependsOn: [] },
        ],
        estimatedDuration: '1m',
      });
    };

    const plan = await decomposeTask('build app', {
      skills: 'file_writer: write files',
      goals: [{ id: 'goal_1', sourceUnitIds: ['unit_1'], description: 'build app' }],
      memoryContext: '## unit_1\n- [HOW.PR-000001] Similar build flow',
      decompositionSummary: '- unit_1 [agentic] build app',
    }, llm);

    const prompt = captured[0].map(message => message.content).join('\n');
    expect(prompt).toContain('goal_1');
    expect(prompt).toContain('Similar build flow');
    expect(prompt).toContain('unit_1 [agentic] build app');
    expect(plan.goals).toHaveLength(1);
    expect(plan.milestones).toHaveLength(1);
  });

  it('accepts milestone-first planner output and derives flattened compatibility steps', async () => {
    const llm: LLMHandler = async () => JSON.stringify({
      goal: 'Ship feature',
      goals: [{ id: 'goal_1', sourceUnitIds: ['unit_1'], description: 'ship feature' }],
      milestones: [
        {
          id: 'm1',
          goalIds: ['goal_1'],
          title: 'Build feature',
          description: 'Feature implemented',
          completionCriteria: 'Code written',
          steps: [
            { id: 'step1', description: 'Write code', skill: 'file_writer', input: { path: 'feature.ts' }, dependsOn: [] },
          ],
        },
        {
          id: 'm2',
          goalIds: ['goal_1'],
          title: 'Verify feature',
          description: 'Feature verified',
          completionCriteria: 'Tests pass',
          steps: [
            { id: 'step2', description: 'Run tests', skill: 'run_bash', input: { command: 'pnpm test' }, dependsOn: ['step1'] },
          ],
        },
      ],
      complexity: 'MEDIUM',
      needsConfirmation: false,
      estimatedDuration: '10m',
    });

    const plan = await decomposeTask('ship feature', { skills: 'file_writer, run_bash' }, llm);

    expect(plan.milestones).toHaveLength(2);
    expect(plan.steps.map(step => step.id)).toEqual(['step1', 'step2']);
    expect(plan.complexity).toBe('MEDIUM');
  });
});
