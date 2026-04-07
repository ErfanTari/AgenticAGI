import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runWithRetry } from '../../core/react.js';
import { registerSkill, _unfreezeRegistry } from '../../core/skills/registry.js';
import { processMessage } from '../../core/agent.js';
import { runHeartbeat } from '../../core/heartbeat.js';
import type { MCPSkill } from '../../core/skills/types.js';
import type { Message, LLMHandler } from '../../core/types.js';
import {
  initDatabase,
  closeDatabase,
  createEntry,
} from '../../core/memory/mod.js';
import { getDb } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';

// --- Test setup ---

const TEST_DIR = path.join(os.tmpdir(), `stress-integration-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'memory.sqlite');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');

const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  initDatabase(TEST_DB);
});

afterAll(async () => {
  closeDatabase();
  const { _resetGitInstance } = await import('../../core/memory/versioning.js');
  _resetGitInstance();
  await new Promise(r => setTimeout(r, 100));
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

// --- Helpers ---

function createFlakeySkill(name: string, failCount: number): MCPSkill {
  let calls = 0;
  return {
    name,
    description: `Fails ${failCount} times then succeeds`,
    permissionLevel: 'read-only',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', description: 'input value' } },
      required: ['value'],
    },
    async execute(input: Record<string, unknown>) {
      calls++;
      if (calls <= failCount) {
        return { success: false, output: '', error: `Attempt ${calls} failed: invalid value for 'value'` };
      }
      return { success: true, output: `Success: ${input.value}` };
    },
  };
}

// --- Group 4: Full Loop Integration ---

describe('Group 4: Full Loop Integration', () => {
  // 4A — ReAct + memory write end-to-end
  it('4A: memory write with JSON parse failure, retry succeeds, entries created', async () => {
    let callCount = 0;
    const retryLLM: LLMHandler = async (messages: Message[]) => {
      callCount++;
      if (messages[0].content.includes('memory writing assistant')) {
        if (callCount === 1) return 'invalid JSON garbage {{{{';
        return JSON.stringify({
          nb: 'WHAT', type: 'PJ', name: 'AgenticAGI',
          status: 'active', summary: 'Erfan owns this project',
          body: 'AgenticAGI project owned by Erfan',
        });
      }
      return 'ok';
    };

    const res = await processMessage('remember that Erfan owns the AgenticAGI project', [], { llmHandler: retryLLM });
    expect(res.intent).toBe('memory_write');
    expect(res.created).toBeDefined();
    expect(res.reply).toContain('Created');
    // Required retry
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  // 4B — Vision check does not block normal queries
  it('4B: normal queries resolve correctly alongside heartbeat findings', async () => {
    // Create North Star + 2 unconnected projects
    createEntry({
      nb: 'WHY', type: 'MT', name: 'North Star Vision',
      status: 'active', summary: 'ceramic analysis platform',
      body: 'Vision',
    });
    createEntry({
      nb: 'WHAT', type: 'PJ', name: 'Shoe Marketing',
      status: 'active', summary: 'marketing shoes online',
      body: 'Unconnected 1',
    });
    createEntry({
      nb: 'WHAT', type: 'PJ', name: 'Yoga App',
      status: 'active', summary: 'yoga scheduling platform',
      body: 'Unconnected 2',
    });

    const mockLLM: LLMHandler = async () => 'Response to your query.';

    // Run 5 normal queries
    const queryResults = [];
    for (let i = 0; i < 5; i++) {
      const res = await processMessage('hello', [], { llmHandler: mockLLM });
      queryResults.push(res);
    }

    // All queries should resolve correctly
    expect(queryResults.length).toBe(5);
    for (const res of queryResults) {
      expect(res.reply).toBeTruthy();
      expect(res.intent).toBe('greeting');
    }

    // Heartbeat queues findings separately
    const hb = await runHeartbeat();
    expect(hb.ran_at).toBeTruthy();
    // Vision drift should be detected for unconnected projects
    const drift = hb.notifications.find(n => n.type === 'vision_drift');
    expect(drift).toBeDefined();
    // Findings appear on next message only (via heartbeat_queue)
    const d = getDb();
    const unseen = d.prepare('SELECT COUNT(*) as c FROM heartbeat_queue WHERE seen = 0').get() as { c: number };
    expect(unseen.c).toBeGreaterThanOrEqual(1);
  });

  // 4C — Retry counter reported correctly
  it('4C: retries field accurate per response, total across mixed session = 3', async () => {
    _unfreezeRegistry();
    const repairLLM: LLMHandler = async () => JSON.stringify({ value: 'repaired' });
    let totalRetries = 0;

    // 3 calls that need 1 retry each
    for (let i = 0; i < 3; i++) {
      const skill = createFlakeySkill(`stress_4c_fail_${i}`, 1);
      registerSkill(skill);
      const result = await runWithRetry(`stress_4c_fail_${i}`, { value: 'x' }, repairLLM);
      expect(result.success).toBe(true);
      expect(result.retries).toBe(1);
      totalRetries += result.retries;
    }

    // 3 calls that succeed immediately
    for (let i = 0; i < 3; i++) {
      const skill = createFlakeySkill(`stress_4c_pass_${i}`, 0);
      registerSkill(skill);
      const result = await runWithRetry(`stress_4c_pass_${i}`, { value: 'x' }, repairLLM);
      expect(result.success).toBe(true);
      expect(result.retries).toBe(0);
    }

    expect(totalRetries).toBe(3);
  });

  // 4D — Zod + ReAct work together
  it('4D: Zod catches invalid LLM response, write retry loop fixes it, user sees one confirmation', async () => {
    let callCount = 0;
    const zodRetryLLM: LLMHandler = async (messages: Message[]) => {
      if (messages[0].content.includes('memory writing assistant')) {
        callCount++;
        if (callCount === 1) {
          // Valid JSON but Zod-invalid (empty name)
          return JSON.stringify({ nb: 'WHO', type: 'CT', name: '', status: 'active', summary: 'test', body: 'test' });
        }
        // Second attempt: valid
        return JSON.stringify({ nb: 'WHO', type: 'CT', name: 'Zod ReAct Person', status: 'active', summary: 'Fixed', body: 'Fixed body' });
      }
      return 'ok';
    };

    const res = await processMessage('create a contact named Zod ReAct Person', [], { llmHandler: zodRetryLLM });

    expect(res.created).toBeDefined();
    expect(res.created!.name).toBe('Zod ReAct Person');
    // User sees one confirmation, not two
    const createdCount = (res.reply.match(/Created/g) || []).length;
    expect(createdCount).toBe(1);
    // LLM called at least twice
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
