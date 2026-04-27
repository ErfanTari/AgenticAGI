import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  transparency,
  withSpan,
  withSpanSync,
  type TransparencyEventEnvelope,
  type SpanContext,
} from '../../core/transparency.js';

let events: TransparencyEventEnvelope[];
let unsub: () => void;

beforeEach(() => {
  events = [];
  transparency.enable();
  unsub = transparency.on(e => events.push(e));
});

afterEach(() => {
  unsub();
  transparency.disable();
});

describe('withSpan', () => {
  it('emits span_start then span_end in order', async () => {
    await withSpan('test label', undefined, 'req-1', async () => 'ok');
    const types = events.map(e => e.type);
    expect(types.indexOf('span_start')).toBeLessThan(types.indexOf('span_end'));
  });

  it('span_end includes durationMs >= 0', async () => {
    await withSpan('dur test', undefined, 'req-2', async () => 'ok');
    const end = events.find(e => e.type === 'span_end');
    expect(end).toBeDefined();
    expect((end!.data as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('nested calls produce correct parentSpanId chain (3 levels)', async () => {
    let l1Ctx!: SpanContext;
    let l2Ctx!: SpanContext;
    let l3Ctx!: SpanContext;

    await withSpan('L1', undefined, 'req-3', async (c1) => {
      l1Ctx = c1;
      await withSpan('L2', c1, 'req-3', async (c2) => {
        l2Ctx = c2;
        await withSpan('L3', c2, 'req-3', async (c3) => {
          l3Ctx = c3;
        });
      });
    });

    expect(l1Ctx.parentSpanId).toBeUndefined();
    expect(l2Ctx.parentSpanId).toBe(l1Ctx.spanId);
    expect(l3Ctx.parentSpanId).toBe(l2Ctx.spanId);
  });

  it('sibling spans share the same parentSpanId', async () => {
    let sibA!: SpanContext;
    let sibB!: SpanContext;

    await withSpan('root', undefined, 'req-4', async (root) => {
      await withSpan('sibA', root, 'req-4', async (c) => { sibA = c; });
      await withSpan('sibB', root, 'req-4', async (c) => { sibB = c; });
    });

    expect(sibA.parentSpanId).toBe(sibA.parentSpanId);
    expect(sibB.parentSpanId).toBe(sibB.parentSpanId);
    expect(sibA.parentSpanId).toBe(sibB.parentSpanId);
  });

  it('throwing inside fn emits span_end with status=error and rethrows', async () => {
    const err = new Error('boom');
    await expect(withSpan('err test', undefined, 'req-5', async () => { throw err; })).rejects.toBe(err);
    const end = events.find(e => e.type === 'span_end') as TransparencyEventEnvelope & { data: { status: string } };
    expect(end).toBeDefined();
    expect(end.data.status).toBe('error');
  });

  it('AbortError emits span_end with status=aborted', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    await expect(withSpan('abort test', undefined, 'req-6', async () => { throw abort; })).rejects.toBe(abort);
    const end = events.find(e => e.type === 'span_end') as TransparencyEventEnvelope & { data: { status: string } };
    expect(end.data.status).toBe('aborted');
  });

  it('existing emit inside span body still appears unchanged', async () => {
    await withSpan('compat test', undefined, 'req-7', async () => {
      transparency.emit({ type: 'route', data: { level: 'LOW', reason: 'test', path: 'test' } });
    });
    const routeEvent = events.find(e => e.type === 'route');
    expect(routeEvent).toBeDefined();
    expect((routeEvent!.data as { level: string }).level).toBe('LOW');
    // span events also present
    expect(events.some(e => e.type === 'span_start')).toBe(true);
    expect(events.some(e => e.type === 'span_end')).toBe(true);
  });
});

describe('withSpanSync', () => {
  it('works for synchronous functions', () => {
    const result = withSpanSync('sync test', undefined, 'req-8', () => 42);
    expect(result).toBe(42);
    const types = events.map(e => e.type);
    expect(types).toContain('span_start');
    expect(types).toContain('span_end');
    expect(types.indexOf('span_start')).toBeLessThan(types.indexOf('span_end'));
    const end = events.find(e => e.type === 'span_end') as TransparencyEventEnvelope & { data: { status: string; durationMs: number } };
    expect(end.data.status).toBe('ok');
    expect(end.data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sync error emits span_end with status=error and rethrows', () => {
    const err = new Error('sync boom');
    expect(() => withSpanSync('sync err', undefined, 'req-9', () => { throw err; })).toThrow(err);
    const end = events.find(e => e.type === 'span_end') as TransparencyEventEnvelope & { data: { status: string } };
    expect(end.data.status).toBe('error');
  });
});
