/**
 * Prompt Budget — Batch 1 (Context Diet sprint)
 *
 * Typed context shapes for each engine. buildPrompt() is the single
 * assembly point; no engine should concatenate prompt parts directly.
 *
 * Current coverage: query-loop, planner, decomposition, conversational.
 * Other engines (executor, router, intake) route through this module's
 * shapes but assemble via their own loaders — migration is incremental.
 */

import type { Message } from './types.js';
import type { PermissionLevel } from './skills/types.js';
import { transparency as _t } from './transparency.js';
import { promptLoader } from './prompt-loader.js';
import { getSkillOneLinerList, getSkillCompactDescriptions } from './skills/registry.js';
import { getActivePermissionMode } from './permission.js';
import { getMemoryMode } from './memory-mode.js';
import { estimateTokens } from './context.js';
import { PROMPT_INPUT_LIMITS } from '../config/agent.config.js';

// ─── Engine-specific context shapes ───────────────────────────────────────────

export interface QueryLoopPromptContext {
  goal: string;
  pointerIndex: string;
  activeLoops: string;
}

export interface PlannerPromptContext {
  runtimeContext: string;
  planningContextSections: string;
  permissionMode: PermissionLevel;
  blockedSkillNames?: string[];
}

export interface DecompositionPromptContext {
  messageCount: number;
}

// ─── Source tracking ──────────────────────────────────────────────────────────

export interface PromptSource {
  name: string;
  tokenEstimate: number;
}

export interface BuiltPrompt {
  text: string;
  tokenEstimate: number;
  sources: PromptSource[];
  promptId: string;
}

// ─── buildPrompt ──────────────────────────────────────────────────────────────

export function buildQueryLoopSystemPrompt(ctx: QueryLoopPromptContext): BuiltPrompt {
  const memoryEnabled = getMemoryMode() === 'enabled';
  const skillList = getSkillOneLinerList(getActivePermissionMode(), { memoryEnabled });

  const activeLoopsSection = memoryEnabled && ctx.activeLoops.trim()
    ? `\n\n## Your current task state\n${ctx.activeLoops.trim()}\n\nUse this to know where you are. Do NOT re-read all memory entries to orient yourself — this section is your anchor.`
    : '';

  const indexSection = memoryEnabled && ctx.pointerIndex.trim()
    ? `\n\n## Known Entries (MEMORY.md)\n${ctx.pointerIndex.trim()}`
    : '';

  const text = promptLoader.load('query-loop', {
    skill_list: skillList,
    goal: ctx.goal,
    index_section: activeLoopsSection + indexSection,
  });

  const sources: PromptSource[] = [
    { name: 'query-loop.md', tokenEstimate: estimateTokens(text) - estimateTokens(skillList) },
    { name: 'skill_list', tokenEstimate: estimateTokens(skillList) },
  ];
  if (activeLoopsSection) sources.push({ name: 'active_loops', tokenEstimate: estimateTokens(activeLoopsSection) });
  if (indexSection) sources.push({ name: 'pointer_index', tokenEstimate: estimateTokens(indexSection) });

  return { text, tokenEstimate: estimateTokens(text), sources, promptId: 'query-loop' };
}

export function buildPlannerSystemPrompt(ctx: PlannerPromptContext): BuiltPrompt {
  const memoryEnabled = getMemoryMode() === 'enabled';
  const skills = getSkillCompactDescriptions(ctx.permissionMode, { memoryEnabled });

  const text = promptLoader.load('planner', {
    skill_descriptions: skills,
    runtime_context: ctx.runtimeContext,
    planning_context_sections: ctx.planningContextSections,
  });

  const sources: PromptSource[] = [
    { name: 'planner.md', tokenEstimate: estimateTokens(text) - estimateTokens(skills) },
    { name: 'skill_descriptions', tokenEstimate: estimateTokens(skills) },
  ];
  if (ctx.runtimeContext) sources.push({ name: 'runtime_context', tokenEstimate: estimateTokens(ctx.runtimeContext) });
  if (ctx.planningContextSections) sources.push({ name: 'memory_context', tokenEstimate: estimateTokens(ctx.planningContextSections) });

  return { text, tokenEstimate: estimateTokens(text), sources, promptId: 'planner' };
}

/** Emit a prompt-budget transparency event with source breakdown.
 *  If the prompt exceeds the per-engine limit in PROMPT_INPUT_LIMITS,
 *  also emits a prompt_budget_exceeded event. */
export function emitPromptBudget(
  t: typeof _t,
  built: BuiltPrompt,
  engine: string,
  iteration?: number,
): void {
  t.emit({
    type: 'prompt_budget',
    data: {
      engine,
      promptId: built.promptId,
      totalTokens: built.tokenEstimate,
      ...(iteration !== undefined ? { iteration } : {}),
      sources: built.sources,
    },
  });

  const limit = (PROMPT_INPUT_LIMITS as Record<string, number>)[engine];
  if (limit !== undefined && built.tokenEstimate > limit) {
    t.emit({
      type: 'prompt_budget_exceeded',
      data: {
        engine,
        promptId: built.promptId,
        totalTokens: built.tokenEstimate,
        limitTokens: limit,
        overage: built.tokenEstimate - limit,
      },
    });
  }
}

/** Build a minimal message array for a given engine's system prompt + user message. */
export function buildMinimalMessages(systemText: string, userText: string): Message[] {
  return [
    { role: 'system', content: systemText },
    { role: 'user', content: userText },
  ];
}
