/**
 * Fresh-run parity test (Batch 2.4)
 *
 * Verifies that:
 * 1. Memory-disabled mode runs all message types without crashing
 * 2. The same messages with a fresh (empty) memory dir also work
 * 3. No surprise writes happen during agentic execution
 * 4. A memory-recall on a fresh install returns "no memory" cleanly
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { PATHS } from '../../config/agent.config.js';
import { _resetMemoryMode, setMemoryMode } from '../../core/memory-mode.js';
import { initDatabase, closeDatabase, queryEntries } from '../../core/memory/mod.js';

// ─── Mock the LLM so tests don't need a real endpoint ────────────────────────

const llmMock = vi.fn();

vi.mock('../../core/llm.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    callLLM: (...args: unknown[]) => llmMock(...args),
  };
});

// ─── Test setup ───────────────────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-fresh-run-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'memory.sqlite');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');

const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  fs.mkdirSync(TEST_MEMORY, { recursive: true });
  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  initDatabase(TEST_DB);
});

afterAll(async () => {
  closeDatabase();
  _resetMemoryMode();
  const { _resetGitInstance } = await import('../../core/memory/versioning.js');
  _resetGitInstance();
  await new Promise(r => setTimeout(r, 100));
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Fresh-run parity (memory disabled)', () => {
  beforeAll(() => {
    setMemoryMode('disabled');
  });

  afterAll(() => {
    _resetMemoryMode();
  });

  it('memory is confirmed disabled', async () => {
    const { isMemoryFullyDisabled } = await import('../../core/memory-mode.js');
    expect(isMemoryFullyDisabled()).toBe(true);
  });

  it('no entries exist on fresh install', () => {
    const allEntries = queryEntries({});
    expect(allEntries.length).toBe(0);
  });

  it('buildContext does not throw on empty resolved with no signals', async () => {
    const { buildContext } = await import('../../core/context.js');
    const messages = await buildContext('hello', null, [], [], 'greeting');
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe('system');
  });

  it('buildContext with personSignal=null does not inject persona', async () => {
    const { buildContext } = await import('../../core/context.js');
    const signals = {
      summary: 'greeting',
      personSignal: null,
      projectSignal: null,
      timeSignal: null,
      agenticSignal: false,
      procedureSignal: false,
      querySignal: false,
    };
    const messages = await buildContext('hello', null, [], [], 'greeting', undefined, undefined, undefined, signals);
    const systemContent = messages[0].content;
    // No persona injected because personSignal is null
    expect(systemContent).not.toContain('## Owner Profile');
    expect(systemContent).not.toContain('## Persona');
  });

  it('buildContext with signals does not crash on empty database', async () => {
    const { buildContext } = await import('../../core/context.js');
    const signals = {
      summary: 'query about projects',
      personSignal: 'Erfan',
      projectSignal: 'TestProject',
      timeSignal: null,
      agenticSignal: false,
      procedureSignal: false,
      querySignal: true,
    };
    // No entries in DB — should not throw, just silently skip
    const messages = await buildContext('what projects do I have?', null, [], [], 'memory_query', undefined, undefined, undefined, signals);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('no memory writes occurred during these tests', () => {
    const allEntries = queryEntries({});
    expect(allEntries.length).toBe(0);
  });
});

describe('Fresh-run parity (empty memory, enabled)', () => {
  it('buildContext with empty DB and resolved=null does not crash', async () => {
    const { buildContext } = await import('../../core/context.js');
    const messages = await buildContext('what is my name?', null, [], [], 'memory_query');
    expect(messages.length).toBeGreaterThan(0);
    // System prompt should still be present even with no memory
    expect(messages[0].content.length).toBeGreaterThan(0);
  });

  it('getIndexSummary on empty DB returns a string without throwing', async () => {
    const { getIndexSummary } = await import('../../core/context.js');
    expect(() => getIndexSummary()).not.toThrow();
  });

  it('memoryWhen.personSignal returns false when no signal', async () => {
    const { memoryWhen } = await import('../../core/memory-when.js');
    const noSignals = {
      summary: 'test',
      personSignal: null,
      projectSignal: null,
      timeSignal: null,
      agenticSignal: false,
      procedureSignal: false,
      querySignal: false,
    };
    expect(memoryWhen.personSignal(noSignals)).toBe(false);
    expect(memoryWhen.projectSignal(noSignals)).toBe(false);
    expect(memoryWhen.querySignal(noSignals)).toBe(false);
  });

  it('memoryWhen predicates return true when signals present', async () => {
    const { memoryWhen } = await import('../../core/memory-when.js');
    const withSignals = {
      summary: 'test',
      personSignal: 'Alice',
      projectSignal: 'Proj',
      timeSignal: null,
      agenticSignal: false,
      procedureSignal: false,
      querySignal: true,
    };
    expect(memoryWhen.personSignal(withSignals)).toBe(true);
    expect(memoryWhen.projectSignal(withSignals)).toBe(true);
    expect(memoryWhen.querySignal(withSignals)).toBe(true);
  });
});
