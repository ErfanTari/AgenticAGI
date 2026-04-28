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

interface DiagState {
  requestId: string;
  goal: string;
  startTs: number;
  engine: string;
  route: string;
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

// Exported so tests can override via the _diagBaseDir variable below.
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

  lines.push('ZARABAN DIAG v1');
  lines.push('===============');
  lines.push(`id:       ${s.requestId.slice(0, 8)}`);
  lines.push(`goal:     ${trunc(s.goal, 120)}`);
  lines.push(`engine:   ${s.engine || '(unknown)'} | ${s.route || '(unknown)'}`);
  lines.push(`outcome:  ${s.outcome || '(unknown)'}`);
  lines.push(`duration: ${s.durationMs}ms`);
  lines.push(`tokens:   in=${s.finalTokensIn} out=${s.finalTokensOut} cost=$${s.finalCostUSD.toFixed(4)}`);
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
    lines.push('  (none)');
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

// ─── Session ──────────────────────────────────────────────────────────────────

const active = new Map<string, DiagState>();

export function startDiagSession(requestId: string): () => Promise<void> {
  const state: DiagState = {
    requestId,
    goal: '',
    startTs: Date.now(),
    engine: '',
    route: '',
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
  };
  active.set(requestId, state);

  const handler = (env: TransparencyEventEnvelope) => {
    // Only process events for this request
    if (env.requestId !== requestId) return;
    const e = env as TransparencyEventEnvelope;

    switch (e.type) {
      case 'route': {
        // level = complexity (LOW/MEDIUM/HIGH/MAX), path = route path description
        const d = e.data as { level?: string; path?: string; reason?: string };
        const parts = [d.level, d.path].filter(Boolean);
        state.route = trunc(parts.join(' | '), 60);
        break;
      }
      case 'query_loop_start': {
        const d = e.data as { goal?: string };
        // Always overwrite goal — query_loop_start carries the actual task, not the user's last message
        if (d.goal) state.goal = trunc(d.goal, 120);
        // query-loop engine always wins (overrides any earlier default)
        state.engine = 'query-loop';
        break;
      }
      case 'query_loop_iteration': {
        const d = e.data as { iteration?: number; reply?: string };
        state.iterations.push({
          n: d.iteration ?? state.iterations.length + 1,
          skill: '',
          input: trunc(d.reply ?? '', 60),
          ok: true,
        });
        break;
      }
      case 'query_loop_skill_call': {
        const d = e.data as { skill?: string; input?: Record<string, unknown> };
        const last = state.iterations[state.iterations.length - 1];
        if (last) {
          last.skill = d.skill ?? '';
          last.input = trunc(JSON.stringify(d.input ?? {}), 60);
        }
        break;
      }
      case 'query_loop_skill_result': {
        const d = e.data as { skill?: string; success?: boolean; error?: string };
        const last = state.iterations[state.iterations.length - 1];
        if (last) {
          last.ok = d.success ?? true;
          if (d.error) last.error = d.error;
        }
        break;
      }
      case 'query_loop_narration': {
        const d = e.data as { narration?: string };
        const narration = d.narration ?? '';
        const match = narration.match(/\[?(json-repair \d+\/\d+)\]?/);
        if (match) {
          const last = state.iterations[state.iterations.length - 1];
          if (last) last.repairNote = match[1];
        }
        break;
      }
      case 'query_loop_repair_loop_detected': {
        const d = e.data as { consecutiveRepairCount?: number; action?: string };
        state.repairEvents.push(`repair-loop: ${d.action ?? '?'} ×${d.consecutiveRepairCount ?? '?'}`);
        break;
      }
      case 'query_loop_end': {
        const d = e.data as { reason?: string };
        state.outcome = d.reason ?? 'ok';
        break;
      }
      case 'milestone_start': {
        const d = e.data as { title?: string };
        // executor engine: milestone_start fires for HIGH/MAX plans; only set if not already known
        if (!state.engine) state.engine = 'executor';
        state.milestones.push({ title: d.title ?? '(untitled)', ok: false, stepsRun: 0 });
        break;
      }
      case 'milestone_result': {
        const d = e.data as { ok?: boolean; stepsRun?: number };
        const last = state.milestones[state.milestones.length - 1];
        if (last) {
          last.ok = d.ok ?? false;
          last.stepsRun = d.stepsRun ?? 0;
        }
        break;
      }
      case 'token_usage': {
        const d = e.data as { inputTokens?: number; outputTokens?: number; estimatedCostUSD?: number };
        state.finalTokensIn = d.inputTokens ?? state.finalTokensIn;
        state.finalTokensOut = d.outputTokens ?? state.finalTokensOut;
        state.finalCostUSD = d.estimatedCostUSD ?? state.finalCostUSD;
        break;
      }
      case 'error': {
        const d = e.data as { source?: string; error?: string };
        state.errors.push(trunc(`${d.source ?? '?'}: ${d.error ?? '?'}`, 80));
        break;
      }
      case 'plan_repair_truncation': {
        const d = e.data as { attempt?: number; expectedSteps?: number; actualSteps?: number };
        state.repairEvents.push(
          `plan-repair attempt ${d.attempt ?? '?'}: expected ${d.expectedSteps ?? '?'} got ${d.actualSteps ?? '?'} steps`,
        );
        break;
      }
      case 'decomposition_repair': {
        const d = e.data as { reason?: string };
        state.repairEvents.push(`decomp-repair: ${d.reason ?? '?'}`);
        break;
      }
      case 'span_start': {
        const d = e.data as { spanId?: string; parentSpanId?: string; label?: string };
        if (!d.parentSpanId && d.label?.startsWith('request: ')) {
          state.rootSpanId = d.spanId ?? null;
          // Only use span label as fallback — query_loop_start will overwrite with the real goal
          if (state.goal === '') state.goal = trunc(d.label.slice('request: '.length), 120);
        }
        break;
      }
      case 'span_end': {
        const d = e.data as { spanId?: string; durationMs?: number };
        if (state.rootSpanId && d.spanId === state.rootSpanId) {
          state.durationMs = d.durationMs ?? 0;
        }
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
    // Notify any transparency subscribers (e.g. ui-server) that the diag is ready
    transparency.emit({ type: 'diag_ready', data: { requestId, path: outPath, content: text } });
  };
}
