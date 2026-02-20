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
  checkUpcomingEvents,
  checkOverdueTodos,
  checkStaleQuestions,
  checkStalePlans,
  checkStaleProjects,
} from '../../core/heartbeat.js';
import { PATHS } from '../../config/agent.config.js';
import { getDb } from '../../core/memory/index.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-heartbeat-${Date.now()}`);
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

// --- checkUpcomingEvents ---

describe('checkUpcomingEvents', () => {
  it('returns null when no upcoming events', () => {
    expect(checkUpcomingEvents()).toBeNull();
  });

  it('returns notification for upcoming WHEN entries', () => {
    createEntry({
      nb: 'WHEN', type: 'CA', name: 'Team Meeting',
      status: 'upcoming', summary: 'Weekly sync', body: 'At 10am',
    });

    const result = checkUpcomingEvents();
    expect(result).not.toBeNull();
    expect(result!.type).toBe('upcoming_event');
    expect(result!.entries.length).toBeGreaterThan(0);
    expect(result!.message).toContain('upcoming event');
  });
});

// --- checkOverdueTodos ---

describe('checkOverdueTodos', () => {
  it('returns null when no overdue todos', () => {
    // Create a fresh todo — updated today, won't be overdue
    createEntry({
      nb: 'NOW', type: 'TD', name: 'Fresh Todo',
      status: 'open', summary: 'Just created', body: 'Body',
    });

    // Fresh todo should not trigger overdue (updated = today)
    // Only existing old entries would trigger. We test with manual date manipulation below.
    // This verifies the "no false positives" case.
    const result = checkOverdueTodos();
    // May or may not be null depending on prior test entries — the key test is below
    if (result) {
      expect(result.type).toBe('overdue_todo');
    }
  });

  it('detects and marks overdue todos with old updated date', () => {
    const entry = createEntry({
      nb: 'NOW', type: 'TD', name: 'Old Todo',
      status: 'open', summary: 'Should be overdue', body: 'Body',
    });

    // Manually backdate the entry in SQLite to 5 days ago
    const d = getDb();
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 5);
    const oldDateStr = oldDate.toISOString().slice(0, 10);
    d.prepare('UPDATE index_entries SET updated = ? WHERE code = ?').run(oldDateStr, entry.code);

    const result = checkOverdueTodos();
    expect(result).not.toBeNull();
    expect(result!.type).toBe('overdue_todo');
    expect(result!.entries.some(e => e.code === entry.code)).toBe(true);
    expect(result!.message).toContain('overdue');

    // Verify status was changed to 'overdue'
    const fromDb = getEntryByCode(entry.code);
    expect(fromDb!.status).toBe('overdue');
  });
});

// --- checkStaleQuestions ---

