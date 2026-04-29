import type { SubAgentProfile } from './types.js';

export type SubAgentProfileConfig = {
  toolWhitelist: string[];
  contextBudgetTokens: number;
  maxIterations: number;
  modelKey: 'planner' | 'executor' | 'qwen-plan';
  promptFile: string;
};

export const SUBAGENT_PROFILES: Record<SubAgentProfile, SubAgentProfileConfig> = {
  explore: {
    toolWhitelist: ['grep_workspace', 'list_dir', 'glob', 'file_reader', 'memory_read'],
    contextBudgetTokens: 8000,
    maxIterations: 10,
    modelKey: 'executor', // Gemma 4 26B
    promptFile: 'prompts/subagent-explore.md',
  },
  plan: {
    toolWhitelist: ['memory_read', 'memory_write', 'confirm_plan'],
    contextBudgetTokens: 6000,
    maxIterations: 5,
    modelKey: 'qwen-plan', // Qwen 3.6 35B
    promptFile: 'prompts/subagent-plan.md',
  },
  task: {
    toolWhitelist: [
      'file_reader', 'file_writer', 'patch_file', 'grep_workspace', 'list_dir',
      'verify_state', 'run_bash', 'task_tracker', 'memory_read', 'memory_write',
      'fetch_url_clean', 'download_file', 'view_image',
    ],
    contextBudgetTokens: 12000,
    maxIterations: 20,
    modelKey: 'executor', // Gemma 4 26B
    promptFile: 'prompts/subagent-task.md',
  },
};
