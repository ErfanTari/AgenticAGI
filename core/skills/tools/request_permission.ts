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

// Known skill → permission level mapping for auto-defaulting required_level
const SKILL_PERMISSION_MAP: Record<string, string> = {
  run_bash: 'full-access',
  implement_and_test: 'full-access',
  file_writer: 'workspace-write',
  patch_file: 'workspace-write',
  memory_write: 'workspace-write',
  relationship_write: 'workspace-write',
  generate_and_save_file: 'workspace-write',
  confirm_plan: 'workspace-write',
  task_tracker: 'workspace-write',
  download_file: 'workspace-write',
  screenshot_url: 'workspace-write',
};

export const requestPermissionSkill: MCPSkill = {
  name: 'request_permission',
  description: 'Ask the user to approve a permission escalation so a higher-level skill can run. Use when a skill fails with a permission-denied error. Fields: skill (the denied skill name; alias: tool), required_level (the permission level needed; auto-detected from skill name if omitted), reason (what you are trying to accomplish).',
  permissionLevel: 'read-only',
  inputSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The skill that was denied (e.g. "run_bash"). Alias: "tool" is also accepted.',
      },
      required_level: {
        type: 'string',
        description: 'The permission level the skill needs (e.g. "full-access"). Auto-detected from skill name if omitted.',
      },
      reason: {
        type: 'string',
        description: 'Why the agent needs this skill — what it is trying to accomplish (e.g. "Download PDF catalogs using curl")',
      },
    },
    required: ['reason'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    // Normalize: accept "tool" as an alias for "skill"
    const rawSkill = input.skill ?? input.tool ?? '';
    const skill = String(rawSkill).trim();

    // Auto-detect required_level from skill name if not provided
    const rawLevel = input.required_level ?? (skill ? SKILL_PERMISSION_MAP[skill] : undefined) ?? '';
    const required = String(rawLevel).trim();

    const reason = String(input.reason ?? '').trim();

    if (!skill) {
      return { success: false, output: '', error: 'Missing field: skill (or alias: tool). Provide the name of the denied skill, e.g. "run_bash".' };
    }
    if (!required) {
      return { success: false, output: '', error: `Missing field: required_level. Provide the permission level needed (e.g. "full-access", "workspace-write"). Known skills: ${Object.keys(SKILL_PERMISSION_MAP).join(', ')}.` };
    }
    if (!reason) {
      return { success: false, output: '', error: 'Missing field: reason. Explain what you are trying to accomplish.' };
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
