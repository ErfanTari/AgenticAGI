import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { TaskPlan, TaskStep } from './schemas.js';
import type { SkillResult } from './skills/types.js';
import type { DecompositionResult, Message, DecomposedUnit, UnitMemoryResult } from './types.js';

// ─── Correlation ID store ──────────────────────────────────────────────────────
const _requestIdStore = new AsyncLocalStorage<string>();

/** Run fn inside a new request scope with a generated or provided requestId. */
export function withRequestId<T>(fn: () => T, requestId?: string): T {
  return _requestIdStore.run(requestId ?? randomUUID(), fn);
}

/** Returns the current request ID, or undefined if called outside a withRequestId scope. */
export function getCurrentRequestId(): string | undefined {
  return _requestIdStore.getStore();
}

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
  | { type: 'session_cache_skip'; data: { code: string; reason: string; status: string } }
  | { type: 'project_brain_hit'; data: { projectCode: string } }
  | { type: 'project_brain_miss'; data: { projectCode: string } }
  | { type: 'project_brain_rebuilt'; data: { projectCode: string } }
  | { type: 'project_brain_invalidated'; data: { projectCode: string } }
  // Phase 16 — QueryLoop events
  | { type: 'query_loop_start'; data: { goal: string } }
  | { type: 'query_loop_iteration'; data: { iteration: number; reply: string } }
  | { type: 'query_loop_narration'; data: { narration: string; iteration: number } }
  | { type: 'query_loop_skill_call'; data: { skill: string; input: Record<string, unknown> } }
  | { type: 'query_loop_skill_result'; data: { skill: string; success: boolean; error?: string } }
  | { type: 'query_loop_end'; data: { reason: string; iterations: number } }
  // Phase 16 Usability — routing decision
  | { type: 'route'; data: { level: string; reason: string; path: string } }
  // Fix 5 — decomposition repair telemetry
  | { type: 'decomposition_repair'; data: { message: string; repairCount: number; reason: string } }
  | { type: 'decomposition_retry'; data: { message: string; repairCount: number; reason: string } }
  // Log-fixes sprint
  | { type: 'verification_snapshot'; data: { files: Array<{ path: string; exists: boolean; sizeBytes: number }>; memory: Array<{ code: string; exists: boolean }> } }
  | { type: 'milestone_revision_skipped'; data: { milestoneId: string; reason: string } }
  | { type: 'post_flight_complete'; data: { verified: boolean; confidence: number; issueCount: number; summaryLength: number } }
  | { type: 'how_pr_skipped'; data: { milestoneId: string; reason: string; skills: string[] } }
  | { type: 'memory_context_filtered'; data: { code: string; reason: string; status: string } }
  // FIX 0 — Plan confirmation state machine
  | { type: 'plan_confirmation_pending'; data: { goal: string; stepCount: number } }
  | { type: 'plan_confirmed'; data: { goal: string } }
  | { type: 'plan_rejected'; data: { goal: string } }
  | { type: 'plan_confirmation_ambiguous'; data: { userMessage: string } }
  // Phase 18 — Coding route + context mode
  | { type: 'coding_route_selected'; data: { unitIds: string[]; complexity: string; reason: string } }
  | { type: 'context_mode_applied'; data: { mode: string; softLimit: number; hardCeiling: number } }
  // Phase 18F — Retrieval fixes
  | { type: 'intake_signals'; data: { personSignal: string | null; projectSignal: string | null; querySignal: boolean; agenticSignal: boolean } }
  | { type: 'unit_search_strategy'; data: { strategy: string; projectName: string | null; confidence: number; codes: string[] } }
  // Phase 19 — Intake + query fix
  | { type: 'list_intent_detected'; data: { unitContent: string; matched: { nb: string; type?: string }; resultCount: number } }
  // Tetris Session Fix Sprint — FIX 1: Milestone count validation
  | { type: 'plan_repair_truncation'; data: { attempt: number; expectedSteps: number | null; actualSteps: number; expectedMilestones: number | null; actualMilestones: number } }
  // Tetris Session Fix Sprint — FIX 2: Continuation intent auto-retrieval
  | { type: 'continuation_context_loaded'; data: { code: string; length: number } }
  // JSON Integrity Sprint — FIX 3: Plan referential integrity
  | { type: 'plan_integrity_warning'; data: { orphanedSteps: string[]; missingSteps: string[]; brokenDependencies: string[] } }
  | { type: 'plan_image_warning'; data: { message: string; steps: string[] } }
  // DVD Log Analysis Fix Sprint — FIX 1: BM25 relevance gate
  | { type: 'unit_search_filtered'; data: { unitId: string; reason: string; droppedCount: number } }
  // Phase 5, Task 5 — Startup prefetch + lazy loading
  | { type: 'startup_prefetch'; data: { pointerEntryCount: number; entriesPrefetched: number; timeMs: number } }
  | { type: 'startup_prefetch_error'; data: { error: string } }
  | { type: 'context_lazy_loaded'; data: Record<string, never> }
  // Token counter
  | { type: 'token_usage'; data: { inputTokens: number; outputTokens: number; callCount: number; estimatedCostUSD: number } }
  // Memory toggle sprint
  | { type: 'memory_mode'; data: { mode: import('./memory-mode.js').MemoryMode } }
  | { type: 'filename_auto_renamed'; data: { original: string; final: string; skill: string } }
  // Planner JSON path telemetry
  | { type: 'plan_json_parse_failed'; data: { attempt: number; error: string } }
  | { type: 'plan_parser_fallback_used'; data: { attempt: number } }
  // Constraint-aware routing
  | { type: 'user_constraints_extracted'; data: { constraints: import('./types.js').UserConstraint[] } }
  | { type: 'coding_route_escalated'; data: { reason: string; constraints: import('./types.js').UserConstraint[] } }
  | { type: 'user_input_requested'; data: { question: string; context?: string } }
  | { type: 'user_input_received'; data: { question: string; answer: string } }
  | { type: 'user_input_cleared'; data: Record<string, never> };

export type TransparencyEventEnvelope = TransparencyEvent & { requestId?: string };

type TransparencyHandler = (event: TransparencyEventEnvelope) => void;

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
    const envelope: TransparencyEventEnvelope = { ...event, requestId: getCurrentRequestId() };
    for (const handler of this.handlers) {
      try {
        handler(envelope);
      } catch {
        // never propagate handler errors
      }
    }
  }
}

export const transparency = new TransparencyBus();
