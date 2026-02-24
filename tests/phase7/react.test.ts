import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runWithRetry, repairSkillInput } from '../../core/react.js';
import { registerSkill } from '../../core/skills/registry.js';
import { processMessage } from '../../core/agent.js';
import type { MCPSkill } from '../../core/skills/types.js';
import type { Message, LLMHandler } from '../../core/types.js';
import {
  initDatabase,
  closeDatabase,
  createEntry,
} from '../../core/memory/mod.js';
import { PATHS } from '../../config/agent.config.js';

// --- Test setup ---

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-test-p7-react-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'memory.sqlite');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');

const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  initDatabase(TEST_DB);
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

// --- Helpers ---

/** A skill that fails N times then succeeds */
function createFlakeySkill(name: string, failCount: number): MCPSkill {
  let calls = 0;
  return {
    name,
    description: `Fails ${failCount} times then succeeds`,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', description: 'input value' } },
      required: ['value'],
    },
    async execute(input: Record<string, unknown>) {
      calls++;
      if (calls <= failCount) {
        return { success: false, output: '', error: `Attempt ${calls} failed: invalid value "${input.value}"` };
      }
      return { success: true, output: `Success on attempt ${calls} with value "${input.value}"` };
    },
  };
}

/** A mock LLM handler that returns a "repaired" JSON input */
const repairingLLM: LLMHandler = async (_messages: Message[]) => {
  return JSON.stringify({ value: 'repaired_value' });
};

/** An LLM handler that always fails */
const failingLLM: LLMHandler = async () => {
  throw new Error('LLM unreachable');
};

/** A no-op LLM for cases where we don't expect repair calls */
const noopLLM: LLMHandler = async () => 'no-op response';

// --- P1A: Skill fails once, repair fixes input, succeeds on retry 2 ---

describe('ReAct self-correction loop', () => {
  it('P1A: skill fails once, repair fixes input, succeeds on retry', async () => {
    const skill = createFlakeySkill('flakey_once', 1);
    registerSkill(skill);

    const result = await runWithRetry('flakey_once', { value: 'bad' }, repairingLLM);

    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
    expect(result.output).toContain('Success on attempt 2');
  });

  // --- P1B: Skill fails 3 times, returns final error (no infinite loop) ---

  it('P1B: skill fails max retries, returns final error', async () => {
    const skill = createFlakeySkill('flakey_always', 100); // never succeeds
    registerSkill(skill);

    const result = await runWithRetry('flakey_always', { value: 'bad' }, repairingLLM, 3);

    expect(result.success).toBe(false);
    expect(result.retries).toBe(3);
    expect(result.error).toContain('failed');
  });

  // --- P1C: Successful skill on first try — zero retries ---

  it('P1C: successful skill on first try has zero retries', async () => {
    const skill: MCPSkill = {
      name: 'instant_success',
      description: 'Always succeeds',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', description: 'input value' } },
        required: ['value'],
      },
      async execute(input: Record<string, unknown>) {
        return { success: true, output: `Got: ${input.value}` };
      },
    };
    registerSkill(skill);

    const result = await runWithRetry('instant_success', { value: 'hello' }, noopLLM);

    expect(result.success).toBe(true);
    expect(result.retries).toBe(0);
    expect(result.output).toBe('Got: hello');
  });

  // --- P1D: Memory write JSON repair — LLM returns invalid JSON first, corrected on retry ---

  it('P1D: memory write retries on invalid LLM JSON, succeeds on retry', async () => {
    let callCount = 0;
    const retryingWriteLLM: LLMHandler = async (messages: Message[]) => {
      callCount++;
      const system = messages[0].content;

      // Memory write LLM call
      if (system.includes('memory writing assistant')) {
        if (callCount === 1) {
          // First call: return garbage
          return 'This is not JSON at all';
        }
        // Second call: return valid JSON
        return JSON.stringify({
          nb: 'WHO', type: 'CT', name: 'Retry Person',
          status: 'active', summary: 'Created on retry', body: 'Retried successfully',
        });
      }
      return 'General response.';
    };

    const res = await processMessage('create a contact named Retry Person', [], { llmHandler: retryingWriteLLM });

    expect(res.intent).toBe('memory_write');
    expect(res.created).toBeDefined();
    expect(res.created!.name).toBe('Retry Person');
    // Should have called LLM at least twice (first failed parse, second succeeded)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  // --- P1E: repairSkillInput LLM call fails — returns original input unchanged ---

  it('P1E: repairSkillInput returns original input when LLM fails', async () => {
    const original = { value: 'original_data', extra: 42 };

    const repaired = await repairSkillInput(
      'some_skill',
      original,
      'Some error occurred',
      failingLLM,
    );

    expect(repaired).toEqual(original);
  });

  // --- Additional: repairSkillInput returns original on non-JSON LLM response ---

  it('repairSkillInput returns original input when LLM returns non-JSON', async () => {
    const nonJsonLLM: LLMHandler = async () => 'This is plain text with no JSON';
    const original = { value: 'keep_this' };

    const repaired = await repairSkillInput(
      'test_skill',
      original,
      'Parse error',
      nonJsonLLM,
    );

    expect(repaired).toEqual(original);
  });

  // --- retries field propagates to AgentResponse ---

  it('retries field appears in AgentResponse from skill execution', async () => {
    const alwaysOkSkill: MCPSkill = {
      name: 'retries_check_skill',
      description: 'Always succeeds for retries check',
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'math expression' } },
        required: ['expression'],
      },
      async execute() {
        return { success: true, output: 'ok' };
      },
    };
    registerSkill(alwaysOkSkill);

    // Use a mock LLM that captures skill output
    const mockLLM: LLMHandler = async (messages: Message[]) => {
      if (messages[0].content.includes('Skill Output')) return 'Skill completed.';
      return 'ok';
    };

    // We need to trigger a skill route — registerSkill makes it available but
    // classifier routes by pattern, not by registry. So use calculator which is already registered.
    const res = await processMessage('calculate 1 + 1', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.retries).toBeDefined();
    expect(res.retries).toBe(0);
  });
});
