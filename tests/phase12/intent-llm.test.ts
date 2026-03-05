/**
 * FIX 5 — LLM Intent Classifier.
 * Tests output normalization, fallback behavior, and valid intent mapping.
 */
import { describe, it, expect } from 'vitest';
import { classifyIntentLLM } from '../../core/intent-llm.js';
import type { LLMHandler } from '../../core/types.js';

describe('FIX 5 — classifyIntentLLM output normalization', () => {
  it('accepts exact intent names', async () => {
    const mock: LLMHandler = async () => 'planned_workflow';
    expect(await classifyIntentLLM('do something complex', mock)).toBe('planned_workflow');
  });

  it('normalizes mixed case output', async () => {
    const mock: LLMHandler = async () => 'Planned_Workflow';
    expect(await classifyIntentLLM('build an app', mock)).toBe('planned_workflow');
  });

  it('strips punctuation from LLM output', async () => {
    const mock: LLMHandler = async () => 'memory_write.';
    expect(await classifyIntentLLM('remember this', mock)).toBe('memory_write');
  });

  it('falls back to general on unrecognized output', async () => {
    const mock: LLMHandler = async () => 'some_random_thing';
    expect(await classifyIntentLLM('random message', mock)).toBe('general');
  });

  it('falls back to general when LLM throws', async () => {
    const mock: LLMHandler = async () => { throw new Error('LLM down'); };
    expect(await classifyIntentLLM('any message', mock)).toBe('general');
  });

  it('handles "memory_read" output by mapping to memory_query', async () => {
    const mock: LLMHandler = async () => 'memory_read';
    // memory_read is not a valid intent — should map via partial match to memory_query
    const result = await classifyIntentLLM('show my contacts', mock);
    expect(result).toBe('memory_query');
  });

  it('accepts meeting intent', async () => {
    const mock: LLMHandler = async () => 'meeting';
    expect(await classifyIntentLLM('start standup', mock)).toBe('meeting');
  });

  it('accepts episodic_query intent', async () => {
    const mock: LLMHandler = async () => 'episodic_query';
    expect(await classifyIntentLLM('what happened yesterday', mock)).toBe('episodic_query');
  });

  it('accepts general intent from LLM', async () => {
    const mock: LLMHandler = async () => 'general';
    expect(await classifyIntentLLM('what is 2 + 2', mock)).toBe('general');
  });

  it('handles whitespace-padded output', async () => {
    const mock: LLMHandler = async () => '  planned_workflow  ';
    expect(await classifyIntentLLM('build something', mock)).toBe('planned_workflow');
  });
});
