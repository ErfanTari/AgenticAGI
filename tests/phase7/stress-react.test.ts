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
} from '../../core/memory/mod.js';
import { getDb } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';

// --- Test setup ---

const TEST_DIR = path.join(os.tmpdir(), `stress-react-${Date.now()}`);
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
      return { success: true, output: `Success with value "${input.value}"` };
    },
  };
}

const repairingLLM: LLMHandler = async () => {
  return JSON.stringify({ value: 'repaired_value' });
};

// --- Group 1: ReAct Self-Correction Loop ---

describe('Group 1: ReAct Self-Correction Loop', () => {
  // 1A — Skill failure retries silently
  it('1A: calculator fails on attempt 1, repair fixes input, succeeds on attempt 2, user sees no error', async () => {
    const skill = createFlakeySkill('stress_calc_1a', 1);
    registerSkill(skill);

    const result = await runWithRetry('stress_calc_1a', { value: 'bad_input' }, repairingLLM);

    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
    expect(result.output).toContain('Success');
    // User sees correct answer only — no error text in output
    expect(result.output).not.toContain('failed');
    expect(result.error).toBeUndefined();
  });

  // 1B — File not found retries with corrected path
  it('1B: file not found on attempt 1, repair returns correct path, succeeds on attempt 2', async () => {
    const WORKSPACE = path.join(TEST_DIR, 'user_workspace');
    fs.mkdirSync(WORKSPACE, { recursive: true });
    const reportPath = path.join(WORKSPACE, 'report.txt');
    fs.writeFileSync(reportPath, 'Phase 7 report content here', 'utf-8');

    const flakeyReader: MCPSkill = {
      name: 'stress_file_reader_1b',
      description: 'File reader that uses wrong path on first attempt',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'file path' } },
        required: ['path'],
      },
      async execute(input: Record<string, unknown>) {
        const filePath = String(input.path ?? '');
        if (!fs.existsSync(filePath)) {
          return { success: false, output: '', error: `File not found: ${filePath}` };
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        return { success: true, output: content };
      },
    };
    registerSkill(flakeyReader);

    // Repair LLM returns the correct path
    const pathRepairLLM: LLMHandler = async () => {
      return JSON.stringify({ path: reportPath });
    };

    // First attempt uses wrong path
    const result = await runWithRetry(
      'stress_file_reader_1b',
      { path: '/nonexistent/wrong.txt' },
      pathRepairLLM,
    );

    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
    expect(result.output).toContain('Phase 7 report content');
  });

  // 1C — Max 3 retries then clean failure
  it('1C: after 3 retries, user sees clean message with NO internal error details', async () => {
    const alwaysFail: MCPSkill = {
      name: 'calculator',
      description: 'Always fails with internal error',
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'math expression' } },
        required: ['expression'],
      },
      async execute() {
        return { success: false, output: '', error: 'INTERNAL_STACK_TRACE_X123_SHOULD_NOT_APPEAR_TO_USER' };
      },
    };
    registerSkill(alwaysFail);

    const mockLLM: LLMHandler = async (messages: Message[]) => {
      // Repair attempts will be made but skill still fails
      if (messages[0].content.includes('JSON repair assistant')) {
        return JSON.stringify({ expression: '1+1' });
      }
      return 'ok';
    };

    const res = await processMessage('calculate 1 + 1', [], { llmHandler: mockLLM });

    // User reply should be clean, no internal error text
    expect(res.reply).not.toContain('INTERNAL_STACK_TRACE');
    expect(res.reply).not.toContain('X123');
    expect(res.reply).not.toContain('[object Object]');
    // Should contain friendly message
    expect(res.reply).toContain('try again');
    // Error is stored internally
    expect(res.error).toBeTruthy();
    expect(res.retries).toBe(3);
  });

  // 1D — Retry never creates memory entries
  it('1D: failed retries do not create index_entries', async () => {
    const d = getDb();
    const countBefore = (d.prepare('SELECT COUNT(*) as c FROM index_entries').get() as { c: number }).c;

    const skill = createFlakeySkill('stress_no_mem_1d', 999);
    registerSkill(skill);

    await runWithRetry('stress_no_mem_1d', { value: 'bad' }, repairingLLM, 3);

    const countAfter = (d.prepare('SELECT COUNT(*) as c FROM index_entries').get() as { c: number }).c;
    expect(countAfter).toBe(countBefore);
  });

  // 1E — Memory write JSON repair works
  it('1E: memory write LLM returns garbage first, valid JSON on retry, entry created in SQLite and on disk', async () => {
    let callCount = 0;
    const retryWriteLLM: LLMHandler = async (messages: Message[]) => {
      callCount++;
      const system = messages[0].content;
      if (system.includes('memory writing assistant')) {
        if (callCount === 1) return 'Not valid JSON at all {broken';
        return JSON.stringify({
          nb: 'WHO', type: 'CT', name: 'Stress Repair Person',
          status: 'active', summary: 'Created via stress test', body: 'Retry worked',
        });
      }
      return 'ok';
    };

    const res = await processMessage('create a contact named Stress Repair Person', [], { llmHandler: retryWriteLLM });

    expect(res.intent).toBe('memory_write');
    expect(res.created).toBeDefined();
    expect(res.created!.name).toBe('Stress Repair Person');
    // Verify entry exists in SQLite
    const d = getDb();
    const entry = d.prepare('SELECT * FROM index_entries WHERE code = ?').get(res.created!.code);
    expect(entry).toBeDefined();
    // Verify file exists on disk
    expect(fs.existsSync(res.created!.path)).toBe(true);
    // User sees confirmation
    expect(res.reply).toContain('Created');
    // Required at least 2 LLM calls
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  // 1F — Retry is invisible in normal flow
  it('1F: 10 successful skill calls have retries=0, no repair LLM calls made', async () => {
    let repairCalled = false;
    const noRepairLLM: LLMHandler = async () => {
      repairCalled = true;
      return '{}';
    };

    const successSkill: MCPSkill = {
      name: 'stress_success_1f',
      description: 'Always succeeds',
      inputSchema: {
        type: 'object',
        properties: { n: { type: 'string', description: 'number' } },
        required: ['n'],
      },
      async execute(input: Record<string, unknown>) {
        return { success: true, output: `Result: ${input.n}` };
      },
    };
    registerSkill(successSkill);

    for (let i = 0; i < 10; i++) {
      const result = await runWithRetry('stress_success_1f', { n: String(i) }, noRepairLLM);
      expect(result.success).toBe(true);
      expect(result.retries).toBe(0);
    }

    expect(repairCalled).toBe(false);
  });

  // 1G — Repair call is isolated
  it('1G: repair call has no conversation history, contains skill name + error + original input, max_tokens <= 200', async () => {
    let capturedMessages: Message[] = [];
    let capturedOptions: { maxTokens?: number } | undefined;
    const capturingRepairLLM: LLMHandler = async (messages: Message[], options?) => {
      capturedMessages = messages;
      capturedOptions = options;
      return JSON.stringify({ value: 'fixed' });
    };

    const skill = createFlakeySkill('stress_capture_1g', 1);
    registerSkill(skill);

    await runWithRetry('stress_capture_1g', { value: 'original_input' }, capturingRepairLLM);

    // Repair call should have exactly 2 messages: system + user
    expect(capturedMessages.length).toBe(2);
    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[1].role).toBe('user');

    // No conversation history (no assistant messages)
    const hasHistory = capturedMessages.some(m => m.role === 'assistant');
    expect(hasHistory).toBe(false);

    // Contains skill name, error, and original input
    const userContent = capturedMessages[1].content;
    expect(userContent).toContain('stress_capture_1g');
    expect(userContent).toContain('failed');
    expect(userContent).toContain('original_input');

    // max_tokens <= 200
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.maxTokens).toBeDefined();
    expect(capturedOptions!.maxTokens!).toBeLessThanOrEqual(200);
  });
});
