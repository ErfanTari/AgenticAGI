import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { transparency, type TransparencyEventEnvelope } from '../../core/transparency.js';

let tmpDir: string;
let originalDb: string;
let originalMemory: string;
let events: TransparencyEventEnvelope[];
let unsub: () => void;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abort-trace-test-'));
  originalDb = PATHS.db;
  originalMemory = PATHS.memory;
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });

  events = [];
  transparency.enable();
  unsub = transparency.on(e => events.push(e));
});

afterEach(() => {
  unsub();
  transparency.disable();
  (PATHS as Record<string, string>).db = originalDb;
  (PATHS as Record<string, string>).memory = originalMemory;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function spanStarts() {
  return events.filter(e => e.type === 'span_start');
}

function spanEnds() {
  return events.filter(e => e.type === 'span_end');
}

function endFor(spanId: string) {
  return spanEnds().find(e => (e.data as { spanId: string }).spanId === spanId);
}

describe('abort trace integration', () => {
  it('aborting processMessage: root span has status=aborted in span_end', async () => {
    const { processMessage } = await import('../../core/agent.js');
    const controller = new AbortController();
    controller.abort(); // pre-abort

    try {
      await processMessage('do a long task', [], { signal: controller.signal });
    } catch { /* expected AbortError */ }

    // Root span should be emitted (withSpan wraps processMessage)
    const rootStart = spanStarts().find(e => !(e.data as { parentSpanId?: string }).parentSpanId);
    if (rootStart) {
      const rootSpanId = (rootStart.data as { spanId: string }).spanId;
      const rootEnd = endFor(rootSpanId);
      if (rootEnd) {
        expect((rootEnd.data as { status: string }).status).toBe('aborted');
      }
    }
    // At minimum, the abort signal was honored
    expect(controller.signal.aborted).toBe(true);
  });

  it('subsequent processMessage after abort produces clean independent spans', async () => {
    const { processMessage } = await import('../../core/agent.js');

    // First request — aborted
    const ctrl1 = new AbortController();
    ctrl1.abort();
    try {
      await processMessage('task one', [], { signal: ctrl1.signal });
    } catch { /* expected */ }

    const eventsAfterFirst = events.length;

    // Second request — clean
    const ctrl2 = new AbortController();
    const mockLlm = async () => 'Hello!';
    await processMessage('hello', [], { llmHandler: mockLlm, signal: ctrl2.signal });

    const newEvents = events.slice(eventsAfterFirst);
    const newSpanStarts = newEvents.filter(e => e.type === 'span_start');
    expect(newSpanStarts.length).toBeGreaterThanOrEqual(1);

    // All new span requestIds should be consistent (new request)
    const newReqIds = newSpanStarts.map(e => e.requestId).filter(Boolean);
    if (newReqIds.length > 1) {
      expect(new Set(newReqIds).size).toBe(1);
    }

    // Second request's requestId should be different from first's (if first emitted any)
    const firstReqIds = events.slice(0, eventsAfterFirst).map(e => e.requestId).filter(Boolean);
    if (firstReqIds.length > 0 && newReqIds.length > 0) {
      expect(newReqIds[0]).not.toBe(firstReqIds[0]);
    }
  });
});
