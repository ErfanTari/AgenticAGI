import { createHash } from 'node:crypto';
import type { LLMHandler, Message } from './types.js';
import type { TaskMilestone, TaskPlan, TaskStep, VerificationResult } from './schemas.js';
import type { WorkingMemory } from './memory/working-memory.js';
import { updatePlan } from './memory/working-memory.js';
import { VerificationResultSchema, verificationJsonSchema } from './schemas.js';
import { runWithRetry } from './react.js';
import { resolveTemplates } from './planner.js';
import { transparency } from './transparency.js';
import { upsertEntry } from './memory/write.js';
import { logExecution } from './memory/execution-log.js';
import { createPlanEX, loadActivePlanEX, savePlanEX, updatePlanEX, type PlanEXEntry } from './memory/plan-ex.js';
import { getDb } from './memory/index.js';
import { addRelationship, getRelationshipsFrom } from './memory/relationships.js';
import { writeEpisodicEvent } from './memory/episodic.js';
import { memoryAgent } from './memory/memory-agent.js';

// Flatten nested objects to primitives (fixes [object Object] issue)
function flattenInput(input: Record<string, unknown>): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(input)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      // Nested object — single key: extract key as the value; multiple keys: stringify to preserve all data
      const nested = val as Record<string, unknown>;
      const nestedKeys = Object.keys(nested);
      flattened[key] = nestedKeys.length === 1 ? nestedKeys[0] : JSON.stringify(val);
    } else {
      flattened[key] = val;
    }
  }

  return flattened;
}

// --- Adaptive Execution — Phase 15, Section 3 ---

export type FailureResponse = 'RETRY' | 'REVISE' | 'ESCALATE';

export interface StepFailure {
  stepId: string;
  milestoneId?: string;
  skill: string;
  error: string;
  attempt: number;
}

export interface SubGoalAttempt {
  milestoneId: string;
  retries: number;
  revisions: number;
}

/**
 * Given a failure and current working memory context, decides how to respond.
 * RETRY  — same approach, minor variation. Max 2 retries per step.
 * REVISE — change approach for this milestone. Max 3 revisions per milestone.
 * ESCALATE — surface to user, pause execution.
 */
export function classifyFailureResponse(
  failure: StepFailure,
  _workingMemory: { goal: string } | null,
  subGoalAttempts: Map<string, SubGoalAttempt>,
): FailureResponse {
  const attempt = subGoalAttempts.get(failure.stepId);
  const milestoneAttempt = subGoalAttempts.get(failure.milestoneId ?? failure.stepId);

  const retries = attempt?.retries ?? 0;
  const revisions = milestoneAttempt?.revisions ?? 0;

  // Hard limit: too many revisions → escalate
  if (revisions >= 3) return 'ESCALATE';

  // Hard limit: too many retries → try revision
  if (retries >= 2) {
    if (revisions < 3) return 'REVISE';
    return 'ESCALATE';
  }

  // Classify failure type to decide response
  const fc = classifyFailure(failure.error);

  if (fc === 'SYNTAX_ERROR') {
    // Syntax errors are usually fixable with a retry (minor variation)
    return 'RETRY';
  }

  if (fc === 'STATE_ERROR') {
    // State errors may need a different approach
    return retries < 2 ? 'RETRY' : 'REVISE';
  }

  // CAPABILITY_ERROR — the skill genuinely can't do this
  if (fc === 'CAPABILITY_ERROR') {
    return 'REVISE';
  }

  return 'RETRY';
}

// --- Failure classification ---

export type FailureClass = 'SYNTAX_ERROR' | 'STATE_ERROR' | 'CAPABILITY_ERROR';

export function classifyFailure(error: string): FailureClass {
  const lower = error.toLowerCase();
  if (/syntax|parse|json|unexpected token|invalid|malformed/.test(lower)) {
    return 'SYNTAX_ERROR';
  }
  if (/not found|missing|does not exist|no such|undefined|null|empty|state/.test(lower)) {
    return 'STATE_ERROR';
  }
  return 'CAPABILITY_ERROR';
}

// --- Executor interfaces (Priority 4) ---

export interface CompletedStep {
  stepId: string;
  skill: string;
  output: string;
  display?: string;
  retries: number;
}

export interface FailedStep {
  stepId: string;
  skill: string;
  error: string;
  optional: boolean;
}

export interface ExecutionResult {
  success: boolean;
  completed: CompletedStep[];
  failed: FailedStep[];
  abortReason?: string;
  milestoneResults?: MilestoneExecutionResult[];
  completedMilestones?: string[];
  currentMilestoneId?: string;
  planExCode?: string;
  linkedCodes?: string[];
  escalated?: boolean;
  escalationMessage?: string;
  taskCompleteEnqueued?: boolean;
}

