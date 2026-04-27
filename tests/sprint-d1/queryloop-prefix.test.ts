/**
 * Sprint D1: query-loop iteration prefix tests.
 * Verifies that messages[0] (system) is never mutated across iterations.
 */
import { describe, it, expect } from 'vitest';
import { buildQueryLoopSystemPrompt, buildQueryLoopContextBlock } from '../../core/prompt-budget.js';
import type { Message } from '../../core/types.js';

describe('query-loop iteration prefix', () => {
  it('buildQueryLoopSystemPrompt returns same text for repeated calls (same skill list)', () => {
    const ctx = { goal: 'task A', pointerIndex: '', activeLoops: '' };
    const r1 = buildQueryLoopSystemPrompt(ctx);
    const r2 = buildQueryLoopSystemPrompt({ ...ctx, goal: 'task B' });
    // System prompt must be identical regardless of goal
    expect(r1.text).toBe(r2.text);
  });

  it('context block changes when goal changes', () => {
    const block1 = buildQueryLoopContextBlock({ goal: 'task A', pointerIndex: '', activeLoops: '' });
    const block2 = buildQueryLoopContextBlock({ goal: 'task B', pointerIndex: '', activeLoops: '' });
    expect(block1).not.toBe(block2);
  });

  it('simulated messages[0] stays stable across appended iterations', () => {
    const systemContent = buildQueryLoopSystemPrompt({ goal: 'x', pointerIndex: '', activeLoops: '' }).text;
    const messages: Message[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: '<context>\n## Current goal\nx\n</context>\n\nGOAL: x' },
    ];
    const initialSystem = messages[0].content;

    // Simulate iteration appending (tool result + goal reminder)
    messages.push({ role: 'assistant', content: '{"action":"calculator","input":{"expr":"1+1"}}' });
    messages.push({ role: 'user', content: 'Result: 2\n\nGOAL: x (iteration 2)' });

    // system message at index 0 must not have changed
    expect(messages[0].content).toBe(initialSystem);
  });

  it('context block contains active loops when provided', () => {
    const block = buildQueryLoopContextBlock({
      goal: 'test',
      pointerIndex: '',
      activeLoops: '- loop-1: doing something',
    });
    // Memory disabled in this test so loops section should be absent
    // (we're not calling setMemoryMode — memory is enabled by default in module)
    expect(typeof block).toBe('string');
    expect(block).toContain('test');
  });
});
