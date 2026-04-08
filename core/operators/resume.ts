/**
 * /resume operator — Resume paused/in-progress execution plans OR restore pending confirmation
 */

import { getDb, loadPendingPlan } from '../memory/index.js';

export interface ResumablePlan {
  code: string;
  name: string;
  status: 'paused' | 'in_progress' | 'active';
  current_milestone?: string;
  next_action?: string;
  abort_reason?: string;
}

export interface ResumeResult {
  found: boolean;
  plan?: ResumablePlan;
  count: number; // total resumable plans available
  error?: string;
}

/**
 * findResumablePlans — find all PLAN.EX entries that can be resumed
 */
export function findResumablePlans(): ResumablePlan[] {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT code, name, summary, status FROM index_entries
       WHERE nb='PLAN' AND type='EX' AND status IN ('paused', 'in_progress', 'active')
       ORDER BY updated DESC
       LIMIT 10`
    ).all() as Array<{ code: string; name: string; summary: string; status: string }>;

    return rows.map(row => ({
      code: row.code,
      name: row.name,
      status: row.status as 'paused' | 'in_progress' | 'active',
      next_action: row.summary?.split('\n')[0] || undefined,
    }));
  } catch (err) {
    console.warn(`[resume] Failed to query plans: ${String(err).slice(0, 50)}`);
    return [];
  }
}

/**
 * selectResumablePlan — check for pending confirmation first, then PLAN.EX resumable plans
 */
export function selectResumablePlan(nameOrCode?: string): ResumeResult {
  // Check for pending confirmation first
  const pendingPlan = loadPendingPlan() as any;
  if (pendingPlan) {
    return {
      found: true,
      plan: {
        code: 'PENDING',
        name: pendingPlan.goal || 'Pending confirmation',
        status: 'paused',
        next_action: 'Awaiting user confirmation',
      },
      count: 1 + findResumablePlans().length, // Include pending + PLAN.EX entries
    };
  }

  const plans = findResumablePlans();

  if (plans.length === 0) {
    return {
      found: false,
      count: 0,
      error: 'No resumable execution plans found.',
    };
  }

  let selected: ResumablePlan | undefined;

  if (nameOrCode) {
    // Search by code or name substring
    const query = nameOrCode.toLowerCase();
    selected = plans.find(p =>
      p.code.toLowerCase().includes(query) ||
      p.name.toLowerCase().includes(query)
    );

    if (!selected) {
      return {
        found: false,
        count: plans.length,
        error: `No plan matching "${nameOrCode}" found. Available: ${plans.map(p => `${p.code}:${p.name}`).join(', ')}`,
      };
    }
  } else {
    // Use most recent
    selected = plans[0];
  }

  return {
    found: true,
    plan: selected,
    count: plans.length,
  };
}

/**
 * formatResumePrompt — format the resume prompt for user
 */
export function formatResumePrompt(result: ResumeResult): string {
  if (!result.found || !result.plan) {
    return result.error || 'No resumable plans available.';
  }

  const lines: string[] = [
    `📋 Resume Execution Plan`,
    `Code: ${result.plan.code}`,
    `Name: ${result.plan.name}`,
    `Status: ${result.plan.status}`,
  ];

  if (result.plan.next_action) {
    lines.push(`Next: ${result.plan.next_action}`);
  }

  if (result.plan.abort_reason) {
    lines.push(`Paused: ${result.plan.abort_reason}`);
  }

  if (result.count > 1) {
    lines.push(`\n(${result.count} total resumable plans available)`);
  }

  return lines.join('\n');
}