export interface MilestoneExecutionResult {
  milestoneId: string;
  title: string;
  success: boolean;
  completedStepIds: string[];
  failedStepIds: string[];
  eventCode?: string;
}

// --- Executor Loop (Priority 4) ---

const TOTAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STEP_DELAY_MS = 100;
const CODE_REGEX = /\b([A-Z]+\.[A-Z]+-\d{6,})\b/g;

interface ExecutionState {
  results: Map<string, string>;
  completed: CompletedStep[];
  failed: FailedStep[];
  startTime: number;
  workingMemoryId: string | null;
}

function getPlanMilestones(plan: TaskPlan): TaskMilestone[] {
  if (plan.milestones && plan.milestones.length > 0) return plan.milestones;
  return [{
    id: 'milestone_1',
    goalIds: (plan.goals ?? []).map(goal => goal.id),
    title: 'Complete task',
    description: plan.goal,
    completionCriteria: plan.steps.at(-1)?.description ?? plan.goal,
    steps: plan.steps,
  }];
}

function collectCodesFromText(text: string): string[] {
  return [...text.matchAll(CODE_REGEX)].map(match => match[1]);
}

function collectLinkedCodes(completed: CompletedStep[]): string[] {
  return [...new Set(completed.flatMap(step => collectCodesFromText(step.output)))];
}

function buildInitialPlanEX(plan: TaskPlan, milestones: TaskMilestone[]): Omit<PlanEXEntry, 'code'> {
  return {
    task_name: plan.goal,
    project_code: '',
    goal: plan.goal,
    goal_ids: (plan.goals ?? []).map(goal => goal.id),
    unit_ids: (plan.goals ?? []).flatMap(goal => goal.sourceUnitIds ?? []),
    milestones: milestones.map(milestone => ({ id: milestone.id, name: milestone.title, done: false })),
    current_milestone: 0,
    next_milestone_id: milestones[0]?.id,
    completed_milestone_ids: [],
    todos: [],
    constraints: {},
    last_action: '',
    next_action: milestones[0]?.title ?? 'Start execution',
    conf_score: 1,
    session_id: plan.createdAt,
    checkpoint_ts: new Date().toISOString(),
    started: new Date().toISOString(),
    attempt_counts: {},
    last_failures: {},
    recent_turns: [],
    loaded_memory_utility: {},
    file_checksums: {},
    revisions: [],
    linked_codes: [],
  };
}

function updatePlanExForMilestone(
  planEx: PlanEXEntry,
  milestone: TaskMilestone,
  milestoneIndex: number,
  milestones: TaskMilestone[],
  linkedCodes: string[],
): PlanEXEntry {
  const completedIds = [...new Set([...(planEx.completed_milestone_ids ?? []), milestone.id])];
  const nextMilestone = milestones[milestoneIndex + 1];
  const updatedMilestones = planEx.milestones.map(existing =>
    existing.id === milestone.id ? { ...existing, done: true } : existing,
  );

  return {
    ...planEx,
    milestones: updatedMilestones,
    current_milestone: milestoneIndex + 1,
    next_milestone_id: nextMilestone?.id,
    completed_milestone_ids: completedIds,
    last_action: milestone.title,
    next_action: nextMilestone?.title ?? 'Complete plan',
    checkpoint_ts: new Date().toISOString(),
    linked_codes: [...new Set([...(planEx.linked_codes ?? []), ...linkedCodes])],
  };
}

function inferRelationshipWrites(
  codes: string[],
  milestone: TaskMilestone,
): string[] {
  const writes: string[] = [];
  if (codes.length < 2) return writes;

  const fromCode = codes[0];
  for (const toCode of codes.slice(1)) {
    try {
      const existing = getRelationshipsFrom(fromCode, 'refers');
      if (existing.some(rel => rel.to_code === toCode)) continue;
      addRelationship({
        from_code: fromCode,
        relation: 'refers',
        to_code: toCode,
        note: `Inferred during ${milestone.id}: ${milestone.title}`,
      });
      writes.push(`relationship:${fromCode}->${toCode}`);
    } catch {
      // Skip unresolved or duplicate-like relationship writes.
    }
  }

  return writes;
}

