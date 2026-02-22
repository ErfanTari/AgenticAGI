import { AUTONOMY_CONFIG } from '../config/agent.config.js';
import { processMessage, isProcessingMessage } from './agent.js';
import { createEntry, queryEntries, updateEntry } from './memory/mod.js';
import type { IndexEntry } from './memory/types.js';
import type { LLMHandler } from './types.js';

export interface AutonomyCycleResult {
  ranAt: string;
  scanned: number;
  processed: number;
  completed: number;
  failed: number;
  reports: IndexEntry[];
}

export interface AutonomyStatus {
  enabledByConfig: boolean;
  loopActive: boolean;
  cycleRunning: boolean;
  intervalMs: number;
  maxTasksPerCycle: number;
}

let timer: NodeJS.Timeout | null = null;
let cycleRunning = false;

function parseAttemptCount(summary: string): number {
  const match = summary.match(/\[autonomy(?:\/failed)?\]\s*attempt\s+(\d+)/i);
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncate(text: string, max = 3000): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n[truncated]';
}

function buildTaskPrompt(task: IndexEntry): string {
  const primary = task.summary.trim() || task.name.trim();
  return primary;
}

export async function runAutonomyCycle(
  options?: { llmHandler?: LLMHandler; maxTasks?: number },
): Promise<AutonomyCycleResult> {
  const ranAt = new Date().toISOString();
  const maxTasks = Math.max(1, options?.maxTasks ?? AUTONOMY_CONFIG.maxTasksPerCycle);
  const openTodos = queryEntries({ nb: 'NOW', type: 'TD', status: 'open' })
    .sort((a, b) => a.updated.localeCompare(b.updated));

  const selected = openTodos.slice(0, maxTasks);
  const result: AutonomyCycleResult = {
    ranAt,
    scanned: openTodos.length,
    processed: 0,
    completed: 0,
    failed: 0,
    reports: [],
  };

  for (const task of selected) {
    const previousAttempts = parseAttemptCount(task.summary);
    const currentAttempt = previousAttempts + 1;

    result.processed += 1;
    updateEntry(task.code, {
      status: 'in_progress',
      summary: `[autonomy] attempt ${currentAttempt}/${AUTONOMY_CONFIG.maxAttemptsPerTask}: ${task.summary}`.slice(0, 240),
    });

    try {
      const response = await processMessage(
        buildTaskPrompt(task),
        [],
        options?.llmHandler ? { llmHandler: options.llmHandler } : undefined,
      );
      if (response.error) {
        throw new Error(response.error);
      }

      createEntry({
        nb: 'NOW',
        type: 'RP',
        name: `Autonomy report for ${task.code}`,
        status: 'active',
        summary: `Result for ${task.code}: ${truncate(response.reply, 180).replace(/\s+/g, ' ')}`,
        body: [
          `## Task`,
          `${task.code} — ${task.name}`,
          '',
          `## Agent Reply`,
          truncate(response.reply),
          '',
          `## Metadata`,
          `- intent: ${response.intent}`,
          `- ran_at: ${ranAt}`,
        ].join('\n'),
      });

      updateEntry(task.code, {
        status: 'closed',
        summary: `[autonomy] Completed at ${ranAt.slice(0, 19).replace('T', ' ')}`,
      });
      result.completed += 1;
    } catch (error) {
      const finalAttempt = currentAttempt >= AUTONOMY_CONFIG.maxAttemptsPerTask;
      updateEntry(task.code, {
        status: finalAttempt ? 'closed' : 'open',
        summary: finalAttempt
          ? `[autonomy/failed] attempt ${currentAttempt}/${AUTONOMY_CONFIG.maxAttemptsPerTask}: ${String(error).slice(0, 160)}`
          : `[autonomy] attempt ${currentAttempt}/${AUTONOMY_CONFIG.maxAttemptsPerTask} failed: ${String(error).slice(0, 150)}`,
      });
      result.failed += 1;
    }
  }

  result.reports = queryEntries({ nb: 'NOW', type: 'RP' })
    .filter(entry => entry.name.startsWith('Autonomy report for '))
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, result.processed);

  return result;
}

async function runCycleSafe(): Promise<void> {
  if (cycleRunning) return;
  if (isProcessingMessage) return;
  cycleRunning = true;
  try {
    await runAutonomyCycle();
  } catch (error) {
    console.error('[autonomy] cycle failed:', error);
  } finally {
    cycleRunning = false;
  }
}

export function startAutonomyLoop(options?: { force?: boolean }): boolean {
  if (!AUTONOMY_CONFIG.enabled && !options?.force) return false;
  if (timer) return true;
  timer = setInterval(runCycleSafe, AUTONOMY_CONFIG.intervalMs);
  return true;
}

export function stopAutonomyLoop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function getAutonomyStatus(): AutonomyStatus {
  return {
    enabledByConfig: AUTONOMY_CONFIG.enabled,
    loopActive: timer !== null,
    cycleRunning,
    intervalMs: AUTONOMY_CONFIG.intervalMs,
    maxTasksPerCycle: AUTONOMY_CONFIG.maxTasksPerCycle,
  };
}
