import { evaluate } from 'mathjs';
import type { MCPSkill, SkillResult } from '../types.js';

const calculatorSkill: MCPSkill = {
  name: 'calculator',
  description: 'Calculate mathematical expressions. Use for any arithmetic, percentages, conversions.',
  permissionLevel: 'read-only',
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
      // Catch division by zero and other non-finite results
      if (typeof result === 'number' && (!isFinite(result) || isNaN(result))) {
        return { success: false, output: '', error: `Math error: result is ${String(result)} (e.g. division by zero)` };
      }
      return { success: true, output: `${expression} = ${String(result)}` };
    } catch {
      return { success: false, output: '', error: `Invalid expression: ${expression}` };
    }
  },
};

export default calculatorSkill;
