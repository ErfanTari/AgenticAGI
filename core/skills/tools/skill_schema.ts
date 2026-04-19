import type { MCPSkill, SkillResult } from '../types.js';
import { getSkill } from '../registry.js';

const skillSchemaSkill: MCPSkill = {
  name: 'skill_schema',
  description: 'Get the full input schema for a skill by name. Use when you need exact parameter names/types before calling an unfamiliar skill.',
  permissionLevel: 'read-only',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name to retrieve schema for' },
    },
    required: ['name'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const name = String(input.name ?? '').trim();
    if (!name) {
      return { success: false, output: '', error: 'name is required' };
    }
    const skill = getSkill(name);
    if (!skill) {
      return { success: false, output: '', error: `Skill '${name}' not found` };
    }
    const schema = {
      name: skill.name,
      description: skill.description,
      inputSchema: skill.inputSchema,
    };
    return { success: true, output: JSON.stringify(schema, null, 2) };
  },
};

export default skillSchemaSkill;
