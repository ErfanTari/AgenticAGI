import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config/agent.config.js';
import { transparency } from './transparency.js';
import type { TransparencyEventEnvelope } from './transparency.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DiagIter {
  n: number;
  skill: string;
  input: string;
  ok: boolean;
  error?: string;
  repairNote?: string;
}

interface DiagMilestone {
  title: string;
  ok: boolean;
  stepsRun: number;
}

interface PhaseRecord {
  name: string;
  startTs: number;
  durationMs: number;
  detail: string;
  warnings: string[];
}

interface DiagState {
  requestId: string;
  goal: string;
  startTs: number;
  engine: string;
  route: string;
  phases: PhaseRecord[];
  iterations: DiagIter[];
  milestones: DiagMilestone[];
  errors: string[];
  repairEvents: string[];
  finalTokensIn: number;
  finalTokensOut: number;
  finalCostUSD: number;
  outcome: string;
  durationMs: number;
  rootSpanId: string | null;
  // track span durations by id for phase timing
  spanStartTs: Map<string, number>;
  spanLabels: Map<string, string>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function trunc(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

// ─── Path ─────────────────────────────────────────────────────────────────────

let _diagBaseDir: string | null = null;

export function _setDiagBaseDir(dir: string | null): void {
  _diagBaseDir = dir;
}

function diagDir(): string {
  return _diagBaseDir ?? path.join(PATHS.workspace, '.diag');
}

export function getDiagPath(requestId: string): string {
  return path.join(diagDir(), `${requestId}.diag`);
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

function render(s: DiagState): string {
  const lines: string[] = [];

  lines.push('ZARABAN DIAG v2');
  lines.push('===============');
  lines.push(`id:       ${s.requestId.slice(0, 8)}`);
  lines.push(`goal:     ${trunc(s.goal, 120)}`);
  lines.push(`engine:   ${s.engine || '(unknown)'} | ${s.route || '(unknown)'}`);
  lines.push(`outcome:  ${s.outcome || '(unknown)'}`);
  lines.push(`duration: ${s.durationMs}ms`);
  lines.push(`tokens:   in=${s.finalTokensIn} out=${s.finalTokensOut} cost=$${s.finalCostUSD.toFixed(4)}`);
  lines.push('');

  // ── Phase Breakdown ──
  lines.push('PHASE BREAKDOWN');
  lines.push('───────────────');
  if (s.phases.length === 0) {
    lines.push('  (none recorded)');
  } else {
    for (const p of s.phases) {
      const dur = p.durationMs > 0 ? `${p.durationMs}ms` : '?ms';
      lines.push(`  ${pad(p.name, 18)} ${pad(dur, 10)} ${p.detail}`);
      for (const w of p.warnings) {
        lines.push(`    ⚠ ${w}`);
      }
    }
  }
  lines.push('');

  lines.push(`ITERATIONS (${s.iterations.length} total)`);
  lines.push('──────────────────────');
  if (s.iterations.length === 0) {
    lines.push('  (none)');
  } else {
    for (const iter of s.iterations) {
      const n = String(iter.n).padStart(2);
      const skill = pad(iter.skill || '(unknown)', 14);
      const inp = pad(trunc(iter.input, 60), 60);
      const status = iter.ok ? 'OK' : `FAIL: ${trunc(iter.error ?? '', 40)}`;
      const repair = iter.repairNote ? `  ${iter.repairNote}` : '';
      lines.push(`  ${n}  ${skill}  ${inp}  [${status}]${repair}`);
    }
  }
  lines.push('');

  lines.push('MILESTONES');
  lines.push('──────────');
  if (s.milestones.length === 0) {
    lines.push(s.engine === 'query-loop' ? '  (query-loop mode — iterations above are the execution record)' : '  (none)');
  } else {
    for (const m of s.milestones) {
      lines.push(`  [${m.ok ? 'OK' : 'FAIL'}] ${m.title} (${m.stepsRun} steps)`);
    }
  }
  lines.push('');

  lines.push('REPAIRS/ANOMALIES');
  lines.push('─────────────────');
  if (s.repairEvents.length === 0) {
    lines.push('  (none)');
  } else {
    for (const r of s.repairEvents) lines.push(`  ${r}`);
  }
  lines.push('');

  lines.push('ERRORS');
  lines.push('──────');
  if (s.errors.length === 0) {
    lines.push('  (none)');
  } else {
    for (const e of s.errors) lines.push(`  ${e}`);
  }

  return lines.join('\n');
}

// ─── Phase helpers ────────────────────────────────────────────────────────────

function addPhase(s: DiagState, name: string, durationMs: number, detail: string, warnings: string[] = []): void {
  s.phases.push({ name, startTs: 0, durationMs, detail, warnings });
}

// ─── Session ──────────────────────────────────────────────────────────────────

const active = new Map<string, DiagState>();

export function startDiagSession(requestId: string): () => Promise<void> {
  const state: DiagState = {
    requestId,
    goal: '',
    startTs: Date.now(),
    engine: '',
    route: '',
    phases: [],
    iterations: [],
    milestones: [],
    errors: [],
    repairEvents: [],
    finalTokensIn: 0,
    finalTokensOut: 0,
    finalCostUSD: 0,
    outcome: '',
    durationMs: 0,
    rootSpanId: null,
    spanStartTs: new Map(),
    spanLabels: new Map(),
  };
  active.set(requestId, state);

  const handler = (env: TransparencyEventEnvelope) => {
    if (env.requestId !== requestId) return;

    switch (env.type) {
      // ── Routing ──────────────────────────────────────────────────────────
      case 'route': {
        const d = env.data as { level?: string; path?: string; reason?: string };
        const parts = [d.level, d.path].filter(Boolean);
        state.route = trunc(parts.join(' | '), 60);
        break;
      }

      // ── Intake ───────────────────────────────────────────────────────────
      case 'intake_signals': {
        const d = env.data as { personSignal?: string | null; projectSignal?: string | null; querySignal?: boolean; agenticSignal?: boolean };
        const signals: string[] = [];
        if (d.personSignal) signals.push(`person:${d.personSignal}`);
        if (d.projectSignal) signals.push(`project:${d.projectSignal}`);
        if (d.agenticSignal) signals.push('agentic');
        if (d.querySignal) signals.push('query');
        addPhase(state, 'Intake', 0, signals.join(', ') || '(no signals)');
        break;
      }

      // ── Decomposition ─────────────────────────────────────────────────────
      case 'decomposition': {
        const d = env.data as { units?: unknown[] };
        const count = Array.isArray(d.units) ? d.units.length : 0;
        const existing = state.phases.find(p => p.name === 'Decomposition');
        if (existing) {
          existing.detail = `${count} unit(s)`;
        } else {
          addPhase(state, 'Decomposition', 0, `${count} unit(s)`);
        }
        break;
      }
      case 'decomposition_repair': {
        const d = env.data as { reason?: string; repairCount?: number };
        const p = state.phases.find(ph => ph.name === 'Decomposition');
        if (p) p.warnings.push(`repair ×${d.repairCount ?? '?'}: ${d.reason ?? '?'}`);
        state.repairEvents.push(`decomp-repair: ${d.reason ?? '?'}`);
        break;
      }

      // ── Planning ──────────────────────────────────────────────────────────
      case 'plan': {
        const d = env.data as { steps?: unknown[] };
        const stepCount = Array.isArray(d.steps) ? d.steps.length : 0;
        const existing = state.phases.find(p => p.name === 'Planning');
        if (existing) {
          existing.detail = `${stepCount} step(s)`;
        } else {
          addPhase(state, 'Planning', 0, `${stepCount} step(s)`);
        }
        break;
      }
      case 'plan_integrity_warning': {
        const d = env.data as { orphanedSteps?: string[]; missingSteps?: string[]; brokenDependencies?: string[] };
        const orphaned = d.orphanedSteps?.length ?? 0;
        const missing = d.missingSteps?.length ?? 0;
        const broken = d.brokenDependencies?.length ?? 0;
        const msg = `plan_integrity_warning: orphaned=${orphaned} missing=${missing} broken=${broken}`;
        state.repairEvents.push(msg);
        const p = state.phases.find(ph => ph.name === 'Planning');
        if (p) {
          if (missing > 0) p.warnings.push(`missingSteps: ${d.missingSteps?.slice(0, 5).join(', ')}${missing > 5 ? `… +${missing - 5}` : ''}`);
          if (orphaned > 0) p.warnings.push(`orphanedSteps: ${d.orphanedSteps?.slice(0, 5).join(', ')}`);
          if (broken > 0) p.warnings.push(`brokenDeps: ${d.brokenDependencies?.slice(0, 5).join(', ')}`);
        } else {
          addPhase(state, 'Planning', 0, '(integrity warning)', [msg]);
        }
        break;
      }
      case 'plan_repair_truncation': {
        const d = env.data as { attempt?: number; expectedSteps?: number; actualSteps?: number };
        const msg = `plan-repair attempt ${d.attempt ?? '?'}: expected ${d.expectedSteps ?? '?'} got ${d.actualSteps ?? '?'} steps`;
        state.repairEvents.push(msg);
        const p = state.phases.find(ph => ph.name === 'Planning');
        if (p) p.warnings.push(msg);
        break;
      }

      // ── Query Loop ────────────────────────────────────────────────────────
      case 'query_loop_start': {
        const d = env.data as { goal?: string };
        if (d.goal) state.goal = trunc(d.goal, 120);
        state.engine = 'query-loop';
        break;
      }
      case 'query_loop_iteration': {
        const d = env.data as { iteration?: number; reply?: string };
        state.iterations.push({
          n: d.iteration ?? state.iterations.length + 1,
          skill: '',
          input: trunc(d.reply ?? '', 60),
          ok: true,
        });
        break;
      }
      case 'query_loop_skill_call': {
        const d = env.data as { skill?: string; input?: Record<string, unknown> };
        const last = state.iterations[state.iterations.length - 1];
        if (last) {
          last.skill = d.skill ?? '';
          last.input = trunc(JSON.stringify(d.input ?? {}), 60);
        }
        break;
      }
      case 'query_loop_skill_result': {
        const d = env.data as { skill?: string; success?: boolean; error?: string };
        const last = state.iterations[state.iterations.length - 1];
        if (last) {
          last.ok = d.success ?? true;
          if (d.error) last.error = d.error;
        }
        break;
      }
      case 'query_loop_narration': {
        const d = env.data as { narration?: string };
        const narration = d.narration ?? '';
        const match = narration.match(/\[?(json-repair \d+\/\d+)\]?/);
        if (match) {
          const last = state.iterations[state.iterations.length - 1];
          if (last) last.repairNote = match[1];
        }
        break;
      }
      case 'query_loop_repair_loop_detected': {
        const d = env.data as { consecutiveRepairCount?: number; action?: string };
        state.repairEvents.push(`repair-loop: ${d.action ?? '?'} ×${d.consecutiveRepairCount ?? '?'}`);
        break;
      }
      case 'query_loop_end': {
        const d = env.data as { reason?: string };
        state.outcome = d.reason ?? 'ok';
        break;
      }

      // ── Executor (HIGH/MAX) ───────────────────────────────────────────────
      case 'milestone_start': {
        const d = env.data as { title?: string };
        if (!state.engine) state.engine = 'executor';
        state.milestones.push({ title: d.title ?? '(untitled)', ok: false, stepsRun: 0 });
        break;
      }
      case 'milestone_result': {
        const d = env.data as { ok?: boolean; stepsRun?: number };
        const last = state.milestones[state.milestones.length - 1];
        if (last) {
          last.ok = d.ok ?? false;
          last.stepsRun = d.stepsRun ?? 0;
        }
        break;
      }

      // ── Tokens / Cost ─────────────────────────────────────────────────────
      case 'token_usage': {
        const d = env.data as { inputTokens?: number; outputTokens?: number; estimatedCostUSD?: number };
        state.finalTokensIn = d.inputTokens ?? state.finalTokensIn;
        state.finalTokensOut = d.outputTokens ?? state.finalTokensOut;
        state.finalCostUSD = d.estimatedCostUSD ?? state.finalCostUSD;
        break;
      }

      // ── Errors ────────────────────────────────────────────────────────────
      case 'error': {
        const d = env.data as { source?: string; error?: string };
        state.errors.push(trunc(`${d.source ?? '?'}: ${d.error ?? '?'}`, 80));
        break;
      }

      // ── Spans (for phase timing) ───────────────────────────────────────────
      case 'span_start': {
        const d = env.data as { spanId?: string; parentSpanId?: string; label?: string; ts?: number };
        const spanId = d.spanId ?? '';
        const ts = d.ts ?? Date.now();
        state.spanStartTs.set(spanId, ts);
        if (d.label) state.spanLabels.set(spanId, d.label);

        if (!d.parentSpanId && d.label?.startsWith('request: ')) {
          state.rootSpanId = spanId;
          if (state.goal === '') state.goal = trunc(d.label.slice('request: '.length), 120);
        }
        break;
      }
      case 'span_end': {
        const d = env.data as { spanId?: string; durationMs?: number };
        const spanId = d.spanId ?? '';
        const label = state.spanLabels.get(spanId) ?? '';
        const dur = d.durationMs ?? 0;

        if (state.rootSpanId && spanId === state.rootSpanId) {
          state.durationMs = dur;
        }

        // Map span labels → phase entries for timing
        if (label.startsWith('Intake:')) {
          const p = state.phases.find(ph => ph.name === 'Intake');
          if (p) p.durationMs = dur;
        } else if (label.startsWith('Decomposition:')) {
          const p = state.phases.find(ph => ph.name === 'Decomposition');
          if (p) p.durationMs = dur;
        } else if (label.startsWith('Planner:')) {
          const p = state.phases.find(ph => ph.name === 'Planning');
          if (p) p.durationMs = dur;
          else addPhase(state, 'Planning', dur, `(span: ${label})`);
        } else if (label.startsWith('QueryLoop')) {
          const p = state.phases.find(ph => ph.name === 'Execution');
          if (p) p.durationMs += dur;
          else addPhase(state, 'Execution', dur, `query-loop`);
        } else if (label.startsWith('SimplePlan:')) {
          addPhase(state, 'Execution', dur, 'simple-plan');
        } else if (label.startsWith('Route:')) {
          const p = state.phases.find(ph => ph.name === 'Routing');
          if (p) p.durationMs = dur;
          else addPhase(state, 'Routing', dur, label.slice('Route: '.length));
        }
        break;
      }

      // ── decomposition_retry ───────────────────────────────────────────────
      case 'decomposition_retry': {
        const d = env.data as { reason?: string; repairCount?: number };
        state.repairEvents.push(`decomp-retry: ${d.reason ?? '?'}`);
        break;
      }
    }
  };

  const unsubscribe = transparency.on(handler);

  return async function flush(): Promise<void> {
    unsubscribe();
    if (!state.durationMs) {
      state.durationMs = Date.now() - state.startTs;
    }
    const text = render(state);
    const outPath = getDiagPath(requestId);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, text, 'utf-8');
    active.delete(requestId);
    transparency.emit({ type: 'diag_ready', data: { requestId, path: outPath, content: text } });
  };
}
