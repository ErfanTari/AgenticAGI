import { evaluate } from 'mathjs';
import type { MCPSkill, SkillResult } from '../types.js';
import { registerSkill } from '../store.js';

const calculatorSkill: MCPSkill = {
  name: 'calculator',
  description: 'Calculate mathematical expressions. Use for any arithmetic, percentages, conversions.',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'The math expression to evaluate' },
    },
    required: ['expression'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const expression = String(input.expression ?? '');
    if (!expression.trim()) {
      return { success: false, output: '', error: 'No expression provided' };
    }
    try {
      const result = evaluate(expression);
      return { success: true, output: `${expression} = ${String(result)}` };
    } catch {
      return { success: false, output: '', error: `Invalid expression: ${expression}` };
    }
  },
};

registerSkill(calculatorSkill);
export default calculatorSkill;
