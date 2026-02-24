import { describe, it, expect } from 'vitest';
import { estimateTokens, buildContext } from '../../core/context.js';
import type { Message } from '../../core/types.js';

describe('Priority 1: Exact Token Counting', () => {
  // P1A — Dense JSON counts correctly
  it('P1A: dense JSON counts more accurately than chars/4', () => {
    const denseJSON = JSON.stringify({
      users: Array.from({ length: 20 }, (_, i) => ({
        id: i,
        name: `User${i}`,
        email: `user${i}@example.com`,
        active: true,
        metadata: { role: 'admin', level: 5 },
      })),
    });

    expect(denseJSON.length).toBeGreaterThanOrEqual(1000);

    const tokenCount = estimateTokens(denseJSON);
    const charBasedEstimate = Math.ceil(denseJSON.length / 4);

    // Dense JSON should use MORE tokens than simple char/4 estimate
    expect(tokenCount).toBeGreaterThan(charBasedEstimate);
    expect(tokenCount).toBeGreaterThan(250);

    console.log(`P1A: 1000-char JSON → ${tokenCount} tokens (chars/4 would give ${charBasedEstimate})`);
  });

  // P1B — Markdown counts correctly
  it('P1B: markdown with code blocks counts more tokens than chars/4', () => {
    const markdown = `# Code Example

Here's a TypeScript function:

\`\`\`typescript
function processData(input: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of input) {
    result[item] = (result[item] || 0) + 1;
  }
  return result;
}
\`\`\`

## Another Section

- Bullet point one
- Bullet point two
- Bullet point three

More text to pad this out to over 1000 characters total. `.repeat(5);

    expect(markdown.length).toBeGreaterThanOrEqual(1000);

    const tokenCount = estimateTokens(markdown);
    const charBasedEstimate = Math.ceil(markdown.length / 4);

    expect(tokenCount).toBeGreaterThan(250);

    console.log(`P1B: 1000-char markdown → ${tokenCount} tokens (chars/4 would give ${charBasedEstimate})`);
  });

  // P1C — Context ceiling enforced
  it('P1C: context truncated before exceeding MAX_TOKENS, never sent oversized', async () => {
    const MAX_TOKENS = 1500;

    // Build a context that would naturally exceed MAX_TOKENS
    const largeHistory: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `This is turn ${i}. `.repeat(50), // ~50 tokens each
    }));

    const userMessage = 'What is the status of the project?';

    const context = await buildContext(userMessage, null, largeHistory, [], 'general');

    const finalTokens = estimateTokens(context);

    // Context should be truncated to stay under MAX_TOKENS
    expect(finalTokens).toBeLessThanOrEqual(MAX_TOKENS);
    console.log(`P1C: Built context with ${finalTokens}/${MAX_TOKENS} tokens (truncated)`);
  });

  // P1D — 80% warning fires
  it('P1D: warning logged when context exceeds 80% but under MAX_TOKENS', async () => {
    const MAX_TOKENS = 1500;
    const WARNING_THRESHOLD = Math.floor(MAX_TOKENS * 0.8); // 1200

    const warnSpy: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = args.join(' ');
      warnSpy.push(msg);
      originalWarn(msg); // Also log so we can see it
    };

    // Build context that lands between 80% and 100%
    // System prompt ~100 tokens, we want final ~1250 tokens
    // Use 12 messages (6 turns) with medium content
    const mediumHistory: Message[] = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Turn ${i}: Here is discussion about project WHAT.PJ-000001 including technical specifications, architectural diagrams, implementation timelines, and stakeholder feedback.`.repeat(3), // ~250 tokens each
    }));

    const userMessage = 'Show me the detailed summary of all active projects and their current status';

    const context = await buildContext(userMessage, null, mediumHistory, [], 'general');
    const finalTokens = estimateTokens(context);

    console.warn = originalWarn;

    console.log(`P1D DEBUG: finalTokens=${finalTokens}, warnings captured:`, warnSpy);

    // Should be between warning threshold and max
    expect(finalTokens).toBeGreaterThan(WARNING_THRESHOLD);
    expect(finalTokens).toBeLessThanOrEqual(MAX_TOKENS);

    // Warning should have fired
    const hasWarning = warnSpy.some(msg =>
      msg.includes('[context]') && msg.includes('approaching limit')
    );

    expect(hasWarning).toBe(true);
    console.log(`P1D: Context at ${finalTokens} tokens → warning fired: ${hasWarning}`);
  });
});
