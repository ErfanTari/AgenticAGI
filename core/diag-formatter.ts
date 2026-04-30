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
  inputTokens?: number; // peak input tokens observed when this iter ran
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

interface RouteConsider {
  tier: string;
  matched: boolean;
  reason: string;
  details?: Record<string, unknown>;
}

interface SpecExtraction {
  engine: string;
  attempted: boolean;
  succeeded: boolean;
  reason?: string;
  rawLlmOutput?: string;
  attempts?: number;
}

interface DiagState {
  requestId: string;
  goal: string;
  startTs: number;
  engine: string;
  route: string;
  routeConsiderations: RouteConsider[];
  specExtractions: SpecExtraction[];
  finalReplyOrigin: 'engine' | 'query_loop_fallback' | 'engine_synthesized_finalize' | 'simple_plan' | 'executor' | 'unknown';
  finalReplyEngine: string | null;
  iterationCap: number | null;
  iterations: DiagIter[];
  narrationCount: number;
  systemBlockCount: number;
  systemHaltCount: number;
  phases: PhaseRecord[];
  milestones: DiagMilestone[];
  errors: string[];
  repairEvents: string[];
  finalTokensIn: number;
  finalTokensOut: number;
  finalCostUSD: number;
  // Token-growth accounting — captured per `token_usage` event
  inputTokenSamples: number[];
  outcome: string;
  durationMs: number;
  rootSpanId: string | null;
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

// ─── Mimicry detection ────────────────────────────────────────────────────────

/**
 * Final-iteration text contains the engine's reserved FINAL_STATUS: label
 * but no engine actually ran. This is the "LLM hallucinated the engine
 * output" failure mode — distinct from a clean no_action.
 */
function detectMimicry(state: DiagState): boolean {
  // Did any dedicated engine actually fire?
  const engineFired = state.specExtractions.some(s => s.succeeded) ||
    state.finalReplyOrigin === 'engine';
  if (engineFired) return false;
  // Did the final iteration's reply mimic the engine's reserved label?
  const last = state.iterations[state.iterations.length - 1];
  const lastText = last?.input ?? '';
  return /\bFINAL_STATUS\s*:/.test(lastText);
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

function renderRoutingDecisionTree(state: DiagState): string[] {
  const lines: string[] = [];
  lines.push('ROUTING DECISION TREE');
  lines.push('─────────────────────');

  if (state.routeConsiderations.length === 0) {
    lines.push('  (no dedicated-engine considerations recorded)');
    if (state.route) {
      lines.push(`  selected:                                ${state.route}`);
    }
    return lines;
  }

  // Map tier names to a consistent left-column label
  const tierLabel = (tier: string): string => {
    if (tier === 'web_download_engine') return 'tier_1a';
    if (tier === 'file_batch_transform') return 'tier_1b';
    if (tier === 'api_paginated_collect') return 'tier_1c';
    return 'tier_? ';
  };

  let winnerTier: string | null = null;
  for (const consider of state.routeConsiderations) {
    const extraction = state.specExtractions.find(s => {
      // map engine names: web_download_engine vs web_download_multi_target
      if (consider.tier === 'web_download_engine' && s.engine === 'web_download_engine') return true;
      if (consider.tier === 'file_batch_transform' && s.engine === 'file_batch_transform') return true;
      if (consider.tier === 'api_paginated_collect' && s.engine === 'api_paginated_collect') return true;
      return false;
    });
    let status: string;
    let reason: string;
    if (consider.matched && extraction?.succeeded) {
      status = 'SELECTED';
      reason = consider.reason;
      winnerTier = consider.tier;
    } else if (consider.matched && extraction && !extraction.succeeded) {
      status = 'REJECTED';
      reason = 'spec_extraction failed';
    } else if (consider.matched) {
      status = 'MATCHED ';
      reason = consider.reason;
    } else {
      status = 'REJECTED';
      reason = consider.reason;
    }
    lines.push(`  ${pad(tierLabel(consider.tier), 8)} ${pad(consider.tier, 24)} ${pad(status, 9)} ${reason}`);
    if (consider.details) {
      for (const [k, v] of Object.entries(consider.details)) {
        const verdict = v === true ? 'matched' : v === false ? 'no match' : String(v);
        lines.push(`           └─ ${pad(k, 30)} ${verdict}`);
      }
    }
    if (extraction && consider.matched) {
      if (extraction.succeeded) {
        lines.push(`           └─ spec_extraction:               ok (attempts=${extraction.attempts ?? '?'})`);
      } else {
        lines.push(`           └─ spec_extraction:               FAILED — ${extraction.reason ?? 'unknown'}`);
        if (extraction.rawLlmOutput) {
          const previewLen = Math.min(200, extraction.rawLlmOutput.length);
          lines.push(`           └─ raw LLM output (${previewLen} chars):  ${trunc(extraction.rawLlmOutput.replace(/\n/g, ' '), previewLen + 4)}`);
        }
      }
    }
  }

  // Fallback engine line — derived from finalReplyOrigin if no dedicated tier won
  if (!winnerTier) {
    const fallbackLabel = (() => {
      switch (state.finalReplyOrigin) {
        case 'query_loop_fallback': return 'query_loop';
        case 'simple_plan':         return 'simple_plan';
        case 'executor':            return 'executor';
        case 'engine':              return 'dedicated_engine';
        case 'engine_synthesized_finalize': return 'engine_force_finalize';
        default:                    return state.engine || 'unknown';
      }
    })();
    lines.push(`  tier_2   ${pad(fallbackLabel, 24)} SELECTED  default fallback`);
  }
  return lines;
}

function render(s: DiagState): string {
  const lines: string[] = [];

  lines.push('ZARABAN DIAG v3');
  lines.push('===============');
  lines.push(`id:       ${s.requestId.slice(0, 8)}`);
  lines.push(`goal:     ${trunc(s.goal, 120)}`);
  lines.push(`engine:   ${s.engine || '(unknown)'} | ${s.route || '(unknown)'}`);
  // Mimicry detection — distinct outcome label
  const mimicry = detectMimicry(s);
  const finalOutcome = mimicry ? 'mimicry' : (s.outcome || '(unknown)');
  lines.push(`outcome:  ${finalOutcome}${mimicry ? '  (LLM hallucinated FINAL_STATUS while no engine ran)' : ''}`);
  lines.push(`origin:   ${s.finalReplyOrigin}${s.finalReplyEngine ? ` (${s.finalReplyEngine})` : ''}`);
  lines.push(`duration: ${s.durationMs}ms`);

  // Iteration cap — visible from header so we can see "33/40 (82%)" at a glance.
  if (s.iterationCap !== null) {
    const used = s.iterations.length;
    const pct = Math.round((used / s.iterationCap) * 100);
    lines.push(`iters:    ${used}/${s.iterationCap} (${pct}%)`);
  } else if (s.iterations.length > 0) {
    lines.push(`iters:    ${s.iterations.length}`);
  }

  // Context growth — peak input tokens observed and per-turn growth rate.
  if (s.inputTokenSamples.length > 0) {
    const peak = Math.max(...s.inputTokenSamples);
    const first = s.inputTokenSamples[0];
    const turns = s.inputTokenSamples.length;
    const growthPerTurn = turns > 1 ? Math.round((peak - first) / (turns - 1)) : 0;
    lines.push(`ctx:      peak=${peak} tokens, +${growthPerTurn}/iter avg, samples=${turns}`);
  }

  // Narration injection counter — high values signal the loop is fighting itself.
  if (s.narrationCount > 0) {
    const flag = (s.systemBlockCount + s.systemHaltCount) > 3 ? '  ⚠ self-fighting' : '';
    lines.push(`narration: total=${s.narrationCount}, BLOCK=${s.systemBlockCount}, HALT=${s.systemHaltCount}${flag}`);
  }
  lines.push(`tokens:   in=${s.finalTokensIn} out=${s.finalTokensOut} cost=$${s.finalCostUSD.toFixed(4)}`);
  lines.push('');

  // ── Routing Decision Tree (Phase 25.4) ──
  for (const ln of renderRoutingDecisionTree(s)) lines.push(ln);
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
  if (s.repairEvents.length === 0 && !mimicry) {
    lines.push('  (none)');
  } else {
    for (const r of s.repairEvents) lines.push(`  ${r}`);
    if (mimicry) {
      lines.push('  ⚠ MIMICRY: final reply contains FINAL_STATUS but no engine fired.');
      lines.push('    The LLM hallucinated the engine output format. This is a routing bug,');
      lines.push('    not a no_action. Check ROUTING DECISION TREE above for which tier was rejected.');
    }
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
    routeConsiderations: [],
    specExtractions: [],
    finalReplyOrigin: 'unknown',
    finalReplyEngine: null,
    iterationCap: null,
    narrationCount: 0,
    systemBlockCount: 0,
    systemHaltCount: 0,
    inputTokenSamples: [],
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
      case 'route_consider': {
        const d = env.data as { tier?: string; matched?: boolean; reason?: string; details?: Record<string, unknown> };
        state.routeConsiderations.push({
          tier: d.tier ?? '?',
          matched: d.matched ?? false,
          reason: d.reason ?? '',
          details: d.details,
        });
        break;
      }
      case 'spec_extraction': {
        const d = env.data as { engine?: string; attempted?: boolean; succeeded?: boolean; reason?: string; rawLlmOutput?: string; attempts?: number };
        state.specExtractions.push({
          engine: d.engine ?? '?',
          attempted: d.attempted ?? false,
          succeeded: d.succeeded ?? false,
          reason: d.reason,
          rawLlmOutput: d.rawLlmOutput,
          attempts: d.attempts,
        });
        break;
      }
      case 'final_reply_origin': {
        const d = env.data as { origin?: DiagState['finalReplyOrigin']; engine?: string };
        if (d.origin) state.finalReplyOrigin = d.origin;
        state.finalReplyEngine = d.engine ?? null;
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
          input: trunc(d.reply ?? '', 200),
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
        state.narrationCount++;
        if (/\[SYSTEM BLOCK\]/.test(narration)) state.systemBlockCount++;
        if (/\[SYSTEM HALT\]/.test(narration)) state.systemHaltCount++;
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
        const d = env.data as { reason?: string; iterations?: number };
        state.outcome = d.reason ?? 'ok';
        // If we never got a route emitted, but the loop ran, the loop IS the
        // selected engine — capture iteration count.
        if (typeof d.iterations === 'number' && state.iterations.length === 0) {
          // synthetic — won't happen if iteration events fired but defensive
        }
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
        if (typeof d.inputTokens === 'number') {
          state.inputTokenSamples.push(d.inputTokens);
        }
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
    // Resolve iteration cap from iterations observed (the loop emits one
    // per iter; we treat the last `iter+remaining` as the cap when available).
    // The runtime caps come from COMPLEXITY_ITERATION_CAPS — we infer the cap
    // by the highest iteration we saw rounded up to the next standard cap.
    if (state.iterationCap === null && state.iterations.length > 0) {
      const last = state.iterations[state.iterations.length - 1].n;
      // Standard caps are 20/40/80/150 — pick the smallest cap >= last.
      const caps = [20, 40, 80, 150];
      state.iterationCap = caps.find(c => c >= last) ?? null;
    }
    const text = render(state);
    const outPath = getDiagPath(requestId);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, text, 'utf-8');
    active.delete(requestId);
    transparency.emit({ type: 'diag_ready', data: { requestId, path: outPath, content: text } });
  };
}
