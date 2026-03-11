import { describe, expect, it, vi } from 'vitest';
import { classifyIntent } from '../../core/intent.js';
import { processMessage } from '../../core/agent.js';

describe('Phase 13: compatibility shims', () => {
  it('keeps legacy intent labels exported for existing callers', () => {
    expect(classifyIntent('hello').intent).toBe('greeting');
    expect(classifyIntent('write a weekly status report based on everything you know').intent).toBe('synthesis_query');
  });

  it('handles "hi" through conversational routing without needing an LLM call', async () => {
    const llm = vi.fn(async () => {
      throw new Error('greeting path should not need the LLM');
    });

    const result = await processMessage('hi', [], { llmHandler: llm });
    expect(result.intent).toBe('greeting');
    expect(result.reply).toContain('Hello');
    expect(llm).not.toHaveBeenCalled();
  });

  it('preserves legacy one-step skill mapping for simple arithmetic', async () => {
    const llm = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('## Skill Output')) return '10';
      return 'unused';
    });

    const result = await processMessage('what is 5 + 5', [], { llmHandler: llm });
    expect(result.intent).toBe('skill');
    expect(result.reply).toContain('10');
  });

  it('classifies workspace build requests as planned_workflow instead of memory_write', () => {
    const classification = classifyIntent(
      'lets do a semi complex task, create a snake_game folder in the workspace and build a snake game in HTML inside it',
    );

    expect(classification.intent).toBe('planned_workflow');
  });
});
