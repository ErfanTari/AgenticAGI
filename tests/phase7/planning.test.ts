import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { localDatePlusDays } from '../../core/utils/date.ts';
import { classifyIntent } from '../../core/intent.js';
import { processMessage } from '../../core/agent.js';
import {
  runHeartbeat,
  checkVisionAlignment,
  checkOverdueTodos,
} from '../../core/heartbeat.js';
import type { Message, LLMHandler } from '../../core/types.js';
import {
  initDatabase,
  closeDatabase,
  createEntry,
} from '../../core/memory/mod.js';
import { getDb } from '../../core/memory/index.js';
import { updateEntry } from '../../core/memory/write.js';
import { PATHS } from '../../config/agent.config.js';

// --- Test setup ---

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-test-p7-plan-${Date.now()}`);
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

// --- P3A: Vision entry + misaligned plan → heartbeat flags vision_drift ---

describe('Vision alignment checks', () => {
  it('P3A: misaligned plan triggers vision_drift notification', () => {
    // Create a North Star vision entry
    createEntry({
      nb: 'WHY', type: 'MT', name: 'North Star Vision',
      status: 'active', summary: 'Build the best ceramic analysis platform',
      body: 'Our North Star is ceramic analysis excellence',
    });

    // Create a plan that has NO keyword overlap with the vision
    createEntry({
      nb: 'PLAN', type: 'PL', name: 'Unrelated Marketing Sprint',
      status: 'active', summary: 'Launch social media campaign for shoes',
      body: 'Focus on shoe marketing',
    });

    const result = checkVisionAlignment();
    expect(result).not.toBeNull();
    expect(result!.type).toBe('vision_drift');
    expect(result!.entries.length).toBeGreaterThanOrEqual(1);
    expect(result!.message).toContain('may not align');
  });

  // --- P3E: No vision entry exists → returns null ---

  it('P3E: checkVisionAlignment returns null when no vision entry exists', () => {
    // Use a fresh DB context — but our test DB has a vision entry.
    // We'll archive it temporarily to test absence
    const d = getDb();
    const visionEntries = d.prepare(
      "SELECT * FROM index_entries WHERE nb = 'WHY' AND type = 'MT' AND name LIKE '%North Star%' AND status = 'active'"
    ).all() as Array<{ code: string }>;

    // Archive all vision entries
    for (const v of visionEntries) {
      updateEntry(v.code, { status: 'archived' });
    }

    const result = checkVisionAlignment();
    expect(result).toBeNull();

    // Restore vision entries
    for (const v of visionEntries) {
      updateEntry(v.code, { status: 'active' });
    }
  });
});

// --- P3B: PLAN.PL with past due_date → heartbeat marks overdue ---

describe('Overdue plan detection', () => {
  it('P3B: plan with past due_date is marked overdue by heartbeat', () => {
    const plan = createEntry({
      nb: 'PLAN', type: 'PL', name: 'Overdue Test Plan',
      status: 'active', summary: 'Should be flagged as overdue',
      body: 'This plan is past its due date',
      due_date: '2020-01-01', // well in the past
    });

    const result = checkOverdueTodos();
    expect(result).not.toBeNull();
    expect(result!.entries.some(e => e.code === plan.code)).toBe(true);

    // Verify status was updated
    const d = getDb();
    const updated = d.prepare('SELECT status FROM index_entries WHERE code = ?').get(plan.code) as { status: string };
    expect(updated.status).toBe('overdue');
  });

  it('P3B: heartbeat integration — vision_drift appears in full heartbeat run', async () => {
    const hbResult = await runHeartbeat();
    // Should have at least one notification (from vision drift or overdue)
    expect(hbResult.notifications.length).toBeGreaterThanOrEqual(1);
  });
});

// --- P3C: due_date extraction from classifier ---

describe('Due date extraction', () => {
  it('P3C: "create a plan due 2025-03-15" extracts ISO due_date', () => {
    const c = classifyIntent('create a plan due 2025-03-15');
    expect(c.intent).toBe('memory_write');
    expect(c.due_date).toBe('2025-03-15');
  });

  // --- P3D: "create a plan due tomorrow" → resolves to tomorrow ---

  it('P3D: "create a plan due tomorrow" resolves to tomorrow ISO date', () => {
    const c = classifyIntent('create a plan due tomorrow');
    const expected = localDatePlusDays(1);
    expect(c.due_date).toBe(expected);
  });

  it('P3D: "create a plan due by next week" resolves to +7 days', () => {
    const c = classifyIntent('create a plan due by next week');
    const expected = localDatePlusDays(7);
    expect(c.due_date).toBe(expected);
  });

  it('no due_date when not present in message', () => {
    const c = classifyIntent('create a plan for the team');
    expect(c.due_date).toBeUndefined();
  });

  // --- due_date passes through to created entry ---

  it('due_date from classifier passes through to created entry', async () => {
    const mockLLM: LLMHandler = async (messages: Message[]) => {
      if (messages[0].content.includes('memory writing assistant')) {
        return JSON.stringify({
          nb: 'PLAN', type: 'PL', name: 'Due Date Test',
          status: 'active', summary: 'Test plan with due date', body: 'Testing due dates',
        });
      }
      return 'ok';
    };

    const res = await processMessage('create a plan due 2025-06-01 named Due Date Test', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('memory_write');
    expect(res.created).toBeDefined();

    // Verify the due_date was stored in the database
    const d = getDb();
    const entry = d.prepare('SELECT due_date FROM index_entries WHERE code = ?').get(res.created!.code) as { due_date: string | null };
    expect(entry.due_date).toBe('2025-06-01');
  });
});
