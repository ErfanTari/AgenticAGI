/**
 * request_permission skill
 *
 * When the agent needs to run a skill that requires a higher permission level
 * than currently active (e.g. run_bash requires full-access but mode is workspace-write),
 * the agent calls this skill to pause and ask the user to approve the escalation.
 *
 * On the next processMessage call, the pending request is detected:
 * - If user approves → PERMISSION_MODE is elevated for the session and loop resumes.
 * - If user denies  → loop resumes with denial recorded so agent can take a different path.
 */

import type { MCPSkill, SkillResult } from '../types.js';
import { savePendingPermissionRequest } from '../../memory/index.js';
import { transparency } from '../../transparency.js';
import { getActivePermissionMode } from '../../permission.js';

export const requestPermissionSkill: MCPSkill = {
  name: 'request_permission',
  description: 'Ask the user to approve a permission escalation so a higher-level skill can run. Use when a skill fails with a permission-denied error. Example: call this when run_bash is blocked by workspace-write mode.',
  permissionLevel: 'read-only',
  inputSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The skill that was denied (e.g. "run_bash")',
      },
      required_level: {
        type: 'string',
        description: 'The permission level the skill needs (e.g. "full-access")',
      },
      reason: {
        type: 'string',
        description: 'Why the agent needs this skill — what it is trying to accomplish (e.g. "Download PDF catalogs from the web using curl")',
      },
    },
    required: ['skill', 'required_level', 'reason'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const skill = String(input.skill ?? '').trim();
    const required = String(input.required_level ?? '').trim();
    const reason = String(input.reason ?? '').trim();

    if (!skill || !required || !reason) {
      return { success: false, output: '', error: 'skill, required_level, and reason are all required' };
    }

    const currentMode = getActivePermissionMode();

    savePendingPermissionRequest(skill, required, reason);
    transparency.emit({ type: 'permission_escalation_requested', data: { skill, required, reason } });

    return {
      success: true,
      output: `Permission escalation requested. Current mode: ${currentMode}. Needed: ${required}. Waiting for user approval to use '${skill}': ${reason}`,
    };
  },
};