export async function writeMilestoneMemoryCycle(
  plan: TaskPlan,
  milestone: TaskMilestone,
  milestoneIndex: number,
  milestones: TaskMilestone[],
  completedSteps: CompletedStep[],
  planEx: PlanEXEntry,
): Promise<{ planEx: PlanEXEntry; writes: string[]; eventCode?: string }> {
  const writes: string[] = [];
  const linkedCodes = collectLinkedCodes(completedSteps);

  let eventCode: string | undefined;
  try {
    eventCode = await writeEpisodicEvent({
      trigger: plan.goal,
      task_name: `${plan.goal} — ${milestone.title}`,
      skill_sequence: completedSteps.map(step => step.skill),
      outcome: 'success',
      linked_codes: linkedCodes,
      session_id: plan.createdAt,
    });
    writes.push(`WHEN.EV:${eventCode}`);
  } catch {
    // Event write is best-effort inside the cycle.
  }

  if (completedSteps.length >= 2) {
    try {
      const procedureName = `Milestone Pattern: ${milestone.title}`.slice(0, 80);
      const procedureBody = [
        `## Goal`,
        plan.goal,
        '',
        `## Milestone`,
        milestone.title,
        '',
        `## Completion Criteria`,
        milestone.completionCriteria,
        '',
        `## Steps`,
        ...completedSteps.map(step => `- ${step.skill}: ${(step.display ?? step.output).slice(0, 120)}`),
      ].join('\n');

      const { code } = upsertEntry({
        nb: 'HOW',
        type: 'PR',
        name: procedureName,
        status: 'active',
        summary: `Reusable pattern from ${milestone.title}`,
        body: procedureBody,
      });
      writes.push(`HOW.PR:${code}`);
    } catch {
      // Procedure write is optional.
    }
  }

  const updatedPlanEx = updatePlanExForMilestone(planEx, milestone, milestoneIndex, milestones, linkedCodes);
  try {
    savePlanEX(updatedPlanEx);
    if (updatedPlanEx.code) {
      writes.push(`PLAN.EX:${updatedPlanEx.code}`);
    }
  } catch {
    // PLAN.EX persistence is best-effort during executor tests and degraded environments.
  }

  writes.push(...inferRelationshipWrites(linkedCodes, milestone));
  transparency.emit({ type: 'milestone_memory_cycle', data: { milestoneId: milestone.id, writes } });

  return { planEx: updatedPlanEx, writes, eventCode };
}

const TRIVIAL_MILESTONE_KEYWORDS = /^(mkdir|package\.json|init|setup\s+directory|create\s+directory|npm\s+init)/i;

async function reviseRemainingMilestones(
  milestones: TaskMilestone[],
  completedMilestones: string[],
  currentIndex: number,
  llmHandler: LLMHandler,
): Promise<TaskMilestone[]> {
  const remaining = milestones.slice(currentIndex + 1);

  // No remaining milestones or no completed milestones → nothing to revise
  if (remaining.length === 0 || completedMilestones.length === 0) {
    return milestones;
  }

  // Skip revision for trivial steps
  const completedMilestone = milestones[currentIndex];
  if (TRIVIAL_MILESTONE_KEYWORDS.test(completedMilestone?.title ?? '')) {
    return milestones;
  }

  try {
    const completedSummary = milestones
      .filter(m => completedMilestones.includes(m.id))
      .map(m => `- ${m.id}: ${m.title} — ${m.completionCriteria}`)
      .join('\n');

    const remainingSummary = remaining
      .map(m => `- ${m.id}: ${m.title} — ${m.description}`)
      .join('\n');

    const prompt: Message[] = [
      {
        role: 'system',
        content: [
          'You are a plan revision assistant.',
          'Given completed milestones and remaining milestones, determine if the remaining milestones are still valid.',
          'Return ONLY a JSON object:',
          '{"revised": false} if no changes needed,',
          'OR {"revised": true, "milestones": [{"id": "...", "title": "...", "description": "...", "completionCriteria": "..."}], "reason": "why"}',
          'Only return revised:true if a significant change is needed. When in doubt, return revised:false.',
        ].join(' '),
      },
      {
        role: 'user',
        content: `Completed milestones:\n${completedSummary}\n\nRemaining milestones to validate:\n${remainingSummary}\n\nAre the remaining milestones still valid given what was completed?`,
      },
    ];

    const response = await llmHandler(prompt, { maxTokens: 512 });
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return milestones;

    const parsed = JSON.parse(jsonMatch[0]) as {
      revised: boolean;
      milestones?: Array<{ id: string; title: string; description: string; completionCriteria: string }>;
      reason?: string;
    };

    if (!parsed.revised) return milestones;
    if (!Array.isArray(parsed.milestones) || parsed.milestones.length === 0) return milestones;

    // Only revise milestones NOT YET STARTED — completed milestones are immutable
    const completedSet = new Set(completedMilestones);
    const originalRemaining = milestones.filter(m => !completedSet.has(m.id));

    const usedOriginalIds = new Set<string>();
    const newRemaining: TaskMilestone[] = parsed.milestones.map((r, index) => {
      const matchedOriginal = originalRemaining.find(orig => !usedOriginalIds.has(orig.id) && orig.id === r.id)
        ?? originalRemaining.find((orig, originalIndex) => !usedOriginalIds.has(orig.id) && originalIndex === index);

      if (!matchedOriginal) {
        throw new Error('Milestone revision returned an unmappable milestone tail');
      }

      usedOriginalIds.add(matchedOriginal.id);
      return {
        id: r.id,
        goalIds: matchedOriginal.goalIds,
        title: r.title,
        description: r.description,
        completionCriteria: r.completionCriteria,
        steps: matchedOriginal.steps,
      };
    });

    const revisedCount = newRemaining.length - originalRemaining.length;
    transparency.emit({
      type: 'milestone_revised',
      data: {
        milestoneId: completedMilestone.id,
        revisedCount,
        reason: parsed.reason ?? 'LLM revision',
      },
    });

    // Combine completed milestones (immutable) + new remaining
    const completedMilestonesData = milestones.filter(m => completedSet.has(m.id));
    return [...completedMilestonesData, ...newRemaining];

  } catch (err) {
    console.warn('[executor] reviseRemainingMilestones failed:', err instanceof Error ? err.message : String(err));
    return milestones; // Never abort on revision failure
  }
}

