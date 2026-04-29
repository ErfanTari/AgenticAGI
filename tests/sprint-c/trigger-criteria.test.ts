import { describe, it, expect } from 'vitest';
import { hasExploreSignal, hasImplementSignal } from '../../core/router.js';

describe('sub-agent trigger heuristics', () => {
  it('explore-only goal (no implement signal) should NOT trigger', () => {
    const goal = 'find the auth module and explore how it works';
    expect(hasExploreSignal(goal)).toBe(true);
    expect(hasImplementSignal(goal)).toBe(false);
  });

  it('implement-only goal (no explore signal) should NOT trigger', () => {
    const goal = 'create a new login endpoint';
    expect(hasExploreSignal(goal)).toBe(false);
    expect(hasImplementSignal(goal)).toBe(true);
  });

  it('both signals present: goal with find + implement', () => {
    const goal = 'find the routing logic, then implement a new dispatch tier';
    expect(hasExploreSignal(goal)).toBe(true);
    expect(hasImplementSignal(goal)).toBe(true);
  });

  it('analyze + refactor: both signals', () => {
    const goal = 'analyze the memory module and refactor it to reduce coupling';
    expect(hasExploreSignal(goal)).toBe(true);
    expect(hasImplementSignal(goal)).toBe(true);
  });

  it('neutral goal: neither signal', () => {
    const goal = 'what is the capital of France';
    expect(hasExploreSignal(goal)).toBe(false);
    expect(hasImplementSignal(goal)).toBe(false);
  });
});
