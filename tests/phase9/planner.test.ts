import { describe, it, expect } from 'vitest';
import { assessComplexity, decomposeTask, resolveTemplates } from '../../core/planner.js';
import type { Classification, LLMHandler } from '../../core/types.js';

const simpleClassification: Classification = {
  intent: 'general',
  codes: [],
};

// Mock LLM that tracks calls
function createMockLLM(response: string): LLMHandler & { calls: number } {
  const handler = Object.assign(
    async (_msgs: any[], _opts?: any) => {
      handler.calls++;
      return response;
    },
    { calls: 0 },
  );
  return handler;
}

describe('Priority 2: Goal Complexity Detector', () => {
  it('P2A: single actions → LOW complexity', async () => {
    const result = await assessComplexity('hello', simpleClassification);
    expect(result.level).toBe('LOW');
  });

  it('P2A: simple question → LOW complexity', async () => {
    const result = await assessComplexity('what is 2+2?', simpleClassification);
    expect(result.level).toBe('LOW');
  });

  it('P2B: multi-step → non-LOW complexity', async () => {
    const result = await assessComplexity(
      'first write a file called test.txt, then run a bash command to list files',
      simpleClassification,
    );
    expect(result.level).not.toBe('LOW');
    expect(result.estimatedSteps).toBeGreaterThanOrEqual(2);
  });

  it('P2B: file and run → non-LOW complexity', async () => {
    const result = await assessComplexity(
      'create a file with the script and then execute it',
      simpleClassification,
    );
    expect(result.level).not.toBe('LOW');
  });

  it('P2C: loop signal → non-LOW complexity', async () => {
    const result = await assessComplexity(
      'for each file in the directory, read and summarize it then write a report',
      simpleClassification,
    );
    expect(result.level).not.toBe('LOW');
  });

  it('P2D: heuristic fires without LLM (<5ms, no LLM call)', async () => {
    const mockLLM = createMockLLM('{}');
    const start = performance.now();
    const result = await assessComplexity(
      'first create a file, then run it, and finally search the web for results',
      simpleClassification,
      mockLLM,
    );
    const elapsed = performance.now() - start;
    expect(result.level).not.toBe('LOW');
    expect(elapsed).toBeLessThan(5);
    expect(mockLLM.calls).toBe(0);
  });

  it('P2E: ambiguous → LLM called once', async () => {
    const mockLLM = createMockLLM(JSON.stringify({
      isComplex: true,
      reason: 'Needs multiple steps',
      estimatedSteps: 3,
    }));
    // 1 signal (multiStep) + long message
    const result = await assessComplexity(
      'then do some complex processing on the data that I have been working on for a while and make sure everything is properly organized',
      simpleClassification,
      mockLLM,
    );
    expect(mockLLM.calls).toBe(1);
    expect(result.level).not.toBe('LOW');
  });
});

describe('Priority 3: Task Decomposer', () => {
  it('P3A: simple 2-step plan generated', async () => {
    const mockLLM = createMockLLM(JSON.stringify({
      goal: 'Write and run a script',
      steps: [
        { id: 'step1', description: 'Write script', skill: 'file_writer', input: { path: 'test.sh', content: 'echo hi' }, dependsOn: [], storeResultAs: 'step1_result' },
        { id: 'step2', description: 'Run script', skill: 'run_bash', input: { command: 'bash test.sh' }, dependsOn: ['step1'] },
      ],
      estimatedDuration: '10s',
    }));

    const plan = await decomposeTask('write a script and run it', { skills: 'file_writer, run_bash' }, mockLLM);
    expect(plan.steps).toHaveLength(2);
    expect(plan.goal).toBe('Write and run a script');
    expect(plan.createdAt).toBeTruthy();
  });

  it('P3B: complex plan with dependencies', async () => {
    const mockLLM = createMockLLM(JSON.stringify({
      goal: 'Research and report',
      steps: [
        { id: 'step1', description: 'Search', skill: 'web_search', input: { query: 'test' }, dependsOn: [], storeResultAs: 'step1_result' },
        { id: 'step2', description: 'Write report', skill: 'file_writer', input: { path: 'report.md', content: '{{step1_result}}' }, dependsOn: ['step1'], storeResultAs: 'step2_result' },
        { id: 'step3', description: 'Verify', skill: 'file_reader', input: { path: 'report.md' }, dependsOn: ['step2'] },
      ],
    }));

    const plan = await decomposeTask('research and write report', { skills: 'web_search, file_writer, file_reader' }, mockLLM);
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[1].dependsOn).toContain('step1');
    expect(plan.steps[2].dependsOn).toContain('step2');
  });

  it('P3C: template syntax resolution', () => {
    const results = new Map<string, string>();
    results.set('step1_result', 'Hello World');
    results.set('step2_result', 'Goodbye');

    const input = { content: '{{step1_result}} and {{step2_result}}', nested: { val: '{{step1_result}}' } };
    const resolved = resolveTemplates(input, results);

    expect(resolved.content).toBe('Hello World and Goodbye');
    expect((resolved.nested as any).val).toBe('Hello World');
  });

  it('P3D: plans under the 30-step cap are preserved', async () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({
      id: `step${i + 1}`,
      description: `Step ${i + 1}`,
      skill: 'calculator',
      input: { expression: `${i}+1` },
      dependsOn: [],
    }));
    const mockLLM = createMockLLM(JSON.stringify({
      goal: 'Many steps',
      steps,
    }));

    const plan = await decomposeTask('do many things', { skills: 'calculator' }, mockLLM);
    expect(plan.steps.length).toBe(10);
  });

  it('P3E: plan can include memory_write step', async () => {
    const mockLLM = createMockLLM(JSON.stringify({
      goal: 'Research and save',
      steps: [
        { id: 'step1', description: 'Search', skill: 'web_search', input: { query: 'AI' }, dependsOn: [], storeResultAs: 'step1_result' },
        { id: 'step2', description: 'Save note', skill: 'memory_write', input: { nb: 'WHAT', type: 'KN', name: 'AI Research' }, dependsOn: ['step1'] },
      ],
    }));

    const plan = await decomposeTask('research AI and save notes', { skills: 'web_search, memory_write' }, mockLLM);
    expect(plan.steps.some(s => s.skill === 'memory_write')).toBe(true);
  });

  it('P3F: invalid plan triggers retry', async () => {
    let callCount = 0;
    const mockLLM: LLMHandler = async () => {
      callCount++;
      if (callCount === 1) return 'not json at all';
      return JSON.stringify({
        goal: 'Fixed',
        steps: [{ id: 'step1', description: 'Do it', skill: 'calculator', input: { expression: '1+1' }, dependsOn: [] }],
      });
    };

    const plan = await decomposeTask('calculate something', { skills: 'calculator' }, mockLLM);
    expect(callCount).toBe(2);
    expect(plan.goal).toBe('Fixed');
  });
});
