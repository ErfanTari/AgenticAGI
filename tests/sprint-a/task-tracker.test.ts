import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { _resetMemoryMode, setMemoryMode } from '../../core/memory-mode.js';

let tmpDir: string;

beforeEach(async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'task-tracker-test-'));
  mkdirSync(path.join(tmpDir, 'memory', 'NOW', 'todos'), { recursive: true });
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  initDatabase();
  _resetMemoryMode();
});

afterEach(async () => {
  closeDatabase();
  _resetMemoryMode();
  const { rmSync } = await import('node:fs');
  rmSync(tmpDir, { recursive: true, force: true });
});

async function runSkill(op: Record<string, unknown>) {
  const { default: taskTrackerSkill } = await import('../../core/skills/tools/task_tracker.js');
  return taskTrackerSkill.execute(op);
}

describe('task_tracker', () => {
  it('add creates a NOW.TD entry', async () => {
    const result = await runSkill({ operation: 'add', title: 'Buy groceries' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('NOW.TD-');
    expect(result.output).toContain('Buy groceries');
  });

  it('list returns active tasks', async () => {
    await runSkill({ operation: 'add', title: 'Task A' });
    await runSkill({ operation: 'add', title: 'Task B' });
    const result = await runSkill({ operation: 'list' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Task A');
    expect(result.output).toContain('Task B');
  });

  it('update changes task status', async () => {
    const addResult = await runSkill({ operation: 'add', title: 'Fix bug' });
    // Extract code from output
    const codeMatch = addResult.output?.match(/NOW\.TD-\d+/);
    expect(codeMatch).toBeTruthy();
    const code = codeMatch![0];

    const updateResult = await runSkill({ operation: 'update', code, status: 'done' });
    expect(updateResult.success).toBe(true);
    expect(updateResult.output).toContain('done');

    // List filtered by done should include it
    const listResult = await runSkill({ operation: 'list', status: 'done' });
    expect(listResult.output).toContain('Fix bug');
  });

  it('memory-disabled returns sentinel error', async () => {
    setMemoryMode('disabled');
    const result = await runSkill({ operation: 'add', title: 'Should fail' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/memory.*disabled/i);
  });
});
