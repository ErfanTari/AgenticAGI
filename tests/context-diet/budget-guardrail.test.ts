/**
 * Budget guardrail tests (Batch 4)
 *
 * Verifies:
 * 1. emitPromptBudget emits prompt_budget event always
 * 2. emitPromptBudget emits prompt_budget_exceeded when over limit
 * 3. No prompt_budget_exceeded when under limit
 * 4. PROMPT_INPUT_LIMITS has entries for all key engines
 * 5. COMPLEXITY_ITERATION_CAPS values are ordered LOW < MEDIUM < HIGH < MAX
 * 6. transparency event union includes prompt_budget_exceeded type
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROMPT_INPUT_LIMITS } from '../../config/agent.config.js';
import { COMPLEXITY_ITERATION_CAPS } from '../../core/query-loop.js';

// ─── Mock transparency ────────────────────────────────────────────────────────

const emittedEvents: Array<{ type: string; data: unknown }> = [];

vi.mock('../../core/transparency.js', () => ({
  transparency: {
    emit: vi.fn((event: { type: string; data: unknown }) => {
      emittedEvents.push(event);
    }),
  },
}));

// ─── Mock deps for prompt-budget ─────────────────────────────────────────────

vi.mock('../../core/prompt-loader.js', () => ({
  promptLoader: { load: vi.fn().mockReturnValue('mock prompt text') },
}));

vi.mock('../../core/skills/registry.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, getSkillOneLinerList: vi.fn().mockReturnValue('skill1 — desc'), getSkillCompactDescriptions: vi.fn().mockReturnValue('skill1: desc') };
});

vi.mock('../../core/permission.js', () => ({ getActivePermissionMode: vi.fn().mockReturnValue('read-only') }));
vi.mock('../../core/memory-mode.js', () => ({ getMemoryMode: vi.fn().mockReturnValue('disabled'), isMemoryFullyDisabled: vi.fn().mockReturnValue(true) }));
vi.mock('../../core/context.js', () => ({ estimateTokens: vi.fn((s: string) => Math.ceil(s.length / 4)) }));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PROMPT_INPUT_LIMITS', () => {
  it('has entries for key engines', () => {
    expect(PROMPT_INPUT_LIMITS['query-loop']).toBeGreaterThan(0);
    expect(PROMPT_INPUT_LIMITS['planner']).toBeGreaterThan(0);
    expect(PROMPT_INPUT_LIMITS['decomposition']).toBeGreaterThan(0);
    expect(PROMPT_INPUT_LIMITS['intake']).toBeGreaterThan(0);
  });

  it('query-loop limit is at or below 2500 (sprint target)', () => {
    expect(PROMPT_INPUT_LIMITS['query-loop']).toBeLessThanOrEqual(2500);
  });

  it('planner limit accommodates planner.md baseline (~8000 tokens)', () => {
    expect(PROMPT_INPUT_LIMITS['planner']).toBeGreaterThan(8000);
  });
});

describe('COMPLEXITY_ITERATION_CAPS', () => {
  it('LOW < MEDIUM < HIGH < MAX', () => {
    expect(COMPLEXITY_ITERATION_CAPS.LOW).toBeLessThan(COMPLEXITY_ITERATION_CAPS.MEDIUM);
    expect(COMPLEXITY_ITERATION_CAPS.MEDIUM).toBeLessThan(COMPLEXITY_ITERATION_CAPS.HIGH);
    expect(COMPLEXITY_ITERATION_CAPS.HIGH).toBeLessThan(COMPLEXITY_ITERATION_CAPS.MAX);
  });

  it('LOW is 20 (default query-loop cap)', () => {
    expect(COMPLEXITY_ITERATION_CAPS.LOW).toBe(20);
  });
});

describe('emitPromptBudget guardrail', () => {
  beforeEach(() => {
    emittedEvents.length = 0;
    vi.clearAllMocks();
  });

  it('emits prompt_budget event', async () => {
    const { emitPromptBudget } = await import('../../core/prompt-budget.js');
    const { transparency } = await import('../../core/transparency.js');

    emitPromptBudget(transparency, {
      text: 'x'.repeat(100),
      tokenEstimate: 25,
      sources: [{ name: 'test', tokenEstimate: 25 }],
      promptId: 'query-loop',
    }, 'query-loop');

    expect(transparency.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'prompt_budget' }),
    );
  });

  it('does NOT emit prompt_budget_exceeded when under limit', async () => {
    const { emitPromptBudget } = await import('../../core/prompt-budget.js');
    const { transparency } = await import('../../core/transparency.js');

    emitPromptBudget(transparency, {
      text: '',
      tokenEstimate: 100, // well under 2500
      sources: [],
      promptId: 'query-loop',
    }, 'query-loop');

    const calls = (transparency.emit as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0].type);
    expect(calls).not.toContain('prompt_budget_exceeded');
  });

  it('emits prompt_budget_exceeded when over limit', async () => {
    const { emitPromptBudget } = await import('../../core/prompt-budget.js');
    const { transparency } = await import('../../core/transparency.js');

    const limit = PROMPT_INPUT_LIMITS['query-loop'];
    emitPromptBudget(transparency, {
      text: '',
      tokenEstimate: limit + 500,
      sources: [],
      promptId: 'query-loop',
    }, 'query-loop');

    const exceeded = (transparency.emit as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0])
      .find((e: { type: string }) => e.type === 'prompt_budget_exceeded');

    expect(exceeded).toBeDefined();
    expect(exceeded.data.overage).toBe(500);
    expect(exceeded.data.limitTokens).toBe(limit);
  });

  it('does NOT emit prompt_budget_exceeded for unknown engine', async () => {
    const { emitPromptBudget } = await import('../../core/prompt-budget.js');
    const { transparency } = await import('../../core/transparency.js');

    emitPromptBudget(transparency, {
      text: '',
      tokenEstimate: 99999, // enormous but no limit defined for this engine
      sources: [],
      promptId: 'unknown-engine',
    }, 'unknown-engine');

    const calls = (transparency.emit as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0].type);
    expect(calls).not.toContain('prompt_budget_exceeded');
  });

  it('includes engine and promptId in exceeded event', async () => {
    const { emitPromptBudget } = await import('../../core/prompt-budget.js');
    const { transparency } = await import('../../core/transparency.js');

    const limit = PROMPT_INPUT_LIMITS['planner'];
    emitPromptBudget(transparency, {
      text: '',
      tokenEstimate: limit + 1,
      sources: [],
      promptId: 'planner',
    }, 'planner');

    const exceeded = (transparency.emit as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0])
      .find((e: { type: string }) => e.type === 'prompt_budget_exceeded');

    expect(exceeded?.data.engine).toBe('planner');
    expect(exceeded?.data.promptId).toBe('planner');
  });
});
