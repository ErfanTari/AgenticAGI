/**
 * UI "Research ▸ collect" mode is sent as `researchCollectEngine: true` on chat
 * WebSocket messages and passed into `processMessage`. That flag must bypass
 * the quick LOW/MEDIUM → QueryLoop shortcut (which calls `assessComplexity`)
 * so dedicated one-call engines can be reached after full routing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('researchCollectEngine', () => {
  let assessSpy: ReturnType<typeof vi.spyOn>;
  let runLoopSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const planner = await import('../../core/planner.js');
    const queryLoop = await import('../../core/query-loop.js');
    assessSpy = vi.spyOn(planner, 'assessComplexity').mockResolvedValue({
      level: 'LOW',
      reason: 'stub',
      estimatedSteps: 2,
    } as Awaited<ReturnType<typeof planner.assessComplexity>>);
    runLoopSpy = vi.spyOn(queryLoop, 'runQueryLoop').mockResolvedValue({ reply: 'loop-stub' } as never);
  });

  afterEach(() => {
    assessSpy.mockRestore();
    runLoopSpy.mockRestore();
  });

  it('bypasses assessComplexity quick precheck when researchCollectEngine is true', async () => {
    const { processMessage } = await import('../../core/agent.js');
    // Agentic, non-compound, not a leading question word, unlikely to hit
    // skill/memory/query classifiers — this shape is exactly what the quick
    // path targets.
    const msg = 'Write three witty taglines for a bicycle repair shop.';
    const llmHandler = vi.fn().mockResolvedValue(
      '{"units":[{"route":"conversational","content":"Write three witty taglines for a bicycle repair shop."}]}',
    );

    await processMessage(msg, [], { llmHandler, researchCollectEngine: true });

    expect(assessSpy).not.toHaveBeenCalled();
  }, 120_000);

  it('runs assessComplexity quick precheck when researchCollectEngine is false', async () => {
    const { processMessage } = await import('../../core/agent.js');
    const msg = 'Write three witty taglines for a bicycle repair shop.';
    const llmHandler = vi.fn().mockResolvedValue('{}');

    await processMessage(msg, [], { llmHandler, researchCollectEngine: false });

    expect(assessSpy).toHaveBeenCalled();
    expect(runLoopSpy).toHaveBeenCalled();
  }, 60_000);
});
