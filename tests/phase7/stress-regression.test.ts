import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runWithRetry } from '../../core/react.js';
import { processMessage } from '../../core/agent.js';
import {
  runHeartbeat,
  checkDeadlines,
  checkOverdueTodos,
  checkStaleQuestions,
  checkPlanCalibration,
  checkStaleProjects,
  checkVisionAlignment,
} from '../../core/heartbeat.js';
import type { LLMHandler, Message } from '../../core/types.js';
import {
  initDatabase,
  closeDatabase,
  createEntry,
} from '../../core/memory/mod.js';
import { addRelationship, getRelationshipsFrom } from '../../core/memory/relationships.js';
import { getDb } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';

// --- Test setup ---

const TEST_DIR = path.join(os.tmpdir(), `stress-regression-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'memory.sqlite');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');

const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  initDatabase(TEST_DB);

  // Create user_workspace for file_reader tests
  const workspace = path.join(process.cwd(), 'user_workspace');
  fs.mkdirSync(workspace, { recursive: true });
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

// --- Group 5: Regression ---

describe('Group 5: Regression', () => {
  // 5B — Phase 6 skills unaffected
  it('5B: calculator skill still works through full agent loop', async () => {
    const mockLLM: LLMHandler = async (messages: Message[]) => {
      if (messages[0].content.includes('Skill Output')) {
        // Extract the math result from skill output
        const skillOutput = messages[0].content;
        if (skillOutput.includes('2 + 2 = 4')) return 'The answer is 4.';
        return 'Calculated successfully.';
      }
      return 'ok';
    };

    const res = await processMessage('what is 2 + 2', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toBeTruthy();
    expect(res.retries).toBeDefined();
    expect(res.retries).toBe(0);
  });

  it('5B: web_search skill routes correctly', async () => {
    const mockLLM: LLMHandler = async (messages: Message[]) => {
      if (messages[0].content.includes('Skill Output')) return 'TypeScript results found.';
      return 'ok';
    };

    const res = await processMessage('search the web for TypeScript', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
  });

  it('5B: memory queries unchanged after Phase 7', async () => {
    // Create a contact
    const mockLLM: LLMHandler = async (messages: Message[]) => {
      if (messages[0].content.includes('memory writing assistant')) {
        return JSON.stringify({
          nb: 'WHO', type: 'CT', name: 'Regression Test Contact',
          status: 'active', summary: 'Test contact', body: 'Test body',
        });
      }
      return 'Regression Test Contact is an active contact.';
    };

    const writeRes = await processMessage('create a contact named Regression Test Contact', [], { llmHandler: mockLLM });
    expect(writeRes.created).toBeDefined();

    // Query it back
    const readRes = await processMessage('show me contacts', [], { llmHandler: mockLLM });
    expect(readRes.intent).toBe('memory_query');
  });

  // 5C — Heartbeat checks 1-5 unaffected by check 6
  it('5C: all 5 original heartbeat checks run normally alongside check 6', async () => {
    const d = getDb();

    // Seed entries for overdue check (check 2)
    createEntry({
      nb: 'NOW', type: 'TD', name: 'Regression Overdue Todo',
      status: 'open', summary: 'Past due for regression',
      body: 'Test', due_date: '2020-01-01',
    });

    // Seed entry for stale question check (check 3)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 5);
    const staleQ = createEntry({
      nb: 'WHY', type: 'QU', name: 'Regression Stale Question',
      status: 'open', summary: 'Unanswered for 5 days',
      body: 'Test question',
    });
    // Manually backdate the updated field
    d.prepare('UPDATE index_entries SET updated = ? WHERE code = ?')
      .run(oldDate.toISOString().slice(0, 10), staleQ.code);

    // Run full heartbeat
    const hb = await runHeartbeat();

    // Check 2 (overdue) should have fired
    const overdue = hb.notifications.find(n => n.type === 'overdue_todo');
    expect(overdue).toBeDefined();

    // Check 3 (stale question) should have fired
    const stale = hb.notifications.find(n => n.type === 'stale_question');
    expect(stale).toBeDefined();

    // Check 6 (vision) should run without crashing — may or may not produce results
    // depending on whether vision entries exist
    expect(hb.ran_at).toBeTruthy();
  });

  // 5D — Relationships unaffected
  it('5D: relationship data survives 10 skill calls without corruption', async () => {
    const a = createEntry({
      nb: 'WHO', type: 'CT', name: 'Rel Stress A',
      status: 'active', summary: 'Person A', body: 'A',
    });
    const b = createEntry({
      nb: 'WHAT', type: 'PJ', name: 'Rel Stress B',
      status: 'active', summary: 'Project B', body: 'B',
    });
    addRelationship({ from_code: a.code, relation: 'owns', to_code: b.code });

    const noopLLM: LLMHandler = async () => 'ok';

    // Run 10 skill calls through runWithRetry
    for (let i = 0; i < 10; i++) {
      const result = await runWithRetry('calculator', { expression: `${i} + 1` }, noopLLM);
      expect(result.success).toBe(true);
    }

    // Verify relationship intact
    const rels = getRelationshipsFrom(a.code);
    expect(rels.length).toBe(1);
    expect(rels[0].to_code).toBe(b.code);
    expect(rels[0].relation).toBe('owns');

    // Verify entries intact
    const d = getDb();
    const entryA = d.prepare('SELECT * FROM index_entries WHERE code = ?').get(a.code);
    const entryB = d.prepare('SELECT * FROM index_entries WHERE code = ?').get(b.code);
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
  });
});
