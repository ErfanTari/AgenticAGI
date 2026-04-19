/**
 * P8: Autonomous Execution Loop
 * Drives PLAN.PJ project execution autonomously across multiple steps.
 */
import type { LLMHandler } from './types.js';
import { transparency } from './transparency.js';
import type { PlanEXEntry } from './memory/plan-ex.js';
import type { WorkingMemory } from './memory/working-memory.js';

export interface AutonomousResult {
  completed: boolean;
  milestoneDone?: string;
  pauseReason?: string;
}

/**
 * Run autonomous execution loop for a project.
 * Checks for an existing PLAN.EX (read-only) then delegates execution to executePlan().
 * executePlan() owns all PLAN.EX write state — autonomous.ts only reads it.
 */
export async function runAutonomousLoop(
  projectCode: string,
  llmHandler: LLMHandler,
): Promise<AutonomousResult> {
  try {
    const { loadActivePlanEX, savePlanEX } = await import('./memory/plan-ex.js');
    const { decomposeTask } = await import('./planner.js');
    const { executePlan } = await import('./executor.js');
    const { getSkillCompactDescriptions } = await import('./skills/registry.js');

    // Check for a resumable plan (read-only — executor owns state writes)
    const existingPlan = loadActivePlanEX();

    // conf_score check: if existing plan has low confidence, pause before executing
    if (existingPlan && (existingPlan.conf_score ?? 1) < 0.8) {
      const reason = `conf_score ${existingPlan.conf_score} below threshold 0.8`;
      // Update status to paused (this is a pre-execution guard, not duplicating executor writes)
      try {
        savePlanEX({
          ...existingPlan,
          status: 'paused',
          abort_reason: reason,
          checkpoint_ts: new Date().toISOString(),
        });
      } catch { /* best-effort */ }
      return { completed: false, pauseReason: reason };
    }

    const resumeFromMilestone = existingPlan?.next_milestone_id ?? null;

    // Phase 15 Conflict 2: load or create working memory before executing
    let workingMemory: WorkingMemory | null = null;
    try {
      const { loadWorkingMemory, createWorkingMemory } = await import('./memory/working-memory.js');
      const { getDb } = await import('./memory/index.js');
      const db = getDb();
      // Try to load existing working memory for this project
      workingMemory = await loadWorkingMemory(projectCode);
      if (!workingMemory) {
        // Create new working memory for this autonomous session
        const projectRow = db.prepare('SELECT name, summary FROM index_entries WHERE code = ?')
          .get(projectCode) as { name: string; summary: string } | undefined;
        if (projectRow) {
          workingMemory = await createWorkingMemory(
            `Autonomous execution: ${projectRow.name}`,
            { summary: projectRow.name, signals: { summary: projectRow.name, personSignal: null, projectSignal: null, timeSignal: null, agenticSignal: true, procedureSignal: false, querySignal: false }, resolvedContext: [], projectCode, constraints: [] },
            db,
          );
        }
      }
    } catch {
      // Working memory is best-effort for autonomous loop
    }

    // Get project info
    const { getDb } = await import('./memory/index.js');
    const db = getDb();
    const project = db.prepare('SELECT * FROM index_entries WHERE code = ?').get(projectCode) as
      { name: string; summary: string } | undefined;

    if (!project) {
      return { completed: false, pauseReason: `Project ${projectCode} not found` };
    }

    // Build task description, optionally resuming from a milestone
    let taskDescription = `Execute next step for project: ${project.name}. ${project.summary}`;
    if (resumeFromMilestone) {
      taskDescription = `Resume project "${project.name}" from milestone ${resumeFromMilestone}. ${project.summary}`;
    }

    const skillDescs = getSkillCompactDescriptions('full-access');
    const plan = await decomposeTask(
      taskDescription,
      { skills: skillDescs, projectCode },
      llmHandler,
    );

    // executePlan owns all PLAN.EX state — we only read the result
    const result = await executePlan(plan, llmHandler, workingMemory ?? undefined);

    if (result.escalated) {
      return { completed: false, pauseReason: result.escalationMessage ?? 'escalated' };
    }

    return {
      completed: result.success,
      milestoneDone: result.success ? plan.goal : undefined,
      pauseReason: result.success ? undefined : (result.abortReason ?? `Failed steps: ${result.failed.map(f => f.stepId).join(', ')}`),
    };

  } catch (err) {
    return { completed: false, pauseReason: `Autonomous loop error: ${String(err)}` };
  }
}

/**
 * Execute an operation with automatic rollback on failure.
 */
export async function withRollback<T>(
  operation: () => Promise<T>,
  rollback: () => Promise<void>,
  verify: (result: T) => boolean,
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (err) {
    transparency.emit({ type: 'saga_rollback', data: { step: 'operation', reason: String(err) } });
    try { await rollback(); } catch { /* rollback failure is non-fatal */ }
    throw err;
  }

  if (!verify(result)) {
    const verifyError = 'Post-operation verification failed';
    transparency.emit({ type: 'saga_rollback', data: { step: 'verify', reason: verifyError } });
    try { await rollback(); } catch { /* rollback failure is non-fatal */ }
    throw new Error(verifyError);
  }

  return result;
}

/**
 * Commit a checkpoint for the current execution state.
 */
export async function commitCheckpoint(planEx: PlanEXEntry): Promise<void> {
  try {
    const { updatePlanEX } = await import('./memory/plan-ex.js');
    updatePlanEX(planEx.code, {
      checkpoint_ts: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[autonomous] commitCheckpoint failed:', err);
  }
}
