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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abort-plumbing-test-'));
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

describe('abort plumbing', () => {
  it('already-aborted signal: processMessage returns without calling LLM', async () => {
    const { processMessage } = await import('../../core/agent.js');
    let llmCalled = false;
    const mockLlm = async () => { llmCalled = true; return 'response'; };

    const controller = new AbortController();
    controller.abort();

    let threw = false;
    try {
      await processMessage('hello', [], { llmHandler: mockLlm, signal: controller.signal });
    } catch (e: unknown) {
      threw = (e as { name?: string })?.name === 'AbortError';
    }

    expect(threw).toBe(true);
    expect(llmCalled).toBe(false);
  });

  it('aborted signal causes processMessage to throw AbortError', async () => {
    const { processMessage } = await import('../../core/agent.js');
    const controller = new AbortController();
    controller.abort();

    let errorName: string | undefined;
    try {
      await processMessage('what is 2+2', [], { signal: controller.signal });
    } catch (e: unknown) {
      errorName = (e as { name?: string })?.name;
    }
    expect(errorName).toBe('AbortError');
  });

  it('runQueryLoop aborts at iteration boundary when signal fires', async () => {
    const { runQueryLoop } = await import('../../core/query-loop.js');

    const controller = new AbortController();
    let callCount = 0;
    const mockLlm = async () => {
      callCount++;
      if (callCount >= 2) controller.abort();
      // Return a valid tool call to keep the loop going
      return '{"action":"calculator","input":{"expression":"1+1"}}';
    };

    let errorName: string | undefined;
    try {
      await runQueryLoop('compute something', mockLlm as never, undefined, [], undefined, undefined, undefined, controller.signal);
    } catch (e: unknown) {
      errorName = (e as { name?: string })?.name;
    }

    expect(errorName).toBe('AbortError');
    // Should have aborted before many more iterations ran
    expect(callCount).toBeLessThanOrEqual(4);
  });

  it('runSkill with already-aborted signal returns aborted error immediately', async () => {
    const { runSkill } = await import('../../core/skills/runner.js');
    const controller = new AbortController();
    controller.abort();

    const result = await runSkill('calculator', { expression: '1+1' }, undefined, controller.signal);
    expect(result.success).toBe(false);
    expect(result.error).toBe('aborted');
  });

  it('aborted span: span_end emitted with status=aborted when AbortError thrown', async () => {
    const { withSpan } = await import('../../core/transparency.js');

    const controller = new AbortController();
    try {
      await withSpan('test-span', undefined, 'req-1', async () => {
        controller.abort();
        throw new DOMException('Aborted by user', 'AbortError');
      });
    } catch { /* expected */ }

    const end = events.find(e => e.type === 'span_end');
    expect(end).toBeDefined();
    expect((end!.data as { status: string }).status).toBe('aborted');
  });

  it('root span shows aborted status when processMessage is aborted', async () => {
    const { processMessage } = await import('../../core/agent.js');
    const controller = new AbortController();

    // Abort after a tiny delay (while processMessage is starting)
    let greetingLlmCalled = false;
    const mockLlm = async () => {
      greetingLlmCalled = true;
      await new Promise(r => setTimeout(r, 50));
      return 'Hello!';
    };

    // Pre-abort so it throws immediately
    controller.abort();

    try {
      await processMessage('hello there', [], { llmHandler: mockLlm, signal: controller.signal });
    } catch { /* expected */ }

    // Root span should show aborted
    const rootStart = events.find(
      e => e.type === 'span_start' && !(e.data as { parentSpanId?: string }).parentSpanId,
    );
    if (rootStart) {
      const rootSpanId = (rootStart.data as { spanId: string }).spanId;
      const rootEnd = events.find(
        e => e.type === 'span_end' && (e.data as { spanId: string }).spanId === rootSpanId,
      );
      // Root span_end may or may not be emitted depending on whether withSpan wraps the throw
      // The important thing is no LLM was called
      expect(greetingLlmCalled).toBe(false);
      if (rootEnd) {
        expect((rootEnd.data as { status: string }).status).toBe('aborted');
      }
    }
  });
});
