import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assertNotNested, setNestingFlag, clearNestingFlag } from './nesting-gate.js';
import { SUBAGENT_PROFILES } from './registry.js';
import { extractSummary } from './summarizer.js';
import type { SubAgentContext, SubAgentResult, SubAgentSummary, ToolCallRecord } from './types.js';
import { spawnSubAgent } from '../sub-agent.js';
import { transparency } from '../transparency.js';
import type { LLMHandler } from '../types.js';
import {
  getPrimaryLLMProfile,
  withLLMRuntime,
  callLLM,
} from '../llm.js';
import { PLANNER_CONFIG, EXECUTOR_CONFIG, SUBAGENT_CONFIG } from '../../config/agent.config.js';

// ─── Model resolution ─────────────────────────────────────────────────────────

function buildModelOverrideProfile(model: string) {
  const base = getPrimaryLLMProfile();
  if (!base || base.kind !== 'openai-compatible') return base;
  return { ...base, model, label: `subagent-${model}` };
}

function resolveModelForKey(key: 'planner' | 'executor' | 'qwen-plan'): string {
  switch (key) {
    case 'planner': return PLANNER_CONFIG.model;
    case 'executor': return EXECUTOR_CONFIG.model;
    case 'qwen-plan': return SUBAGENT_CONFIG.qwenPlanModel;
  }
}

function buildSubAgentHandler(modelKey: 'planner' | 'executor' | 'qwen-plan'): LLMHandler {
  const model = resolveModelForKey(modelKey);
  const profile = buildModelOverrideProfile(model);
  // Return a handler that uses the given model profile
  return async (messages, options) => {
    return withLLMRuntime(
      { primary: profile, fallback: null },
      () => callLLM(messages, options),
    );
  };
}

// ─── Template rendering ────────────────────────────────────────────────────────

function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// ─── Tool-call history extraction ─────────────────────────────────────────────
// The transparency bus captures skill calls. For simplicity we collect them from
// the sub-agent's reply string (skills emit their name/args via narration events).
// A production-grade version would hook the bus. This is sufficient for fallback summaries.
function parseToolCallHistory(_reply: string): ToolCallRecord[] {
  // The reply from spawnSubAgent doesn't expose a structured tool-call log directly.
  // Return empty — the JSON-block parser in summarizer handles the structured case.
  // The fallback summary uses this for a best-effort history parse; empty is safe.
  return [];
}

// ─── Main runner ──────────────────────────────────────────────────────────────