async function executeSingleStep(
  plan: TaskPlan,
  step: TaskStep,
  state: ExecutionState,
  llmHandler: LLMHandler,
): Promise<string | null> {
  if (Date.now() - state.startTime > TOTAL_TIMEOUT_MS) {
    return 'Total execution timeout (5 minutes)';
  }

  const unmetDeps = step.dependsOn.filter(dep => !state.results.has(dep + '_result') && !state.results.has(dep));
  if (unmetDeps.length > 0) {
    const firstUnmet = unmetDeps[0];
    const depFailedRequired = state.failed.some(f => f.stepId === firstUnmet && !f.optional);
    const depFailedOptional = state.failed.some(f => f.stepId === firstUnmet && f.optional);
    const depPending = !depFailedRequired && !depFailedOptional;

    if (depFailedRequired) {
      return `Dependency '${firstUnmet}' failed`;
    }

    if (depPending) {
      console.warn(`[executor] Step '${step.id}' has unmet pending dependency '${firstUnmet}' — plan ordering error, skipping`);
    }

    state.failed.push({
      stepId: step.id,
      skill: step.skill,
      error: `Blocked: dependency '${firstUnmet}' ${depPending ? 'not yet completed (ordering error)' : 'failed'}`,
      optional: step.optional ?? false,
    });

    return step.optional ? null : `Required step '${step.id}' blocked by dependency '${firstUnmet}'`;
  }

  const confScore = (step as Record<string, unknown>).confidence_score as number ?? 0.8;
  const riskLevel = (step as Record<string, unknown>).risk_level as string ?? 'LOW';
  if (confScore < 0.75 && riskLevel === 'HIGH') {
    return 'HIGH_RISK_LOW_CONFIDENCE';
  }

  let resolvedInput = resolveTemplates(step.input, state.results);
  resolvedInput = flattenInput(resolvedInput);

  const unresolvedTokens: string[] = [];
  for (const value of Object.values(resolvedInput)) {
    if (typeof value !== 'string') continue;
    const matches = value.match(/\{\{\w+\}\}/g);
    if (matches) unresolvedTokens.push(...matches);
  }

  if (unresolvedTokens.length > 0) {
    const unique = [...new Set(unresolvedTokens)];
    const optionalStoreResultAsKeys = new Set(state.failed.filter(f => f.optional).map(f => f.stepId));
    const optionalResultKeys = new Set<string>();
    for (const ps of plan.steps) {
      if (ps.optional && state.failed.some(f => f.stepId === ps.id) && ps.storeResultAs) {
        optionalResultKeys.add(ps.storeResultAs);
        optionalResultKeys.add(`${ps.storeResultAs}_result`);
      }
    }

    const unmetOptionalDeps = unique.every(token => {
      const key = token.replace(/^\{\{/, '').replace(/\}\}$/, '');
      const depId = key.replace(/_result$/, '');
      return (
        optionalStoreResultAsKeys.has(depId) ||
        optionalResultKeys.has(key) ||
        optionalResultKeys.has(depId) ||
        state.failed.some(f => f.stepId === depId && f.optional)
      );
    });

    if (unmetOptionalDeps) {
      for (const key of Object.keys(resolvedInput)) {
        if (typeof resolvedInput[key] === 'string') {
          resolvedInput[key] = (resolvedInput[key] as string).replace(/\{\{\w+\}\}/g, '');
        }
      }
    } else {
      state.failed.push({
        stepId: step.id,
        skill: step.skill,
        error: `Unresolved template values: ${unique.join(', ')}`,
        optional: step.optional ?? false,
      });
      return step.optional ? null : `Required step '${step.id}' has unresolved templates`;
    }
  }

  if (process.env.DEBUG_DEEP === 'true') {
    const inputPreview = JSON.stringify(resolvedInput).slice(0, 400);
    console.log(`[executor:DEEP] step=${step.id} skill=${step.skill} input=${inputPreview}`);
  }

  transparency.emit({ type: 'step_start', data: { step } });

  const stepStart = performance.now();
  const skillResult = await runWithRetry(step.skill, resolvedInput, llmHandler);
  const stepMs = Math.round(performance.now() - stepStart);
  transparency.emit({ type: 'step_result', data: { step, result: skillResult, ms: stepMs } });

  try {
    const artifactHash = skillResult.success
      ? createHash('sha256').update(skillResult.output ?? '').digest('hex').slice(0, 16)
      : '';
    logExecution({
      ts: new Date().toISOString(),
      session_id: plan.createdAt,
      step_id: step.id,
      skill: step.skill,
      action: step.description,
      success: skillResult.success,
      pre_hash: '',
      post_hash: artifactHash,
      artifacts: skillResult.success ? [skillResult.output?.slice(0, 100) ?? ''] : [],
      constraints: [],
      ms: stepMs,
    });
  } catch {
    // Non-fatal logging path.
  }

  if (!skillResult.success && skillResult.error) {
    const failureClass = classifyFailure(skillResult.error);
    transparency.emit({ type: 'failure_classified', data: { error: skillResult.error, class: failureClass } });
  }

  if (skillResult.success) {
    state.completed.push({
      stepId: step.id,
      skill: step.skill,
      output: skillResult.output,
      display: skillResult.display,
      retries: skillResult.retries ?? 0,
    });
    // Phase 15: enqueue step_complete event (fire-and-forget)
    const stepCodes = collectCodesFromText(skillResult.output);
    memoryAgent.enqueue({
      type: 'step_complete',
      stepId: step.id,
      result: skillResult.output.slice(0, 200),
      codes: stepCodes,
      workingMemoryId: state.workingMemoryId,
    });
    // FIX-C3: enqueue new_code for each code found in step output
    for (const code of stepCodes) {
      memoryAgent.enqueue({
        type: 'new_code',
        code,
        workingMemoryId: state.workingMemoryId,
      });
    }
    if (step.storeResultAs) {
      state.results.set(step.storeResultAs, skillResult.output);
      if (step.storeResultAs.endsWith('_result')) {
        state.results.set(step.storeResultAs.replace(/_result$/, ''), skillResult.output);
      } else {
        state.results.set(`${step.storeResultAs}_result`, skillResult.output);
      }
    }
    state.results.set(step.id + '_result', skillResult.output);
    state.results.set(step.id, skillResult.output);
  } else {
    state.failed.push({
      stepId: step.id,
      skill: step.skill,
      error: skillResult.error ?? 'Unknown error',
      optional: step.optional ?? false,
    });
    if (!step.optional) {
      return `Required step '${step.id}' failed: ${skillResult.error}`;
    }
  }

  if (STEP_DELAY_MS > 0) {
    await new Promise(resolve => setTimeout(resolve, STEP_DELAY_MS));
  }

  return null;
}

