import type { TaskPlan, TaskStep } from './schemas.js';
import type { SkillResult } from './skills/types.js';
import type { DecompositionResult, Message, DecomposedUnit, UnitMemoryResult } from './types.js';

export type TransparencyEvent =
  | { type: 'decomposition'; data: DecompositionResult }
  | { type: 'unit_memory_search'; data: { unit: DecomposedUnit; result: UnitMemoryResult } }
  | { type: 'plan'; data: TaskPlan }
  | { type: 'step_start'; data: { step: TaskStep } }
  | {
      type: 'step_result';
      data: { step: TaskStep; result: SkillResult; ms: number };
    }
  | { type: 'llm_request'; data: { system: string; messages: Message[]; schema?: Record<string, unknown> } }
  | { type: 'llm_raw'; data: { raw: string; ms: number } }
  | { type: 'llm_stripped'; data: { stripped: string } }
  | { type: 'memory_query'; data: { query: string; nb?: string; results: number } }
  | { type: 'memory_write'; data: { code: string; nb: string; name: string } }
  | { type: 'context_built'; data: { tokens: number; sections: string[] } }
  | { type: 'heartbeat'; data: { checks: string[]; findings: number } }
  | { type: 'error'; data: { source: string; error: string } }
  | { type: 'planner_reasoning'; data: { thought: string } }
  | { type: 'failure_classified'; data: { error: string; class: string } }
  | { type: 'context_compacted'; data: { before: number; after: number } }
  | { type: 'milestone_start'; data: { id: string; title: string; index: number; total: number } }
  | { type: 'milestone_result'; data: { id: string; title: string; success: boolean; index: number; total: number } }
  | { type: 'milestone_revised'; data: { fromId?: string; remaining?: string[]; milestoneId?: string; revisedCount?: number; reason?: string } }
  | { type: 'milestone_memory_cycle'; data: { milestoneId: string; writes: string[] } }
  | { type: 'project_transition'; data: { code: string; from: string; to: string } }
  | { type: 'saga_rollback'; data: { step: string; reason: string } }
  | { type: 'meeting_complete'; data: { updatesWritten: string[] } }
  | { type: 'linker_pass'; data: { linked: number } }
  | { type: 'intake'; data: { summary: string; signals: Record<string, unknown>; resolvedCodes: string[] } }
  | { type: 'project_brain'; data: { hit: boolean; projectCode: string | null | undefined } }
  | { type: 'working_memory_created'; data: { taskId: string; projectCode: string | null } }
  | { type: 'working_memory_loaded'; data: { taskId: string; projectCode: string | null } }
  | { type: 'working_memory_updated'; data: { taskId: string; event: string } }
  | { type: 'working_memory_archived'; data: { taskId: string } }
  | { type: 'session_cache_hit'; data: { code: string } }
  | { type: 'session_cache_miss'; data: { code: string } }
  | { type: 'session_cache_store'; data: { code: string } }
  | { type: 'project_brain_hit'; data: { projectCode: string } }
  | { type: 'project_brain_miss'; data: { projectCode: string } }
  | { type: 'project_brain_rebuilt'; data: { projectCode: string } }
  | { type: 'project_brain_invalidated'; data: { projectCode: string } };

type TransparencyHandler = (event: TransparencyEvent) => void;

class TransparencyBus {
  private handlers: TransparencyHandler[] = [];
  private active = false;

  enable() {
    this.active = true;
  }

  disable() {
    this.active = false;
  }

  isEnabled() {
    return this.active;
  }

  on(handler: TransparencyHandler) {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }

  emit(event: TransparencyEvent) {
    if (!this.active) return;
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // never propagate handler errors
      }
    }
  }
}

export const transparency = new TransparencyBus();
