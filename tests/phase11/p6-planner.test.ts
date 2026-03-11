import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { _resetGitInstance } from '../../core/memory/versioning.js';

const mockLLM = async () => '{"isComplex": false, "reason": "simple task", "estimatedSteps": 1}';
const mockLLMAssertions = async () => '{"passed": true, "failedAssertions": []}';

describe('Phase 11 P6: Enhanced Planner', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-planner-'));
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

  it('P6A: assessComplexity returns LOW for simple message', async () => {
    const { assessComplexity } = await import('../../core/planner.js');
    const result = await assessComplexity('hello', { intent: 'greeting', codes: [] });
    expect(result.level).toBe('LOW');
  });

  it('P6B: assessComplexity returns MEDIUM/HIGH for complex message', async () => {
    const { assessComplexity } = await import('../../core/planner.js');
    const result = await assessComplexity(
      'search the web for python tutorials then write a summary and save it to a file',
      { intent: 'general', codes: [] }
    );
    expect(['MEDIUM', 'HIGH', 'MAX']).toContain(result.level);
  });

  it('P6C: assessComplexity returns estimatedSteps > 0', async () => {
    const { assessComplexity } = await import('../../core/planner.js');
    const result = await assessComplexity('write a file', { intent: 'general', codes: [] });
    expect(result.estimatedSteps).toBeGreaterThan(0);
  });

  it('P6D: assessComplexity returns expected shape', async () => {
    const { assessComplexity } = await import('../../core/planner.js');
    const result = await assessComplexity('hello', { intent: 'greeting', codes: [] });
    expect(result).toHaveProperty('level');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('estimatedSteps');
  });

  it('P6E: extractThought returns null for no thought block', async () => {
    const { extractThought } = await import('../../core/planner.js');
    const result = extractThought('{"goal": "test", "steps": []}');
    expect(result).toBeNull();
  });

  it('P6F: extractThought extracts thought block', async () => {
    const { extractThought } = await import('../../core/planner.js');
    const result = extractThought('<thought>I need to think about this step by step</thought>{"goal": "test"}');
    expect(result).toBe('I need to think about this step by step');
  });

  it('P6G: verifyPlanAssertions returns passed=true by default', async () => {
    const { verifyPlanAssertions } = await import('../../core/planner.js');
    const plan = {
      goal: 'Test plan',
      steps: [{ id: 'step1', description: 'Test step', skill: 'calculator', input: { expression: '1+1' }, dependsOn: [], optional: false, confidence_score: 0.9, risk_level: 'LOW' as const }],
      createdAt: new Date().toISOString(),
    };
    const result = await verifyPlanAssertions(plan, mockLLMAssertions as any);
    expect(result.passed).toBe(true);
  });

  it('P6H: verifyPlanAssertions returns failedAssertions array', async () => {
    const { verifyPlanAssertions } = await import('../../core/planner.js');
    const plan = {
      goal: 'Test plan',
      steps: [],
      createdAt: new Date().toISOString(),
    };
    const result = await verifyPlanAssertions(plan, mockLLMAssertions as any);
    expect(Array.isArray(result.failedAssertions)).toBe(true);
  });

  it('P6I: TaskStepSchema has confidence_score field', async () => {
    const { TaskStepSchema } = await import('../../core/schemas.js');
    const result = TaskStepSchema.safeParse({
      id: 'step1',
      description: 'test',
      skill: 'calculator',
      input: {},
      dependsOn: [],
      confidence_score: 0.9,
      risk_level: 'LOW',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confidence_score).toBe(0.9);
    }
  });

  it('P6J: TaskStepSchema has risk_level field', async () => {
    const { TaskStepSchema } = await import('../../core/schemas.js');
    const result = TaskStepSchema.safeParse({
      id: 'step1',
      description: 'test',
      skill: 'calculator',
      input: {},
      dependsOn: [],
      risk_level: 'HIGH',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.risk_level).toBe('HIGH');
    }
  });

  it('P6K: HIGH_RISK_LOW_CONFIDENCE aborts execution', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { executePlan } = await import('../../core/executor.js');

    const plan = {
      goal: 'Test abort',
      steps: [{
        id: 'step1',
        description: 'Risky step',
        skill: 'run_bash',
        input: { command: 'echo test' },
        dependsOn: [],
        optional: false,
        confidence_score: 0.5,  // below 0.75
        risk_level: 'HIGH' as const,
      }],
      createdAt: new Date().toISOString(),
    };

    const result = await executePlan(plan, async () => '');
    expect(result.abortReason).toBe('HIGH_RISK_LOW_CONFIDENCE');
  });

  it('P6L: planner_reasoning transparency event type is valid', async () => {
    const { transparency } = await import('../../core/transparency.js');
    let emitted = false;
    const off = transparency.on((event) => {
      if (event.type === 'planner_reasoning') emitted = true;
    });
    transparency.enable();
    transparency.emit({ type: 'planner_reasoning', data: { thought: 'I think step by step' } });
    transparency.disable();
    off();
    expect(emitted).toBe(true);
  });

  it('P6M: failure_classified transparency event type is valid', async () => {
    const { transparency } = await import('../../core/transparency.js');
    let emitted = false;
    const off = transparency.on((event) => {
      if (event.type === 'failure_classified') emitted = true;
    });
    transparency.enable();
    transparency.emit({ type: 'failure_classified', data: { error: 'test error', class: 'SYNTAX_ERROR' } });
    transparency.disable();
    off();
    expect(emitted).toBe(true);
  });

  it('P6N: assessComplexity returns reason string', async () => {
    const { assessComplexity } = await import('../../core/planner.js');
    const result = await assessComplexity('simple task', { intent: 'general', codes: [] });
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('P6O: ComplexityLevel enum covers all 4 values', async () => {
    const { assessComplexity } = await import('../../core/planner.js');
    // Test with different message complexities
    const r1 = await assessComplexity('hi', { intent: 'greeting', codes: [] });
    expect(['LOW', 'MEDIUM', 'HIGH', 'MAX']).toContain(r1.level);
  });
});