export async function executePlan(
  plan: TaskPlan,
  llmHandler: LLMHandler,
  workingMemory?: WorkingMemory,
): Promise<ExecutionResult> {
  const wm = workingMemory ?? null;
  let milestones = getPlanMilestones(plan);
  const state: ExecutionState = {
    results: new Map<string, string>(),
    completed: [],
    failed: [],
    startTime: Date.now(),
    workingMemoryId: wm?.taskId ?? null,
  };
  const milestoneResults: MilestoneExecutionResult[] = [];
  const completedMilestones: string[] = [];
  const subGoalAttempts = new Map<string, SubGoalAttempt>();

  const initialPlanEx = buildInitialPlanEX(plan, milestones);
  let planExCode: string | undefined;
  let planEx: PlanEXEntry = { ...initialPlanEx, code: '' };
  try {
    planExCode = createPlanEX(initialPlanEx);
    planEx = loadActivePlanEX() ?? { ...initialPlanEx, code: planExCode };
  } catch {
    planEx = { ...initialPlanEx, code: '' };
  }

  for (let milestoneIndex = 0; milestoneIndex < milestones.length; milestoneIndex++) {
    const milestone = milestones[milestoneIndex];
    transparency.emit({
      type: 'milestone_start',
      data: { id: milestone.id, title: milestone.title, index: milestoneIndex + 1, total: milestones.length },
    });

    const completedStart = state.completed.length;
    const failedStart = state.failed.length;

    let milestoneEscalated = false;
    let milestoneRevised = false;
    let milestoneAbortReason: string | undefined;
    for (const step of milestone.steps) {
      let abortReason = await executeSingleStep(plan, step, state, llmHandler);

      // FIX 4: Adaptive loop — RETRY → REVISE → ESCALATE instead of immediate abort
      // Exception: hard-abort conditions (HIGH_RISK_LOW_CONFIDENCE, timeouts) bypass the loop
      const isHardAbort = abortReason === 'HIGH_RISK_LOW_CONFIDENCE' || (abortReason?.includes('timeout') ?? false);
      if (abortReason && isHardAbort) {
        milestoneEscalated = true;
        milestoneAbortReason = abortReason;
        milestoneResults.push({
          milestoneId: milestone.id,
          title: milestone.title,
          success: false,
          completedStepIds: state.completed.slice(completedStart).map(item => item.stepId),
          failedStepIds: state.failed.slice(failedStart).map(item => item.stepId),
        });
        transparency.emit({
          type: 'milestone_result',
          data: { id: milestone.id, title: milestone.title, success: false, index: milestoneIndex + 1, total: milestones.length },
        });
        try {
          savePlanEX({
            ...planEx,
            status: 'failed',
            abort_reason: abortReason,
            current_milestone: milestoneIndex,
            next_milestone_id: milestone.id,
            next_action: milestone.title,
            checkpoint_ts: new Date().toISOString(),
            last_failures: { ...planEx.last_failures, [milestone.id]: abortReason },
          });
        } catch { /* best-effort */ }
        return {
          success: false,
          completed: state.completed,
          failed: state.failed,
          abortReason,
          milestoneResults,
          completedMilestones,
          currentMilestoneId: milestone.id,
          planExCode: planEx.code,
          linkedCodes: collectLinkedCodes(state.completed),
          escalated: true,
          escalationMessage: abortReason,
        };
      }

      if (abortReason) {
        // Find the last failure for this step
        const failedForStep = state.failed.filter(f => f.stepId === step.id);
        const lastFailed = failedForStep[failedForStep.length - 1];
        const failure: StepFailure = {
          stepId: step.id,
          milestoneId: milestone.id,
          skill: step.skill,
          error: lastFailed?.error ?? abortReason,
          attempt: (subGoalAttempts.get(step.id)?.retries ?? 0) + 1,
        };

        const response = classifyFailureResponse(failure, wm ? { goal: wm.goal } : null, subGoalAttempts);

        if (response === 'RETRY') {
          // Increment retry counter
          const existing = subGoalAttempts.get(step.id) ?? { milestoneId: milestone.id, retries: 0, revisions: 0 };
          subGoalAttempts.set(step.id, { ...existing, retries: existing.retries + 1 });

          // Remove the last failed entry for this step so it can be retried
          for (let i = state.failed.length - 1; i >= 0; i--) {
            if (state.failed[i].stepId === step.id) {
              state.failed.splice(i, 1);
              break;
            }
          }

          // Re-run the step
          abortReason = await executeSingleStep(plan, step, state, llmHandler);

          if (!abortReason) continue; // Retry succeeded — proceed to next step
          // Retry also failed — fall through to check remaining options
        }

        if (response === 'REVISE' || (response === 'RETRY' && abortReason)) {
          // Increment revision counter for this milestone
          const milestoneAttempt = subGoalAttempts.get(milestone.id) ?? { milestoneId: milestone.id, retries: 0, revisions: 0 };
          subGoalAttempts.set(milestone.id, { ...milestoneAttempt, revisions: milestoneAttempt.revisions + 1 });

          // Revise remaining milestones given the failure context
          milestones = await reviseRemainingMilestones(milestones, completedMilestones, milestoneIndex, llmHandler);

          // Update working memory plan with revised milestones
          if (wm) {
            await updatePlan(wm, milestones);
          }

          // Log milestone as failed-but-revised, continue to next milestone
          const milestoneResult: MilestoneExecutionResult = {
            milestoneId: milestone.id,
            title: milestone.title,
            success: false,
            completedStepIds: state.completed.slice(completedStart).map(item => item.stepId),
            failedStepIds: state.failed.slice(failedStart).map(item => item.stepId),
          };
          milestoneResults.push(milestoneResult);
          transparency.emit({
            type: 'milestone_result',
            data: { id: milestone.id, title: milestone.title, success: false, index: milestoneIndex + 1, total: milestones.length },
          });
          milestoneRevised = true;
          break; // Break out of step loop — skip to next milestone
        }

        if (response === 'ESCALATE' || abortReason) {
          // ESCALATE: mark planEx as paused, return with escalated flag
          milestoneEscalated = true;
          milestoneAbortReason = abortReason ?? lastFailed?.error ?? 'Escalated after too many failures';

          const milestoneResult: MilestoneExecutionResult = {
            milestoneId: milestone.id,
            title: milestone.title,
            success: false,
            completedStepIds: state.completed.slice(completedStart).map(item => item.stepId),
            failedStepIds: state.failed.slice(failedStart).map(item => item.stepId),
          };
          milestoneResults.push(milestoneResult);
          transparency.emit({
            type: 'milestone_result',
            data: { id: milestone.id, title: milestone.title, success: false, index: milestoneIndex + 1, total: milestones.length },
          });
          try {
            savePlanEX({
              ...planEx,
              status: 'paused',
              abort_reason: milestoneAbortReason,
              current_milestone: milestoneIndex,
              next_milestone_id: milestone.id,
              next_action: milestone.title,
              checkpoint_ts: new Date().toISOString(),
              last_failures: {
                ...planEx.last_failures,
                [milestone.id]: milestoneAbortReason,
              },
            });
          } catch {
            // PLAN.EX persistence is best-effort.
          }
          return {
            success: false,
            completed: state.completed,
            failed: state.failed,
            abortReason: milestoneAbortReason,
            milestoneResults,
            completedMilestones,
            currentMilestoneId: milestone.id,
            planExCode: planEx.code,
            linkedCodes: collectLinkedCodes(state.completed),
            escalated: true,
            escalationMessage: milestoneAbortReason,
          };
        }
      }
    }

    if (milestoneEscalated || milestoneRevised) continue; // Skip milestone completion logic

    completedMilestones.push(milestone.id);
    // Phase 15: enqueue milestone_complete event (fire-and-forget)
    memoryAgent.enqueue({
      type: 'milestone_complete',
      milestoneId: milestone.id,
      summary: milestone.title,
      workingMemoryId: wm?.taskId ?? null,
      planExCode: planEx.code || undefined,
    });
    const completedInMilestone = state.completed.slice(completedStart);
    const cycle = await writeMilestoneMemoryCycle(
      plan,
      milestone,
      milestoneIndex,
      milestones,
      completedInMilestone,
      planEx,
    );
    if (cycle.planEx.code) {
      planEx = cycle.planEx;
    }

    milestoneResults.push({
      milestoneId: milestone.id,
      title: milestone.title,
      success: true,
      completedStepIds: completedInMilestone.map(item => item.stepId),
      failedStepIds: state.failed.slice(failedStart).map(item => item.stepId),
      eventCode: cycle.eventCode,
    });
    transparency.emit({
      type: 'milestone_result',
      data: { id: milestone.id, title: milestone.title, success: true, index: milestoneIndex + 1, total: milestones.length },
    });

    milestones = await reviseRemainingMilestones(milestones, completedMilestones, milestoneIndex, llmHandler);
  }

  try {
    savePlanEX({
      ...planEx,
      status: 'complete',
      abort_reason: undefined,
      current_milestone: milestones.length,
      next_milestone_id: null,
      completed_milestone_ids: completedMilestones,
      next_action: 'Complete plan',
      checkpoint_ts: new Date().toISOString(),
      linked_codes: collectLinkedCodes(state.completed),
    });
  } catch {
    // PLAN.EX persistence is best-effort.
  }

  // Phase 15 FIX 3: enqueue task_complete event (fire-and-forget)
  memoryAgent.enqueue({
    type: 'task_complete',
    workingMemory: wm ?? undefined,
    workingMemoryId: wm?.taskId ?? null,
  });

  // FIX-4: Safety — ensure PLAN.EX is in terminal state if it was created
  if (planEx.code) {
    try {
      const db = getDb();
      const currentPlanEx = db.prepare(
        "SELECT status FROM index_entries WHERE code = ?"
      ).get(planEx.code) as { status: string } | undefined;
      if (currentPlanEx && !['complete', 'failed', 'paused'].includes(currentPlanEx.status)) {
        updatePlanEX(planEx.code, {
          status: state.failed.length === 0 ? 'complete' : 'failed',
        });
      }
    } catch { /* non-fatal */ }
  }

  return {
    success: state.failed.length === 0,
    completed: state.completed,
    failed: state.failed,
    milestoneResults,
    completedMilestones,
    currentMilestoneId: milestones.at(-1)?.id,
    planExCode: planEx.code,
    linkedCodes: collectLinkedCodes(state.completed),
    taskCompleteEnqueued: true,
  };
}

