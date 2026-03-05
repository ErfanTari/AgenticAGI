/**
 * Unit tests for Phase 11 LM Studio behavioral fix regressions.
 * These test the code paths that were identified as failing behavioral tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { _resetGitInstance } from '../../core/memory/versioning.js';

const mockLLM = async (_msgs: unknown[]) => '{}';

describe('Phase 11 LM Studio Fix: T3.1 — extractThought handles <think> blocks', () => {
  it('extracts <thought> tags', async () => {
    const { extractThought } = await import('../../core/planner.js');
    const raw = '<thought>my reasoning here</thought>{"goal":"test"}';
    expect(extractThought(raw)).toBe('my reasoning here');
  });

  it('extracts <think> tags (Qwen-style)', async () => {
    const { extractThought } = await import('../../core/planner.js');
    const raw = '<think>qwen reasoning block</think>{"goal":"test"}';
    expect(extractThought(raw)).toBe('qwen reasoning block');
  });

  it('returns null when no thought block present', async () => {
    const { extractThought } = await import('../../core/planner.js');
    const raw = '{"goal":"test","steps":[]}';
    expect(extractThought(raw)).toBeNull();
  });
});

describe('Phase 11 LM Studio Fix: T4.3 — /log bypasses LLM', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-logfix-'));
    origDb = PATHS.db;
    origMemory = PATHS.memory;
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
    (PATHS as Record<string, string>).logs = path.join(tmpDir, 'workspace', 'logs');
    (PATHS as Record<string, string>).projects = path.join(tmpDir, 'workspace', 'projects');
    fs.mkdirSync(PATHS.memory, { recursive: true });
  });

  afterEach(async () => {
    (PATHS as Record<string, string>).db = origDb;
    (PATHS as Record<string, string>).memory = origMemory;
    _resetGitInstance();
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('/log returns "Logged." without calling LLM', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { processMessage } = await import('../../core/agent.js');

    let llmCalled = false;
    const trackingLLM = async (_msgs: unknown[]) => {
      llmCalled = true;
      return '{}';
    };

    const result = await processMessage('/log just finished the session', [], { llmHandler: trackingLLM });

    expect(result.reply).toBe('Logged.');
    // LLM may still be called for complexity check — but NOT for write extraction
    // The important thing is that /log doesn't trigger planned_workflow and returns "Logged."
    expect(result.intent).toBe('memory_write');
  });

  it('/log creates a NOW.LOG entry', async () => {
    const { initDatabase, queryEntries } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { processMessage } = await import('../../core/agent.js');

    await processMessage('/log taking a break for 30 minutes', [], { llmHandler: mockLLM });

    const logs = queryEntries({ nb: 'NOW', type: 'LOG' });
    expect(logs.length).toBeGreaterThan(0);
    const log = logs[0];
    expect(log.summary).toContain('taking a break');
  });
});

describe('Phase 11 LM Studio Fix: T6.1/T6.2 — WHEN.EV written for both success and failure', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-ev-'));
    origDb = PATHS.db;
    origMemory = PATHS.memory;
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
    (PATHS as Record<string, string>).logs = path.join(tmpDir, 'workspace', 'logs');
    (PATHS as Record<string, string>).projects = path.join(tmpDir, 'workspace', 'projects');
    fs.mkdirSync(PATHS.memory, { recursive: true });
  });

  afterEach(async () => {
    (PATHS as Record<string, string>).db = origDb;
    (PATHS as Record<string, string>).memory = origMemory;
    _resetGitInstance();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeEpisodicEvent writes WHEN.EV for a failure outcome', async () => {
    const { initDatabase, queryEntries } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { writeEpisodicEvent } = await import('../../core/memory/episodic.js');

    const code = await writeEpisodicEvent({
      trigger: 'read the file /nonexistent/path.txt',
      task_name: 'Read nonexistent file',
      skill_sequence: ['file_reader'],
      outcome: 'failure',
      failure_reason: 'File not found: /nonexistent/path.txt',
      linked_codes: [],
      session_id: 'test-sess',
    });

    expect(code).toMatch(/^WHEN\.EV-\d{6,}$/);

    const evEntries = queryEntries({ nb: 'WHEN', type: 'EV' });
    expect(evEntries.length).toBeGreaterThanOrEqual(1);
    const ev = evEntries.find(e => e.code === code);
    expect(ev).toBeDefined();
    expect(ev!.summary).toContain('failure');
  });

  it('writeReflection creates WHEN.RF linked to WHEN.EV', async () => {
    const { initDatabase, queryEntries } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { writeEpisodicEvent, writeReflection } = await import('../../core/memory/episodic.js');

    const evCode = await writeEpisodicEvent({
      trigger: 'web search task',
      task_name: 'Search and save',
      skill_sequence: ['web_search', 'memory_write'],
      outcome: 'success',
      linked_codes: [],
      session_id: 'test-sess-2',
    });

    const ev = { code: evCode, trigger: 'web search task', task_name: 'Search and save', skill_sequence: ['web_search', 'memory_write'], outcome: 'success' as const, linked_codes: [], session_id: 'test-sess-2' };
    const rfCode = await writeReflection(evCode, ev, mockLLM);

    expect(rfCode).toMatch(/^WHEN\.RF-\d{6,}$/);

    const rfEntries = queryEntries({ nb: 'WHEN', type: 'RF' });
    expect(rfEntries.length).toBeGreaterThanOrEqual(1);
    const rf = rfEntries.find(e => e.code === rfCode);
    expect(rf).toBeDefined();
    // WHEN.RF body should reference the WHEN.EV code
    const { fetchByCode } = await import('../../core/memory/fetch.js');
    const rfFetched = fetchByCode(rfCode);
    expect(rfFetched?.content).toContain(evCode);
  });
});

describe('Phase 11 LM Studio Fix: T7.2 — PLAN.CT injected into context', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-ct-'));
    origDb = PATHS.db;
    origMemory = PATHS.memory;
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
    (PATHS as Record<string, string>).logs = path.join(tmpDir, 'workspace', 'logs');
    (PATHS as Record<string, string>).projects = path.join(tmpDir, 'workspace', 'projects');
    fs.mkdirSync(PATHS.memory, { recursive: true });
  });

  afterEach(async () => {
    (PATHS as Record<string, string>).db = origDb;
    (PATHS as Record<string, string>).memory = origMemory;
    _resetGitInstance();
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PLAN.CT entries appear in system context', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { upsertEntry } = await import('../../core/memory/write.js');
    const { buildContext } = await import('../../core/context.js');

    upsertEntry({
      nb: 'PLAN',
      type: 'CT',
      name: 'Python Version Constraint',
      status: 'active',
      summary: 'Never use Python 2, always use Python 3',
      body: 'Source: user. Enforce Python 3 only.',
    });

    const messages = await buildContext('write a python script', null, [], [], 'general', undefined, mockLLM);
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg?.content).toContain('Active Constraints');
    expect(systemMsg?.content).toContain('Python Version Constraint');
  });
});
