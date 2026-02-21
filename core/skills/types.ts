import type { Intent } from '../types.js';

/** MCP-compatible skill result */
export interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
}

/** MCP-compatible universal skill interface */
export interface MCPSkill {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  execute(input: Record<string, unknown>): Promise<SkillResult>;
}

/** Legacy skill descriptor (used by context builder for prompt injection) */
export interface Skill {
  name: string;
  description: string;
  intents: Intent[];
}
