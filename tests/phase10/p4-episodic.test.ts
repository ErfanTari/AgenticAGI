import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { initDatabase, closeDatabase, queryEntries } from '../../core/memory/index.js';
import { writeEpisodicMemory } from '../../core/executor.js';
import { PATHS } from '../../config/agent.config.js';
import type { TaskPlan } from '../../core/schemas.js';
import type { ExecutionResult, VerificationResult } from '../../core/executor.js';

function makePlan(goal: string): TaskPlan {
  return {
    goal,
    steps: [
      { id: 'step1', description: 'First step', skill: 'web_search', input: { query: 'test' }, dependsOn: [], optional: false, storeResultAs: 'step1_result' },
      { id: 'step2', description: 'Second step', skill: 'file_writer', input: { path: 'out.md', content: 'content' }, dependsOn: ['step1'], optional: false, storeResultAs: null },
    ],
    estimatedDuration: '10s',
    createdAt: new Date().toISOString(),
  };
}

function makeResult(completedCount: number): ExecutionResult {
  const completed = Array.from({ length: completedCount }, (_, i) => ({
    stepId: `step${i + 1}`,
    skill: i === 0 ? 'web_search' : 'file_writer',
    output: `output ${i + 1}`,
    retries: 0,
  }));
  return { success: completedCount > 0, completed, failed: [] };
}

const successVerification: VerificationResult = {
  verified: true,
  confidence: 0.9,
  issues: [],
  suggestion: undefined,
};

const failedVerification: VerificationResult = {
  verified: false,
  confidence: 0.3,
  issues: ['Goal not achieved'],
  suggestion: undefined,
};

describe('Priority 4: Episodic memory + HOW auto-write', () => {
  let tmpDir: string;
  const origDb = PATHS.db;
  const origMemory = PATHS.memory;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-episodic-'));
    // Isolate from real memory directory
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
    initDatabase(path.join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    closeDatabase();
    (PATHS as Record<string, string>).db = origDb;
    (PATHS as Record<string, string>).memory = origMemory;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P4A: 2+ completed steps + verified → HOW.PR created', async () => {
    const plan = makePlan('Build a landing page');
    const result = makeResult(2);
    const code = await writeEpisodicMemory(plan, result, successVerification);

    expect(code).not.toBeNull();
    expect(code).toMatch(/^HOW\.PR-/);

    const entries = queryEntries({ nb: 'HOW', type: 'PR' });
    expect(entries.length).toBe(1);
    expect(entries[0].name).toContain('Pattern:');
  });

  it('P4B: only 1 step completed → HOW.PR NOT created', async () => {
    const plan = makePlan('Simple task');
    const result = makeResult(1);
    const code = await writeEpisodicMemory(plan, result, successVerification);

    expect(code).toBeNull();
    const entries = queryEntries({ nb: 'HOW', type: 'PR' });
    expect(entries.length).toBe(0);
  });

  it('P4C: failed verification → HOW.PR NOT created', async () => {
    const plan = makePlan('Failed task');
    const result = makeResult(3);
    const code = await writeEpisodicMemory(plan, result, failedVerification);

    expect(code).toBeNull();
    const entries = queryEntries({ nb: 'HOW', type: 'PR' });
    expect(entries.length).toBe(0);
  });

  it('P4D: HOW.PR name format starts with "Pattern: "', async () => {
    const goal = 'Create a blog post about AI';
    const plan = makePlan(goal);
    const result = makeResult(2);
    const code = await writeEpisodicMemory(plan, result, successVerification);

    expect(code).not.toBeNull();
    const entries = queryEntries({ nb: 'HOW', type: 'PR' });
    expect(entries[0].name).toBe('Pattern: ' + goal.slice(0, 60));
  });

  it('P4E: goal truncated to 60 chars in name', async () => {
    const longGoal = 'A'.repeat(100);
    const plan = makePlan(longGoal);
    const result = makeResult(2);
    await writeEpisodicMemory(plan, result, successVerification);

    const entries = queryEntries({ nb: 'HOW', type: 'PR' });
    const name = entries[0].name;
    expect(name.length).toBeLessThanOrEqual('Pattern: '.length + 60);
  });
});
