import { describe, it, expect } from 'vitest';
import { stripThinking } from '../../core/llm-helpers/strip-thinking.js';
import { stripThinkingTags } from '../../core/llm.js';

describe('stripThinking (llm-helpers)', () => {
  it('<think> block is removed and bytesRemoved is correct', () => {
    const raw = 'before <think>internal reasoning</think> after';
    const { stripped, bytesRemoved } = stripThinking(raw);
    expect(stripped).not.toContain('<think>');
    expect(stripped).not.toContain('internal reasoning');
    expect(stripped).toContain('before');
    expect(stripped).toContain('after');
    expect(bytesRemoved).toBeGreaterThan(0);
  });

  it('<thinking> block is removed', () => {
    const raw = 'start <thinking>long reasoning block</thinking> end';
    const { stripped, bytesRemoved } = stripThinking(raw);
    expect(stripped).not.toContain('<thinking>');
    expect(stripped).not.toContain('long reasoning block');
    expect(stripped).toContain('start');
    expect(stripped).toContain('end');
    expect(bytesRemoved).toBeGreaterThan(0);
  });

  it('both <think> and <thinking> stripped together', () => {
    const raw = '<think>A</think> hello <thinking>B</thinking>';
    const { stripped, bytesRemoved } = stripThinking(raw);
    expect(stripped).toBe('hello');
    expect(bytesRemoved).toBeGreaterThan(0);
  });

  it('no thinking blocks — output unchanged, bytesRemoved is 0', () => {
    const raw = 'plain response with no thinking blocks';
    const { stripped, bytesRemoved } = stripThinking(raw);
    expect(stripped).toBe(raw);
    expect(bytesRemoved).toBe(0);
  });
});

describe('stripThinkingTags in llm.ts handles <thinking> variant', () => {
  it('<thinking> blocks are stripped', () => {
    const raw = 'result <thinking>should be removed</thinking> done';
    const result = stripThinkingTags(raw);
    expect(result).not.toContain('<thinking>');
    expect(result).not.toContain('should be removed');
    expect(result).toContain('done');
  });
});
