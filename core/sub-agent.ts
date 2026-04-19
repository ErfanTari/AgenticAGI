/**
 * Sub-Agent Primitive — Context Diet sprint, Batch 3
 *
 * Spawns a scoped sub-agent that starts with a minimal prompt.
 * The sub-agent does NOT inherit the parent's message history, memory context,
 * or full skill registry. It receives only what the parent explicitly hands off.
 *
 * Design: sub-agents run as isolated QueryLoop instances with restricted context.
 * The parent passes a compact handoff (≤500 tokens) and an explicit skill allowlist.
 */

import type { LLMHandler } from './types.js';
import { runQueryLoop, type QueryLoopResult } from './query-loop.js';
import { transparency } from './transparency.js';
import { getSkillsByPermission } from './skills/registry.js';
import { getActivePermissionMode } from './permission.js';
import { getMemoryMode } from './memory-mode.js';

export interface SubAgentTask {
  /** What the sub-agent must accomplish. Concise — this becomes the QL goal. */
  goal: string;
  /** Explicit allowlist of skill names. Sub-agent cannot call skills not in this list. */
  allowedSkills: string[];
  /** Max iterations for this sub-agent. Defaults to complexity-scaled cap. */
  maxIterations?: number;
  /** Constraints inherited from parent — injected as goal prefix. */
  inheritConstraints?: string[];
  /** Compact prose handoff from parent. Max 500 tokens (~2000 chars). */
  contextHandoff?: string;
}

export interface SubAgentResult {
  reply: string;
  iterations: number;
  skillsUsed: string[];
  stoppedBecause: QueryLoopResult['stoppedBecause'];
  success: boolean;
}

/**
 * Spawn a scoped sub-agent for an isolated subtask.
 *
 * The sub-agent gets a fresh minimal prompt. It does not see the parent's
 * message history, prior tool calls, or memory context.
 */
export async function spawnSubAgent(
  task: SubAgentTask,
  llmHandler: LLMHandler,
): Promise<SubAgentResult> {
  const mode = getActivePermissionMode();
  const memoryEnabled = getMemoryMode() === 'enabled';

  // Build a scoped skill allowlist — intersection of allowed skills and permission-filtered list
  const permittedSkills = getSkillsByPermission(mode, { memoryEnabled }).map(s => s.name);
  const scopedSkills = task.allowedSkills.filter(name => permittedSkills.includes(name));

  // Build goal with handoff context and constraints
  const goalParts: string[] = [];
  if (task.inheritConstraints && task.inheritConstraints.length > 0) {
    goalParts.push(`[CONSTRAINTS: ${task.inheritConstraints.join('; ')}]`);
  }
  if (task.contextHandoff) {
    const handoff = task.contextHandoff.slice(0, 2000); // cap at ~500 tokens
    goalParts.push(`[CONTEXT FROM PARENT]\n${handoff}\n[END CONTEXT]`);
  }
  goalParts.push(task.goal);
  const scopedGoal = goalParts.join('\n\n');

  transparency.emit({
    type: 'route',
    data: {
      level: 'sub-agent',
      reason: `spawning scoped sub-agent for: ${task.goal.slice(0, 80)}`,
      path: `skills: [${scopedSkills.join(', ')}]`,
    },
  });

  // Run as a QueryLoop with fresh context (no history, no prior artifact context)
  const result = await runQueryLoop(
    scopedGoal,
    llmHandler,
    undefined,
    [],   // no prior history
    undefined, // no artifact context
    { allowedSkillsOverride: scopedSkills, maxIterationsOverride: task.maxIterations },
  );

  return {
    reply: result.reply,
    iterations: result.iterations,
    skillsUsed: result.skillsUsed,
    stoppedBecause: result.stoppedBecause,
    success: result.stoppedBecause === 'no_action' || result.stoppedBecause === 'goal_complete',
  };
}
