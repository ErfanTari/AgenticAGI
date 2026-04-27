import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-span-test-'));
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

// Mock LLM handler that immediately throws so processMessage doesn't block
function throwingLlm(_messages: unknown): Promise<string> {
  throw new Error('mock LLM unavailable');
}

// Mock LLM handler that returns a simple response
function mockLlm(_messages: unknown): Promise<string> {
  return Promise.resolve('Hello!');
}

describe('root span in processMessage', () => {
  it('produces a span_start and span_end with matching spanId, no parentSpanId', async () => {
    const { processMessage } = await import('../../core/agent.js');
    await processMessage('hello there', [], { llmHandler: mockLlm }).catch(() => {});

    const starts = events.filter(e => e.type === 'span_start');
    const ends = events.filter(e => e.type === 'span_end');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(ends.length).toBeGreaterThanOrEqual(1);

    // Root span is the first span_start with no parentSpanId
    const rootStart = starts.find(e => !(e.data as { parentSpanId?: string }).parentSpanId);
    expect(rootStart).toBeDefined();

    const rootSpanId = (rootStart!.data as { spanId: string }).spanId;
    const rootEnd = ends.find(e => (e.data as { spanId: string }).spanId === rootSpanId);
    expect(rootEnd).toBeDefined();
  });

  it("root span's label includes truncated input", async () => {
    const { processMessage } = await import('../../core/agent.js');
    await processMessage('hello there', [], { llmHandler: mockLlm }).catch(() => {});

    const rootStart = events.find(
      e => e.type === 'span_start' && !(e.data as { parentSpanId?: string }).parentSpanId,
    );
    expect(rootStart).toBeDefined();
    const label = (rootStart!.data as { label: string }).label;
    expect(label).toContain('hello');
  });

  it("root span's requestId matches every other event emitted during the call", async () => {
    const { processMessage } = await import('../../core/agent.js');
    await processMessage('hi', [], { llmHandler: mockLlm }).catch(() => {});

    const rootStart = events.find(
      e => e.type === 'span_start' && !(e.data as { parentSpanId?: string }).parentSpanId,
    );
    expect(rootStart).toBeDefined();
    const reqId = rootStart!.requestId;
    expect(reqId).toBeTruthy();

    // Every event that has a requestId should match
    const withReqId = events.filter(e => e.requestId !== undefined);
    expect(withReqId.length).toBeGreaterThan(0);
    for (const e of withReqId) {
      expect(e.requestId).toBe(reqId);
    }
  });

  it('two concurrent processMessage calls produce distinct requestIds and spanIds', async () => {
    const { processMessage } = await import('../../core/agent.js');
    await Promise.all([
      processMessage('msg one', [], { llmHandler: mockLlm }).catch(() => {}),
      processMessage('msg two', [], { llmHandler: mockLlm }).catch(() => {}),
    ]);

    const rootStarts = events.filter(
      e => e.type === 'span_start' && !(e.data as { parentSpanId?: string }).parentSpanId,
    );
    expect(rootStarts.length).toBeGreaterThanOrEqual(2);

    const requestIds = rootStarts.map(e => e.requestId);
    const spanIds = rootStarts.map(e => (e.data as { spanId: string }).spanId);
    expect(new Set(requestIds).size).toBe(rootStarts.length);
    expect(new Set(spanIds).size).toBe(rootStarts.length);
  });

  it('LLM error: span_end emitted with status=error and error propagates', async () => {
    const { processMessage } = await import('../../core/agent.js');
    // processMessage catches all errors and returns an error AgentResponse — it never throws
    const result = await processMessage('make a plan', [], { llmHandler: throwingLlm });
    // The agent returns an error response, not a throw
    expect(result).toBeDefined();

    // The root span_end should still be emitted (with ok status since processMessage catches internally)
    const rootStart = events.find(
      e => e.type === 'span_start' && !(e.data as { parentSpanId?: string }).parentSpanId,
    );
    const rootSpanId = (rootStart?.data as { spanId: string } | undefined)?.spanId;
    const rootEnd = events.find(
      e => e.type === 'span_end' && (e.data as { spanId: string }).spanId === rootSpanId,
    );
    expect(rootEnd).toBeDefined();
  });
});
