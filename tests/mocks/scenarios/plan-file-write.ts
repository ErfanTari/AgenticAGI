/**
 * Planner scenario: file write with 2 steps
 * Returns a plan: write file + verify
 */
import type { MockScenario } from '../MockLLMHandler.js';

export const planFileWrite: MockScenario[] = [
  {
    trigger: 'write hello world',
    response: JSON.stringify({
      goal: 'write hello world to hello.txt',
      complexity: 'LOW',
      milestones: [{ id: 'M1', title: 'Write file', steps: ['step-1'] }],
      steps: [
        {
          id: 'step-1',
          skill: 'file_writer',
          description: 'Write hello world',
          input: { path: 'hello.txt', content: 'hello world' },
          dependsOn: [],
        },
      ],
    }),
  },
];
