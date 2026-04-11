/**
 * Tests for core/token-counter.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recordTokens, getTokenStats, resetTokenStats } from '../../core/token-counter.js';

// Mock transparency to avoid side effects
vi.mock('../../core/transparency.js', () => ({
  transparency: { emit: vi.fn(), isEnabled: () => false },
}));

beforeEach(() => {
  resetTokenStats();
});

describe('token counter', () => {
  it('starts at zero', () => {
    const stats = getTokenStats();
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
    expect(stats.callCount).toBe(0);
    expect(stats.estimatedCostUSD).toBe(0);
  });

  it('accumulates tokens across multiple calls', () => {
    recordTokens(1000, 200);
    recordTokens(500, 100);
    const stats = getTokenStats();
    expect(stats.inputTokens).toBe(1500);
    expect(stats.outputTokens).toBe(300);
    expect(stats.callCount).toBe(2);
  });

  it('increments callCount on each recordTokens call', () => {
    recordTokens(100, 50);
    recordTokens(100, 50);
    recordTokens(100, 50);
    expect(getTokenStats().callCount).toBe(3);
  });

  it('resetTokenStats zeroes all counters', () => {
    recordTokens(1000, 500);
    resetTokenStats();
    const stats = getTokenStats();
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
    expect(stats.callCount).toBe(0);
    expect(stats.estimatedCostUSD).toBe(0);
  });

  it('computes estimatedCostUSD correctly for input tokens', () => {
    recordTokens(1_000_000, 0);
    const stats = getTokenStats();
    expect(stats.estimatedCostUSD).toBeCloseTo(3.0, 4);
  });

  it('computes estimatedCostUSD correctly for output tokens', () => {
    recordTokens(0, 1_000_000);
    const stats = getTokenStats();
    expect(stats.estimatedCostUSD).toBeCloseTo(15.0, 4);
  });

  it('computes estimatedCostUSD correctly for mixed tokens', () => {
    recordTokens(100_000, 10_000);
    const stats = getTokenStats();
    // input: 100k * 0.000003 = 0.3, output: 10k * 0.000015 = 0.15 → 0.45
    expect(stats.estimatedCostUSD).toBeCloseTo(0.45, 5);
  });

  it('accumulates estimatedCostUSD across calls', () => {
    recordTokens(500, 100);
    recordTokens(500, 100);
    const stats = getTokenStats();
    expect(stats.inputTokens).toBe(1000);
    expect(stats.outputTokens).toBe(200);
    // 1000 * 0.000003 + 200 * 0.000015 = 0.003 + 0.003 = 0.006
    expect(stats.estimatedCostUSD).toBeCloseTo(0.006, 6);
  });
});

describe('token extraction compatibility', () => {
  it('handles zero input and output without throwing', () => {
    expect(() => recordTokens(0, 0)).not.toThrow();
    expect(getTokenStats().callCount).toBe(1);
    expect(getTokenStats().estimatedCostUSD).toBe(0);
  });

  it('handles large token counts without overflow', () => {
    recordTokens(10_000_000, 2_000_000);
    const stats = getTokenStats();
    expect(stats.inputTokens).toBe(10_000_000);
    expect(stats.outputTokens).toBe(2_000_000);
    expect(stats.estimatedCostUSD).toBeCloseTo(60, 1);
  });
});