export async function runSubAgent(
  ctx: SubAgentContext,
  llmHandler?: LLMHandler,
): Promise<SubAgentResult> {
  assertNotNested();
  setNestingFlag();

  const profileConfig = SUBAGENT_PROFILES[ctx.profile];
  const subRequestId = `${ctx.parentRequestId}.sub-${ctx.profile}-${randomUUID().slice(0, 8)}`;

  transparency.emit({
    type: 'subagent_start',
    data: { parentRequestId: ctx.parentRequestId, subRequestId, profile: ctx.profile, goal: ctx.goal },
  });

  try {
    // Load and render prompt template
    let promptTemplate: string;
    try {
      promptTemplate = await readFile(profileConfig.promptFile, 'utf-8');
    } catch {
      promptTemplate = `You are a ${ctx.profile} sub-agent. Goal: {{goal}}`;
    }

    const renderedPrompt = renderPrompt(promptTemplate, {
      goal: ctx.goal,
      inheritedSummary: ctx.inheritedSummary ?? '',
      toolWhitelist: profileConfig.toolWhitelist.join(', '),
    });

    // Build handler — use provided handler (for tests) or build from model key
    const handler = llmHandler ?? buildSubAgentHandler(profileConfig.modelKey);

    // Run the sub-agent using the existing spawnSubAgent primitive
    const result = await spawnSubAgent(
      {
        goal: renderedPrompt,
        allowedSkills: profileConfig.toolWhitelist,
        maxIterations: profileConfig.maxIterations,
        contextHandoff: ctx.inheritedSummary,
      },
      handler,
    );

    const toolHistory = parseToolCallHistory(result.reply);
    const summary = extractSummary(ctx.profile, result.reply, toolHistory);

    transparency.emit({
      type: 'subagent_complete',
      data: {
        parentRequestId: ctx.parentRequestId,
        subRequestId,
        profile: ctx.profile,
        iterations: result.iterations,
        summary,
      },
    });

    return {
      success: true,
      profile: ctx.profile,
      summary,
      tokensUsed: 0, // token counting via transparency bus — not surfaced from spawnSubAgent
      iterations: result.iterations,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    transparency.emit({
      type: 'subagent_failed',
      data: { parentRequestId: ctx.parentRequestId, subRequestId, profile: ctx.profile, error: msg },
    });
    return { success: false, profile: ctx.profile, error: msg };
  } finally {
    clearNestingFlag();
  }
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export type SubAgentPipelineResult = {
  reply: string;
  exploreResult: SubAgentResult;
  planResult: SubAgentResult;
  taskResults: SubAgentResult[];
};

export async function runSubAgentPipeline(
  goal: string,
  parentRequestId: string,
  llmHandler: LLMHandler,
): Promise<SubAgentPipelineResult> {
  // 1. Explore
  const exploreResult = await runSubAgent({
    parentRequestId,
    profile: 'explore',
    goal: `Map the relevant code for: ${goal}`,
  }, llmHandler);

  if (!exploreResult.success) {
    const fallbackReply = `Sub-agent explore phase failed: ${(exploreResult as { error: string }).error}`;
    return { reply: fallbackReply, exploreResult, planResult: { success: false, profile: 'plan', error: 'skipped' }, taskResults: [] };
  }

  const exploreSummary = (exploreResult as { success: true; summary: SubAgentSummary }).summary;

  // 2. Plan (Qwen)
  const planResult = await runSubAgent({
    parentRequestId,
    profile: 'plan',
    goal,
    inheritedSummary: exploreSummary.narrative + '\n\n' + JSON.stringify(exploreSummary, null, 2),
  }, llmHandler);

  if (!planResult.success || !(planResult as { success: true; summary: SubAgentSummary }).summary.milestones) {
    return { reply: assembleFallbackReply(exploreResult, planResult), exploreResult, planResult, taskResults: [] };
  }

  const planSummary = (planResult as { success: true; summary: SubAgentSummary }).summary;

  // 3. Task agents — one per milestone in order
  const taskResults: SubAgentResult[] = [];
  for (const milestone of planSummary.milestones ?? []) {
    const taskResult = await runSubAgent({
      parentRequestId,
      profile: 'task',
      goal: `${milestone.title}\n\nCompletion criteria: ${milestone.criteria}`,
    }, llmHandler);
    taskResults.push(taskResult);
    if (!taskResult.success) break;
  }

  return {
    reply: assembleReply(exploreResult, planResult, taskResults),
    exploreResult,
    planResult,
    taskResults,
  };
}

function assembleFallbackReply(explore: SubAgentResult, plan: SubAgentResult): string {
  const parts = ['**Sub-agent pipeline partial result:**'];
  if (explore.success) parts.push(`Explore: ${(explore as { summary: SubAgentSummary }).summary.narrative}`);
  if (!plan.success) parts.push(`Plan failed: ${(plan as { error: string }).error}`);
  return parts.join('\n');
}

function assembleReply(
  explore: SubAgentResult,
  plan: SubAgentResult,
  tasks: SubAgentResult[],
): string {
  const parts = ['**Sub-agent pipeline complete:**'];
  if (explore.success) parts.push(`**Explore:** ${(explore as { summary: SubAgentSummary }).summary.narrative}`);
  if (plan.success) parts.push(`**Plan:** ${(plan as { summary: SubAgentSummary }).summary.narrative}`);
  for (const t of tasks) {
    if (t.success) {
      const s = (t as { summary: SubAgentSummary }).summary;
      parts.push(`**Task (${s.verificationStatus ?? 'unverified'}):** ${s.narrative}`);
    } else {
      parts.push(`**Task failed:** ${(t as { error: string }).error}`);
    }
  }
  return parts.join('\n');
}
