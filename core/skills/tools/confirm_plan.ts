/**
 * confirm_plan skill — Plan confirmation state management (compatibility/fallback)
 *
 * ARCHITECTURAL NOTE: Plan confirmation is now primarily handled by the agent's
 * deterministic confirmation interceptor (agent.ts, classifyConfirmationResponse).
 * The interceptor runs at step [0] before any routing and executes/cancels plans
 * without calling this skill.
 *
 * This skill exists as a compatibility shim for scenarios where the LLM somehow
 * reaches the skill routing layer while a plan is pending. Normal flow:
 * 1. User response arrives
 * 2. Agent interceptor classifies it (approve/reject/ambiguous)
 * 3. Agent handles execution or re-prompt
 * 4. Pending state cleared by agent
 * 5. This skill is NOT called
 */

import type { MCPSkill, SkillResult } from '../types.js';
import { transparency } from '../../transparency.js';

// Module state: holds the pending plan between confirmation requests
let _pendingConfirmationPlan: any = null;

export function setPendingConfirmationPlan(plan: any): void {
  _pendingConfirmationPlan = plan;
}

export function getPendingConfirmationPlan(): any {
  return _pendingConfirmationPlan;
}

export function clearPendingConfirmationPlan(): void {
  _pendingConfirmationPlan = null;
}

const confirmPlanSkill: MCPSkill = {
  name: 'confirm_plan',
  description: 'Handle LLM decision on pending plan (approve/reject/unclear). Compatibility shim; normally handled by agent interceptor.',
  permissionLevel: 'workspace-write',

  inputSchema: {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        enum: ['approve', 'reject', 'unclear'],
        description: 'Decision: approve, reject, or unclear',
      },
      reason: {
        type: 'string',
        description: 'Optional reason for unclear responses',
      },
    },
    required: ['decision'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const decision = String(input.decision ?? '').toLowerCase();

    if (!['approve', 'reject', 'unclear'].includes(decision)) {
      return {
        success: false,
        output: '',
        error: `Invalid decision: "${decision}". Must be: approve, reject, or unclear.`,
      };
    }

    if (decision === 'approve' || decision === 'reject') {
      const plan = getPendingConfirmationPlan();
      if (!plan) {
        return {
          success: false,
          output: '',
          error: `No plan pending confirmation to ${decision}.`,
        };
      }

      // Fallback path: if the skill is called, clear the pending plan.
      // Normal flow: agent interceptor clears this before skill is invoked.
      clearPendingConfirmationPlan();
      if (decision === 'approve') {
        transparency.emit({
          type: 'plan_confirmed',
          data: { goal: plan.goal ?? 'unknown' },
        });
        return {
          success: true,
          output: JSON.stringify({ decision: 'approve', executed: true }),
        };
      }

      transparency.emit({
        type: 'plan_rejected',
        data: { goal: plan.goal ?? 'unknown' },
      });
      return {
        success: true,
        output: JSON.stringify({ decision: 'reject', cleared: true }),
      };
    }

    // decision === 'unclear' — keep plan pending, need more clarification
    const reason = String(input.reason ?? 'Need clarification from user');
    transparency.emit({
      type: 'plan_confirmation_ambiguous',
      data: { userMessage: reason },
    });
    return {
      success: true,
      output: JSON.stringify({ decision: 'unclear', reason }),
    };
  },
};

export default confirmPlanSkill;
