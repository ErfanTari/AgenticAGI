import { describe, it, expect } from 'vitest';
import { buildRollingContext, buildContext, estimateTokens } from '../../core/context.js';
import type { Message, LLMHandler } from '../../core/types.js';

describe('Priority 2: Rolling Context Summaries', () => {
  // P2A — Short history (≤6 turns) returns all turns, no summary
  it('P2A: short history returns all turns without summarization', async () => {
    const shortHistory: Message[] = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Turn ${i} content`,
    }));

    // 10 messages = 5 turns (≤6 threshold)
    expect(shortHistory.length).toBe(10);

    const mockHandler: LLMHandler = async () => {
      throw new Error('LLM should not be called for short history');
    };

    const result = await buildRollingContext(shortHistory, mockHandler);

    expect(result.turns).toEqual(shortHistory);
    expect(result.summary).toBeUndefined();
    console.log(`P2A: ${shortHistory.length} messages (5 turns) → no summarization, ${result.turns.length} turns returned`);
  });

  // P2B — Long history (>6 turns) returns summary + recent 3 turns
  it('P2B: long history returns summary + recent 3 turns (6 messages)', async () => {
    const longHistory: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Turn ${i}: Discussion about project planning and implementation details.`,
    }));

    // 20 messages = 10 turns (>6 threshold)
    expect(longHistory.length).toBe(20);

    const mockHandler: LLMHandler = async (messages) => {
      // Verify summarization prompt
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('Summarize');
      expect(messages[1].role).toBe('user');

      return 'Summary: The conversation covered project planning and implementation strategies.';
    };

    const result = await buildRollingContext(longHistory, mockHandler);

    // Should keep only last 3 turns (6 messages)
    expect(result.turns.length).toBe(6);
    expect(result.turns[0].content).toContain('Turn 14'); // First kept message
    expect(result.turns[5].content).toContain('Turn 19'); // Last kept message

    // Summary should be present
    expect(result.summary).toBeDefined();
    expect(result.summary).toContain('project planning');

    console.log(`P2B: ${longHistory.length} messages → summary + ${result.turns.length} recent messages`);
    console.log(`P2B: Summary: ${result.summary}`);
  });

  // P2C — Summary token count is < 200 tokens
  it('P2C: summary stays under 150 token limit', async () => {
    const longHistory: Message[] = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Turn ${i}: Very detailed discussion about architectural decisions, implementation strategies, testing approaches, and deployment considerations.`.repeat(3),
    }));

    let summaryTokenCount = 0;

    const mockHandler: LLMHandler = async (messages, options) => {
      // Verify maxTokens is set to 150
      expect(options?.maxTokens).toBe(150);

      const summary = 'Summary: The conversation covered architectural decisions and implementation strategies for the project.';
      summaryTokenCount = estimateTokens(summary);
      return summary;
    };

    const result = await buildRollingContext(longHistory, mockHandler);

    expect(result.summary).toBeDefined();
    expect(summaryTokenCount).toBeLessThanOrEqual(150);

    console.log(`P2C: Summary token count: ${summaryTokenCount}/150 tokens`);
  });

  // P2D — Graceful fallback when summary LLM call fails
  it('P2D: graceful fallback when summarization fails', async () => {
    const longHistory: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Turn ${i} content`,
    }));

    const failingHandler: LLMHandler = async () => {
      throw new Error('LLM summarization failed (simulated network error)');
    };

    const result = await buildRollingContext(longHistory, failingHandler);

    // Should fall back to recent turns only, no summary
    expect(result.turns.length).toBe(6); // Last 3 turns
    expect(result.summary).toBeUndefined();

    console.log(`P2D: Summarization failed → fallback to ${result.turns.length} recent messages`);
  });

  // P2E — Full buildContext integration with rolling summarization
  it('P2E: buildContext integrates rolling summarization for long history', async () => {
    const longHistory: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Turn ${i}: Detailed conversation content about various topics.`,
    }));

    let summaryCallCount = 0;

    const mockHandler: LLMHandler = async (messages, options) => {
      // First call is for summarization (system + user with old messages)
      if (messages[0].content.includes('Summarize')) {
        summaryCallCount++;
        expect(options?.maxTokens).toBe(150);
        return 'Conversation summary paragraph here.';
      }
      // Subsequent calls would be normal LLM calls
      return 'Response';
    };

    const context = await buildContext(
      'What is the current status?',
      null,
      longHistory,
      [],
      'general',
      undefined,
      mockHandler,
    );

    // Summary should have been called once
    expect(summaryCallCount).toBe(1);

    // Context should include:
    // 1. System prompt
    // 2. Conversation summary message
    // 3. Recent 6 messages (3 turns)
    // 4. Current user message
    expect(context.length).toBeGreaterThanOrEqual(8);

    // Find summary message
    const summaryMessage = context.find(m =>
      m.role === 'system' && m.content.includes('Previous Conversation')
    );
    expect(summaryMessage).toBeDefined();
    expect(summaryMessage?.content).toContain('summary paragraph');

    console.log(`P2E: Full context built with ${context.length} messages (includes summary injection)`);
  });
});
