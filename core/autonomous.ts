/**
 * P8: Autonomous Execution Loop
 * Drives PLAN.PJ project execution autonomously across multiple steps.
 */
import type { LLMHandler } from './types.js';
import { transparency } from './transparency.js';
import type { PlanEXEntry } from './memory/plan-ex.js';

export interface AutonomousResult {
  completed: boolean;
  milestoneDone?: string;
  pauseReason?: string;
}

/**
 * Run autonomous execution loop for a project.
 * Loads or creates a PLAN.EX entry and drives execution.
 */
export async function runAutonomousLoop(
  projectCode: string,
  llmHandler: LLMHandler,
): Promise<AutonomousResult> {
  const MAX_ITERATIONS = 10;
  let iterations = 0;

  try {
    const { loadActivePlanEX } = await import('./memory/plan-ex.js');
    const { decomposeTask } = await import('./planner.js');
    const { executePlan } = await import('./executor.js');
    const { getSkillDescriptions } = await import('./skills/registry.js');

    let planEx = loadActivePlanEX();

    if (!planEx) {
      // No active execution plan — check project and create one
      const { getDb } = await import('./memory/index.js');
      const db = getDb();
      const project = db.prepare('SELECT * FROM index_entries WHERE code = ?').get(projectCode) as
        { name: string; summary: string } | undefined;

      if (!project) {
        return { completed: false, pauseReason: `Project ${projectCode} not found` };
      }

      // Create a new execution plan
      const skillDescs = getSkillDescriptions();
      const plan = await decomposeTask(
        `Execute next step for project: ${project.name}. ${project.summary}`,
        { skills: skillDescs },
        llmHandler,
      );

      const execResult = await executePlan(plan, llmHandler);

      if (execResult.success) {
        return { completed: true, milestoneDone: plan.goal };
      } else {
        return {
          completed: false,
          pauseReason: execResult.abortReason ?? `Failed steps: ${execResult.failed.map(f => f.stepId).join(', ')}`,
        };
      }
    }

    // Execute next milestone
    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const milestones: typeof planEx.milestones = planEx.milestones ?? [];
      const currentIdx: number = planEx.current_milestone ?? 0;

      if (currentIdx >= milestones.length) {
        const { savePlanEX } = await import('./memory/plan-ex.js');
        savePlanEX({
          ...planEx,
          status: 'complete',
          next_milestone_id: null,
          checkpoint_ts: new Date().toISOString(),
        });
        return { completed: true, milestoneDone: 'All milestones completed' };
      }

      // conf_score check: pause if below threshold
      if ((planEx.conf_score ?? 1) < 0.8) {
        const { savePlanEX } = await import('./memory/plan-ex.js');
        const nextMilestone = milestones[currentIdx];
        savePlanEX({
          ...planEx,
          status: 'paused',
          abort_reason: `conf_score ${planEx.conf_score} below threshold 0.8`,
          next_milestone_id: nextMilestone?.id ?? null,
          checkpoint_ts: new Date().toISOString(),
        });
        return { completed: false, pauseReason: `conf_score ${planEx.conf_score} below threshold 0.8` };
      }

      const milestone = milestones[currentIdx];
      if (!milestone || milestone.done) {
        // Move to next milestone
        const { updatePlanEX } = await import('./memory/plan-ex.js');
        updatePlanEX(planEx.code, { current_milestone: currentIdx + 1 });
        planEx = { ...planEx, current_milestone: currentIdx + 1 };
        continue;
      }

      // Execute this milestone
      const skillDescs = getSkillDescriptions();
      try {
        const plan = await decomposeTask(
          milestone.name,
          { skills: skillDescs },
          llmHandler,
        );

        const execResult = await executePlan(plan, llmHandler);

        if (execResult.success) {
          // Mark milestone done
          const updatedMilestones = [...milestones];
          updatedMilestones[currentIdx] = { ...milestone, done: true };
          const { updatePlanEX, savePlanEX } = await import('./memory/plan-ex.js');
          updatePlanEX(planEx.code, {
            milestones: updatedMilestones,
            current_milestone: currentIdx + 1,
            last_action: milestone.name,
            checkpoint_ts: new Date().toISOString(),
            status: currentIdx + 1 >= milestones.length ? 'complete' : 'in_progress',
          });
          planEx = { ...planEx, milestones: updatedMilestones, current_milestone: currentIdx + 1, last_action: milestone.name };
          savePlanEX({
            ...planEx,
            status: currentIdx + 1 >= milestones.length ? 'complete' : 'in_progress',
            next_milestone_id: milestones[currentIdx + 1]?.id ?? null,
            checkpoint_ts: new Date().toISOString(),
          });

          return { completed: false, milestoneDone: milestone.name };
        } else {
          const { savePlanEX } = await import('./memory/plan-ex.js');
          savePlanEX({
            ...planEx,
            status: 'failed',
            abort_reason: execResult.abortReason ?? `Milestone failed: ${milestone.name}`,
            checkpoint_ts: new Date().toISOString(),
            last_action: milestone.name,
          });
          return {
            completed: false,
            pauseReason: execResult.abortReason ?? `Milestone failed: ${milestone.name}`,
          };
        }
      } catch (err) {
        const { savePlanEX } = await import('./memory/plan-ex.js');
        savePlanEX({
          ...planEx,
          status: 'failed',
          abort_reason: `Exception: ${String(err)}`,
          checkpoint_ts: new Date().toISOString(),
        });
        return {
          completed: false,
          pauseReason: `Error executing milestone "${milestone.name}": ${String(err)}`,
        };
      }
    }

    const { savePlanEX } = await import('./memory/plan-ex.js');
    const nextMilestone = (planEx.milestones ?? [])[planEx.current_milestone ?? 0];
    savePlanEX({
      ...planEx,
      status: 'paused',
      abort_reason: 'Maximum iterations reached',
      next_milestone_id: nextMilestone?.id ?? null,
      checkpoint_ts: new Date().toISOString(),
    });
    return { completed: false, pauseReason: 'Maximum iterations reached' };

  } catch (err) {
    // Best-effort: try to mark as failed if we have a planEx reference
    try {
      const { loadActivePlanEX, savePlanEX } = await import('./memory/plan-ex.js');
      const planEx = loadActivePlanEX();
      if (planEx) {
        savePlanEX({
          ...planEx,
          status: 'failed',
          abort_reason: `Exception: ${String(err)}`,
          checkpoint_ts: new Date().toISOString(),
        });
      }
    } catch { /* ignore secondary failure */ }
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
