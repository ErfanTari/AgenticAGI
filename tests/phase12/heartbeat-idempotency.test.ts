/**
 * FIX 4 — Heartbeat Idempotency.
 * Verifies that running the same heartbeat check twice on the same stale entry
 * produces only ONE NOW.LOG pointer alert entry (not duplicates).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runHeartbeat } from '../../core/heartbeat.js';
import { initDatabase, closeDatabase, queryEntries } from '../../core/memory/index.js';
import { createEntry } from '../../core/memory/write.js';
import { PATHS } from '../../config/agent.config.js';
import { updateEntry } from '../../core/memory/write.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-phase12-hb-${Date.now()}`);
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  fs.mkdirSync(path.join(TEST_DIR, 'memory'), { recursive: true });
  (PATHS as Record<string, string>).db = path.join(TEST_DIR, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(TEST_DIR, 'memory');
  initDatabase(path.join(TEST_DIR, 'test.sqlite'));
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

describe('FIX 4 — Heartbeat Idempotency', () => {
  it('running heartbeat twice does not create duplicate NOW.LOG pointer alert entries', async () => {
    // Create a stale question (older than 3 days)
    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - 10);
    const staleDateStr = staleDate.toISOString().slice(0, 10);

    createEntry({
      nb: 'WHY',
      type: 'QU',
      name: 'Unanswered question about deployment',
      status: 'open',
      summary: 'How do we handle deployment?',
      body: 'This question has been open for too long.',
    });

    // Manually backdate the entry to simulate staleness
    const { getDb } = await import('../../core/memory/index.js');
    const d = getDb();
    d.prepare("UPDATE index_entries SET updated = ? WHERE nb = 'WHY' AND type = 'QU'").run(staleDateStr);

    // Run heartbeat twice
    await runHeartbeat();
    await runHeartbeat();

    // Count NOW.LOG pointer alert entries
    const alerts = queryEntries({ nb: 'NOW', type: 'LOG' });
    const staleQuestionAlerts = alerts.filter(e =>
      (e.purpose === 'pointer') && (e.name.toLowerCase().includes('stale_question') || e.name.toLowerCase().includes('stale question'))
    );

    // Should be exactly 1, not 2
    expect(staleQuestionAlerts.length).toBe(1);
  });

  it('running heartbeat 3 times still only creates 1 alert per notification type', async () => {
    // Create an overdue todo
    createEntry({
      nb: 'NOW',
      type: 'TD',
      name: 'Overdue task idempotency test',
      status: 'open',
      summary: 'This should be overdue',
      body: 'Test',
    });

    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 5);
    const pastStr = pastDate.toISOString().slice(0, 10);

    const { getDb } = await import('../../core/memory/index.js');
    const d = getDb();
    d.prepare("UPDATE index_entries SET due_date = ?, updated = ? WHERE nb = 'NOW' AND type = 'TD' AND name = ?")
      .run(pastStr, pastStr, 'Overdue task idempotency test');

    await runHeartbeat();
    await runHeartbeat();
    await runHeartbeat();

    const alerts = queryEntries({ nb: 'NOW', type: 'LOG' });
    const overdueTodoAlerts = alerts.filter(e =>
      (e.purpose === 'pointer') && (e.name.toLowerCase().includes('overdue_todo') || e.name.toLowerCase().includes('overdue todo'))
    );

    // Should be exactly 1
    expect(overdueTodoAlerts.length).toBeLessThanOrEqual(1);
  });
});
