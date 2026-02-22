import type { MCPSkill, SkillResult } from '../types.js';
import { registerSkill } from '../store.js';

function toTitle(text: string): string {
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, c => c.toUpperCase());
}

const taskPlannerSkill: MCPSkill = {
  name: 'task_planner',
  description: 'Break a complex goal into ordered, executable steps with checkpoints.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Goal to break down into steps' },
      context: { type: 'string', description: 'Optional context or constraints' },
      maxSteps: { type: 'number', description: 'Max number of steps to return (default 8, max 20)' },
    },
    required: ['goal'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const goal = String(input.goal ?? '').trim();
    if (!goal) {
      return { success: false, output: '', error: 'No goal provided' };
    }

    const context = String(input.context ?? '').trim();
    const maxStepsRaw = Number(input.maxSteps ?? 8);
    const maxSteps = Math.max(3, Math.min(20, Number.isFinite(maxStepsRaw) ? Math.floor(maxStepsRaw) : 8));

    const seedSteps = [
      `Clarify requirements for: ${toTitle(goal)}`,
      'Inspect relevant files and current behavior',
      'Draft implementation approach and risks',
      'Implement smallest viable change',
      'Run compiler and tests',
      'Analyze failures and patch issues',
      'Repeat implement/test until green',
      'Summarize changes and verification evidence',
    ];

    const steps = seedSteps.slice(0, maxSteps);
    const lines = ['Execution plan:'];
    steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    if (context) {
      lines.push('');
      lines.push(`Context: ${context}`);
    }

    return { success: true, output: lines.join('\n') };
  },
};

registerSkill(taskPlannerSkill);
export default taskPlannerSkill;