// --- Execution Verification (Priority 5) ---

export async function verifyExecution(
  plan: TaskPlan,
  result: ExecutionResult,
  llmHandler: LLMHandler,
): Promise<VerificationResult> {
  try {
    const completedSummary = result.completed
      .map(s => `- [DONE] ${s.stepId} (${s.skill}): ${s.output.slice(0, 200)}`)
      .join('\n');

    const failedSummary = result.failed
      .map(s => `- [FAILED] ${s.stepId} (${s.skill}): ${s.error}`)
      .join('\n');

    const prompt: Message[] = [
      {
        role: 'system',
        content: `You are a task verification assistant. Given a plan and its execution results, assess whether the goal was achieved.
Return ONLY a JSON object: {"verified": true/false, "confidence": 0.0-1.0, "issues": ["issue1"], "suggestion": "optional fix"}`,
      },
      {
        role: 'user',
        content: `Goal: ${plan.goal}
Plan had ${plan.steps.length} steps.

Completed steps:
${completedSummary || '(none)'}

Failed steps:
${failedSummary || '(none)'}

Was the goal achieved?`,
      },
    ];

    const response = await llmHandler(prompt, {
      responseSchema: verificationJsonSchema,
      maxTokens: 300,
    });

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { verified: result.success, confidence: result.success ? 0.7 : 0.3, issues: [], suggestion: undefined };
    }

    const raw = JSON.parse(jsonMatch[0]);
    const parsed = VerificationResultSchema.safeParse(raw);
    if (parsed.success) return parsed.data;

    return { verified: result.success, confidence: result.success ? 0.7 : 0.3, issues: [], suggestion: undefined };
  } catch {
    // Verification is advisory — never block
    return { verified: result.success, confidence: 0.5, issues: ['Verification failed'], suggestion: undefined };
  }
}

