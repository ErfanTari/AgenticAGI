/**
 * Memory Agent — Phase 15, Section 4
 *
 * Queue-based parallel memory write processor.
 * The executor enqueues updates synchronously (never awaits),
 * and the MemoryAgent drains the queue asynchronously.
 *
 * Register drain() in the shutdown handler.
 */
import type { WorkingMemory } from './working-memory.js';
import type { LLMHandler } from '../types.js';
import type Database from 'better-sqlite3';
import { isMemoryFullyDisabled } from '../memory-mode.js';
import { transparency } from '../transparency.js';

// --- Types ---

export interface WriteEntryData {
  nb: string;
  type: string;
  name: string;
  status: string;
  summary: string;
  body: string;
  due_date?: string;
}

export type MemoryUpdate =
  | { type: 'step_complete'; stepId: string; result: string; codes: string[]; workingMemoryId?: string | null }
  | { type: 'milestone_complete'; milestoneId: string; summary: string; workingMemoryId?: string | null; planExCode?: string }
  | { type: 'task_complete'; workingMemory?: WorkingMemory; workingMemoryId?: string | null }
  | { type: 'new_code'; code: string; workingMemoryId?: string | null }
  | { type: 'fact_write'; nb: string; data: WriteEntryData };

// --- Module-level state for DB and LLM access ---

let _db: Database.Database | null = null;
let _llm: LLMHandler | null = null;

// --- Handlers ---

async function processUpdate(update: MemoryUpdate): Promise<void> {
  try {
    switch (update.type) {
      case 'step_complete': {
        // Append to working memory step log if we have a working memory ID
        if (update.workingMemoryId) {
          const { loadWorkingMemory, appendStepLog } = await import('./working-memory.js');
          const wm = await loadWorkingMemory(update.workingMemoryId);
          if (wm) {
            await appendStepLog(wm, {
              stepId: update.stepId,
              skill: 'executor',
              outcome: 'success',
              summary: update.result.slice(0, 120),
              ts: new Date().toISOString(),
            });
          }
        }
        // Add new codes to session cache
        if (update.codes.length > 0) {
          const { sessionCache } = await import('./session-cache.js');
          const { getEntryByCode } = await import('./index.js');
          for (const code of update.codes) {
            if (!sessionCache.getByCode(code)) {
              const entry = getEntryByCode(code);
              if (entry) sessionCache.set(entry.code, entry);
            }
          }
        }
        break;
      }

      case 'milestone_complete': {
        // Update working memory plan section if applicable
        // Note: WHEN.EV is already written by writeMilestoneMemoryCycle in the executor
        if (update.workingMemoryId) {
          const { loadWorkingMemory, appendStepLog, markMilestoneComplete } = await import('./working-memory.js');
          const wm = await loadWorkingMemory(update.workingMemoryId);
          if (wm) {
            await appendStepLog(wm, {
              stepId: update.milestoneId,
              skill: 'milestone',
              outcome: 'success',
              summary: `Milestone complete: ${update.summary}`,
              ts: new Date().toISOString(),
            });
            await markMilestoneComplete(wm, update.milestoneId);
          }
        }
        // Update PLAN.EX if code is provided
        if (update.planExCode && _db) {
          const { updatePlanEX } = await import('./plan-ex.js');
          try {
            updatePlanEX(update.planExCode, {
              last_action: `Milestone complete: ${update.summary}`,
              checkpoint_ts: new Date().toISOString(),
            });
          } catch {
            // PLAN.EX update is best-effort
          }
        }
        break;
      }

      case 'task_complete': {
        // Archive working memory — always load fresh from disk so stepLog contains all steps
        // that were appended by preceding step_complete queue items (queue is FIFO-sequential,
        // so all step_complete items are fully persisted before this runs).
        if (_db && _llm) {
          const { loadWorkingMemory, archiveWorkingMemory } = await import('./working-memory.js');
          const wmId = update.workingMemoryId ?? update.workingMemory?.taskId ?? null;
          if (wmId) {
            const loaded = await loadWorkingMemory(wmId);
            if (loaded) {
              await archiveWorkingMemory(loaded, _db, _llm);
              break;
            }
          }
          // Fallback: if we can't load by ID, archive the in-memory reference
          if (update.workingMemory) {
            await archiveWorkingMemory(update.workingMemory, _db, _llm);
          }
        }
        break;
      }

      case 'new_code': {
        // Fetch entry and add to session cache
        const { getEntryByCode } = await import('./index.js');
        const { sessionCache } = await import('./session-cache.js');
        const entry = getEntryByCode(update.code);
        if (entry) {
          sessionCache.set(entry.code, entry);
          // Add to working memory active context if applicable
          if (update.workingMemoryId) {
            const { loadWorkingMemory, addToActiveContext } = await import('./working-memory.js');
            const wm = await loadWorkingMemory(update.workingMemoryId);
            if (wm) {
              await addToActiveContext(wm, entry.code, entry.summary ?? entry.name);
              // FIX 6: Write `contains` relationship from WHAT.PJ → NOW.TD
              if (entry.nb === 'NOW' && entry.type === 'TD' && wm.projectCode) {
                const { addRelationship } = await import('./relationships.js');
                try {
                  addRelationship({
                    from_code: wm.projectCode,
                    relation: 'contains',
                    to_code: entry.code,
                    note: 'task spawned from this project',
                  });
                } catch { /* best-effort */ }
              }
            }
          }
        }
        break;
      }

      case 'fact_write': {
        // Write a fact to memory
        const { upsertEntry } = await import('./write.js');
        upsertEntry({
          nb: update.nb,
          type: update.data.type,
          name: update.data.name,
          status: update.data.status,
          summary: update.data.summary,
          body: update.data.body,
          due_date: update.data.due_date,
        });
        break;
      }
    }
  } catch (err) {
    console.warn('[memory-agent] processUpdate failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

// --- MemoryAgent class ---

class MemoryAgent {
  private queue: MemoryUpdate[] = [];
  private processing = false;

  /** Initialize with DB and LLM handler at agent startup */
  init(db: Database.Database, llm: LLMHandler): void {
    _db = db;
    _llm = llm;
  }

  enqueue(update: MemoryUpdate): void {
    if (isMemoryFullyDisabled()) {
      transparency.emit({ type: 'memory_disabled_drop', data: { taskType: update.type } });
      return;
    }
    this.queue.push(update);
    if (!this.processing) {
      this.processNext().catch(err => {
        console.warn('[memory-agent] processNext error:', err);
      });
    }
  }

  private async processNext(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const update = this.queue.shift()!;
      await processUpdate(update);
    }
    this.processing = false;
  }

  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.processing) {
      await new Promise(r => setTimeout(r, 10));
    }
  }

  queueLength(): number {
    return this.queue.length;
  }

  isProcessing(): boolean {
    return this.processing;
  }
}

export const memoryAgent = new MemoryAgent();
