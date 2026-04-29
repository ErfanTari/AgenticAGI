import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { transparency, withRequestId } from '../../core/transparency.js';
import { parseWithRetry, formatZodError, buildCorrectionPrompt } from '../../core/llm-helpers/schema-retry.js';

beforeEach(() => transparency.enable());
afterEach(() => transparency.disable());

const schema = z.object({ level: z.string(), reason: z.string() });

function run<T>(fn: () => Promise<T>): Promise<T> {
  return withRequestId(fn, 'test-retry-req') as Promise<T>;
}

describe('parseWithRetry — Layer 3', () => {
  it('Layer-1 success: valid JSON + valid schema, 1 attempt, layer: 1', async () => {
    const result = await run(() => parseWithRetry({
      schema,
      rawOutput: '{"level":"MEDIUM","reason":"test"}',
      retryFn: vi.fn(),
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.layer).toBe(1);
      expect(result.attempts).toBe(1);
    }
  });

  it('Layer-2 success: trailing comma + valid schema, layer: 2', async () => {
    const result = await run(() => parseWithRetry({
      schema,
      rawOutput: '{"level":"HIGH","reason":"too complex",}',
      retryFn: vi.fn(),
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.layer).toBe(2);
      expect(result.attempts).toBe(1);
    }
  });

  it('Layer-3 success: invalid JSON → retry returns valid, 2 attempts', async () => {
    const retryFn = vi.fn().mockResolvedValue('{"level":"LOW","reason":"retry"}');
    const result = await run(() => parseWithRetry({
      schema,
      rawOutput: '{{{broken',
      retryFn,
    }));
    // retry produces valid JSON
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.layer).toBe(3);
      expect(result.attempts).toBe(2);
    }
    expect(retryFn).toHaveBeenCalledTimes(1);
  });

  it('Layer-3 success: valid JSON but schema fail → retry valid schema', async () => {
    const retryFn = vi.fn().mockResolvedValue('{"level":"MAX","reason":"fixed"}');
    const result = await run(() => parseWithRetry({
      schema,
      rawOutput: '{"level":42,"reason":"wrong type"}',
      retryFn,
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.layer).toBe(3);
  });

  it('hard fail: both attempts produce invalid → ok: false, attempts: 2', async () => {
    const retryFn = vi.fn().mockResolvedValue('{{{still broken');
    const result = await run(() => parseWithRetry({
      schema,
      rawOutput: '{{{broken',
      retryFn,
    }));
    expect(result.ok).toBe(false);
    expect(retryFn).toHaveBeenCalledTimes(1);
  });

  it('formatZodError includes path and message', () => {
    const err = schema.safeParse({ level: 42, reason: 'ok' }) as { success: false; error: z.ZodError };
    const formatted = formatZodError(err.error);
    expect(formatted).toContain('level');
    expect(formatted).toContain('path');
  });

  it('buildCorrectionPrompt includes schema and original output snippet', () => {
    const prompt = buildCorrectionPrompt('{"bad":true}', schema, 'field missing');
    expect(prompt).toContain('field missing');
    expect(prompt).toContain('level');  // schema field
    expect(prompt).toContain('{"bad":true}');
  });
});
