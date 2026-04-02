import { describe, it, expect, vi } from 'vitest';
import { processMessage } from '../../core/agent.js';
import type { LLMHandler, Message } from '../../core/types.js';

// Phase 16: stub assessComplexity so these tests continue to exercise
// the decomposeTask+executePlan pipeline (the queryLoop path tests are in phase16/).
vi.mock('../../core/planner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/planner.js')>();
  return {
    ...actual,
    assessComplexity: vi.fn().mockResolvedValue({ level: 'HIGH', reason: 'test-stub', estimatedSteps: 4 }),
  };
});

// Mock the database to avoid SQLite dependency in pipeline tests
vi.mock('../../core/memory/index.js', () => ({
  getDb: () => ({
    prepare: () => ({ all: () => [], run: () => {} }),
  }),
}));

vi.mock('../../core/memory/mod.js', () => ({
  createEntry: vi.fn(),
  hybridSearch: vi.fn(async () => []),
  fetchByCode: vi.fn(() => null),
}));

vi.mock('../../core/memory/relationships.js', () => ({
  addRelationship: vi.fn(),
}));

// Mock skill runner for controlled execution
vi.mock('../../core/skills/runner.js', () => ({
  runSkill: vi.fn(async (name: string, input: Record<string, unknown>) => {
    if (name === 'calculator') {
      return { success: true, output: '42', error: undefined };
    }
    if (name === 'file_writer') {
      return { success: true, output: 'Written to workspace/test.txt', error: undefined };
    }
    if (name === 'run_bash') {
      return { success: true, output: 'bash output', error: undefined };
    }
    if (name === 'web_search') {
      return { success: true, output: 'Search results for query', error: undefined };
    }
    return { success: true, output: `${name} done`, error: undefined };
  }),
}));

// Complex task LLM handler: responds to planner prompts with valid plans
function createPipelineLLM(): LLMHandler {
  return async (messages: Message[], options?: any) => {
    const content = messages.map(m => m.content).join(' ');

    // Complexity check
    if (content.includes('task complexity analyzer')) {
      return JSON.stringify({
        isComplex: true,
        reason: 'Multiple steps needed',
        estimatedSteps: 2,
        requiresSkills: ['file_writer', 'run_bash'],
      });
    }

    // Task decomposition
    if (content.includes('task planner')) {
      return JSON.stringify({
        goal: 'Write and run a script',
        steps: [
          { id: 'step1', description: 'Write file', skill: 'file_writer', input: { path: 'test.txt', content: 'hello' }, dependsOn: [], storeResultAs: 'step1_result', optional: false },
          { id: 'step2', description: 'Run command', skill: 'run_bash', input: { command: 'cat test.txt' }, dependsOn: ['step1'], optional: false },
        ],
        estimatedDuration: '5s',
      });
    }

    // Verification
    if (content.includes('verification assistant')) {
      return JSON.stringify({
        verified: true,
        confidence: 0.9,
        issues: [],
      });
    }

    // Default LLM response for simple tasks
    return 'I can help with that.';
  };
}

// Simple LLM that never triggers complex path
function createSimpleLLM(): LLMHandler {
  return async () => 'Simple response from LLM.';
}

describe('Priority 6: Pipeline Integration', () => {
  it('P6A: full end-to-end pipeline (complex task)', async () => {
    const llm = createPipelineLLM();
    const result = await processMessage(
      'first write a file called test.txt then run a command to read it',
      [],
      { llmHandler: llm },
    );

    // Should go through planner path
    expect(result.intent).toBe('planned_workflow');
    expect(result.reply).toContain('Done');
    expect(result.reply).toContain('file_writer');
  });

  it('P6C: simple task bypasses planner', async () => {
    const llm = createSimpleLLM();
    const result = await processMessage(
      'hello',
      [],
      { llmHandler: llm },
    );

    expect(result.intent).toBe('greeting');
    expect(result.reply).toContain('Hello');
  });

  it('P6F: simple tasks unaffected after complex task', async () => {
    const complexLLM = createPipelineLLM();
    // Run a complex task first
    await processMessage(
      'first create a file then execute a bash command to test it',
      [],
      { llmHandler: complexLLM },
    );

    // Now run a simple task
    const simpleResult = await processMessage(
      'hello',
      [],
      { llmHandler: createSimpleLLM() },
    );

    expect(simpleResult.intent).toBe('greeting');
    expect(simpleResult.reply).toContain('Hello');
  });

  it('P6D: failed plan reports cleanly', async () => {
    const failLLM: LLMHandler = async (messages: Message[]) => {
      const content = messages.map(m => m.content).join(' ');

      if (content.includes('task complexity analyzer')) {
        return JSON.stringify({ isComplex: true, reason: 'Multi-step', estimatedSteps: 2, requiresSkills: ['fail_skill'] });
      }
      if (content.includes('task planner')) {
        return JSON.stringify({
          goal: 'Failing task',
          steps: [
            { id: 'step1', description: 'Will fail', skill: 'nonexistent_skill', input: {}, dependsOn: [], optional: false },
          ],
        });
      }
      if (content.includes('verification assistant')) {
        return JSON.stringify({ verified: false, confidence: 0.1, issues: ['Step failed'], suggestion: 'Try again' });
      }
      return 'fallback';
    };

    const result = await processMessage(
      'first do something complex then do another thing after that',
      [],
      { llmHandler: failLLM },
    );

    expect(result.intent).toBe('planned_workflow');
    expect(result.reply).toContain('Warning');
  });
});