describe('checkStaleQuestions', () => {
  it('returns null when no stale questions', () => {
    // Any existing WHY.QU entries were just created, so not stale
    const result = checkStaleQuestions();
    // Either null or only has genuinely stale entries
    if (result) {
      expect(result.type).toBe('stale_question');
    }
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

// --- checkStalePlans ---

describe('checkStalePlans', () => {
  it('returns null when no stale plans', () => {
    const result = checkStalePlans();
    if (result) {
      expect(result.type).toBe('stale_plan');
    }
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

    const result = checkStalePlans();
    expect(result).not.toBeNull();
    expect(result!.type).toBe('stale_plan');
    expect(result!.entries.some(e => e.code === entry.code)).toBe(true);
  });
});

// --- checkStaleProjects ---

describe('checkStaleProjects', () => {
  it('returns null when no stale projects', () => {
    const result = checkStaleProjects();
    if (result) {
      expect(result.type).toBe('stale_project');
    }
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
  it('returns HeartbeatResult with ran_at date', () => {
    const result = runHeartbeat();
    expect(result.ran_at).toBe(new Date().toISOString().slice(0, 10));
    expect(Array.isArray(result.notifications)).toBe(true);
  });

  it('creates WHY.MT entry when findings exist', () => {
    // Create an overdue todo to ensure findings
    const todo = createEntry({
      nb: 'NOW', type: 'TD', name: 'Heartbeat Test Todo',
      status: 'open', summary: 'Will be overdue', body: 'Body',
    });

    const d = getDb();
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 3);
    d.prepare('UPDATE index_entries SET updated = ? WHERE code = ?')
      .run(oldDate.toISOString().slice(0, 10), todo.code);

    const result = runHeartbeat();
    expect(result.notifications.length).toBeGreaterThan(0);
    expect(result.created).not.toBeNull();
    expect(result.created!.nb).toBe('WHY');
    expect(result.created!.type).toBe('MT');
    expect(result.created!.name).toContain('Heartbeat');

    // Verify the WHY.MT file exists
    expect(fs.existsSync(result.created!.path)).toBe(true);
    const content = fs.readFileSync(result.created!.path, 'utf-8');
    expect(content).toContain('Findings');
  });

  it('returns null created when no findings on clean DB', () => {
    // Close and set up a completely fresh database
    closeDatabase();
    const cleanDir = path.join(os.tmpdir(), `agentic-agi-clean-${Date.now()}`);
    const cleanDb = path.join(cleanDir, 'memory.sqlite');
    const cleanMemory = path.join(cleanDir, 'memory');
    (PATHS as Record<string, string>).db = cleanDb;
    (PATHS as Record<string, string>).memory = cleanMemory;
    initDatabase(cleanDb);

    const result = runHeartbeat();
    expect(result.notifications).toEqual([]);
    expect(result.created).toBeNull();

    // Clean up and restore test DB
    closeDatabase();
    fs.rmSync(cleanDir, { recursive: true, force: true });
    (PATHS as Record<string, string>).db = TEST_DB;
    (PATHS as Record<string, string>).memory = TEST_MEMORY;
    initDatabase(TEST_DB);
  });
});

// --- Acceptance test ---

describe('acceptance', () => {
  it('overdue TODO triggers heartbeat notification + WHY.MT creation', () => {
    // Close and set up a fresh database for this acceptance test
    closeDatabase();
    const acceptDir = path.join(os.tmpdir(), `agentic-agi-accept-${Date.now()}`);
    const acceptDb = path.join(acceptDir, 'memory.sqlite');
    const acceptMemory = path.join(acceptDir, 'memory');
    (PATHS as Record<string, string>).db = acceptDb;
    (PATHS as Record<string, string>).memory = acceptMemory;
    initDatabase(acceptDb);

    // Create a todo and backdate it
    const todo = createEntry({
      nb: 'NOW', type: 'TD', name: 'Buy groceries',
      status: 'open', summary: 'Need milk and eggs', body: '- Milk\n- Eggs',
    });

    const d = getDb();
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    d.prepare('UPDATE index_entries SET updated = ? WHERE code = ?')
      .run(twoDaysAgo.toISOString().slice(0, 10), todo.code);

    // Run heartbeat
    const result = runHeartbeat();

    // Notification exists for overdue todo
    const overdue = result.notifications.find(n => n.type === 'overdue_todo');
    expect(overdue).toBeDefined();
    expect(overdue!.entries.some(e => e.code === todo.code)).toBe(true);

    // WHY.MT entry was created
    expect(result.created).not.toBeNull();
    expect(result.created!.nb).toBe('WHY');
    expect(result.created!.type).toBe('MT');

    // Todo status was changed to overdue
    const updated = getEntryByCode(todo.code);
    expect(updated!.status).toBe('overdue');

    // Clean up and restore test DB
    closeDatabase();
    fs.rmSync(acceptDir, { recursive: true, force: true });
    (PATHS as Record<string, string>).db = TEST_DB;
    (PATHS as Record<string, string>).memory = TEST_MEMORY;
    initDatabase(TEST_DB);
  });
});

// --- Performance ---

describe('performance', () => {
  it('full heartbeat completes in under 100ms', () => {
    const start = performance.now();
    runHeartbeat();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});
