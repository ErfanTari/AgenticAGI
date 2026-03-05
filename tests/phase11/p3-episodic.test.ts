import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { _resetGitInstance } from '../../core/memory/versioning.js';

const mockLLM = async (messages: unknown[]) => {
  const last = (messages as Array<{ role: string; content: string }>).at(-1);
  if (last?.role === 'user') {
    return 'The task succeeded with useful results. Consider reusing this approach in future.';
  }
  return '{}';
};

describe('Phase 11 P3: WHEN.EV + WHEN.RF + WHEN.HX', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-episodic-'));
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

  it('P3A: writeEpisodicEvent creates a WHEN.EV entry', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { writeEpisodicEvent } = await import('../../core/memory/episodic.js');

    const code = await writeEpisodicEvent({
      trigger: 'user_request',
      task_name: 'Write test file',
      skill_sequence: ['file_writer'],
      outcome: 'success',
      linked_codes: [],
      session_id: 'test-sess',
    });

    expect(code).toMatch(/^WHEN\.EV-\d{6,}$/);
  });

  it('P3B: writeEpisodicEvent sets correct outcome in body', async () => {
    const { initDatabase, getEntryByCode } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { writeEpisodicEvent } = await import('../../core/memory/episodic.js');

    const code = await writeEpisodicEvent({
      trigger: 'user_request',
      task_name: 'Failing Task',
      skill_sequence: ['run_bash'],
      outcome: 'failure',
      failure_reason: 'command not found',
      linked_codes: [],
      session_id: 'sess-fail',
    });

    const entry = getEntryByCode(code);
    expect(entry?.summary).toContain('failure');
  });

  it('P3C: writeEpisodicEvent includes skill_sequence in body', async () => {
    const { initDatabase, getEntryByCode } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { writeEpisodicEvent } = await import('../../core/memory/episodic.js');
    const { fetchByCode } = await import('../../core/memory/fetch.js');

    const code = await writeEpisodicEvent({
      trigger: 'test',
      task_name: 'Multi-skill task',
      skill_sequence: ['memory_read', 'content_writer', 'file_writer'],
      outcome: 'success',
      linked_codes: [],
      session_id: 'sess-multi',
    });

    const fetched = fetchByCode(code);
    expect(fetched?.content).toContain('memory_read');
    expect(fetched?.content).toContain('content_writer');
  });

  it('P3D: writeReflection creates a WHEN.RF entry', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { writeEpisodicEvent, writeReflection } = await import('../../core/memory/episodic.js');

    const evCode = await writeEpisodicEvent({
      trigger: 'user_request',
      task_name: 'Reflectable Task',
      skill_sequence: ['calculator'],
      outcome: 'success',
      linked_codes: [],
      session_id: 'sess-reflect',
    });

    const rfCode = await writeReflection(evCode, {
      code: evCode,
      trigger: 'user_request',
      task_name: 'Reflectable Task',
      skill_sequence: ['calculator'],
      outcome: 'success',
      linked_codes: [],
      session_id: 'sess-reflect',
    }, mockLLM as any);

    expect(rfCode).toMatch(/^WHEN\.RF-\d{6,}$/);
  });

  it('P3E: writeReflection references the event code', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { writeEpisodicEvent, writeReflection } = await import('../../core/memory/episodic.js');
    const { fetchByCode } = await import('../../core/memory/fetch.js');

    const evCode = await writeEpisodicEvent({
      trigger: 'user', task_name: 'Ref Test',
      skill_sequence: [], outcome: 'success',
      linked_codes: [], session_id: 's1',
    });

    const rfCode = await writeReflection(evCode, {
      code: evCode, trigger: 'user', task_name: 'Ref Test',
      skill_sequence: [], outcome: 'success',
      linked_codes: [], session_id: 's1',
    }, mockLLM as any);

    const fetched = fetchByCode(rfCode);
    expect(fetched?.content).toContain(evCode);
  });

  it('P3F: WHEN.EV is in TYPE_MAP', async () => {
    const { TYPE_MAP } = await import('../../config/agent.config.js');
    expect('WHEN.EV' in TYPE_MAP).toBe(true);
  });

  it('P3G: WHEN.RF is in TYPE_MAP', async () => {
    const { TYPE_MAP } = await import('../../config/agent.config.js');
    expect('WHEN.RF' in TYPE_MAP).toBe(true);
  });

  it('P3H: WHEN.HX is in TYPE_MAP', async () => {
    const { TYPE_MAP } = await import('../../config/agent.config.js');
    expect('WHEN.HX' in TYPE_MAP).toBe(true);
  });

  it('P3I: compactEpisodicHistory is a no-op when < 20 events', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { compactEpisodicHistory } = await import('../../core/memory/episodic.js');

    // Should not throw
    await expect(compactEpisodicHistory(mockLLM as any)).resolves.toBeUndefined();
  });

  it('P3J: episodic_query intent is recognized', async () => {
    const { classifyIntent } = await import('../../core/intent.ts');
    const result = classifyIntent('what happened last week with my projects?');
    expect(result.intent).toBe('episodic_query');
  });

  it('P3K: episodic_query pattern matches "last month"', async () => {
    const { classifyIntent } = await import('../../core/intent.ts');
    const result = classifyIntent('show me what happened last month');
    expect(result.intent).toBe('episodic_query');
  });

  it('P3L: "what happened and tell me" does NOT match episodic', async () => {
    const { classifyIntent } = await import('../../core/intent.ts');
    // Short "what happened" followed by unrelated content - should not episodic
    // Based on our tightened pattern
    const result = classifyIntent('run echo hello and tell me what happened');
    expect(result.intent).not.toBe('episodic_query');
  });

  it('P3M: detectMacroSkills is no-op when < 5 events', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { detectMacroSkills } = await import('../../core/memory/episodic.js');
    await expect(detectMacroSkills(mockLLM as any)).resolves.toBeUndefined();
  });

  it('P3N: writeEpisodicEvent handles empty skill_sequence', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { writeEpisodicEvent } = await import('../../core/memory/episodic.js');

    const code = await writeEpisodicEvent({
      trigger: 'auto',
      task_name: 'Empty skills',
      skill_sequence: [],
      outcome: 'partial',
      linked_codes: [],
      session_id: 'sess-empty',
    });

    expect(code).toMatch(/^WHEN\.EV-\d{6,}$/);
  });

  it('P3O: writeReflection does not throw on LLM failure', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { writeEpisodicEvent, writeReflection } = await import('../../core/memory/episodic.js');

    const failingLLM = async () => { throw new Error('LLM unavailable'); };

    const evCode = await writeEpisodicEvent({
      trigger: 'user', task_name: 'Error Test',
      skill_sequence: [], outcome: 'failure',
      linked_codes: [], session_id: 'sess-err',
    });

    // Should not throw — falls back to default text
    const rfCode = await writeReflection(evCode, {
      code: evCode, trigger: 'user', task_name: 'Error Test',
      skill_sequence: [], outcome: 'failure',
      linked_codes: [], session_id: 'sess-err',
    }, failingLLM as any);

    expect(rfCode).toMatch(/^WHEN\.RF-\d{6,}$/);
  });
});
