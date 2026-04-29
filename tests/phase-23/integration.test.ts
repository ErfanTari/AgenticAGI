import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { transparency, withRequestId } from '../../core/transparency.js';
import { parseWithRetry } from '../../core/llm-helpers/schema-retry.js';

const schema = z.object({ level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'MAX']), reason: z.string() });

beforeEach(() => transparency.enable());
afterEach(() => transparency.disable());

function run<T>(fn: () => Promise<T>): Promise<T> {
  return withRequestId(fn, 'integration-req') as Promise<T>;
}

describe('three-layer chain — integration', () => {
  it('handles all three success modes correctly', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsub = transparency.on(e => {
      if (['json_repair_succeeded', 'json_repair_failed', 'schema_validation_succeeded', 'schema_validation_failed'].includes(e.type)) {
        events.push({ type: e.type, data: e.data as Record<string, unknown> });
      }
    });

    // Call 1: trailing comma → Layer 2 jsonrepair succeeds, schema validates
    const result1 = await run(() => parseWithRetry({
      schema,
      rawOutput: '{"level":"MEDIUM","reason":"ok",}',
      retryFn: vi.fn(),
    }));
    expect(result1.ok).toBe(true);
    if (result1.ok) expect(result1.layer).toBe(2);

    // Call 2: valid JSON but wrong enum → retry fixes it → Layer 3
    const retryFn2 = vi.fn().mockResolvedValue('{"level":"HIGH","reason":"corrected"}');
    const result2 = await run(() => parseWithRetry({
      schema,
      rawOutput: '{"level":"INVALID","reason":"wrong"}',
      retryFn: retryFn2,
    }));
    expect(result2.ok).toBe(true);
    if (result2.ok) expect(result2.layer).toBe(3);

    // Call 3: broken JSON both times → not ok
    const retryFn3 = vi.fn().mockResolvedValue('{{{still broken');
    const result3 = await run(() => parseWithRetry({
      schema,
      rawOutput: '{{{broken',
      retryFn: retryFn3,
    }));
    expect(result3.ok).toBe(false);

    unsub();

    // Verify events were emitted in meaningful sequence
    const successEvents = events.filter(e => e.type === 'schema_validation_succeeded');
    expect(successEvents.length).toBeGreaterThanOrEqual(2);

    // Call 1 produced layer:2 event, call 2 produced layer:3 event
    expect(successEvents.some(e => e.data.layer === 2)).toBe(true);
    expect(successEvents.some(e => e.data.layer === 3)).toBe(true);
  });
});