// --- User Report (Priority 6) ---

export function buildUserReport(
  plan: TaskPlan,
  result: ExecutionResult,
  verification: VerificationResult,
): string {
  const lines: string[] = [];

  // Header
  lines.push(`## ${verification.verified ? 'Done' : 'Warning'}: ${plan.goal}`);
  lines.push('');

  if (!verification.verified) {
    lines.push('**Note:** Could not fully complete this task as planned.');
    lines.push('');
  }

  // Primary: find content_writer output (the main content to show user)
  const contentStep = result.completed.find(s => s.skill === 'content_writer');

  if (
    contentStep?.output &&
    contentStep.output.length > 10 &&
    !/^\d+$/.test(contentStep.output.trim())
  ) {
    // Valid content (not a count like "1" or "3")
    lines.push(contentStep.output);
    lines.push('');
  }

  // Completed steps summary
  if (result.completed.length > 0 && !contentStep) {
    lines.push('**Completed:**');
    for (const step of result.completed) {
      const label = step.display ?? step.output;
      const output =
        label.length > 150 ? label.slice(0, 150) + '...' : label;
      lines.push(`- [Done] ${step.skill}: ${output}`);
    }
    lines.push('');
  }

  // Failed steps
  if (result.failed.length > 0) {
    lines.push('**Issues:**');
    for (const step of result.failed) {
      const prefix = step.optional ? '[Skipped]' : '[Failed]';
      lines.push(`- ${prefix} ${step.skill}: ${step.error}`);
    }
    lines.push('');
  }

  // Abort reason
  if (result.abortReason) {
    lines.push(`**Stopped:** ${result.abortReason}`);
    lines.push('');
  }

  // Memory codes created
  const memorySteps = result.completed.filter(s => s.skill === 'memory_write');
  const createdCodes = memorySteps
    .map(s => extractCreatedCode(s.output))
    .filter(Boolean);

  if (createdCodes.length > 0) {
    lines.push(`**Memory:** ${createdCodes.join(', ')}`);
    lines.push('');
  }

  // Verification suggestion
  if (verification.suggestion) {
    lines.push(`**Suggestion:** ${verification.suggestion}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Extract memory code from memory_write output.
 * Handles both "WHO.CT-000067" and "Created WHO.CT-000067: Sara Ahmadi" formats.
 */
function extractCreatedCode(output: string): string | null {
  const match = output.match(/([A-Z]+\.[A-Z]+-\d{6,})/);
  return match ? match[1] : null;
}
