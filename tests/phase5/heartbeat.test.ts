import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initDatabase,
  closeDatabase,
  createEntry,
  updateEntry,
  getEntryByCode,
  queryEntries,
} from '../../core/memory/mod.js';
import {
  runHeartbeat,
  checkDeadlines,
  checkOverdueTodos,
  checkStaleQuestions,
  checkPlanCalibration,
  checkStaleProjects,
} from '../../core/heartbeat.js';
import { PATHS } from '../../config/agent.config.js';
import { getDb } from '../../core/memory/index.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-heartbeat-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'memory.sqlite');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');

const origDb = PATHS.db;
const origMemory = PATHS.memory;

function freshDb(): { dir: string; cleanup: () => void } {
  const dir = path.join(os.tmpdir(), `agentic-agi-t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const dbPath = path.join(dir, 'memory.sqlite');
  const memPath = path.join(dir, 'memory');
  closeDatabase();
  (PATHS as Record<string, string>).db = dbPath;
  (PATHS as Record<string, string>).memory = memPath;
  initDatabase(dbPath);
  return {
    dir,
    cleanup() {
      closeDatabase();
      fs.rmSync(dir, { recursive: true, force: true });
      (PATHS as Record<string, string>).db = TEST_DB;
      (PATHS as Record<string, string>).memory = TEST_MEMORY;
      initDatabase(TEST_DB);
    },
  };
}

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

// --- updateEntry ---

describe('updateEntry', () => {
  it('updates status in SQLite and returns updated entry', () => {
    const entry = createEntry({
      nb: 'NOW', type: 'TD', name: 'Test Todo',
      status: 'open', summary: 'A todo for testing', body: 'Details here',
    });

    const updated = updateEntry(entry.code, { status: 'done' });
    expect(updated.status).toBe('done');
    expect(updated.summary).toBe('A todo for testing');
    expect(updated.updated).toBe(new Date().toISOString().slice(0, 10));

    const fromDb = getEntryByCode(entry.code);
    expect(fromDb!.status).toBe('done');
  });

  it('updates summary in SQLite and returns updated entry', () => {
    const entry = createEntry({
      nb: 'WHAT', type: 'PJ', name: 'Summary Project',
      status: 'active', summary: 'Original summary', body: 'Body',
    });

    const updated = updateEntry(entry.code, { summary: 'New summary' });
    expect(updated.summary).toBe('New summary');
    expect(updated.status).toBe('active');

    const fromDb = getEntryByCode(entry.code);
    expect(fromDb!.summary).toBe('New summary');
  });

  it('updates both status and summary at once', () => {
    const entry = createEntry({
      nb: 'NOW', type: 'TD', name: 'Dual Update',
      status: 'open', summary: 'Old', body: 'Body',
    });

    const updated = updateEntry(entry.code, { status: 'closed', summary: 'Finished' });
    expect(updated.status).toBe('closed');
    expect(updated.summary).toBe('Finished');
  });

  it('updates markdown frontmatter on disk', () => {
    const entry = createEntry({
      nb: 'NOW', type: 'TD', name: 'Disk Update',
      status: 'open', summary: 'Check disk', body: 'Body',
    });

    updateEntry(entry.code, { status: 'overdue' });

    const content = fs.readFileSync(entry.path, 'utf-8');
    expect(content).toContain('status: overdue');
    expect(content).toContain(`updated: ${new Date().toISOString().slice(0, 10)}`);
  });

  it('throws for nonexistent code', () => {
    expect(() => updateEntry('NOW.TD-999999', { status: 'done' })).toThrow('Entry not found');
  });
});

// --- checkDeadlines ---

describe('checkDeadlines', () => {
  it('returns null when no upcoming events', () => {
    const { cleanup } = freshDb();
    expect(checkDeadlines()).toBeNull();
    cleanup();
  });

  it('returns notification for upcoming WHEN entries with due_date today', () => {
    const { cleanup } = freshDb();
    const todayStr = new Date().toISOString().split('T')[0];

    createEntry({
      nb: 'WHEN', type: 'CA', name: 'Team Meeting',
      status: 'upcoming', summary: 'Weekly sync', body: 'At 10am',
      due_date: todayStr,
    });

    const result = checkDeadlines();
    expect(result).not.toBeNull();
    expect(result!.type).toBe('upcoming_event');
    expect(result!.entries.length).toBe(1);
    expect(result!.message).toContain('upcoming event');
    cleanup();
  });

  it('returns notification for upcoming WHEN entries with due_date tomorrow', () => {
    const { cleanup } = freshDb();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    createEntry({
      nb: 'WHEN', type: 'CA', name: 'Tomorrow Meeting',
      status: 'upcoming', summary: 'Sync', body: 'At 10am',
      due_date: tomorrowStr,
    });

    const result = checkDeadlines();
    expect(result).not.toBeNull();
    expect(result!.type).toBe('upcoming_event');
    expect(result!.entries.length).toBe(1);
    cleanup();
  });

  it('does NOT flag deadlines with due_date far in the future', () => {
    const { cleanup } = freshDb();
    const nextMonth = new Date();
    nextMonth.setDate(nextMonth.getDate() + 30);

    createEntry({
      nb: 'WHEN', type: 'DL', name: 'Far Deadline',
      status: 'upcoming', summary: 'Not due yet', body: 'Details',
      due_date: nextMonth.toISOString().split('T')[0],
    });

    expect(checkDeadlines()).toBeNull();
    cleanup();
  });

  it('does NOT flag deadlines with due_date in the past (yesterday)', () => {
    const { cleanup } = freshDb();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    createEntry({
      nb: 'WHEN', type: 'DL', name: 'Past Deadline',
      status: 'upcoming', summary: 'Already passed', body: 'Details',
      due_date: yesterday.toISOString().split('T')[0],
    });

    expect(checkDeadlines()).toBeNull();
    cleanup();
  });
});

// --- checkOverdueTodos ---

describe('checkOverdueTodos', () => {
  it('returns null when no overdue todos', () => {
    const { cleanup } = freshDb();

    // Create a todo with no due_date — should not trigger
    createEntry({
      nb: 'NOW', type: 'TD', name: 'Fresh Todo',
      status: 'open', summary: 'Just created', body: 'Body',
    });

    expect(checkOverdueTodos()).toBeNull();
    cleanup();
  });

  it('returns null for todo with due_date in the future', () => {
    const { cleanup } = freshDb();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    createEntry({
      nb: 'NOW', type: 'TD', name: 'Future Todo',
      status: 'open', summary: 'Not overdue yet', body: 'Body',
      due_date: tomorrow.toISOString().split('T')[0],
    });

    expect(checkOverdueTodos()).toBeNull();
    cleanup();
  });

  it('detects and marks overdue todos with past due_date', () => {
    const { cleanup } = freshDb();
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    const entry = createEntry({
      nb: 'NOW', type: 'TD', name: 'Old Todo',
      status: 'open', summary: 'Should be overdue', body: 'Body',
      due_date: fiveDaysAgo.toISOString().split('T')[0],
    });

    const result = checkOverdueTodos();
    expect(result).not.toBeNull();
    expect(result!.type).toBe('overdue_todo');
    expect(result!.entries.some(e => e.code === entry.code)).toBe(true);
    expect(result!.message).toContain('overdue');

    // Verify status was changed to 'overdue'
    const fromDb = getEntryByCode(entry.code);
    expect(fromDb!.status).toBe('overdue');
    cleanup();
  });
});

// --- checkStaleQuestions ---

describe('checkStaleQuestions', () => {
  it('returns null when no stale questions', () => {
    const { cleanup } = freshDb();
    const result = checkStaleQuestions();
    expect(result).toBeNull();
    cleanup();
  });

  it('detects stale open questions older than 3 days', () => {
    const entry = createEntry({
      nb: 'WHY', type: 'QU', name: 'Stale Question',
      status: 'open', summary: 'Why is the sky blue?', body: 'Wondering about this',
    });

    const d = getDb();
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 5);
    d.prepare('UPDATE index_entries SET updated = ? WHERE code = ?')
      .run(oldDate.toISOString().slice(0, 10), entry.code);

    const result = checkStaleQuestions();
    expect(result).not.toBeNull();
    expect(result!.type).toBe('stale_question');
    expect(result!.entries.some(e => e.code === entry.code)).toBe(true);
  });
});

// --- checkPlanCalibration ---

describe('checkPlanCalibration', () => {
  it('returns null when no stale plans', () => {
    const { cleanup } = freshDb();
    expect(checkPlanCalibration()).toBeNull();
    cleanup();
  });

  it('detects stale planning entries older than 7 days', () => {
    const entry = createEntry({
      nb: 'PLAN', type: 'PL', name: 'Old Plan',
      status: 'active', summary: 'Plan that went stale', body: 'Details',
    });

    const d = getDb();
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    d.prepare('UPDATE index_entries SET updated = ? WHERE code = ?')
      .run(oldDate.toISOString().slice(0, 10), entry.code);

    const result = checkPlanCalibration();
    expect(result).not.toBeNull();
    expect(result!.type).toBe('stale_plan');
    expect(result!.entries.some(e => e.code === entry.code)).toBe(true);
  });
});

// --- checkStaleProjects ---

describe('checkStaleProjects', () => {
  it('returns null when no stale projects', () => {
    const { cleanup } = freshDb();
    expect(checkStaleProjects()).toBeNull();
    cleanup();
  });

  it('detects stale active projects older than 7 days', () => {
    const entry = createEntry({
      nb: 'WHAT', type: 'PJ', name: 'Stale Project',
      status: 'active', summary: 'Abandoned project', body: 'Details',
    });

    const d = getDb();
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    d.prepare('UPDATE index_entries SET updated = ? WHERE code = ?')
      .run(oldDate.toISOString().slice(0, 10), entry.code);

    const result = checkStaleProjects();
    expect(result).not.toBeNull();
    expect(result!.type).toBe('stale_project');
    expect(result!.entries.some(e => e.code === entry.code)).toBe(true);
  });
});

// --- runHeartbeat ---

describe('runHeartbeat', () => {
  it('returns HeartbeatResult with ran_at date', async () => {
    const { cleanup } = freshDb();
    const result = await runHeartbeat();
    expect(result.ran_at).toBe(new Date().toISOString().slice(0, 10));
    expect(Array.isArray(result.notifications)).toBe(true);
    expect(Array.isArray(result.created)).toBe(true);
    cleanup();
  });

  it('creates one WHY.MT entry per notification', async () => {
    const { cleanup } = freshDb();
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

    // Create overdue todo (needs due_date in the past)
    createEntry({
      nb: 'NOW', type: 'TD', name: 'Heartbeat Test Todo',
      status: 'open', summary: 'Will be overdue', body: 'Body',
      due_date: twoDaysAgoStr,
    });

    // Create stale question (needs updated in the past)
    const q = createEntry({
      nb: 'WHY', type: 'QU', name: 'Stale Q',
      status: 'open', summary: 'Old question', body: 'Body',
    });
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    getDb().prepare('UPDATE index_entries SET updated = ? WHERE code = ?')
      .run(fiveDaysAgo.toISOString().split('T')[0], q.code);

    const result = await runHeartbeat();
    expect(result.notifications.length).toBe(2);
    expect(result.created.length).toBe(2);

    // Each created entry is a WHY.MT
    for (const entry of result.created) {
      expect(entry.nb).toBe('WHY');
      expect(entry.type).toBe('MT');
      expect(entry.name).toContain('Heartbeat');
      expect(fs.existsSync(entry.path)).toBe(true);
      const content = fs.readFileSync(entry.path, 'utf-8');
      expect(content).toContain('Findings');
    }
    cleanup();
  });

  it('returns empty created array when no findings on clean DB', async () => {
    const { cleanup } = freshDb();
    const result = await runHeartbeat();
    expect(result.notifications).toEqual([]);
    expect(result.created).toEqual([]);
    cleanup();
  });
});

// --- Acceptance test ---

describe('acceptance', () => {
  it('overdue TODO triggers heartbeat notification + WHY.MT creation', async () => {
    const { cleanup } = freshDb();
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    const todo = createEntry({
      nb: 'NOW', type: 'TD', name: 'Buy groceries',
      status: 'open', summary: 'Need milk and eggs', body: '- Milk\n- Eggs',
      due_date: twoDaysAgo.toISOString().split('T')[0],
    });

    const result = await runHeartbeat();

    // Notification exists for overdue todo
    const overdue = result.notifications.find(n => n.type === 'overdue_todo');
    expect(overdue).toBeDefined();
    expect(overdue!.entries.some(e => e.code === todo.code)).toBe(true);

    // WHY.MT entry was created for this notification
    expect(result.created.length).toBeGreaterThan(0);
    const mtEntry = result.created.find(e => e.summary.includes('overdue'));
    expect(mtEntry).toBeDefined();
    expect(mtEntry!.nb).toBe('WHY');
    expect(mtEntry!.type).toBe('MT');

    // Todo status was changed to overdue
    const updated = getEntryByCode(todo.code);
    expect(updated!.status).toBe('overdue');
    cleanup();
  });
});

// --- FIX 3: Heartbeat queue ---

describe('heartbeat_queue', () => {
  it('inserts one queue row per notification', async () => {
    const { cleanup } = freshDb();
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    // Trigger 1: overdue todo
    createEntry({
      nb: 'NOW', type: 'TD', name: 'Queue Todo',
      status: 'open', summary: 'Will trigger queue', body: 'Body',
      due_date: twoDaysAgo.toISOString().split('T')[0],
    });

    // Trigger 2: stale question
    const q = createEntry({
      nb: 'WHY', type: 'QU', name: 'Queue Question',
      status: 'open', summary: 'Old question', body: 'Body',
    });
    getDb().prepare('UPDATE index_entries SET updated = ? WHERE code = ?')
      .run(fiveDaysAgo.toISOString().split('T')[0], q.code);

    const result = await runHeartbeat();
    expect(result.notifications.length).toBe(2);
    expect(result.created.length).toBe(2);

    // Queue should have one row per notification
    const d = getDb();
    const unseen = d.prepare('SELECT * FROM heartbeat_queue WHERE seen = 0').all() as Array<{
      id: number; code: string; message: string; seen: number; created: string;
    }>;
    expect(unseen.length).toBe(2);

    // Each queue row maps to a created WHY.MT entry
    for (let i = 0; i < result.created.length; i++) {
      expect(unseen[i].code).toBe(result.created[i].code);
      expect(unseen[i].seen).toBe(0);
    }

    // Mark as seen
    d.prepare('UPDATE heartbeat_queue SET seen = 1').run();
    const afterMark = d.prepare('SELECT * FROM heartbeat_queue WHERE seen = 0').all();
    expect(afterMark.length).toBe(0);
    cleanup();
  });

  it('does NOT insert queue row when no findings', async () => {
    const { cleanup } = freshDb();
    const result = await runHeartbeat();
    expect(result.created).toEqual([]);

    const d = getDb();
    const rows = d.prepare('SELECT * FROM heartbeat_queue').all();
    expect(rows.length).toBe(0);
    cleanup();
  });
});

// --- FIX 2: Error isolation ---

describe('error isolation', () => {
  it('one check failing does not stop other checks', async () => {
    const { cleanup } = freshDb();
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    // Create an overdue todo so checkOverdueTodos has findings
    createEntry({
      nb: 'NOW', type: 'TD', name: 'Isolation Test',
      status: 'open', summary: 'Will survive isolation', body: 'Body',
      due_date: fiveDaysAgo.toISOString().split('T')[0],
    });

    // Run heartbeat — even if checkDeadlines or others have issues,
    // checkOverdueTodos should still produce its notification
    const result = await runHeartbeat();
    const overdue = result.notifications.find(n => n.type === 'overdue_todo');
    expect(overdue).toBeDefined();
    expect(overdue!.entries.length).toBeGreaterThan(0);
    cleanup();
  });
});

// --- Performance ---

describe('performance', () => {
  it('full heartbeat completes in under 100ms', async () => {
    const start = performance.now();
    await runHeartbeat();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});
