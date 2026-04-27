/**
 * Sprint D1: prefix stability tests.
 * Verifies that buildStablePrelude() is truly stable (same string across calls)
 * and that buildQueryLoopSystemPrompt produces output that does NOT contain the goal.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildStablePrelude } from '../../core/context.js';
import { buildQueryLoopSystemPrompt, buildQueryLoopContextBlock } from '../../core/prompt-budget.js';
import { setMemoryMode, _resetMemoryMode } from '../../core/memory-mode.js';

beforeEach(() => {
  _resetMemoryMode();
  setMemoryMode('disabled');
});

describe('buildStablePrelude', () => {
  it('returns a non-empty string', () => {
    const prelude = buildStablePrelude();
    expect(typeof prelude).toBe('string');
    expect(prelude.length).toBeGreaterThan(0);
  });

  it('is identical across multiple calls', () => {
    const a = buildStablePrelude();
    const b = buildStablePrelude();
    expect(a).toBe(b);
  });

  it('contains agent identity text', () => {
    const prelude = buildStablePrelude();
    expect(prelude).toContain('zaraban');
  });
});

describe('buildQueryLoopSystemPrompt prefix stability', () => {
  it('system prompt does NOT contain the goal', () => {
    const uniqueGoal = `unique-goal-${Date.now()}`;
    const built = buildQueryLoopSystemPrompt({ goal: uniqueGoal, pointerIndex: '', activeLoops: '' });
    expect(built.text).not.toContain(uniqueGoal);
  });

  it('system prompt is identical for two different goals', () => {
    const a = buildQueryLoopSystemPrompt({ goal: 'build an HTML game', pointerIndex: '', activeLoops: '' });
    const b = buildQueryLoopSystemPrompt({ goal: 'search the web for news', pointerIndex: '', activeLoops: '' });
    expect(a.text).toBe(b.text);
  });

  it('context block contains the goal', () => {
    const goal = 'write a haiku generator';
    const block = buildQueryLoopContextBlock({ goal, pointerIndex: '', activeLoops: '' });
    expect(block).toContain(goal);
  });

  it('context block contains pointer index when memory enabled', () => {
    setMemoryMode('enabled');
    const pointerIndex = 'WHO.CT-000001: Alice';
    const block = buildQueryLoopContextBlock({ goal: 'hello', pointerIndex, activeLoops: '' });
    setMemoryMode('disabled');
    expect(block).toContain(pointerIndex);
  });
});
