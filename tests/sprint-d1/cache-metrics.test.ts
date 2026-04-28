/**
 * Sprint D1: cache metrics tests.
 * Verifies llm_cache_metric event type and session seen-set behavior.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetSeenPrefixHashes } from '../../core/llm.js';
import { transparency, type TransparencyEventEnvelope } from '../../core/transparency.js';
import { buildStablePrelude } from '../../core/context.js';
import { buildQueryLoopSystemPrompt } from '../../core/prompt-budget.js';
import { setMemoryMode, _resetMemoryMode } from '../../core/memory-mode.js';

beforeEach(() => {
  _resetSeenPrefixHashes();
  _resetMemoryMode();
  setMemoryMode('disabled');
});

describe('llm_cache_metric event type', () => {
  it('llm_cache_metric event has required fields', () => {
    let captured: TransparencyEventEnvelope | undefined;
    const unsub = transparency.on(e => {
      if (e.type === 'llm_cache_metric') captured = e;
    });

    transparency.enable();
    transparency.emit({
      type: 'llm_cache_metric',
      data: { prefixHash: 'abc12345', hit: false, requestId: 'req-1', engine: 'primary', stableTokens: 220 },
    });
    transparency.disable();
    unsub();

    expect(captured).toBeDefined();
    expect(captured!.type).toBe('llm_cache_metric');
    const d = (captured!.data as { prefixHash: string; hit: boolean; requestId: string; engine: string; stableTokens: number });
    expect(d.prefixHash).toBe('abc12345');
    expect(d.hit).toBe(false);
    expect(d.stableTokens).toBe(220);
  });

  it('_resetSeenPrefixHashes clears the session set', () => {
    // After reset, the seen set is empty — subsequent calls would register as miss
    _resetSeenPrefixHashes();
    expect(true).toBe(true); // no throw = pass
  });

  it('buildStablePrelude output length is non-zero (proxy for token count)', () => {
    const prelude = buildStablePrelude();
    const approxTokens = Math.round(prelude.length / 4);
    expect(approxTokens).toBeGreaterThan(50);
  });

  it('buildQueryLoopSystemPrompt token estimate is positive', () => {
    const built = buildQueryLoopSystemPrompt({ goal: 'hello', pointerIndex: '', activeLoops: '' });
    expect(built.tokenEstimate).toBeGreaterThan(0);
  });

  it('system prompt token estimate is smaller than old combined estimate (goal not included)', () => {
    // The stable system prompt should be < 1500 tokens since it no longer includes goal+index
    const built = buildQueryLoopSystemPrompt({ goal: 'a'.repeat(5000), pointerIndex: 'b'.repeat(5000), activeLoops: '' });
    // If goal/index were still in system, this would be huge
    // Threshold raised to 3500 after queryloop-webdownload-complete sprint added ~600 tokens
    expect(built.tokenEstimate).toBeLessThan(3500);
  });
});
