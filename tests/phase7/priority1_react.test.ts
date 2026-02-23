import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Message } from '../../core/types.js';
import { processMessage } from '../../core/agent.js';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase, closeDatabase, getDb } from '../../core/memory/mod.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-p7-p1-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'memory.sqlite');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');
const WORKSPACE_ROOT = path.resolve(process.cwd(), 'user_workspace');
const WORKSPACE_TEST_DIR = path.join(WORKSPACE_ROOT, `phase7-p1-${Date.now()}`);

const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  fs.mkdirSync(WORKSPACE_TEST_DIR, { recursive: true });
  initDatabase(TEST_DB);
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(WORKSPACE_TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

describe('Phase 7 Priority 1 — ReAct self-correction loop', () => {
  it('P1A: self-corrects calculator input and returns correct result', async () => {
    let repairCalls = 0;
    const llm = async (messages: Message[]) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('repair tool inputs after a failed tool execution')) {
        repairCalls += 1;
        return JSON.stringify({ expression: '15/100*280' });
      }
      if (system.includes('## Skill Output')) {
        const skill = system.match(/## Skill Output\n([\s\S]*)/)?.[1]?.trim() ?? '';
        return `Result: ${skill}`;
      }
      return 'ok';
    };

    const res = await processMessage('calculate 15 percent of 280 plus abc', [], { llmHandler: llm });
    expect(res.intent).toBe('skill');
    expect(res.error).toBeUndefined();
    expect(res.reply).toContain('42');
    expect(repairCalls).toBeGreaterThanOrEqual(1);
  });

  it('P1B: self-corrects file path and succeeds on retry', async () => {
    const reportFile = path.join(WORKSPACE_ROOT, 'report.txt');
    fs.writeFileSync(reportFile, 'phase7 react file fix', 'utf-8');

    const llm = async (messages: Message[]) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('repair tool inputs after a failed tool execution')) {
        return JSON.stringify({ path: 'user_workspace/report.txt' });
      }
      if (system.includes('## Skill Output')) {
        return messages[0].content;
      }
      return 'ok';
    };

    const res = await processMessage('read the file workspace/report.txt', [], { llmHandler: llm });
    expect(res.intent).toBe('skill');
    expect(res.error).toBeUndefined();
    expect(res.reply).toContain('phase7 react file fix');
  });

  it('P1C: after max retries, returns clean failure message', async () => {
    const llm = async (messages: Message[]) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('repair tool inputs after a failed tool execution')) {
        return JSON.stringify({ expression: 'abc + xyz' });
      }
      return 'ok';
    };

    const res = await processMessage('calculate abc plus xyz', [], { llmHandler: llm });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain("I couldn't complete that after 3 attempts.");
    expect(res.reply).not.toContain('Error:');
    expect(res.reply).not.toContain('{');
  });

  it('P1D: retries do not create memory entries', async () => {
    const d = getDb();
    const before = (d.prepare('SELECT COUNT(*) as c FROM index_entries').get() as { c: number }).c;

    const llm = async (messages: Message[]) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('repair tool inputs after a failed tool execution')) {
        return JSON.stringify({ expression: 'abc + xyz' });
      }
      return 'ok';
    };

    await processMessage('calculate abc plus xyz', [], { llmHandler: llm });
    const after = (d.prepare('SELECT COUNT(*) as c FROM index_entries').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('P1E: repairs malformed memory-write JSON and creates entry', async () => {
    let writeAttempts = 0;
    const llm = async (messages: Message[]) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('memory writing assistant')) {
        writeAttempts += 1;
        return 'not json';
      }
      if (system.includes('repair malformed memory-write JSON')) {
        return JSON.stringify({
          nb: 'WHO',
          type: 'CT',
          name: 'Phase7 Repair User',
          status: 'active',
          summary: 'created after repair',
          body: 'Recovered write JSON output.',
        });
      }
      return 'ok';
    };

    const res = await processMessage('create a contact named Phase7 Repair User', [], { llmHandler: llm });
    expect(res.intent).toBe('memory_write');
    expect(res.error).toBeUndefined();
    expect(res.reply).toContain('Created');
    expect(writeAttempts).toBe(1);
  });
});
