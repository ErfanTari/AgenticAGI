import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';
import { memoryAgent, type MemoryUpdate } from '../../core/memory/memory-agent.js';

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magent-test-'));
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  initDatabase(path.join(tmpDir, 'test.sqlite'));
});

afterEach(async () => {
  await memoryAgent.drain();
  closeDatabase();
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Phase 15: MemoryAgent', () => {
  it('enqueue() is synchronous — does not block the caller', () => {
    const start = Date.now();
    memoryAgent.enqueue({ type: 'new_code', code: 'WHO.CT-000001' });
    memoryAgent.enqueue({ type: 'step_complete', stepId: 'step-1', result: 'ok', codes: [] });
    const elapsed = Date.now() - start;
    // Should complete very fast (< 50ms) because enqueue is synchronous
    expect(elapsed).toBeLessThan(50);
  });

  it('drain() waits for all queued items to be processed', async () => {
    const processed: string[] = [];

    // Enqueue several items
    for (let i = 0; i < 5; i++) {
      memoryAgent.enqueue({ type: 'new_code', code: `WHO.CT-00000${i}` });
    }

    await memoryAgent.drain();

    // After drain, queue should be empty and not processing
    expect(memoryAgent.queueLength()).toBe(0);
    expect(memoryAgent.isProcessing()).toBe(false);
  });

  it('processes step_complete events without throwing', async () => {
    const update: MemoryUpdate = {
      type: 'step_complete',
      stepId: 'step-x',
      result: 'done',
      codes: ['WHO.CT-000001', 'WHAT.PJ-000002'],
    };
    memoryAgent.enqueue(update);
    await memoryAgent.drain();
    // No throw = success
  });

  it('processes milestone_complete events without throwing', async () => {
    const update: MemoryUpdate = {
      type: 'milestone_complete',
      milestoneId: 'milestone-1',
      summary: 'First milestone done',
    };
    memoryAgent.enqueue(update);
    await memoryAgent.drain();
  });

  it('processes task_complete events without throwing', async () => {
    const fakeWM = {
      taskId: 'wm-test',
      filePath: '/tmp/wm-test.md',
      goal: 'Test goal',
      projectContext: '',
      constraints: [],
      milestones: [],
      stepLog: [],
      activeContext: [],
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      projectCode: null,
    };
    const update: MemoryUpdate = { type: 'task_complete', workingMemory: fakeWM };
    memoryAgent.enqueue(update);
    await memoryAgent.drain();
  });

  it('handles multiple rapid enqueues correctly', async () => {
    for (let i = 0; i < 20; i++) {
      memoryAgent.enqueue({ type: 'new_code', code: `WHO.CT-${String(i).padStart(6, '0')}` });
    }

    await memoryAgent.drain();
    expect(memoryAgent.queueLength()).toBe(0);
  });

  it('drain() resolves immediately when queue is empty', async () => {
    await memoryAgent.drain();
    // No hang = success
    expect(memoryAgent.queueLength()).toBe(0);
  });
});
