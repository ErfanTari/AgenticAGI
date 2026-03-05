import type { Classification } from './types.js';
import type { ComplexityResult } from './planner.js';
import type { TaskPlan, TaskStep } from './schemas.js';
import type { SkillResult } from './skills/types.js';
import type { Message } from './types.js';

export type TransparencyEvent =
  | { type: 'intent'; data: Classification }
  | { type: 'complexity'; data: ComplexityResult }
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
  | { type: 'project_transition'; data: { code: string; from: string; to: string } }
  | { type: 'saga_rollback'; data: { step: string; reason: string } }
  | { type: 'meeting_complete'; data: { updatesWritten: string[] } }
  | { type: 'linker_pass'; data: { linked: number } };

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
