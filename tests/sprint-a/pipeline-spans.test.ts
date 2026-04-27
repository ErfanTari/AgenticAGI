import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { transparency, type TransparencyEventEnvelope } from '../../core/transparency.js';
import { labelForSkill } from '../../core/skills/runner.js';

let tmpDir: string;
let originalDb: string;
let originalMemory: string;
let events: TransparencyEventEnvelope[];
let unsub: () => void;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-spans-test-'));
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

function mockLlm(_messages: unknown): Promise<string> {
  return Promise.resolve('Hello!');
}

function spanStarts() {
  return events.filter(e => e.type === 'span_start');
}

function spansWithLabel(label: string) {
  return events.filter(
    e => e.type === 'span_start' && (e.data as { label: string }).label === label,
  );
}

function spansLabelStartsWith(prefix: string) {
  return events.filter(
    e => e.type === 'span_start' && (e.data as { label: string }).label.startsWith(prefix),
  );
}

function matchingEnd(spanId: string) {
  return events.find(
    e => e.type === 'span_end' && (e.data as { spanId: string }).spanId === spanId,
  );
}

describe('pipeline spans', () => {
  it('greeting path emits at least one span_start with no parentSpanId (root)', async () => {
    const { processMessage } = await import('../../core/agent.js');
    await processMessage('hello', [], { llmHandler: mockLlm });

    const rootStart = spanStarts().find(e => !(e.data as { parentSpanId?: string }).parentSpanId);
    expect(rootStart).toBeDefined();
  });

  it('every span_start has a corresponding span_end with matching spanId', async () => {
    const { processMessage } = await import('../../core/agent.js');
    await processMessage('hello', [], { llmHandler: mockLlm });

    const starts = spanStarts();
    expect(starts.length).toBeGreaterThanOrEqual(1);
    for (const s of starts) {
      const spanId = (s.data as { spanId: string }).spanId;
      const end = matchingEnd(spanId);
      expect(end, `span_end missing for spanId ${spanId}`).toBeDefined();
    }
  });

  it('span_start carries requestId matching root span', async () => {
    const { processMessage } = await import('../../core/agent.js');
    await processMessage('hello', [], { llmHandler: mockLlm });

    const rootStart = spanStarts().find(e => !(e.data as { parentSpanId?: string }).parentSpanId);
    const rootReqId = rootStart?.requestId;
    expect(rootReqId).toBeTruthy();

    // All span_start events should share the same requestId
    for (const s of spanStarts()) {
      expect(s.requestId).toBe(rootReqId);
    }
  });

  it('span_end carries positive durationMs', async () => {
    const { processMessage } = await import('../../core/agent.js');
    await processMessage('hello', [], { llmHandler: mockLlm });

    const ends = events.filter(e => e.type === 'span_end');
    expect(ends.length).toBeGreaterThanOrEqual(1);
    for (const e of ends) {
      expect((e.data as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('labelForSkill returns correct label for path input', () => {
    expect(labelForSkill('file_reader', { path: '/tmp/foo.txt' })).toBe(
      'Skill: file_reader (path=/tmp/foo.txt)',
    );
  });

  it('labelForSkill returns correct label for command input', () => {
    const label = labelForSkill('run_bash', { command: 'echo hello world' });
    expect(label).toBe('Skill: run_bash (cmd=echo hello world)');
  });

  it('labelForSkill returns correct label for query input', () => {
    const label = labelForSkill('web_search', { query: 'typescript generics' });
    expect(label).toBe('Skill: web_search (query=typescript generics)');
  });

  it('labelForSkill falls back to skill name when no key args', () => {
    expect(labelForSkill('calculator', { expression: '2+2' })).toBe('Skill: calculator');
  });
});
